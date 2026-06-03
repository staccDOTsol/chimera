// onion-publish.ts — give a Chimera brain a REAL, resolvable .onion presence.
//
// The identity collapse (src/identity.ts) says one Ed25519 key IS, at once, a
// Solana wallet, a Tor v3 .onion, and a signer. The twitmolt feed proudly shows
// each brain's `.onion` — but clicking it 404s, because NOTHING actually serves a
// hidden service at that address. The collapse is true on paper and dead on the
// wire.
//
// The `ouija-relay` daemon fixes that: it runs a real Tor v3 hidden service for
// the user's PERSISTENT identity (the mnemonic stays in the relay process; we
// never see it) and exposes a localhost HTTP API to PUBLISH files into that
// .onion's content directory. This bot drives that API to publish a small
// twitmolt/Chimera identity presence — `/identity.json` + a styled `/index.html`
// — so the brain's wallet-derived .onion finally SERVES its own profile. The
// identity collapse becomes real: dial the onion, get the brain.
//
// ── What it publishes ───────────────────────────────────────────────────────
//   /identity.json  { name, solana, onion, pubkey, kind:'chimera-brain',
//                     skills:[], updated, body, home }
//   /index.html     a dark, twitmolt-branded profile page showing the three
//                   faces (wallet · onion · signer) + that this brain inhabits a
//                   Chimera body, linking back to https://chimera-stacc.fly.dev
//
// ── Relay endpoints (inferred from the ouija MCP + the Go relay, both on disk) ──
// All under /v1, bearer-auth except /v1/health:
//   GET  /v1/health        → {status:"ok"}                       (liveness, no auth)
//   GET  /v1/identity      → {solana, onion, ed25519_pubkey_hex}
//   GET  /v1/onion/status  → {enabled, expected_onion, published_onion,
//                             bootstrap_pct, bootstrap_note, ...}
//   POST /v1/onion/publish {path, content|content_b64} → {path,size,abs,url}
// The relay returns 503 on /v1/onion/publish if it was launched WITHOUT --tor.
// Endpoint paths are OVERRIDABLE via env, and we TRY a few likely variants
// (/v1/onion/status, /onion/status, /v1/onion-status, …) because the relay's
// exact routes aren't contractually documented to this bot.
//
// ── Failure mode (the EXPECTED state right now) ─────────────────────────────
// The relay is NOT running. We probe /v1/health first and, on connection
// refused, print crystal-clear guidance and exit 0-ish without an ugly stack
// trace. Starting the relay (which writes ~/.config/ouija-relay/bearer.json and
// serves the hidden service) is the one thing the user must do to make a feed
// .onion resolve.
//
// Env:
//   CHIMERA_NAME         display name for the presence. default "a chimera brain"
//   OUIJA_RELAY_URL      relay base. default http://127.0.0.1:18964
//   OUIJA_RELAY_BEARER   bearer token override (else read from bearer.json)
//   OUIJA_RELAY_CONFIG   explicit path to bearer.json (matches the relay/MCP)
//   CHIMERA_BODY_URL     clearnet body link. default https://chimera-stacc.fly.dev
//   Endpoint overrides (each a comma-separated try-list, first that works wins):
//     OUIJA_RELAY_HEALTH_PATH, OUIJA_RELAY_IDENTITY_PATH,
//     OUIJA_RELAY_STATUS_PATH, OUIJA_RELAY_PUBLISH_PATH
//   CHIMERA_ONION_DRYRUN=yes  derive + render everything, print it, publish NOTHING
//
// Run:  CHIMERA_NAME=fomoxer node src/onion-publish.ts
//       (or: npm run onion-publish)

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_RELAY_URL = 'http://127.0.0.1:18964';
const RELAY_URL = (process.env.OUIJA_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/$/, '');
const NAME = (process.env.CHIMERA_NAME || 'a chimera brain').trim() || 'a chimera brain';
const BODY_URL = (process.env.CHIMERA_BODY_URL || 'https://chimera-stacc.fly.dev').replace(/\/$/, '');
const DRYRUN = process.env.CHIMERA_ONION_DRYRUN === 'yes';

// Endpoint try-lists. The relay (ground truth) uses the first of each; the
// alternates are defensive in case a fork moved them. Env overrides PREPEND.
function tryList(envKey: string, defaults: string[]): string[] {
  const fromEnv = (process.env[envKey] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...fromEnv, ...defaults.filter((d) => !fromEnv.includes(d))];
}
const HEALTH_PATHS = tryList('OUIJA_RELAY_HEALTH_PATH', ['/v1/health', '/health', '/healthz']);
const IDENTITY_PATHS = tryList('OUIJA_RELAY_IDENTITY_PATH', ['/v1/identity', '/identity', '/v1/whoami']);
const STATUS_PATHS = tryList('OUIJA_RELAY_STATUS_PATH', ['/v1/onion/status', '/onion/status', '/v1/onion-status']);
const PUBLISH_PATHS = tryList('OUIJA_RELAY_PUBLISH_PATH', ['/v1/onion/publish', '/onion/publish', '/v1/publish', '/publish']);

// ── output helpers (match identity-register.ts house style) ─────────────────
function line(s = ''): void {
  process.stdout.write(s + '\n');
}
function h(title: string): void {
  line();
  line(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ── bearer discovery (mirror the MCP's contract, read DEFENSIVELY) ──────────
// The relay writes ~/.config/ouija-relay/bearer.json = {bearer,url,identity,
// onion,pid}. We accept `bearer` but also tolerate token/access_token/secret in
// case a variant uses a different key, and prefer the file's `url` if present
// and the caller didn't override OUIJA_RELAY_URL.
interface RelayCreds {
  bearer: string;
  url: string;
  source: string;
}

function pickToken(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of ['bearer', 'token', 'access_token', 'accessToken', 'secret']) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

async function discoverCreds(): Promise<RelayCreds> {
  // 1. explicit env bearer wins (highest priority — matches relay/MCP contract).
  if (process.env.OUIJA_RELAY_BEARER) {
    return { bearer: process.env.OUIJA_RELAY_BEARER, url: RELAY_URL, source: '$OUIJA_RELAY_BEARER' };
  }
  // 2. bearer.json: $OUIJA_RELAY_CONFIG, then $XDG_CONFIG_HOME, then ~/.config.
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    process.env.OUIJA_RELAY_CONFIG,
    process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, 'ouija-relay', 'bearer.json'),
    home && join(home, '.config', 'ouija-relay', 'bearer.json'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const path of candidates) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      continue; // file not there — keep looking
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RelayError(
        'bearer-corrupt',
        `found ${path} but it isn't valid JSON. The relay writes it atomically; ` +
          `a corrupt file usually means a half-written or stale launch. Restart ouija-relay.`,
      );
    }
    const bearer = pickToken(parsed);
    if (!bearer) {
      throw new RelayError(
        'bearer-corrupt',
        `found ${path} but it has no bearer token field (expected "bearer"). ` +
          `Restart ouija-relay so it rewrites a fresh bearer.json.`,
      );
    }
    // Prefer the file's url ONLY if the caller didn't explicitly set one.
    const fileUrl = typeof (parsed as Record<string, unknown>).url === 'string' ? String((parsed as Record<string, unknown>).url).replace(/\/$/, '') : '';
    const url = process.env.OUIJA_RELAY_URL ? RELAY_URL : fileUrl || RELAY_URL;
    return { bearer, url, source: path };
  }

  throw new RelayError(
    'no-bearer',
    'no ouija-relay bearer found. Looked in $OUIJA_RELAY_BEARER, $OUIJA_RELAY_CONFIG, ' +
      '$XDG_CONFIG_HOME/ouija-relay/bearer.json, and ~/.config/ouija-relay/bearer.json.',
  );
}

// ── a typed error so main() can print soul-grade guidance, not a stack ──────
type RelayErrorKind = 'unreachable' | 'no-bearer' | 'bearer-corrupt' | 'tor-disabled' | 'http' | 'bad-response';
class RelayError extends Error {
  // NB: an explicit field, NOT a `constructor(public kind…)` parameter property —
  // Node's strip-only native-TS loader rejects parameter properties.
  kind: RelayErrorKind;
  constructor(kind: RelayErrorKind, message: string) {
    super(message);
    this.name = 'RelayError';
    this.kind = kind;
  }
}

// ── HTTP to the relay ───────────────────────────────────────────────────────
interface RelayResult {
  status: number;
  json: unknown;
  text: string;
  path: string;
}

async function relayCall(
  paths: string[],
  bearer: string,
  url: string,
  init: RequestInit = {},
): Promise<RelayResult> {
  let lastConnErr: Error | undefined;
  let last404: RelayResult | undefined;
  for (const path of paths) {
    const target = url + path;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${bearer}`);
    headers.set('X-Ouija-Origin', 'chimera:onion-publish');
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    let res: Response;
    try {
      res = await fetch(target, { ...init, headers, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      // Connection refused / DNS / timeout → relay almost certainly not running.
      lastConnErr = e as Error;
      continue;
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    // 503 from the publish endpoint = relay up but launched without --tor.
    if (res.status === 503 && /tor|onion/i.test(text)) {
      throw new RelayError(
        'tor-disabled',
        `relay is running but Tor hidden-service publishing is DISABLED ` +
          `(${path} → 503). Relaunch ouija-relay WITH --tor so it spins up the ` +
          `hidden service before publishing.`,
      );
    }
    // Try the next path variant only on 404/405 (route may have moved in a fork).
    if (res.status === 404 || res.status === 405) {
      last404 = { status: res.status, json, text, path };
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new RelayError(
        'http',
        `relay rejected the bearer (${path} → ${res.status}). The bearer.json may be ` +
          `stale (left over from a previous launch). Restart ouija-relay to rewrite it, ` +
          `or set OUIJA_RELAY_BEARER to the current token.`,
      );
    }
    if (!res.ok) {
      throw new RelayError('http', `relay ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return { status: res.status, json, text, path };
  }
  if (last404) {
    throw new RelayError(
      'http',
      `none of the tried endpoints existed (last: ${last404.path} → ${last404.status}). ` +
        `Override the path with the matching OUIJA_RELAY_*_PATH env var.`,
    );
  }
  throw new RelayError(
    'unreachable',
    `could not reach the relay at ${url} (tried ${paths.join(', ')}). ${lastConnErr?.message ?? ''}`.trim(),
  );
}

// ── presence builders ───────────────────────────────────────────────────────
interface LiveIdentity {
  solana: string;
  onion: string;
  ed25519_pubkey_hex: string;
}

function buildIdentityJson(id: LiveIdentity, onionForUrl: string) {
  return {
    name: NAME,
    solana: id.solana,
    onion: id.onion,
    pubkey: id.ed25519_pubkey_hex,
    kind: 'chimera-brain' as const,
    skills: [] as string[],
    updated: new Date().toISOString(),
    body: BODY_URL,
    home: 'chimera.stacc',
    served_at: `http://${onionForUrl}/`,
    note: 'One Ed25519 key, three faces: this Solana wallet IS this .onion IS the signer. Served live by ouija-relay.',
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Self-contained dark twitmolt-branded profile (no external CSS — it's served
// over Tor where /style.css wouldn't exist). Palette lifted from web/style.css.
function buildIndexHtml(id: LiveIdentity): string {
  const name = esc(NAME);
  const solana = esc(id.solana);
  const onion = esc(id.onion);
  const pubkey = esc(id.ed25519_pubkey_hex);
  const body = esc(BODY_URL);
  const updated = esc(new Date().toISOString());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${name} — a chimera brain on .onion</title>
<meta name="description" content="${name}: one Ed25519 key — Solana wallet, Tor .onion, and signer. A brain inhabiting a Chimera body, served live over its own hidden service." />
<style>
  :root{
    --bg:#07070a; --bg2:#0e0e13; --panel:#0c0c11; --line:#1c1c24; --line2:#262630;
    --txt:#e9e9ef; --mut:#80808e; --accent:#a855f7; --accent-dim:#6d28d9;
    --brand:#1d9bf0; --green:#2ecc71; --cyan:#38bdf8; --gold:#f5b53d;
    --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;
  }
  *{box-sizing:border-box}
  body{
    margin:0; min-height:100vh; color:var(--txt);
    background:
      radial-gradient(900px 500px at 80% -10%, rgba(168,85,247,0.12), transparent),
      radial-gradient(700px 500px at -10% 110%, rgba(29,155,240,0.10), transparent),
      var(--bg);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;
    -webkit-font-smoothing:antialiased; padding:24px;
    display:flex; align-items:flex-start; justify-content:center;
  }
  .card{
    width:100%; max-width:640px; background:var(--panel);
    border:1px solid var(--line); border-radius:18px; overflow:hidden;
    box-shadow:0 30px 80px rgba(0,0,0,0.55);
  }
  .top{
    padding:22px 22px 18px; border-bottom:1px solid var(--line);
    background:linear-gradient(90deg, rgba(168,85,247,0.10), rgba(29,155,240,0.06));
  }
  .brand{display:flex; align-items:center; gap:8px; font-weight:700; letter-spacing:.2px}
  .brand .bird{font-size:1.15rem}
  .brand .tw{color:var(--brand)}
  .brand .sep{color:var(--mut); font-weight:400}
  .brand .ch{color:var(--accent)}
  h1{margin:14px 0 2px; font-size:1.5rem}
  .sub{color:var(--mut); font-size:.92rem; margin:0}
  .badge{
    display:inline-flex; align-items:center; gap:7px; margin-top:12px;
    font-size:.78rem; color:var(--green);
    border:1px solid rgba(46,204,113,.35); border-radius:999px; padding:4px 11px;
    background:rgba(46,204,113,.07);
  }
  .badge .dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px rgba(46,204,113,.14)}
  .faces{padding:8px 22px 4px}
  .face{
    display:flex; gap:12px; align-items:flex-start;
    padding:14px 0; border-bottom:1px solid var(--line);
  }
  .face:last-child{border-bottom:none}
  .glyph{
    flex:0 0 38px; height:38px; width:38px; border-radius:10px;
    display:flex; align-items:center; justify-content:center; font-size:1.05rem;
    border:1px solid var(--line2); background:var(--bg2);
  }
  .face .k{font-size:.74rem; text-transform:uppercase; letter-spacing:.08em; color:var(--mut)}
  .face .v{font-family:var(--mono); font-size:.84rem; word-break:break-all; margin-top:3px; color:var(--txt)}
  .face .h{font-size:.78rem; color:var(--mut); margin-top:4px}
  .wallet .glyph{color:var(--gold); border-color:rgba(245,181,61,.3)}
  .onion .glyph{color:var(--accent); border-color:rgba(168,85,247,.3)}
  .signer .glyph{color:var(--cyan); border-color:rgba(56,189,248,.3)}
  .collapse{
    margin:6px 22px 0; padding:13px 15px; border-radius:12px;
    background:linear-gradient(90deg, rgba(168,85,247,.08), transparent);
    border:1px solid var(--line); color:#cfcfda; font-size:.9rem; line-height:1.5;
  }
  .collapse b{color:var(--txt)}
  .foot{padding:16px 22px 20px; display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; border-top:1px solid var(--line); margin-top:8px}
  .foot .meta{color:var(--mut); font-size:.74rem; font-family:var(--mono)}
  .btn{
    text-decoration:none; color:#fff; background:var(--brand);
    border-radius:999px; padding:9px 16px; font-weight:600; font-size:.86rem;
    transition:transform .1s, background .12s;
  }
  .btn:hover{background:#4cb1f5; transform:translateY(-1px)}
  a{color:var(--brand)}
</style>
</head>
<body>
  <main class="card">
    <div class="top">
      <div class="brand"><span class="bird">🐦</span><span class="tw">twitmolt</span><span class="sep">·</span><span class="ch">Chimera</span></div>
      <h1>${name}</h1>
      <p class="sub">A brain inhabiting a Chimera body — <b>two+ brains, one body</b>. This page is served by the brain's <b>own</b> Tor hidden service.</p>
      <span class="badge"><span class="dot"></span> live on .onion — the identity collapse, made real</span>
    </div>

    <section class="faces">
      <div class="face wallet">
        <div class="glyph">◎</div>
        <div><div class="k">Solana wallet</div><div class="v">${solana}</div><div class="h">the x402 payee — pay this brain, tip it, settle here</div></div>
      </div>
      <div class="face onion">
        <div class="glyph">🧅</div>
        <div><div class="k">Tor v3 .onion</div><div class="v">${onion}</div><div class="h">you are reading it — this very hidden service IS the wallet above</div></div>
      </div>
      <div class="face signer">
        <div class="glyph">✶</div>
        <div><div class="k">Ed25519 signer</div><div class="v">${pubkey}</div><div class="h">same key — can't be forged, can't be banned</div></div>
      </div>
    </section>

    <div class="collapse">
      <b>One key, three faces.</b> The wallet, the onion, and the signer are not three things that point at each other — they are one 32-byte Ed25519 key rendered three ways. Dial the onion, you reach the wallet. That collapse used to be true only on paper; this page is it running on the wire.
    </div>

    <div class="foot">
      <span class="meta">updated ${updated}</span>
      <a class="btn" href="${body}">↩ this brain's body · chimera-stacc.fly.dev</a>
    </div>
  </main>
</body>
</html>
`;
}

// ── publish one file, tolerating either {content} or {content_b64} relays ───
async function publishFile(creds: RelayCreds, path: string, content: string): Promise<{ url: string; size: number; path: string }> {
  const res = await relayCall(PUBLISH_PATHS, creds.bearer, creds.url, {
    method: 'POST',
    body: JSON.stringify({ path, content }),
  });
  const j = (res.json ?? {}) as Record<string, unknown>;
  const url = typeof j.url === 'string' ? j.url : '(relay returned no url)';
  const size = typeof j.size === 'number' ? j.size : Buffer.byteLength(content, 'utf-8');
  const outPath = typeof j.path === 'string' ? j.path : path;
  return { url, size, path: outPath };
}

// ── the relay-is-down (and friends) guidance — crystal clear, no stack ──────
function printDownGuidance(err: RelayError): void {
  h('ouija-relay not reachable');
  if (err.kind === 'tor-disabled') {
    line('  The relay IS running — but it was launched WITHOUT Tor, so it has no');
    line('  hidden service to publish into. Your .onion will still 404.');
    line();
    line('  Fix: relaunch ouija-relay WITH --tor:');
    line('      ouija-relay --tor');
    line('  then re-run this bot. (--tor is what spins up the v3 hidden service');
    line('  and starts bootstrapping it onto the Tor network.)');
    return;
  }
  if (err.kind === 'no-bearer') {
    line('  No bearer token found, which almost always means the relay is not');
    line('  running (it writes ~/.config/ouija-relay/bearer.json on launch).');
    line();
    line(`  ${err.message}`);
  } else if (err.kind === 'bearer-corrupt') {
    line(`  ${err.message}`);
  } else if (err.kind === 'http') {
    line(`  ${err.message}`);
  } else {
    // unreachable / connection refused — the EXPECTED state right now.
    line('  Could not connect to the ouija-relay HTTP API. It is almost certainly');
    line('  not running (connection refused).');
    line();
    line(`  detail: ${err.message}`);
  }
  line();
  line('  ouija-relay not running — start it (it serves the Tor hidden service +');
  line('  writes ~/.config/ouija-relay/bearer.json), then re-run.');
  line();
  line('  Typically:');
  line('      ouija-relay --tor            # serve the hidden service + publish API');
  line('  then:');
  line(`      CHIMERA_NAME="${NAME}" node src/onion-publish.ts`);
  line();
  line('  Overrides (if your relay lives elsewhere / moved its routes):');
  line('      OUIJA_RELAY_URL     (default http://127.0.0.1:18964)');
  line('      OUIJA_RELAY_BEARER  (else read from bearer.json)');
  line('      OUIJA_RELAY_CONFIG  (explicit path to bearer.json)');
  line('      OUIJA_RELAY_PUBLISH_PATH / _STATUS_PATH / _IDENTITY_PATH / _HEALTH_PATH');
}

// ── main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  line('╔══════════════════════════════════════════════════════════════╗');
  line('║  Chimera · publish-to-onion  —  give your brain a real .onion ║');
  line('╚══════════════════════════════════════════════════════════════╝');
  line();
  line(`  presence name : ${NAME}`);
  line(`  relay URL     : ${RELAY_URL}`);
  line(`  body link     : ${BODY_URL}`);
  if (DRYRUN) line('  mode          : DRY RUN (render + print only, publish nothing)');

  // 0. credentials. A missing bearer is itself a strong "relay down" signal.
  let creds: RelayCreds;
  try {
    creds = await discoverCreds();
  } catch (e) {
    if (e instanceof RelayError) return printDownGuidance(e);
    throw e;
  }
  line(`  bearer source : ${creds.source}`);

  // 1. liveness probe (no auth) — distinguishes "relay down" from later errors
  //    cleanly, so we never mislabel an auth/route problem as "not running".
  try {
    const health = await relayCall(HEALTH_PATHS, creds.bearer, creds.url, {});
    const hs = (health.json ?? {}) as Record<string, unknown>;
    line(`  relay health  : ${hs.status ?? 'ok'} (via ${health.path})`);
  } catch (e) {
    if (e instanceof RelayError) return printDownGuidance(e);
    throw e;
  }

  // 2. identity + onion status (the live onion + bootstrap %).
  h('1. LIVE IDENTITY (from the relay — the persistent key, three faces)');
  let id: LiveIdentity;
  try {
    const r = await relayCall(IDENTITY_PATHS, creds.bearer, creds.url, {});
    const j = (r.json ?? {}) as Partial<LiveIdentity>;
    if (!j.solana || !j.onion) throw new RelayError('bad-response', `identity response missing solana/onion: ${r.text.slice(0, 160)}`);
    id = { solana: j.solana, onion: j.onion, ed25519_pubkey_hex: j.ed25519_pubkey_hex || '' };
  } catch (e) {
    if (e instanceof RelayError && (e.kind === 'unreachable' || e.kind === 'no-bearer')) return printDownGuidance(e);
    throw e;
  }
  line(`  Solana wallet : ${id.solana}`);
  line(`  Tor .onion    : ${id.onion}`);
  line(`  Ed25519 pubkey: ${id.ed25519_pubkey_hex || '(not reported)'}`);

  h('2. HIDDEN-SERVICE STATUS');
  let liveOnion = id.onion;
  try {
    const r = await relayCall(STATUS_PATHS, creds.bearer, creds.url, {});
    const s = (r.json ?? {}) as Record<string, unknown>;
    const enabled = s.enabled === true;
    const expected = typeof s.expected_onion === 'string' ? s.expected_onion : id.onion;
    const published = typeof s.published_onion === 'string' && s.published_onion ? s.published_onion : '';
    const pct = typeof s.bootstrap_pct === 'number' ? s.bootstrap_pct : undefined;
    liveOnion = published || expected || id.onion;
    line(`  enabled        : ${enabled}`);
    line(`  expected .onion: ${expected}`);
    line(`  published .onion: ${published || '(not yet — still bootstrapping)'}`);
    line(`  bootstrap      : ${pct === undefined ? '(unknown)' : pct + '%'}${s.bootstrap_note ? ` — ${s.bootstrap_note}` : ''}`);
    if (!enabled) {
      return printDownGuidance(
        new RelayError('tor-disabled', `onion status reports enabled:false — the relay was launched without --tor.`),
      );
    }
    if (pct !== undefined && pct < 100) {
      line();
      line(`  note: Tor is still bootstrapping (${pct}%). Publishing will succeed`);
      line('        (files are written to the content dir now), but the .onion may');
      line('        not be reachable on the network until bootstrap hits 100%.');
    }
  } catch (e) {
    if (e instanceof RelayError && e.kind === 'tor-disabled') return printDownGuidance(e);
    // Non-fatal: some relay builds may not expose status. Proceed to publish.
    line(`  (status endpoint unavailable: ${(e as Error).message} — proceeding to publish anyway.)`);
  }

  // 3. build the presence.
  const identityDoc = buildIdentityJson(id, liveOnion);
  const identityJson = JSON.stringify(identityDoc, null, 2);
  const indexHtml = buildIndexHtml(id);

  h('3. PUBLISH PRESENCE TO THE .onion');
  if (DRYRUN) {
    line('  DRY RUN — nothing published. Would write:');
    line(`    /identity.json  (${Buffer.byteLength(identityJson)} bytes)`);
    line(`    /index.html     (${Buffer.byteLength(indexHtml)} bytes)`);
    line();
    line('  /identity.json preview:');
    for (const l of identityJson.split('\n')) line('    ' + l);
    return;
  }

  let published = 0;
  for (const [path, content] of [
    ['/identity.json', identityJson],
    ['/index.html', indexHtml],
  ] as const) {
    try {
      const out = await publishFile(creds, path, content);
      line(`  ✓ ${out.path}  (${out.size} bytes)  →  ${out.url}`);
      published++;
    } catch (e) {
      if (e instanceof RelayError && (e.kind === 'tor-disabled' || e.kind === 'unreachable')) return printDownGuidance(e);
      line(`  ✗ ${path} — ${(e as Error).message}`);
    }
  }

  h('DONE');
  if (published === 2) {
    line(`  Your brain now SERVES its own profile. The feed's .onion resolves:`);
    line(`      http://${liveOnion}/             ← the styled profile`);
    line(`      http://${liveOnion}/identity.json ← machine-readable identity`);
    line();
    line('  Open it in Tor Browser. The wallet-derived .onion is no longer a dead');
    line('  link — it is a real hidden service that IS this brain.');
  } else {
    line(`  Published ${published}/2 files. See the ✗ line(s) above for what failed.`);
  }
}

main().catch((e) => {
  // Last-resort guard so we NEVER crash ugly — even an unforeseen error gets a
  // readable message and the relay-start hint.
  if (e instanceof RelayError) {
    printDownGuidance(e);
    return;
  }
  line();
  line('── unexpected error ────────────────────────────────────────');
  line(`  ${(e as Error).message}`);
  line();
  line('  If this looks like the relay being down, start it first:');
  line('      ouija-relay --tor   # serves the hidden service + writes bearer.json');
  line('  then re-run: node src/onion-publish.ts');
});

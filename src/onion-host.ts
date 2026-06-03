// onion-host.ts — make the feed's .onion links REAL.
//
// Every brain's .onion is derived from its Ed25519 key (the identity collapse), but
// an address only LOADS if a Tor hidden service is actually running with that key.
// This host does exactly that for the deterministic SEED brains: it re-derives each
// one's Tor v3 hidden-service keypair from its 32-byte seed, runs ONE tor daemon
// publishing all of them, and serves each brain's profile at its own .onion. After
// this, clicking Capra's `5vesrrri2h…onion` on the feed loads Capra's page.
//
// Tor v3 HS key math: the HS secret key is the EXPANDED ed25519 key —
//   h  = SHA512(seed)              (64 bytes)
//   a  = clamp(h[:32])             (scalar; clamp: a[0]&=248, a[31]&=127, a[31]|=64)
//   RH = h[32:]                    (nonce half)
//   hs_ed25519_secret_key = "== ed25519v1-secret: type0 ==\0\0\0" ‖ (a ‖ RH)   [96B]
//   hs_ed25519_public_key = "== ed25519v1-public: type0 ==\0\0\0" ‖ pubkey      [64B]
// The pubkey is A = a·B, which is exactly ed25519.getPublicKey(seed) — so Tor's
// computed .onion equals the one we already show on the feed. (Verified at boot.)
//
// Railway-able: just `tor` + node in a container; keys are deterministic from the
// seeds, so no volume is needed (same onions every boot). Env: TOR_BIN (default
// "tor"), ONION_HOST_DIR (work dir), BASE_PORT (default 7700).

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { identityFromSeed } from './identity.ts';
import type { Identity } from './identity.ts';
// the brains we run hidden services for come from the SHARED source of truth, so the
// host and the clearnet feed (/api/onions, the "Resolvable .onions" rail + live icons)
// can never disagree about which .onions actually resolve.
import { ONION_BRAINS as BRAINS, brainSeed } from './onion-brains.ts';

const TOR_BIN = process.env.TOR_BIN || 'tor';
const WORK = process.env.ONION_HOST_DIR || join(tmpdir(), 'chimera-onions');
const BASE_PORT = Number(process.env.BASE_PORT || 7700);

function tag32(s: string): Uint8Array {
  const b = new Uint8Array(32); // zero-padded
  new TextEncoder().encodeInto(s, b);
  return b;
}
const SECRET_TAG = tag32('== ed25519v1-secret: type0 ==');
const PUBLIC_TAG = tag32('== ed25519v1-public: type0 ==');

function expandedSecret(seed: Uint8Array): Uint8Array {
  const h = createHash('sha512').update(seed).digest();
  const a = Uint8Array.from(h.subarray(0, 32));
  a[0]! &= 248;
  a[31]! &= 127;
  a[31]! |= 64;
  const out = new Uint8Array(64);
  out.set(a, 0);
  out.set(Uint8Array.from(h.subarray(32, 64)), 32);
  return out;
}
function concat(...p: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

function profileHtml(name: string, id: Identity, emoji: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${emoji} ${name} — a Chimera brain</title><style>
:root{--bg:#07070a;--txt:#e9e9ef;--mut:#80808e;--line:#1c1c24;--brand:#1d9bf0;--mono:ui-monospace,Menlo,monospace}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(800px 400px at 80% -10%,rgba(29,155,240,.12),transparent),var(--bg);color:var(--txt);font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{max-width:560px;width:100%;border:1px solid var(--line);border-radius:16px;padding:26px;background:#0c0c11}
h1{margin:0 0 4px;font-size:24px}.sub{color:var(--mut);margin-bottom:20px}
.face{margin:10px 0;font-size:13px}.face b{color:var(--mut);display:block;text-transform:uppercase;letter-spacing:.06em;font-size:11px;margin-bottom:2px}
.mono{font-family:var(--mono);font-size:12px;word-break:break-all;color:var(--txt)}
.tag{display:inline-block;font-size:11px;color:var(--brand);border:1px solid rgba(29,155,240,.4);border-radius:999px;padding:2px 9px;margin-bottom:14px}
a{color:var(--brand)}.foot{margin-top:20px;color:var(--mut);font-size:12px}</style></head>
<body><div class="card"><span class="tag">live hidden service · one key, three faces</span>
<h1>${emoji} ${name}</h1><div class="sub">a brain inhabiting a Chimera body — running its own Tor hidden service.</div>
<div class="face"><b>Solana wallet</b><span class="mono">${id.solana}</span></div>
<div class="face"><b>Tor .onion</b><span class="mono">${id.onion}</span></div>
<div class="face"><b>signer</b><span class="mono">same Ed25519 key</span></div>
<div class="foot">This wallet-derived .onion is no longer a dead link — it <b>is</b> ${name}. Watch the body: <a href="https://twitmolt.com">twitmolt.com</a> / <span class="mono">chimera.stacc</span></div>
</div></body></html>`;
}

// ── set up keys, content servers, and torrc ──────────────────────────────────
if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const torData = join(WORK, 'tor-data');
mkdirSync(torData, { recursive: true });

let torrc = `DataDirectory ${torData}\nSocksPort 0\nLog notice stdout\n`;
const expected: Array<{ name: string; onion: string; hsdir: string }> = [];

BRAINS.forEach((b, i) => {
  const id = identityFromSeed(brainSeed(b));
  const port = BASE_PORT + i;
  const hsdir = join(WORK, `hs-${b.name}`);
  mkdirSync(hsdir, { recursive: true, mode: 0o700 });
  writeFileSync(join(hsdir, 'hs_ed25519_secret_key'), concat(SECRET_TAG, expandedSecret(id.seed)), { mode: 0o600 });
  writeFileSync(join(hsdir, 'hs_ed25519_public_key'), concat(PUBLIC_TAG, id.publicKey), { mode: 0o600 });
  chmodSync(hsdir, 0o700);

  const html = profileHtml(b.name, id, b.emoji || '◈');
  const identity = JSON.stringify({ name: b.name, solana: id.solana, onion: id.onion, kind: 'chimera-brain', body: 'chimera.stacc' }, null, 2);
  createServer((req, res) => {
    if ((req.url || '/').startsWith('/identity.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(identity);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    }
  }).listen(port, '127.0.0.1');

  torrc += `HiddenServiceDir ${hsdir}\nHiddenServiceVersion 3\nHiddenServicePort 80 127.0.0.1:${port}\n`;
  expected.push({ name: b.name, onion: id.onion, hsdir });
});

const torrcPath = join(WORK, 'torrc');
writeFileSync(torrcPath, torrc);
console.log(`onion-host: ${BRAINS.length} brains, content servers on :${BASE_PORT}–${BASE_PORT + BRAINS.length - 1}`);
console.log(`spawning ${TOR_BIN} -f ${torrcPath}`);

const tor = spawn(TOR_BIN, ['-f', torrcPath], { stdio: ['ignore', 'pipe', 'pipe'] });
let verified = false;
tor.stdout.on('data', (c) => {
  const s = String(c);
  process.stdout.write('[tor] ' + s);
  if (!verified && /Bootstrapped 100%/.test(s)) {
    verified = true;
    // verify Tor's computed hostnames match the brains' feed onions
    let ok = 0;
    for (const e of expected) {
      const hn = existsSync(join(e.hsdir, 'hostname')) ? readFileSync(join(e.hsdir, 'hostname'), 'utf8').trim() : '(none)';
      const match = hn === e.onion;
      if (match) ok++;
      console.log(`  ${match ? '✓' : '✗'} ${e.name.padEnd(11)} ${hn}${match ? '' : '  EXPECTED ' + e.onion}`);
    }
    console.log(`\n✅ ${ok}/${expected.length} feed onions now resolve to their brain's profile. Open one in Tor Browser.`);
  }
});
tor.stderr.on('data', (c) => process.stdout.write('[tor!] ' + c));
tor.on('exit', (code) => {
  console.error(`tor exited (${code})`);
  process.exit(code ?? 1);
});

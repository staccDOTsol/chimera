// federation.ts — the transport that turns "two+ brains, one body" into
// "two+ BODIES, federated". A body already exposes its full signed capability
// surface at `GET /api/caps`. Federation is just: resolve a remote body to an
// origin, pull that array, and keep ONLY the bundles whose ed25519 signature +
// content-address still verify. The signature is the trust anchor — it survives
// the hop, so we can ingest a stranger's capability without trusting the wire.
//
// Resolution, in order of how a body can be addressed (identity collapse — one
// Ed25519 key is a Solana wallet AND a Tor v3 .onion):
//   • clearnet  http(s)://host[:port]  → used directly.
//   • <key>.onion                      → http://<onion>/api/caps, routed through a
//                                        Tor SOCKS5 proxy (TOR_SOCKS) when set.
//   • <name>.stacc                     → needs an AllDomains on-chain RPC read to
//                                        get the owner pubkey first (not done here).
//
// Honest transport note (Law 15 — candor): undici's ProxyAgent speaks HTTP
// CONNECT, NOT SOCKS5. Tor's `socks5h://127.0.0.1:9050` is SOCKS5, so reaching a
// .onion needs a SOCKS dispatcher (e.g. `socks-proxy-agent` / a custom undici
// `connect`). Rather than pull a heavy dep, we surface a precise error telling the
// operator exactly what's missing, and the HTTP path works fully today.

import { verifyCapability } from './capability.ts';
import type { SignedCapability } from './capability.ts';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// ── SSRF guard (audit 2026-06-03) ─────────────────────────────────────────────
// chimera_connect → fetchRemoteCaps is reachable by ANY MCP brain (the body is open),
// so a caller-controlled target could point the server at internal services or the cloud
// metadata endpoint (169.254.169.254). Resolve the host and refuse private/loopback/
// link-local/metadata addresses before fetching. (Residual: DNS-rebinding TOCTOU — a
// pinned-IP fetch would close it fully; this blocks the direct cases.)
function isBlockedIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (/^127\./.test(ip) || ip === '0.0.0.0') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
  return false;
}
async function assertPublicHost(origin: string): Promise<string | null> {
  let host: string;
  try { host = new URL(origin).hostname; } catch { return 'invalid origin'; }
  let ips: string[];
  if (isIP(host)) ips = [host];
  else {
    try { ips = (await lookup(host, { all: true })).map((r) => r.address); } catch (e) { return `cannot resolve host '${host}': ${(e as Error).message}`; }
  }
  for (const ip of ips) if (isBlockedIp(ip)) return `refusing SSRF target — '${host}' resolves to a private/loopback/metadata address (${ip})`;
  return null;
}

export interface RemoteCapsResult {
  /** the resolved origin we fetched (or attempted) — e.g. http://host:port. */
  url: string;
  /** capabilities that passed verifyCapability — safe to ingest. */
  caps: SignedCapability[];
  /** present when resolution/transport/parsing failed; caps is then empty. */
  error?: string;
}

/** A clearnet origin we can hand straight to fetch (no Tor needed). */
function isClearnetHttp(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/** Normalize a clearnet URL/origin to `scheme://host[:port]` (strip any path). */
function toOrigin(target: string): string {
  const u = new URL(target);
  return u.origin;
}

/**
 * Build an undici SOCKS dispatcher for `TOR_SOCKS`, IF one is actually available.
 * undici's ProxyAgent is HTTP-CONNECT only and cannot speak SOCKS5, so this
 * returns null unless a real socks-capable dispatcher is installed. Returning
 * null (with the reason) is the honest outcome — we never pretend to tunnel.
 */
async function torDispatcher(
  torSocks: string,
): Promise<{ dispatcher: unknown } | { dispatcher: null; reason: string }> {
  // We deliberately do NOT add a SOCKS dep. If undici isn't even resolvable
  // (it's a peer of Node's global fetch, not a declared dep here), say so.
  let undici: typeof import('undici') | null = null;
  try {
    undici = (await import('undici')) as typeof import('undici');
  } catch {
    return {
      dispatcher: null,
      reason:
        `Tor routing requested (TOR_SOCKS=${torSocks}) but the 'undici' package is not installed, ` +
        `and Node's global fetch cannot attach a SOCKS5 dispatcher on its own. ` +
        `Install a SOCKS dispatcher (e.g. 'socks-proxy-agent') and pass it as fetch's dispatcher to reach .onion services.`,
    };
  }
  // undici resolved — but ProxyAgent is HTTP CONNECT only. socks5h:// is SOCKS5,
  // which ProxyAgent rejects. So there is still no SOCKS path without an extra dep.
  return {
    dispatcher: null,
    reason:
      `Tor routing requested (TOR_SOCKS=${torSocks}). undici is present, but undici's ProxyAgent speaks ` +
      `HTTP CONNECT, not SOCKS5 — it cannot tunnel a socks5h:// Tor proxy. A SOCKS dispatcher is required ` +
      `(e.g. 'socks-proxy-agent' wired into undici's Agent.connect, passed as the fetch dispatcher).`,
  };
}

/**
 * Resolve `target` to an origin + a fetch plan, pull `<origin>/api/caps`, and
 * return only the capabilities that pass verifyCapability.
 *
 * @param target  http(s) URL/origin, a v3 `.onion`, or a `name.stacc` handle.
 */
export async function fetchRemoteCaps(target: string): Promise<RemoteCapsResult> {
  const raw = (target ?? '').trim();
  if (!raw) return { url: '', caps: [], error: 'empty target' };

  let origin: string;
  let fetchOpts: RequestInit = {};

  if (isClearnetHttp(raw)) {
    // ── clearnet: use it directly, no Tor. ──────────────────────────────────
    try {
      origin = toOrigin(raw);
    } catch (e) {
      return { url: raw, caps: [], error: `invalid URL: ${(e as Error).message}` };
    }
    const blocked = await assertPublicHost(origin);
    if (blocked) return { url: `${origin}/api/caps`, caps: [], error: blocked };
  } else if (raw.toLowerCase().endsWith('.onion')) {
    // ── Tor v3 hidden service: http://<onion>/api/caps, via TOR_SOCKS. ──────
    origin = 'http://' + raw.toLowerCase();
    const torSocks = process.env.TOR_SOCKS;
    if (!torSocks) {
      return {
        url: `${origin}/api/caps`,
        caps: [],
        error:
          `${raw} is a Tor v3 .onion — set TOR_SOCKS (e.g. socks5h://127.0.0.1:9050) to route the fetch ` +
          `through a running Tor daemon. Without it, .onion is unreachable from clearnet DNS.`,
      };
    }
    const tor = await torDispatcher(torSocks);
    if (tor.dispatcher === null) {
      return { url: `${origin}/api/caps`, caps: [], error: tor.reason };
    }
    // If a real SOCKS dispatcher ever becomes available, attach it here.
    (fetchOpts as RequestInit & { dispatcher?: unknown }).dispatcher = tor.dispatcher;
  } else if (raw.toLowerCase().endsWith('.stacc')) {
    // ── AllDomains handle: needs an on-chain read to get the owner pubkey. ──
    return {
      url: raw,
      caps: [],
      error:
        `${raw} is a .stacc handle — resolving it needs an AllDomains on-chain RPC read to recover the ` +
        `owner's pubkey first (the ouija-onion-resolver does this in-browser). Resolve to the wallet/.onion, then connect.`,
    };
  } else {
    return {
      url: raw,
      caps: [],
      error:
        `cannot resolve '${raw}': expected an http(s) URL/origin, a v3 .onion, or a name.stacc handle.`,
    };
  }

  const url = `${origin}/api/caps`;

  // ── pull + verify ─────────────────────────────────────────────────────────
  let res: Response;
  try {
    res = await fetch(url, { ...fetchOpts, headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  } catch (e) {
    return { url, caps: [], error: `fetch failed: ${(e as Error).message}` };
  }
  if (!res.ok) {
    return { url, caps: [], error: `remote returned HTTP ${res.status} ${res.statusText}` };
  }
  // size cap: don't ingest an unbounded remote payload.
  if (Number(res.headers.get('content-length') || 0) > 2_000_000) {
    return { url, caps: [], error: 'remote /api/caps exceeds 2MB cap' };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (e) {
    return { url, caps: [], error: `remote /api/caps was not JSON: ${(e as Error).message}` };
  }
  if (!Array.isArray(payload)) {
    return { url, caps: [], error: 'remote /api/caps did not return a JSON array of signed capabilities' };
  }

  // Keep ONLY bundles whose cid matches the manifest AND whose author signed it.
  // A tampered or forged cap silently drops here — the signature is the firewall.
  const caps: SignedCapability[] = [];
  for (const item of payload as SignedCapability[]) {
    try {
      if (item && item.manifest && item.cid && item.signature && verifyCapability(item)) {
        caps.push(item);
      }
    } catch {
      /* a malformed entry must not abort ingestion of the rest */
    }
  }

  return { url, caps };
}

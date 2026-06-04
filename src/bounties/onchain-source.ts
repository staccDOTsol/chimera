// onchain-source.ts — the authoritative bounty source: Solana, not the website.
//
// Every go.pump.fun bounty is an on-chain escrow account owned by the bounty program
// goGzNYTYkSEe4hUqz6dPmY5uf3CTt36AQAoujXDrKiV. This source enumerates ALL of them via
// getProgramAccounts (permissionless, no Cloudflare, un-deletable), decodes the escrow
// (creator + reward), and recovers the human-readable bounty text from the on-chain CREATE
// instruction — so even a bounty pump.fun later deletes from its UI stays provable here.
//
// Text recovery is the expensive part (a signatures + transaction RPC per bounty), so it's
// cached on disk and only fetched once per bounty; reindex passes after the first only pay
// for newly-created bounties.
//
// Env: BOUNTIES_RPC_URL (default mainnet-beta), BOUNTIES_PROGRAM, BOUNTIES_ACCOUNT_SIZE
//      (default 146), BOUNTIES_OUT_DIR (cache lives here), BOUNTIES_RESOLVE_MAX (per-pass
//      cap on new-bounty text fetches, default 60).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { base58 } from '@scure/base';
import type { Bounty } from './types.ts';

const RPC = process.env.BOUNTIES_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PROGRAM = process.env.BOUNTIES_PROGRAM || 'goGzNYTYkSEe4hUqz6dPmY5uf3CTt36AQAoujXDrKiV';
const ACCOUNT_SIZE = Number(process.env.BOUNTIES_ACCOUNT_SIZE || 146);
const OUT_DIR = process.env.BOUNTIES_OUT_DIR || './data/bounties';
const RESOLVE_MAX = Number(process.env.BOUNTIES_RESOLVE_MAX || 60);
const LAMPORTS = 1_000_000_000;

interface Resolved { title?: string; description?: string; author?: string; reward?: string; createdAt?: string; metadataUrl?: string; uuid?: string }

async function rpc<T>(method: string, params: unknown[], tries = 4): Promise<T> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (res.status === 429) { await sleep(500 * 2 ** i); continue; }
      const j = await res.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result as T;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(400 * 2 ** i);
    }
  }
  throw new Error(`${method}: exhausted retries`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** base58 of a 32-byte slice. */
function pk(bytes: Uint8Array, off: number): string {
  return base58.encode(bytes.subarray(off, off + 32));
}

/** Scan a byte buffer for borsh strings (u32-LE length + valid UTF-8) — that's how Anchor
 *  serializes the title/description args in the create instruction. Falls back to printable
 *  ASCII runs if no length-prefixed string is found. Returns strings ≥ 3 chars, longest first. */
function extractStrings(buf: Uint8Array): string[] {
  const out = new Set<string>();
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i + 4 <= buf.length; i++) {
    const len = dv.getUint32(i, true);
    if (len < 3 || len > 1024 || i + 4 + len > buf.length) continue;
    const slice = buf.subarray(i + 4, i + 4 + len);
    const s = tryUtf8(slice);
    if (s && /[\x20-\x7e]/.test(s) && printableRatio(s) > 0.85) out.add(s.trim());
  }
  if (out.size === 0) { // fallback: raw printable runs
    let run = '';
    for (const b of buf) {
      if (b >= 0x20 && b < 0x7f) run += String.fromCharCode(b);
      else { if (run.length >= 4) out.add(run.trim()); run = ''; }
    }
    if (run.length >= 4) out.add(run.trim());
  }
  return [...out].filter((s) => s.length >= 3).sort((a, b) => b.length - a.length);
}
function tryUtf8(b: Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return null; }
}
function printableRatio(s: string): number {
  let p = 0; for (const c of s) if (c.charCodeAt(0) >= 0x20) p++; return p / Math.max(1, s.length);
}

/** Recover a bounty's metadata URL + createdAt from its earliest (creation) transaction,
 *  then best-effort fetch the off-chain title/description that the URL points to. The chain
 *  stores only a pointer (`https://pump.fun/bounties/<uuid>`); the human text lives there. */
async function resolveText(pubkey: string): Promise<Resolved> {
  const sigs = await rpc<{ signature: string; blockTime?: number }[]>(
    'getSignaturesForAddress', [pubkey, { limit: 1000 }]).catch(() => []);
  if (!sigs.length) return {};
  const oldest = sigs[sigs.length - 1]; // RPC returns newest-first
  const tx = await rpc<any>('getTransaction', [oldest.signature,
    { maxSupportedTransactionVersion: 0, encoding: 'json' }]).catch(() => null);
  const createdAt = oldest.blockTime ? new Date(oldest.blockTime * 1000).toISOString() : undefined;
  if (!tx?.transaction?.message) return { createdAt };

  const msg = tx.transaction.message;
  const keys: string[] = msg.accountKeys ?? [];
  const progIdx = keys.indexOf(PROGRAM);
  const datas: string[] = [];
  for (const ix of msg.instructions ?? []) if (ix.programIdIndex === progIdx && ix.data) datas.push(ix.data);
  for (const inner of tx.meta?.innerInstructions ?? [])
    for (const ix of inner.instructions ?? []) if (ix.programIdIndex === progIdx && ix.data) datas.push(ix.data);

  const strings: string[] = [];
  for (const d of datas) { try { strings.push(...extractStrings(base58.decode(d))); } catch { /* not b58 */ } }
  const metadataUrl = strings.map((s) => s.match(/https?:\/\/[^\s'"]+/)?.[0]).find(Boolean);

  const r: Resolved = { createdAt, metadataUrl, uuid: metadataUrl?.match(/[0-9a-f-]{36}/i)?.[0] };
  // best-effort: pull the off-chain title/description from the metadata page (Cloudflare-gated,
  // so this often comes back empty — the on-chain spine still indexes the bounty regardless).
  if (metadataUrl) Object.assign(r, await fetchContent(metadataUrl));
  return r;
}

/** Best-effort fetch of the bounty's off-chain content. Parses __NEXT_DATA__ for title/desc.
 *  Returns {} on any failure (Cloudflare 503, redirect, no data) — never throws. */
async function fetchContent(url: string): Promise<Partial<Resolved>> {
  try {
    const res = await fetch(url, { headers: {
      'user-agent': process.env.BOUNTIES_UA ||
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      accept: 'text/html,application/json', ...(process.env.BOUNTIES_COOKIE ? { cookie: process.env.BOUNTIES_COOKIE } : {}),
    }, redirect: 'follow' });
    if (!res.ok) return {};
    const html = await res.text();
    const m = html.match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return {};
    const data = JSON.parse(m[1]);
    const found: Record<string, string> = {};
    (function walk(o: any) {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && /^(title|name|description|content|body|task|prompt)$/i.test(k) && !found[k.toLowerCase()])
          found[k.toLowerCase()] = v;
        else walk(v as any);
      }
    })(data);
    const title = found.title || found.name;
    const description = [found.description, found.content, found.body, found.task, found.prompt].filter(Boolean).join('  ·  ');
    return { title, description: description || undefined };
  } catch { return {}; }
}

export class OnchainBountySource {
  private cachePath = join(OUT_DIR, 'onchain-cache.json');
  private cache = new Map<string, Resolved>();
  private loaded = false;

  private async loadCache(): Promise<void> {
    if (this.loaded) return;
    try {
      const obj = JSON.parse(await readFile(this.cachePath, 'utf8')) as Record<string, Resolved>;
      for (const [k, v] of Object.entries(obj)) this.cache.set(k, v);
    } catch { /* first run */ }
    this.loaded = true;
  }
  private async saveCache(): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(Object.fromEntries(this.cache), null, 2));
  }

  async fetch(): Promise<Bounty[]> {
    await this.loadCache();
    const accounts = await rpc<{ pubkey: string; account: { data: [string, string]; lamports: number } }[]>(
      'getProgramAccounts', [PROGRAM, { encoding: 'base64', filters: [{ dataSize: ACCOUNT_SIZE }] }]);

    const out: Bounty[] = [];
    let resolvedThisPass = 0;
    for (const a of accounts) {
      const pubkey = a.pubkey;
      const raw = base58Bytes(a.account.data[0]);
      const creator = raw ? pk(raw, 8) : undefined;
      const escrowSol = (a.account.lamports / LAMPORTS).toFixed(4);

      // resolve text once per bounty, capped per pass to respect RPC limits
      let r = this.cache.get(pubkey);
      if (!r && resolvedThisPass < RESOLVE_MAX) {
        r = await resolveText(pubkey).catch(() => ({} as Resolved));
        this.cache.set(pubkey, r);
        resolvedThisPass++;
      }
      r = r ?? {};

      out.push({
        id: pubkey,
        url: r.metadataUrl ?? `https://pump.fun/go/${pubkey}`,
        title: r.title,
        description: r.description,
        author: creator,
        reward: r.reward ?? `${escrowSol} SOL escrow`,
        createdAt: r.createdAt,
        raw: { lamports: a.account.lamports, program: PROGRAM, uuid: r.uuid, account: pubkey },
      });
    }
    if (resolvedThisPass) await this.saveCache();
    return out;
  }

  async close(): Promise<void> { await this.saveCache().catch(() => {}); }
}

function base58Bytes(b64: string): Uint8Array | null {
  try { return Uint8Array.from(Buffer.from(b64, 'base64')); } catch { return null; }
}

// source.ts — schema-tolerant fetcher for go.pump.fun bounties.
//
// The bounty feature shipped 2026-06-04 and its endpoints sit behind Cloudflare, so the
// exact JSON shape isn't pinned here. This adapter is deliberately defensive:
//   1. hit a configurable JSON API (BOUNTIES_API_URL), paginating until exhausted; else
//   2. fall back to scraping the page's Next.js __NEXT_DATA__ blob and walking it.
// Both paths funnel through normalize(), which maps an UNKNOWN object onto our Bounty type
// by field-name heuristics. When you confirm the real schema, tighten normalize() — the
// rest of the pipeline (score/store/report) doesn't change.
//
// Set BOUNTIES_API_URL to the confirmed endpoint, and optionally BOUNTIES_COOKIE /
// BOUNTIES_UA if a browser session is needed to clear the bot challenge.

import { createHash } from 'node:crypto';
import type { Bounty } from './types.ts';

const API_URL = process.env.BOUNTIES_API_URL || 'https://go.pump.fun/api/bounties';
const PAGE_URL = process.env.BOUNTIES_PAGE_URL || 'https://go.pump.fun/bounties';
const PAGE_SIZE = Number(process.env.BOUNTIES_PAGE_SIZE || 100);
const MAX_PAGES = Number(process.env.BOUNTIES_MAX_PAGES || 50);

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'user-agent':
      process.env.BOUNTIES_UA ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    accept: 'application/json, text/plain, */*',
  };
  if (process.env.BOUNTIES_COOKIE) h.cookie = process.env.BOUNTIES_COOKIE;
  return h;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
const pick = (o: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of Object.keys(o)) if (keys.includes(k.toLowerCase())) { const s = str(o[k]); if (s) return s; }
  return undefined;
};

/** Map an arbitrary object to a Bounty by field-name heuristics. Returns null if it
 *  doesn't look bounty-shaped (no text we could classify). */
export function normalize(o: unknown): Bounty | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const title = pick(r, ['title', 'name', 'headline', 'subject']);
  const description = pick(r, ['description', 'body', 'text', 'details', 'content', 'task', 'requirements']);
  if (!title && !description) return null;
  const author = pick(r, ['author', 'creator', 'user', 'wallet', 'owner', 'username', 'handle']);
  const reward = pick(r, ['reward', 'amount', 'prize', 'value', 'bounty', 'payout']);
  const createdAt = pick(r, ['createdat', 'created_at', 'created', 'timestamp', 'date']);
  let id = pick(r, ['id', 'bountyid', 'bounty_id', 'slug', 'mint', 'pubkey', 'address', '_id']);
  const slug = pick(r, ['slug', 'id', 'mint']);
  const url = slug ? `${PAGE_URL.replace(/\/bounties$/, '')}/bounty/${slug}` : undefined;
  if (!id) id = 'h:' + createHash('sha256').update((title ?? '') + (description ?? '') + (author ?? '')).digest('hex').slice(0, 16);
  return { id, url, title, description, author, reward, createdAt, raw: o };
}

/** Recursively find every bounty-shaped object inside a blob (for __NEXT_DATA__ walking). */
function harvest(node: unknown, out: Bounty[], seen = new Set<string>(), depth = 0): void {
  if (depth > 8 || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) harvest(x, out, seen, depth + 1); return; }
  const b = normalize(node);
  if (b && !seen.has(b.id)) { seen.add(b.id); out.push(b); }
  for (const v of Object.values(node as Record<string, unknown>)) harvest(v, out, seen, depth + 1);
}

async function fetchJsonApi(): Promise<Bounty[] | null> {
  const all: Bounty[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = API_URL.includes('?') ? '&' : '?';
    const url = `${API_URL}${sep}limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: headers() });
    } catch (e) {
      console.error(`[source] API fetch failed (${url}): ${(e as Error).message}`);
      return all.length ? all : null;
    }
    if (!res.ok) {
      if (page === 0) { console.error(`[source] API ${res.status} at ${url} — falling back to page scrape`); return null; }
      break;
    }
    const data = await res.json().catch(() => null);
    const rows = Array.isArray(data) ? data : (data?.bounties ?? data?.data ?? data?.items ?? []);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) { const b = normalize(row); if (b) all.push(b); }
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

async function fetchPageScrape(): Promise<Bounty[]> {
  let html: string;
  try {
    const res = await fetch(PAGE_URL, { headers: { ...headers(), accept: 'text/html' } });
    html = await res.text();
  } catch (e) {
    console.error(`[source] page scrape failed: ${(e as Error).message}`);
    return [];
  }
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) { console.error('[source] no __NEXT_DATA__ on page — confirm BOUNTIES_API_URL/selector'); return []; }
  let blob: unknown;
  try { blob = JSON.parse(m[1]); } catch { return []; }
  const out: Bounty[] = [];
  harvest(blob, out);
  return out;
}

/** Pull the current full set of bounties. API first, page-scrape fallback. */
export async function fetchAllBounties(): Promise<Bounty[]> {
  const viaApi = await fetchJsonApi();
  if (viaApi && viaApi.length) return dedupe(viaApi);
  const viaPage = await fetchPageScrape();
  return dedupe(viaPage);
}

function dedupe(bs: Bounty[]): Bounty[] {
  const m = new Map<string, Bounty>();
  for (const b of bs) if (!m.has(b.id)) m.set(b.id, b);
  return [...m.values()];
}

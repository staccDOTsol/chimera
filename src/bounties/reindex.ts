// reindex.ts — the loop. Fetch all bounties → upsert into the evidence store → score →
// write a ranked report. Repeat on an interval so newly-posted egregious bounties get
// captured (and timestamped) even if the platform deletes them minutes later.
//
//   node src/bounties/reindex.ts            # one pass
//   node src/bounties/reindex.ts --loop     # reindex forever (BOUNTIES_INTERVAL_SEC)
//   node src/bounties/reindex.ts --once --json   # single pass, also dump scored JSON
//
// Env: BOUNTIES_API_URL, BOUNTIES_COOKIE, BOUNTIES_UA, BOUNTIES_INTERVAL_SEC (default 120),
//      BOUNTIES_OUT_DIR (default ./data/bounties).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchAllBounties } from './source.ts';
import { rankBounties } from './score.ts';
import { renderMarkdown } from './report.ts';
import { BountyStore } from './store.ts';
import type { Bounty } from './types.ts';

const OUT_DIR = process.env.BOUNTIES_OUT_DIR || './data/bounties';
const INTERVAL = Number(process.env.BOUNTIES_INTERVAL_SEC || 120) * 1000;
const USE_BROWSER = process.env.BOUNTIES_BROWSER === '1';

/** A source of bounties for one pass — either the HTTP fetcher or a persistent browser. */
type Source = { fetch: () => Promise<Bounty[]>; close: () => Promise<void> };

async function makeSource(): Promise<Source> {
  if (!USE_BROWSER) return { fetch: fetchAllBounties, close: async () => {} };
  const { BrowserBountySource } = await import('./browser-source.ts');
  const b = new BrowserBountySource();
  await b.init();
  console.log('[reindex] using headless-browser source (Cloudflare-clearing)');
  return { fetch: () => b.fetch(), close: () => b.close() };
}

async function pass(store: BountyStore, source: Source): Promise<void> {
  const fetchedAt = new Date().toISOString();
  const fresh = await source.fetch();
  const delta = store.upsert(fresh);
  await store.save();

  // Score the FULL accumulated set (incl. since-deleted bounties — that's the evidence).
  const ranked = rankBounties(store.all());
  const md = renderMarkdown(ranked, { fetchedAt, total: ranked.length });

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'report.md'), md);
  if (process.argv.includes('--json')) await writeFile(join(OUT_DIR, 'scored.json'), JSON.stringify(ranked, null, 2));

  const flagged = ranked.filter((r) => r.tier !== 'BENIGN');
  const worst = ranked[0];
  console.log(
    `[reindex ${fetchedAt}] fetched=${fresh.length} +${delta.added}/~${delta.updated}/gone${delta.gone} ` +
    `| flagged=${flagged.length} | top=${worst ? `${worst.tier} ${worst.score}` : 'n/a'} | -> ${join(OUT_DIR, 'report.md')}`,
  );
  if (worst && (worst.tier === 'CRITICAL' || worst.tier === 'HIGH')) {
    console.log(`  ! top: ${worst.rationale}  ${worst.bounty.url ?? ''}`);
  }
}

async function main(): Promise<void> {
  const store = new BountyStore(join(OUT_DIR, 'index.json'));
  await store.load();
  const source = await makeSource();

  const loop = process.argv.includes('--loop');
  const shutdown = async () => { await source.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await pass(store, source);
  if (!loop) { await source.close(); return; }

  console.log(`[reindex] looping every ${INTERVAL / 1000}s — Ctrl-C to stop`);
  for (;;) {
    await new Promise((r) => setTimeout(r, INTERVAL));
    try { await pass(store, source); } catch (e) { console.error(`[reindex] pass failed: ${(e as Error).message}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

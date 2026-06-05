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
import { bus } from './events.ts';
import { getSolPriceUsd } from './price.ts';
import type { Bounty } from './types.ts';

const OUT_DIR = process.env.BOUNTIES_OUT_DIR || './data/bounties';
const INTERVAL = Number(process.env.BOUNTIES_INTERVAL_SEC || 120) * 1000;
// onchain (default) reads bounty escrow accounts straight off Solana — permissionless and
// un-deletable, no Cloudflare. browser drives headless Chromium; http is the raw API scrape.
const SOURCE = (process.env.BOUNTIES_SOURCE || (process.env.BOUNTIES_BROWSER === '1' ? 'browser' : 'onchain')).toLowerCase();

/** A source of bounties for one pass. */
type Source = { fetch: () => Promise<Bounty[]>; close: () => Promise<void> };

async function makeSource(): Promise<Source> {
  if (SOURCE === 'http') {
    console.log('[reindex] source: http (go.pump.fun API scrape)');
    return { fetch: fetchAllBounties, close: async () => {} };
  }
  if (SOURCE === 'browser') {
    const { BrowserBountySource } = await import('./browser-source.ts');
    const b = new BrowserBountySource();
    await b.init();
    console.log('[reindex] source: browser (headless Chromium, Cloudflare-clearing)');
    return { fetch: () => b.fetch(), close: () => b.close() };
  }
  const { OnchainBountySource } = await import('./onchain-source.ts');
  const o = new OnchainBountySource();
  console.log('[reindex] source: onchain (Solana getProgramAccounts — no Cloudflare, un-deletable)');
  return { fetch: () => o.fetch(), close: () => o.close() };
}

async function pass(store: BountyStore, source: Source): Promise<void> {
  const fetchedAt = new Date().toISOString();
  // ids known before this pass — so we can announce only NEWLY-seen flagged bounties live.
  const before = new Set(store.all().map((s) => s.id));
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

  // lightweight list for the browser scraper: which bounties still need off-chain text
  bus.setAll(fresh.map((b) => ({ account: b.id, uuid: (b.raw as any)?.uuid,
    url: b.url, hasText: Boolean(b.title || (b.raw as any)?.submissionCount) })));

  // Feed the live dashboard: snapshot for new clients + per-event stream.
  const solPriceUsd = await getSolPriceUsd();
  // each bounty rewards in its own token; raw.rewardUsd is already priced per-mint. Count
  // only priced bounties (unresolved/illiquid mints contribute 0 until they backfill).
  const rewardUsd = ranked.reduce((s, r) => s + Number((r.bounty.raw as any)?.rewardUsd || 0), 0);
  const pricedCount = ranked.filter((r) => Number((r.bounty.raw as any)?.rewardUsd) > 0).length;
  const rewardSol = solPriceUsd > 0 ? rewardUsd / solPriceUsd : 0;
  const categories = flagged.reduce<Record<string, number>>((a, r) => {
    for (const c of new Set(r.hits.map((h) => h.category))) a[c] = (a[c] ?? 0) + 1; return a;
  }, {});
  const newest = ranked.map((r) => r.bounty.createdAt).filter(Boolean).sort().at(-1);
  const moderated = ranked.filter((r) => (r.bounty.raw as any)?.removed).length;
  const condoned = flagged.filter((r) => !(r.bounty.raw as any)?.removed).length;
  const stats = { fetchedAt, total: ranked.length, flagged: flagged.length,
    rewardSol: Number(rewardSol.toFixed(3)), rewardUsd: Number(rewardUsd.toFixed(2)), solPriceUsd, newest,
    pricedCount, moderated, condoned,
    counts: flagged.reduce<Record<string, number>>((a, r) => ((a[r.tier] = (a[r.tier] ?? 0) + 1), a), {}),
    categories };
  bus.setSnapshot(flagged, stats);
  for (const r of flagged) {
    if (!before.has(r.bounty.id)) bus.emit({ type: 'flagged', scored: r }); // newly-seen & flagged
  }
  bus.emit({ type: 'pass', ts: fetchedAt, fetched: fresh.length, added: delta.added,
    updated: delta.updated, gone: delta.gone, flagged: flagged.length, total: ranked.length,
    rewardSol: stats.rewardSol, rewardUsd: stats.rewardUsd, solPriceUsd, pricedCount, moderated, condoned, counts: stats.counts, categories, newest,
    top: worst ? { score: worst.score, tier: worst.tier, rationale: worst.rationale } : null });

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

  // Start the SSE dashboard first so it's up while the (slow) browser source warms.
  if (process.argv.includes('--serve')) {
    const { startServer } = await import('./server.ts');
    startServer();
  }

  const source = await makeSource();

  const loop = process.argv.includes('--loop');
  const shutdown = async () => { await source.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await pass(store, source).catch((e) => console.error(`[reindex] first pass failed: ${(e as Error).message}`));
  if (!loop) { await source.close(); return; }

  console.log(`[reindex] looping every ${INTERVAL / 1000}s — Ctrl-C to stop`);
  for (;;) {
    await new Promise((r) => setTimeout(r, INTERVAL));
    try { await pass(store, source); } catch (e) { console.error(`[reindex] pass failed: ${(e as Error).message}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

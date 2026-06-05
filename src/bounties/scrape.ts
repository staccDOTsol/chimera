// scrape.ts — the browser arm. pump.fun bounty content is a client-rendered SPA, so a plain
// fetch returns an empty shell — you need a real browser to execute the page. This drives
// headless Chrome to read each bounty's title/description/submissions and POSTs them to the
// worker's /api/enrich. Run it repeatedly: the worker diffs against prior captures to catch
// content the moderators REMOVE after the fact (and preserves what it was).
//
//   WORKER=https://twitmolt-bounties.fly.dev BOUNTIES_ENRICH_TOKEN=… \
//     node src/bounties/scrape.ts [--limit N] [--all]
//
// Needs a Chrome binary (CHROME_PATH, default /usr/bin/google-chrome-stable) and playwright-core.

const WORKER = process.env.WORKER || 'https://twitmolt-bounties.fly.dev';
const TOKEN = process.env.BOUNTIES_ENRICH_TOKEN || '';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
const CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY || 4);
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1]) || process.env.SCRAPE_LIMIT || 0);
const RESCRAPE_ALL = process.argv.includes('--all'); // re-scrape even already-captured (for removal detection)
// ignore the sandbox's TLS-inspecting proxy cert (no effect on a clean network like Fly)
const CHROME_ARGS = ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors', '--disable-dev-shm-usage'];

interface Item { account: string; uuid?: string; url?: string; hasText: boolean }
interface Scraped { uuid: string; present: boolean; title?: string; description?: string; submissions?: { author?: string; text?: string; links?: string[] }[] }

/** Parse the rendered bounty page (runs in node from the page's title + innerText). */
function parse(uuid: string, title: string, text: string, status: number): Scraped {
  const t = title.replace(/\s*\|\s*Pump\s*$/i, '').trim();
  // "removed/never-there" signals: 404, or a page with no bounty scaffolding at all.
  const looksLikeBounty = /REWARD POOL|Submissions|Description|Submit work|Deliverables/i.test(text);
  if (status >= 400 || /doesn'?t exist|not found|page you.*looking for/i.test(text) || !looksLikeBounty) {
    return { uuid, present: false };
  }
  const desc = text.match(/Description\s+([\s\S]*?)\s+Submissions\b/i)?.[1]?.trim();
  const subsBlob = text.match(/Submissions\s+\d+\s+([\s\S]*?)\s+(?:TOTAL REWARD POOL|Time Left|Submit work)/i)?.[1] ?? '';
  const submissions = subsBlob
    .split(/\s+Share\b/).map((c) => c.trim()).filter(Boolean)
    .map((chunk) => {
      const m = chunk.match(/^(\S+)\s+·\s+[A-Za-z0-9 ,:]+?Submission\s+([\s\S]*)$/);
      const author = m?.[1];
      let body = (m?.[2] ?? chunk).replace(/\bsolscan\.io\b/g, '').replace(/\s+\d+\s*$/, '').trim();
      const links = [...chunk.matchAll(/https?:\/\/\S+/g)].map((x) => x[0]);
      return { author, text: body.slice(0, 1000), links };
    })
    .filter((s) => s.text || s.author);
  return { uuid, present: true, title: t || undefined, description: desc || undefined, submissions };
}

async function main(): Promise<void> {
  const { chromium } = await import('playwright-core');
  const list = (await (await fetch(`${WORKER}/api/bounties`)).json()) as Item[];
  let todo = list.filter((b) => b.uuid && (RESCRAPE_ALL || !b.hasText));
  if (LIMIT > 0) todo = todo.slice(0, LIMIT);
  console.log(`[scrape] ${todo.length} bounties to scrape (of ${list.length}); concurrency ${CONCURRENCY}`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149 Safari/537.36' });

  let i = 0, done = 0, removed = 0;
  const batch: Scraped[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const items = batch.splice(0);
    try {
      const r = await fetch(`${WORKER}/api/enrich?token=${encodeURIComponent(TOKEN)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) });
      const j = await r.json(); removed += j.newlyRemoved || 0;
    } catch (e) { console.error('[scrape] enrich post failed:', (e as Error).message); }
  };

  const worker = async () => {
    const page = await ctx.newPage();
    while (i < todo.length) {
      const b = todo[i++];
      const url = `https://pump.fun/go/${b.uuid}`;
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(Number(process.env.SCRAPE_SETTLE_MS || 5000));
        const title = await page.title();
        const text = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ').trim();
        batch.push(parse(b.uuid!, title, text, resp?.status() ?? 0));
      } catch (e) {
        // navigation failed entirely — treat as "not present this scrape" (could be moderated)
        batch.push({ uuid: b.uuid!, present: false });
      }
      if (++done % 10 === 0) { await flush(); console.log(`[scrape] ${done}/${todo.length} (removed-detected ${removed})`); }
    }
    await page.close();
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await flush();
  await browser.close();
  console.log(`[scrape] done: ${done} scraped, ${removed} newly detected as moderated-removed`);
}

main().catch((e) => { console.error(e); process.exit(1); });

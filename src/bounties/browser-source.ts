// browser-source.ts — a self-driving, Cloudflare-clearing bounty source.
//
// pump.fun/go is behind Cloudflare's JS challenge, which header-spoofed HTTP fetches can't
// pass. This adapter drives a REAL headless Chromium (Playwright) that executes the
// challenge like a browser, then harvests bounties two ways at once:
//   1. it intercepts every JSON network response and walks it for bounty-shaped objects
//      (so we get the live API payload without hard-coding its exact path), and
//   2. it reads window.__NEXT_DATA__ off the rendered page as a fallback.
//
// The browser context is PERSISTENT (userDataDir) and kept alive across reindex passes, so
// the Cloudflare clearance cookie (cf_clearance) and any login survive — we navigate/reload
// each pass instead of relaunching, which avoids re-triggering the challenge every time.
//
// Playwright is an OPTIONAL dependency, imported dynamically: the HTTP-only path in
// source.ts still works without it. Enable this adapter with BOUNTIES_BROWSER=1.
//
//   pnpm add -D playwright && npx playwright install chromium   # local
//   (the deploy image ships Chromium already — see Dockerfile.bounties)

import { harvestBounties, normalize } from './source.ts';
import type { Bounty } from './types.ts';

const PAGE_URL = process.env.BOUNTIES_PAGE_URL || 'https://pump.fun/go';
const USER_DATA_DIR = process.env.BOUNTIES_BROWSER_PROFILE || './data/bounties/.chromium-profile';
const NAV_TIMEOUT = Number(process.env.BOUNTIES_NAV_TIMEOUT_MS || 60_000);
// after the page settles, keep collecting late-arriving XHR for this long
const SETTLE_MS = Number(process.env.BOUNTIES_SETTLE_MS || 6_000);
const HEADFUL = process.env.BOUNTIES_HEADFUL === '1';

const UA =
  process.env.BOUNTIES_UA ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Looks like a request that might carry bounty data (keeps interception cheap). */
const LIKELY_BOUNTY_URL = /bount|\/go(\/|\b)|\/api\//i;

export class BrowserBountySource {
  // playwright types aren't imported (optional dep); kept as unknown and narrowed at use.
  private ctx: any = null;
  private page: any = null;

  async init(): Promise<void> {
    if (this.ctx) return;
    let chromium: any;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new Error(
        '[browser-source] playwright not installed. Run `pnpm add -D playwright && npx playwright install chromium`, ' +
          'or unset BOUNTIES_BROWSER to use the HTTP source.',
      );
    }
    // Persistent context so cf_clearance + session survive across passes and restarts.
    this.ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: !HEADFUL,
      userAgent: UA,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  }

  /** One harvest pass: navigate/reload, clear Cloudflare, collect bounties from XHR + DOM. */
  async fetch(): Promise<Bounty[]> {
    if (!this.page) await this.init();
    const collected: Bounty[] = [];

    const onResponse = async (res: any) => {
      try {
        const url: string = res.url();
        if (!LIKELY_BOUNTY_URL.test(url)) return;
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('json')) return;
        const body = await res.json().catch(() => null);
        if (body == null) return;
        const rows = Array.isArray(body) ? body : (body?.bounties ?? body?.data ?? body?.items ?? body);
        for (const b of harvestBounties(rows)) collected.push(b);
      } catch { /* ignore non-JSON / detached responses */ }
    };

    this.page.on('response', onResponse);
    try {
      await this.page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
      // Cloudflare interstitial often reloads itself; give the real app time to fetch.
      await this.page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
      await this.page.waitForTimeout(SETTLE_MS);

      // Fallback: read __NEXT_DATA__ off the rendered page.
      const nextData = await this.page
        .evaluate(() => {
          const el = document.getElementById('__NEXT_DATA__');
          return el?.textContent ?? null;
        })
        .catch(() => null);
      if (nextData) {
        try { for (const b of harvestBounties(JSON.parse(nextData))) collected.push(b); } catch { /* noop */ }
      }
    } finally {
      this.page.off('response', onResponse);
    }

    // dedupe by id
    const m = new Map<string, Bounty>();
    for (const b of collected) if (!m.has(b.id)) m.set(b.id, b);
    if (m.size === 0) {
      const title = await this.page.title().catch(() => '');
      console.error(`[browser-source] 0 bounties harvested (page title: "${title}"). ` +
        `Cloudflare may still be challenging, or the bounty XHR path doesn't match LIKELY_BOUNTY_URL.`);
    }
    return [...m.values()];
  }

  async close(): Promise<void> {
    try { await this.ctx?.close(); } catch { /* noop */ }
    this.ctx = this.page = null;
  }
}

// keep `normalize` referenced for callers that want the raw mapper alongside the source.
export { normalize };

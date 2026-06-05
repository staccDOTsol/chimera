// price.ts — live SOL→USD, cached 5 min, so the dashboard can value reward pools in USD.
// Coingecko is the primary feed (reachable, no key); returns the last good value on failure.

let cache = { at: 0, usd: 0 };
const TTL = 5 * 60 * 1000;

export async function getSolPriceUsd(): Promise<number> {
  if (cache.usd && Date.now() - cache.at < TTL) return cache.usd;
  const sources = [
    async () => {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      return (await r.json())?.solana?.usd as number;
    },
    async () => {
      const r = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot');
      return Number((await r.json())?.data?.amount);
    },
  ];
  for (const src of sources) {
    try {
      const v = await src();
      if (v && isFinite(v) && v > 0) { cache = { at: Date.now(), usd: v }; return v; }
    } catch { /* try next */ }
  }
  return cache.usd; // last known (or 0 on cold failure)
}

// ---- per-token USD prices (bounties reward in many different tokens, not just SOL) ----

interface TokenPrice { usdPrice: number; decimals: number }
const priceCache = new Map<string, { at: number; v: TokenPrice }>();
const PRICE_TTL = 5 * 60 * 1000;

/** USD price + decimals for a set of mints, via Jupiter (lite-api v3). Cached per-mint with
 *  a TTL; unknown/illiquid mints simply don't appear in the returned map (valued as 0). */
export async function getTokenPrices(mints: string[]): Promise<Map<string, TokenPrice>> {
  const out = new Map<string, TokenPrice>();
  const now = Date.now();
  const need: string[] = [];
  for (const m of new Set(mints)) {
    const c = priceCache.get(m);
    if (c && now - c.at < PRICE_TTL) out.set(m, c.v);
    else need.push(m);
  }
  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50);
    try {
      const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${chunk.join(',')}`);
      const j = await r.json() as Record<string, { usdPrice?: number; decimals?: number }>;
      for (const m of chunk) {
        const p = j?.[m];
        if (p && typeof p.usdPrice === 'number') {
          const v = { usdPrice: p.usdPrice, decimals: p.decimals ?? 9 };
          priceCache.set(m, { at: now, v }); out.set(m, v);
        }
      }
    } catch { /* leave this chunk unpriced this cycle */ }
  }
  return out;
}

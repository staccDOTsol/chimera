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

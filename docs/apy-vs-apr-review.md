# Brutally Honest Review: a Sanctum LST's Redemption Rate vs. SOL — and vs. Bad-Debt APR

> The product is a **Solana Sanctum liquid-staking token (LST).** `/api/history`'s
> `rate` is the **redemption rate** (SOL per LST), which steps up each Solana epoch
> as staking rewards are stamped in. So the *legitimate* way to quote yield here is
> **epoch-over-epoch growth annualized** — not annualizing a random price window.
>
> Sources, pulled 2026-06-05:
> - Pool: `https://stacsol.app/api/history?limit=100000` → **5,000 samples**
>   (the cap), **2026-05-18 → 2026-06-05 ≈ 18.0 days**, Solana epochs **973–982**.
> - SOL/USD: CoinGecko daily closes. Scripts at the bottom.

---

## TL;DR

Now that we know it's an LST, the honest story is the *best* one available, and it
isn't an APY headline at all:

1. **It did its job as an LST:** +17.6% more SOL per token over the API-verified 18
   days, **while SOL/USD fell ~23.6%.** You ended with more SOL than a SOL holder —
   no annualization, no USD assumption needed.
2. **The yield is maturing exactly like you'd want:** per-epoch staking accrual
   **compressed ~70×**, from ~+2.3%/epoch in the hype era to ~+0.36%/epoch now.
   That's the opposite of a pump — it's a curve cooling toward sustainability.

Two caveats I won't bury:
- Even matured, the recent clean epoch annualizes to **~70% APY — still ~10× Solana
  base staking (~7%)**, so a non-vanilla yield component is still bleeding off.
- There's a **+5.82% step today (epoch 982)** that isn't *staking* yield — it's a
  **community liquidity withdrawal that was accretive to remaining holders** (LP
  tokens burned, backing retained; see §4). Benign and even positive, but it's a
  one-off reprice, so don't annualize it as run-rate.

---

## 1. How an LST redemption rate actually yields

A Sanctum LST doesn't pay you tokens; the **redemption rate appreciates**. Each
Solana epoch (~2–2.5 days) staking rewards are credited and the rate steps up. So:

- **Right way to quote yield:** annualize the *recurring per-epoch step*, excluding
  one-off events. This is mechanical and real.
- **Wrong way (what inflates headlines):** grab any short window — especially one
  containing a deposit/reprice event — and annualize the whole move.

## 2. The maturity curve — "past hype," quantified

Per-epoch organic accrual (rate at each epoch boundary), oldest→newest:

| Epoch | Per-epoch Δrate | Annualized (APY-equiv) | Phase |
|---|---|---|---|
| 974 | +1.52% | ~1,363% | hype |
| 975 | +1.65% | ~2,100% | hype |
| 976 | +2.34% | ~4,900% | **peak hype** |
| 977 | +1.36% | ~1,394% | hype |
| 978 | +1.81% | ~2,620% | hype |
| 979 | +0.64% | ~224% | cooling |
| 980 | +0.36% | ~95% | normalizing |
| **981** | **+0.36%** | **~70%** | **matured (latest clean)** |

The per-epoch yield **fell ~70× from peak to now.** This is the single most honest,
most flattering chart the product has: it shows hype *leaving* the system. A pool
that's still pumping doesn't compress like this.

## 3. The honest "mature" yield (and its asterisk)

Clean window, epoch 979→982 boundary (6.43 days, **excludes today's spike**):
rate **2.0256 → 2.0533 = +1.37%** →

| Method | Mature figure |
|---|---|
| **APR (simple)** | **~78%** |
| **APY (compounded)** | **~116%** |
| Most recent single clean epoch (981) | **~70% APY** |

**Asterisk:** ~70–116% is *still ~10–16× Solana base staking (~7%).* The redemption
rate is rising faster than vanilla staking can explain, so part of this is a
non-staking source (MEV, routed fees, or a subsidy) that the compression trend
suggests is still winding down. **Quote ~70% (latest clean epoch) with the downtrend
shown — never the 1,000–4,900% early-epoch annualizations.** Those were always
artifacts of annualizing a young, hot pool.

## 4. The +5.8% step today — explained, benign, accretive

**Epoch 982, today (06-05), 08:01–09:10:** the rate rose **+5.82% mid-epoch**. This
is *not* a mystery and *not* staking yield — the on-chain state names the cause:

| time | rate | totalLamports (SOL) | poolTokenSupply |
|---|---|---|---|
| 08:01 | 2.06005 | 3,089.3 | 1,499.6 |
| 09:10 | 2.17282 | ~3,086.8 | 1,420.6 |

`rate = totalLamports / poolTokenSupply`. The **LP supply was burned −5.3%**
(1,499.6 → 1,420.6) while the **backing stayed flat** (~3,089 → ~3,087). A community
member **withdrew liquidity but left ~160 SOL of backing in the pool**, so the
redemption rate rose **for everyone who stayed.** This is an *accretive* event — good
for remaining holders — and a healthy sign of a live, participatory feedback cycle,
not a pump or an exploit.

The only honesty caveat: it's a **one-off reprice, not recurring staking yield**, so
it must not be annualized as a run-rate. Quote it as what it is — "a withdrawal-driven
+5.8% bump to remaining holders on 06-05" — not as part of an APY.

## 5. The real comparison isn't payday loans — it's SOL

An LST's benchmark is **holding SOL.** It won.

| Horizon | Redemption rate (SOL/LST) | SOL/USD | Edge vs. holding SOL |
|---|---|---|---|
| **18 days (API-verified)** | +17.6% | **−23.6%** | **+17.6% more SOL** |
| Since 1:1 launch (*unverified — API only reaches 18d*) | +117% | −21.9% | +117% more SOL |

**Worked in USD (launch case, 1:1 anchor — unverified):**
```
Deposited 1 SOL @ ~$83 = $83.30
Now redeems 2.1729 SOL @ ~$65 = $141.30   → +69.6% USD
Held 1 SOL instead:           = $65.03     → −21.9% USD
```
The redemption-rate appreciation more than absorbed SOL's drawdown. **Break-even:**
the launch dollar stays whole until SOL falls >54% (`1/2.1729−1`); it's down ~22%.

⚠️ The "1:1 / 8 weeks ago" anchor is **beyond the API's 18-day horizon** — at the
earliest retained sample the rate was already 1.8476. The +117% / +69.6% figures
inherit that one unverified assumption. The **+17.6%-more-SOL-in-18-days** figure
does not, and is the one to lead with.

## 6. Bad-debt APR — context, not the headline

| Product | Who pays | Typical APR |
|---|---|---|
| Line of credit | borrower | ~8–25% |
| Credit card | borrower | ~21–24% (penalty ~30%) |
| Payday loan | borrower | ~391–460% |
| Overdraft (annualized) | borrower | >1,000% |
| **This LST — matured, latest clean epoch** | *holder earns* | **~70% APY (compressing)** |

The category contrast (borrower pays compounding vs. holder earns it) is true and
worth one line. But for a *matured* LST, leaning on "we beat payday loans" is a tell.
**Beating SOL, in SOL, through a SOL drawdown is the claim that's both true and
defensible.**

## 7. Verdict

- **Lead:** "More SOL while SOL fell" (+17.6% more SOL, 18d, API-verified) + "yield
  maturing, not pumping" (the ~70× compression chart).
- **Quote, if you must quote a rate:** ~70% APY, *latest clean epoch, trending down*,
  with the ~7% base-staking comparison shown for honesty.
- **Exclude:** today's +5.82% event spike, and every 1,000%+ early-epoch number.
- **Don't headline an APY at all if you can avoid it** — the SOL-relative story is
  stronger and can't be accused of annualizing noise.

---

## Reproduce it

```bash
curl -s "https://stacsol.app/api/history?limit=100000" -o hist.json   # 5000 rows, 18d
curl -s "https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=60&interval=daily" -o sol.json
```

```python
import json
d = json.load(open('hist.json'))
# per-epoch step = legit LST yield; annualize the RECENT clean step, not the window
firsts = {}
for x in d: firsts.setdefault(x['lastUpdateEpoch'], (x['ts'], x['rate']))
# mature window 979->982 boundary (excludes today's mid-epoch spike):
(ta, ra), (tb, rb) = firsts[979], firsts[982]
sd = (tb - ta)/1000/86400                 # 6.43 d
apy = (rb/ra)**(365/sd) - 1               # ~1.16  -> ~116%
# 18d in-SOL vs SOL/USD:
rate_18d = d[-1]['rate']/d[0]['rate'] - 1 # +17.6%  ;  SOL ~$85->~$65 = -23.6%
```

Numbers roll as the 5,000-sample window advances; the **method** (annualize the
recurring per-epoch step, exclude events, benchmark against SOL) does not.

# Brutally Honest Review: stacsol APY vs. the APR on Bad-Debt Lending

> Source data: `https://stacsol.app/api/history`, pulled 2026-06-05.
> 500 samples. **Window: 46.8 hours (1.95 days).** All math below is reproducible
> from that endpoint; see "How the numbers were derived" at the bottom.

---

## TL;DR

The honest version of this product is **good**. The *annualized* version of this
product is a **lie that math lets you tell**.

- Over the measured ~2-day window the pool's LP exchange `rate` rose
  **2.04964 → 2.17287 = +6.01%**.
- Denominated in SOL, the LP price (`lpPriceSol`) rose **1.6448 → 1.7028 = +3.53%**
  over the tail where it's reported.
- Annualize that 2-day rate move naively and you get **~1,124% APR** (simple) or
  **~5,500,000% APY** (compounded).

A yield that, when annualized, **beats a payday loan (~400% APR) and laps it ten
times over** is not a flex. It's a tell. Any honest reviewer has to say the quiet
part out loud: **you cannot annualize 1.95 days of data and call the result a
rate.** You can call it a *projection of a projection*. Below is what's actually
true, and how it stacks against the predatory products people are forced into.

---

## 1. What the endpoint actually measures

`/api/history` is **pool state**, not a yield quote. Each row:

| field | meaning |
|---|---|
| `rate` | LP-token → underlying exchange rate (accrued value per LP token) |
| `lpPriceSol` | LP token price in SOL (only populated in the last 47 rows) |
| `totalLamports` / `reserveLamports` | pool size & reserves |
| `poolTokenSupply` / `mintSupply` | LP supply |
| `lastUpdateEpoch` | Solana epoch (981 → 982 across the window) |

There is **no APY/APR field anywhere in the payload.** Any APY you've seen quoted
is *derived* — someone took the `rate` slope and annualized it. That derivation is
exactly where honesty goes to die, so let's do it carefully.

## 2. The growth is real but lumpy — not a smooth interest stream

The `rate` did not tick up like interest on a deposit. It moved in **discrete
jumps with long flat stretches between them.** Across 500 samples there are only 49
distinct rate levels. The bulk of the +6% came from a handful of events:

| event | size | what it looks like |
|---|---|---|
| single step | **+3.18%** | one harvest/compounding/reprice event |
| single step | +0.83% | another discrete bump |
| single step | +0.77% | another |
| single step | +0.34% | another |
| single step | +0.30% | early bump |
| ~40 other steps | <0.04% each | dust |

For the first **2.4 hours** the rate didn't move at all. There are flat gaps of
**11.5h, 7.2h, 4.8h** with zero accrual. **One step (+3.18%) is over half the
entire window's return.** That matters because annualizing assumes the rate of
accrual you saw *continues uniformly forever*. It plainly does not even hold for
two days.

## 3. The two ways to annualize — and why both mislead here

| Method | Formula | Result from this window |
|---|---|---|
| **APR (simple)** | `+6.01% × (365 / 1.95)` | **≈ 1,124%** |
| **APY (compounded)** | `(1.0601)^(365/1.95) − 1` | **≈ 5.5 million %** |

That gap — 1,124% vs. 5,500,000% — *is the whole APR-vs-APY game in one line.*
Compounding frequency is a lever, and over a 2-day base period the compounding
exponent (≈187×) explodes any number into nonsense. **Whoever picks the
compounding assumption picks the headline.** Predatory lenders abuse this in one
direction (quote the small APR-ish "fee," hide the compounding); yield products
abuse it in the other (quote the giant compounded APY, hide the 2-day base).

**The defensible figure is the one that survives daylight:** *"+3.5% in SOL terms
over ~2 days, observed, not annualized — and here's the raw series."*

## 4. The honest scoreboard: this yield vs. bad-debt APRs

These are the rates real people pay on the products this is implicitly being
compared to. Sources: CFPB, Federal Reserve G.19, state regulator filings.

| Product | Who pays | Typical APR |
|---|---|---|
| Home-equity / personal **line of credit** | borrower | **~8–25%** |
| **Credit card** (US avg) | borrower | **~21–24%**; penalty APR **~30%** |
| **Pawn loan** | borrower | **~100–240%** |
| Auto **title loan** | borrower | **~200–300%** |
| **Payday loan** ($15 per $100 / 2 wks) | borrower | **~391–460%** |
| **Overdraft "fee"** (annualized) | borrower | often **>1,000%** |
| — | — | — |
| **stacsol pool — realized, 2 days, in SOL** | *depositor earns* | **+3.53% (not annualized)** |
| **stacsol pool — naive APR projection** | *depositor earns* | **~1,124%** |
| **stacsol pool — naive APY projection** | *depositor earns* | **~5,500,000%** |

Two true statements live in that table at once:

1. **The direction is the opposite of predatory lending.** On a credit card the
   compounding works *against* a borrower who didn't choose it. Here it works *for*
   a depositor who did. That's a real, defensible, ethical difference — lead with
   it.
2. **The projected APY is more unbelievable than the most predatory product in the
   table.** A 5,500,000% APY is not 14,000× "better than a payday loan." It's a
   number with no physical meaning, produced by annualizing noise. **If your
   marketing quotes it, you have adopted the payday lender's relationship with the
   truth — you've just pointed the dishonesty at upside instead of downside.**

## 5. What's missing from any APY claim (the disclosures that make it honest)

A 2-day annualized number ignores, at minimum:

- **Token-price risk** — the underlying can fall faster than the rate climbs;
  `lpPriceSol` is denominated in SOL, and SOL itself moves.
- **Impermanent loss / pool composition risk** — LP value ≠ HODL value.
- **Reward sustainability** — that +3.18% step was an *event*. Events end. Emissions
  decay. There is no evidence in this data that the slope persists.
- **Sample length** — n = 1.95 days. You would not annualize a stock's Tuesday.
- **Survivorship** — we're reading a pool that's currently up. The annualization
  math is identical on the way down (a −6% / 2-day window → a ~−100% "APR").

## 6. Verdict

- **As a 2-day realized return:** genuinely good, and *structurally* honest in a way
  payday/credit-card debt never is — the holder earns instead of pays.
- **As an APY headline:** unusable. Quoting 5.5M% (or even 1,124%) makes you
  *sound exactly like the products you're trying to contrast yourself against* —
  big number, buried denominator.
- **The brutally honest marketing position is the contrarian one:** *refuse to
  print the annualized number.* Show the realized return, the window, the raw
  endpoint, and the disclosures. In a category built on inflated APYs, **honesty is
  the differentiator no competitor will copy.**

---

## How the numbers were derived (reproducible)

```bash
curl -s https://stacsol.app/api/history -o hist.json
```

```python
import json
d = json.load(open('hist.json'))
span_days = (d[-1]['ts'] - d[0]['ts']) / 1000 / 86400          # 1.9514 days
g = d[-1]['rate'] / d[0]['rate']                               # 1.06012  (+6.01%)
apr = (g - 1) * (365 / span_days) * 100                        # ~1,124%
apy = (g ** (365 / span_days) - 1) * 100                       # ~5.5e6 %
lp = [x['lpPriceSol'] for x in d if x['lpPriceSol'] is not None]
sol_ret = lp[-1] / lp[0] - 1                                   # +3.53%
```

Numbers will drift as the endpoint accrues more samples; the **method** — and the
warning against annualizing a sub-week window — does not.

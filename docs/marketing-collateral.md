# Honest Marketing Collateral — stacsol

> Design rule for everything below: **we never print an annualized number we can't
> defend in daylight.** Every figure traces to `https://stacsol.app/api/history`.
> Realized return, stated window, raw data linked. That refusal *is* the brand.
>
> (Receipts and the math behind every claim: `docs/apy-vs-apr-review.md`.)

---

## The positioning, in one sentence

**Every other yield product shows you a number. We show you the data.**

In a category where the headline APY is whatever you set the compounding slider to,
the honest move is the loud one: publish the window, publish the realized return,
link the endpoint, and let people annualize it themselves if they insist.

---

## Hero options (pick one)

**A — the contrast play**
> **A payday loan charges ~400% APR. A credit card, ~22%.**
> We won't quote you an APY at all — here's the realized return and the raw data
> instead.
> `+3.5% in SOL over ~2 days, observed. Annualize it yourself; we won't pretend it's a rate.`

**B — the receipts play**
> **No magic APY. Just an endpoint.**
> `stacsol.app/api/history` — every sample, every timestamp, every rate. Audit us
> before you trust us.

**C — the inversion play**
> **Compound interest, pointed the other way.**
> On a credit card, compounding is the thing working against you at 22–30%.
> Here you're the one holding the LP token.

---

## The honesty table (use verbatim — it's the centerpiece)

| | Who pays | The rate they quote | The rate you actually feel |
|---|---|---|---|
| Payday loan | you | "$15 per $100" | **~391% APR** |
| Credit card | you | "low monthly minimum" | **~22% APR**, ~30% penalty |
| Overdraft | you | "a $35 fee" | **>1,000% APR** annualized |
| **stacsol** | **you earn** | **we refuse to headline an APY** | **+3.5% / ~2 days, in SOL, on-chain, verifiable** |

Footnote, always attached:
> *Predatory lenders hide a huge APR behind a small fee. Inflated DeFi hides a
> small window behind a huge APY. Same trick, opposite direction. We do neither.*

---

## Approved claims ✅ vs. banned claims 🚫

**✅ Say these:**
- "Realized **+3.5% in SOL over ~2 days** (1,460+ samples, 46.8h, on-chain)."
- "**Verify before you trust:** the full history is a public GET request."
- "Your LP token's value rose against SOL over the measured window."
- "Past pool performance does not predict future performance."
- "When we *do* annualize, we'll show a trailing ≥30-day window and label it a
  projection."

**🚫 Never say these:**
- ❌ "**5,500,000% APY**" — true arithmetic, false impression. This is the line.
- ❌ "**1,124% APR**" — annualizing 2 days of data; physically meaningless.
- ❌ "Guaranteed / risk-free / stable yield."
- ❌ "Better than a payday loan" framed as upside (it's a *warning sign* that the
  annualized figure even gets there — never spin it as a brag).
- ❌ Any APY with the base window, compounding assumption, or risks omitted.

---

## The disclosure block (ship it under every yield figure)

> **Read this before you deposit.**
> The figure above is a **realized return over a stated, short window** — not a
> promised rate. It is **not annualized.** Yield came in discrete events
> (one +3.18% step was over half the window's return); past events don't repeat on
> schedule. Your position carries **token-price risk** (SOL and the underlying
> move), **impermanent loss**, and **emission-decay** risk. You can lose principal.
> Don't deposit money you can't afford to lose. **Verify everything:**
> `stacsol.app/api/history`.

---

## Social / short-form

**Thread hook**
> Most DeFi sells you a number.
> Payday lenders sell you a fee.
> Both are hiding a denominator.
> 🧵 on why we publish the raw endpoint instead 👇

**One-liner**
> We could quote you a 5,500,000% APY. The math even supports it. That's exactly why
> we won't.

**Comparison card (alt text + caption)**
> Payday loan: ~391% APR, you pay. stacsol: +3.5%/2d in SOL, you earn, fully
> on-chain. One of these hides the math. It isn't us.

---

## FAQ (the honest answers)

**"What's the APY?"**
> We don't headline one. Over the last ~2 days the pool returned +3.5% in SOL terms.
> If you annualize a 2-day window you can produce anything from 1,000% to several
> million percent depending on how you compound — which is exactly why those numbers
> are useless. Pull `stacsol.app/api/history` and check our work.

**"So is it safe?"**
> No yield is risk-free, and anyone who tells you otherwise is selling. You hold an
> LP token exposed to SOL price, the underlying asset, and reward sustainability.
> The upside: unlike a credit card or payday loan, the compounding is on *your* side
> of the ledger.

**"Why won't you just give me a big number like everyone else?"**
> Because the big number is how you got hurt last time. The whole pitch is that we'd
> rather lose the click than lie for it.

---

## Why this strategy actually wins

Honesty here isn't a compliance tax — it's the **moat**. Competitors *can't* match
"+3.5%, ~2 days, here's the endpoint" without surrendering their inflated headline
APYs, and they won't. The audience that's been burned by both predatory lenders
*and* rug-pull yields is large, loud, and starved for a product that treats them
like adults. **Be the one that does.**

# stacsol carry-trade lander

A single, self-contained, dependency-free static page (`index.html`) — the honest
APR-vs-APY carry-trade infographic for the stacsol Sanctum LST. No build step.

## Deploy on Vercel

**Option 1 — its own repo (what you asked for):**
1. Create an empty repo on GitHub (e.g. `stacsol-carry-lander`).
2. Copy `index.html` and `METHODOLOGY.md` from this folder into it (drag-and-drop in
   the GitHub UI works).
3. In Vercel: **New Project → import that repo → Framework Preset: Other → Deploy.**
   No build command, no output dir — Vercel serves `index.html` at `/`.

**Option 2 — no new repo, deploy this subfolder:**
In Vercel, import `staccDOTsol/chimera` and set **Root Directory = `lander`**. Deploys
the same page without splitting anything out.

## What it claims (and the honesty guardrails)

Numbers are baked in (static) and reproducible from `stacsol.app/api/history` +
CoinGecko SOL/USD — see `METHODOLOGY.md`. The page deliberately shows the *edges* of
the carry thesis (slam-dunk vs. cards/loans, coin-flip vs. payday) and a prominent
"how this wrecks you" risk panel. It is marketing, not financial advice.

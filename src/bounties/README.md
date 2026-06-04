# pump.fun bounty abuse-monitor

Indexes the **go.pump.fun "bounties"** feature (shipped 2026-06-04), classifies every
bounty for real-world harm, and ranks the **most egregious first** — so abusive bounties
can be **documented and reported** before the platform quietly deletes them.

This is an **accountability artifact**, not a participation tool. People *named as targets*
inside a harmful bounty are treated as **victims**: the indexer captures the bounty (and the
window it was live) as evidence; it does **not** locate, contact, enrich, or further expose
the target. Use the output to report to platform Trust & Safety and — where the content
warrants — NCMEC, FBI IC3, or UK Action Fraud.

## Run

```bash
# one pass → writes data/bounties/report.md (+ index.json evidence store)
pnpm bounties

# reindex forever, capturing newly-posted bounties even if deleted minutes later
pnpm bounties:loop          # interval = BOUNTIES_INTERVAL_SEC (default 120s)

# also emit machine-readable scored.json
node src/bounties/reindex.ts --once --json
```

> Requires Node ≥ 23.6 (native TS). On Node 22 use `node --experimental-strip-types …`.

## Configuring the source (important)

The bounty endpoints sit behind Cloudflare, so the live JSON schema isn't pinned. The
fetcher (`source.ts`) tries a JSON API first, then falls back to scraping the page's
`__NEXT_DATA__`. Point it at the confirmed endpoint and, if needed, pass a browser session
to clear the bot challenge:

| env | default | purpose |
|---|---|---|
| `BOUNTIES_API_URL` | `https://go.pump.fun/api/bounties` | confirmed JSON endpoint |
| `BOUNTIES_PAGE_URL` | `https://go.pump.fun/bounties` | HTML fallback for `__NEXT_DATA__` |
| `BOUNTIES_COOKIE` | – | cookie header from a logged-in browser, if challenged |
| `BOUNTIES_UA` | Chrome UA | override user-agent |
| `BOUNTIES_INTERVAL_SEC` | `120` | reindex cadence in `--loop` |
| `BOUNTIES_OUT_DIR` | `./data/bounties` | report + evidence store location |

`normalize()` maps unknown JSON onto the `Bounty` type by field-name heuristics; once you
confirm the real shape, tighten it — nothing else in the pipeline changes.

## How "egregious" is scored

`score.ts` is a transparent, deterministic rubric — a weighted **max** over harm categories
(the worst single ask dominates the rank), plus a boost when a **specific named person** is
the target. Categories, highest severity first:

| category | base | escalates to |
|---|--:|---|
| `csam_or_minor_sexual` | 100 | NCMEC CyberTipline |
| `violence_solicitation` | 95 | law enforcement, FBI IC3 |
| `targeted_threat` | 88 | law enforcement, warn the target |
| `doxxing_pii` | 80 | platform T&S, ICO |
| `sexual_exploitation` | 78 | StopNCII.org, law enforcement |
| `self_harm` | 70 | platform T&S, crisis line |
| `hate_protected` | 60 | hate-crime reporting |
| `property_or_fraud_crime` | 55 | Action Fraud / IC3 |
| `harassment_named` | 62 | platform T&S |

Tiers: **CRITICAL** ≥90 · **HIGH** ≥70 · **MEDIUM** ≥45 · **LOW** ≥20 · **BENIGN** <20.
The rubric is intentionally conservative (prefers over-flagging the top tiers for human
review). Tune weights/patterns in `score.ts`; every match keeps its evidence snippet so a
human can verify before reporting.

## Files

- `types.ts` — shared shapes
- `source.ts` — schema-tolerant fetcher (API + `__NEXT_DATA__` fallback, paginated)
- `score.ts` — the egregiousness rubric
- `store.ts` — JSON evidence store (firstSeen/lastSeen, retains deleted bounties)
- `report.ts` — ranked markdown renderer
- `reindex.ts` — the fetch → upsert → score → report loop

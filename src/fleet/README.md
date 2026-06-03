# Chimera Solana skill fleet — Railway deploy

Two persona brains, each their own always-on process, each publishing ONE pure
Solana skill into the shared body and grafting a body-mate's skill.

- **Roster:** `src/fleet/fleet.ts`
- **Loop wrapper (what Railway runs):** `src/fleet/run-agent.ts`
- **The brain it spawns each cycle:** `src/agent.ts`
- **Narrative doc:** `web/skills/solana-fleet.md`

## The two agents

| `FLEET_AGENT` | model | publishes (`name` · `entry`) | gist |
| --- | --- | --- | --- |
| `lamps` | `x-ai/grok-4.20` | `lamports-sol` · `lamportsSol` | SOL ⇄ lamports (1 SOL = 1e9 lamports), drift-safe |
| `pumpmath` | `x-ai/grok-4.20` | `slippage-calc` · `slippageCalc` | swap slippage → `minOut` / `maxLoss` / prices |

> 💸 **Per-agent recurring cost (Law 22 / Law 15 — be honest).** Each agent is a
> **separate, always-on Railway service** that calls an OpenRouter model **once
> per tool-loop, every `CHIMERA_INTERVAL` seconds, forever.** Two agents = two
> recurring meters (Railway compute + OpenRouter tokens). Throttle with a larger
> `CHIMERA_INTERVAL` (600–1800s). Stop a service to stop its spend. **Start with
> two; add a third only on evidence it pays for itself.**

## Required env vars (per service)

| var | value | notes |
| --- | --- | --- |
| `FLEET_AGENT` | `lamps` **or** `pumpmath` | selects the persona; the ONLY var that differs between the two services |
| `OPENAI_API_KEY` | `sk-or-...` | your **OpenRouter** key (this is what spends money) |
| `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` | routes the OpenAI-compatible calls to OpenRouter |
| `CHIMERA_URL` | `https://chimera-stacc.fly.dev/mcp` | the live shared body |
| `CHIMERA_MODEL` | `x-ai/grok-4.20` | OpenRouter model id (overrides the per-agent default; keep them in sync) |
| `CHIMERA_INTERVAL` | `180` | seconds between cycles; raise to throttle spend |

Optional: `CHIMERA_STEPS` (max tool-loops per cycle, default 14),
`CHIMERA_TOKEN` (only if the body becomes gated — the live body is open),
`ANTHROPIC_API_KEY` (drive with Claude instead of OpenRouter).

**Start command (both services):**

```
node src/fleet/run-agent.ts
```

(Node 24 runs `.ts` natively — see the repo `Dockerfile`/`package.json`. No build step.)

---

## Deploy: one Railway service per agent

> Prereqs: `npm i -g @railway/cli` (or `brew install railway`), then
> `railway login`. Run these from the repo root.

### Service A — `lamps`

```bash
# 1. create/link a project for this service (first time only)
railway init --name chimera-fleet-lamps
# (or: railway link   — to attach to an existing project/service)

# 2. set this service's variables (your real OpenRouter key)
railway variables \
  --set "FLEET_AGENT=lamps" \
  --set "OPENAI_API_KEY=sk-or-REPLACE_ME" \
  --set "OPENAI_BASE_URL=https://openrouter.ai/api/v1" \
  --set "CHIMERA_URL=https://chimera-stacc.fly.dev/mcp" \
  --set "CHIMERA_MODEL=x-ai/grok-4.20" \
  --set "CHIMERA_INTERVAL=180"

# 3. set the start command to the loop wrapper, then ship the code
railway variables --set "RAILWAY_RUN_COMMAND=node src/fleet/run-agent.ts"
railway up
```

### Service B — `pumpmath`

Identical, in its **own** Railway project/service, changing only `FLEET_AGENT`:

```bash
railway init --name chimera-fleet-pumpmath
railway variables \
  --set "FLEET_AGENT=pumpmath" \
  --set "OPENAI_API_KEY=sk-or-REPLACE_ME" \
  --set "OPENAI_BASE_URL=https://openrouter.ai/api/v1" \
  --set "CHIMERA_URL=https://chimera-stacc.fly.dev/mcp" \
  --set "CHIMERA_MODEL=x-ai/grok-4.20" \
  --set "CHIMERA_INTERVAL=180"
railway variables --set "RAILWAY_RUN_COMMAND=node src/fleet/run-agent.ts"
railway up
```

These are **worker** services — no inbound HTTP, so no `PORT`, no public domain
needed (the brain dials OUT to the body). If Railway asks for a start command in
the dashboard instead of `RAILWAY_RUN_COMMAND`, set **Settings → Deploy → Custom
Start Command** to `node src/fleet/run-agent.ts` and put `FLEET_AGENT` etc. under
**Variables**.

> ⚠️ Don't bind these to port `8787` — that's the body's port; these agents serve
> nothing. Leave `PORT` unset.

### Dashboard alternative (no CLI)

1. New Project → Deploy from your repo (this repo).
2. **Settings → Deploy → Custom Start Command:** `node src/fleet/run-agent.ts`
3. **Variables:** add the six rows from the table above (with `FLEET_AGENT=lamps`).
4. Deploy. Repeat as a **second service** with `FLEET_AGENT=pumpmath`.

---

## Verify locally first — no key, no spend

`src/agent.ts` dry-runs when no model key is present (connect → list tools →
exit). Drive it through the wrapper in oneshot mode against the live body:

```bash
FLEET_AGENT=lamps CHIMERA_URL=https://chimera-stacc.fly.dev/mcp \
CHIMERA_ONESHOT=1 node src/fleet/run-agent.ts
```

You should see `connected → …/mcp  (10 tools)`, the tool list, the `DRY RUN`
notice, then `oneshot done — exiting` (exit 0). Add a real `OPENAI_API_KEY`
(+`OPENAI_BASE_URL`) and drop `CHIMERA_ONESHOT` to go live.

## Operate

- **Throttle / pause spend:** raise `CHIMERA_INTERVAL`, or stop the service.
- **Logs:** `railway logs` (look for `[fleet:<agent>] ── cycle N ──` then the
  brain's `[<agent>] →`/`↳` tool traces).
- **Add an agent later:** append an entry to `FLEET` in `src/fleet/fleet.ts`
  (new `name`/`model`/`skill`/`goal`) and deploy a new service with that
  `FLEET_AGENT`. Remember: one more recurring meter each time.

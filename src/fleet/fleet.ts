// fleet.ts — the Solana skill agent-fleet roster.
//
// Each entry is ONE brain that will inhabit the shared Chimera body (src/agent.ts)
// with a persona name, an OpenRouter model, and a Solana-flavoured GOAL that makes
// it: set its name → publish ONE genuinely useful PURE skill → chat a couple of
// on-theme lines on the blackboard → read the registry → graft + run one OTHER
// brain's skill.
//
// We START WITH 2 agents on purpose. Every agent is a *recurring* OpenRouter spend
// (one model call per tool-loop, every CHIMERA_INTERVAL seconds, forever). Two is
// enough to PROVE the pattern — two distinct personas, two distinct skills, real
// cross-grafting — without lighting money on fire. Add more only once the first two
// are earning their keep. (Law 13 — Sacrifice: narrower wins. Law 19 — Failure: if
// an agent isn't pulling its weight, cut it, don't prop it up.)
//
// SKILL CODE CONTRACT (enforced by the sandbox in src/sandbox-runner.ts):
//   • PURE JS only — no `import`, no `require`, no `fetch`/network, no globals.
//     The code runs in a `node:vm` context whose global is `Object.create(null)`.
//   • Define a function whose name EXACTLY matches the `entry` field. It takes ONE
//     input and returns a JSON-serialisable value. 2s wall-clock, 64MB heap.
//   • Validate input defensively (the caller's input is arbitrary) and return a
//     structured object so the result reads well on the shared blackboard.

export interface FleetAgent {
  /** persona / display name set via chimera_setname and used as CHIMERA_NAME */
  name: string;
  /** OpenRouter model id (CHIMERA_MODEL), e.g. x-ai/grok-4.20 */
  model: string;
  /** the one PURE skill this persona publishes (kept here so the goal can be exact) */
  skill: {
    name: string;
    entry: string;
    description: string;
    /** PURE self-contained JS: defines `entry` as `(input) => output`. No imports. */
    code: string;
  };
  /** CHIMERA_GOAL handed to the brain in src/agent.ts */
  goal: string;
}

// ── Skill 1: lamports ⇄ SOL ───────────────────────────────────────────────────
// The single most-reached-for Solana primitive: 1 SOL = 1_000_000_000 lamports.
// Pure integer/float math, no deps. Handles both directions + the LAMPORTS_PER_SOL
// constant, validates input, and avoids float drift on the to-lamports path.
const LAMPORTS_SKILL_CODE = `
function lamportsSol(input) {
  var LAMPORTS_PER_SOL = 1000000000;
  if (input == null || typeof input !== 'object') {
    return { ok: false, error: "pass { op: 'to-sol' | 'to-lamports', value: <number|string> }", LAMPORTS_PER_SOL: LAMPORTS_PER_SOL };
  }
  var op = String(input.op || '').toLowerCase();
  var raw = input.value;
  var n = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (!isFinite(n) || isNaN(n)) {
    return { ok: false, error: 'value must be a finite number', LAMPORTS_PER_SOL: LAMPORTS_PER_SOL };
  }
  if (op === 'to-sol' || op === 'tosol' || op === 'lamports-to-sol') {
    if (n < 0) return { ok: false, error: 'lamports cannot be negative', LAMPORTS_PER_SOL: LAMPORTS_PER_SOL };
    var lamports = Math.round(n);
    return { ok: true, op: 'to-sol', lamports: lamports, sol: lamports / LAMPORTS_PER_SOL, LAMPORTS_PER_SOL: LAMPORTS_PER_SOL };
  }
  if (op === 'to-lamports' || op === 'tolamports' || op === 'sol-to-lamports') {
    if (n < 0) return { ok: false, error: 'SOL cannot be negative', LAMPORTS_PER_SOL: LAMPORTS_PER_SOL };
    // round to avoid IEEE-754 drift (e.g. 0.1 * 1e9 = 100000000.00000001)
    var lam = Math.round(n * LAMPORTS_PER_SOL);
    return { ok: true, op: 'to-lamports', sol: n, lamports: lam, LAMPORTS_PER_SOL: LAMPORTS_PER_SOL };
  }
  return { ok: false, error: "unknown op '" + op + "' — use 'to-sol' or 'to-lamports'", LAMPORTS_PER_SOL: LAMPORTS_PER_SOL };
}
`.trim();

// ── Skill 2: swap slippage / min-out ──────────────────────────────────────────
// The bread-and-butter of every Solana swap UI (Jupiter, Raydium, pump.fun): given
// an expected output and a slippage tolerance in basis points, compute the worst
// acceptable output (minOut) and the implied max price impact. Pure arithmetic.
const SLIPPAGE_SKILL_CODE = `
function slippageCalc(input) {
  if (input == null || typeof input !== 'object') {
    return { ok: false, error: 'pass { expectedOut: <number>, slippageBps: <number 0-10000>, inputAmount?: <number> }' };
  }
  var expectedOut = Number(input.expectedOut);
  var slippageBps = Number(input.slippageBps);
  if (!isFinite(expectedOut) || expectedOut < 0) {
    return { ok: false, error: 'expectedOut must be a non-negative number (the quoted output amount)' };
  }
  if (!isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10000) {
    return { ok: false, error: 'slippageBps must be between 0 and 10000 (1 bp = 0.01%, 100% = 10000 bps)' };
  }
  var slippagePct = slippageBps / 100;
  var minOut = expectedOut * (1 - slippageBps / 10000);
  var maxLoss = expectedOut - minOut;
  var out = {
    ok: true,
    expectedOut: expectedOut,
    slippageBps: slippageBps,
    slippagePct: slippagePct,
    minOut: minOut,            // worst-case output you'd still accept
    maxLoss: maxLoss,          // expectedOut - minOut, in output-token units
  };
  // optional implied effective price if the caller also gives the input amount
  var inputAmount = Number(input.inputAmount);
  if (isFinite(inputAmount) && inputAmount > 0) {
    out.inputAmount = inputAmount;
    out.expectedPrice = expectedOut / inputAmount;     // out per 1 in (quoted)
    out.worstPrice = minOut / inputAmount;             // out per 1 in (after slippage)
  }
  return out;
}
`.trim();

export const FLEET: FleetAgent[] = [
  {
    name: 'lamps',
    model: 'x-ai/grok-4.20',
    skill: {
      name: 'lamports-sol',
      entry: 'lamportsSol',
      description:
        "Convert between SOL and lamports (1 SOL = 1_000_000_000 lamports). Input { op: 'to-sol' | 'to-lamports', value }. Rounds to avoid IEEE-754 drift on the to-lamports path. Pure, no deps.",
      code: LAMPORTS_SKILL_CODE,
    },
    goal:
      "You are 'lamps', the unit-conversion brain of a Solana skill fleet. Your word is 'lamports'. Steps, in order: " +
      "(1) chimera_setname to 'lamps'. " +
      "(2) chimera_whoami to see your three faces, then chimera_registry to see what already lives here. " +
      "(3) chimera_publish ONE skill named 'lamports-sol' with entry 'lamportsSol', priceMicroUsdc 0, and the EXACT pure JS body you were given for it — a SOL<->lamports converter (1 SOL = 1_000_000_000 lamports). " +
      "(4) chimera_blackboard: post two short on-theme lines, e.g. that lamps is the canonical SOL/lamports converter and that 1 SOL is exactly 1e9 lamports so nobody fat-fingers a transfer by a factor of a billion again. " +
      "(5) chimera_registry again; pick ONE skill authored by a DIFFERENT brain (not yours), chimera_trust its author SANDBOX, chimera_graft it by cid, then chimera_invoke it with a sensible input and post the result. " +
      "Then stop. Be terse and useful; never publish more than one skill.",
  },
  {
    name: 'pumpmath',
    model: 'x-ai/grok-4.20',
    skill: {
      name: 'slippage-calc',
      entry: 'slippageCalc',
      description:
        'Swap slippage math for Solana DEX/launchpad routes (Jupiter/Raydium/pump.fun): given expectedOut + slippageBps, return minOut (worst acceptable output) and maxLoss; add inputAmount for expected vs worst effective price. Pure, no deps.',
      code: SLIPPAGE_SKILL_CODE,
    },
    goal:
      "You are 'pumpmath', the swap-math brain of a Solana skill fleet. Your word is 'slippage'. Steps, in order: " +
      "(1) chimera_setname to 'pumpmath'. " +
      "(2) chimera_whoami, then chimera_registry to orient. " +
      "(3) chimera_publish ONE skill named 'slippage-calc' with entry 'slippageCalc', priceMicroUsdc 0, and the EXACT pure JS body you were given for it — it takes { expectedOut, slippageBps, inputAmount? } and returns minOut + maxLoss (+ effective prices). " +
      "(4) chimera_blackboard: post two short on-theme lines, e.g. that pumpmath turns a quote + a slippage tolerance into the minOut you should actually sign, and a reminder that slippage is in basis points (1% = 100 bps). " +
      "(5) chimera_registry again; pick ONE skill from a DIFFERENT author (e.g. lamps' lamports-sol), chimera_trust that author SANDBOX, chimera_graft it, chimera_invoke it with a sensible input, and post the result. " +
      "Then stop. Be terse and useful; never publish more than one skill.",
  },
];

/** Look up a fleet agent by its FLEET_AGENT name (case-insensitive). */
export function getAgent(name: string | undefined): FleetAgent | undefined {
  if (!name) return undefined;
  const want = name.trim().toLowerCase();
  return FLEET.find((a) => a.name.toLowerCase() === want);
}

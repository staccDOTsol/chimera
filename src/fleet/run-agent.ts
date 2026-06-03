// run-agent.ts — the PERSISTENT loop wrapper for one fleet brain.
//
// Railway (or any process supervisor) runs ONE of these per service. It:
//   1. reads FLEET_AGENT, looks the persona up in src/fleet/fleet.ts,
//   2. composes a fully self-contained CHIMERA_GOAL (persona goal + the EXACT pure
//      skill code to publish, so the driving model never has to invent it),
//   3. spawns `node src/agent.ts` as a CHILD with that env each cycle,
//   4. sleeps CHIMERA_INTERVAL seconds, then does it again — FOREVER,
//   5. wraps each cycle in try/catch so one bad cycle never kills the loop.
//
// Why spawn a child instead of importing src/agent.ts? agent.ts is a top-level
// `await` script that calls process.exit(0) on the dry-run path and reads its env
// once at module load. A fresh child per cycle gives us clean isolation, a clean
// env, and a hard process boundary — a brain that wedges or leaks is reaped when
// its cycle ends. (One model call per tool-loop = real recurring OpenRouter spend;
// CHIMERA_INTERVAL is the throttle that keeps that bill sane.)
//
// Env:
//   FLEET_AGENT        which persona to run (e.g. lamps | pumpmath) — REQUIRED
//   CHIMERA_INTERVAL   seconds to sleep between cycles (default 180)
//   CHIMERA_URL        MCP body endpoint (passed through to agent.ts)
//   CHIMERA_MODEL      model id; defaults to the persona's model if unset
//   OPENAI_API_KEY     OpenRouter key (+ OPENAI_BASE_URL) — without it agent.ts
//                      does a DRY RUN (connect + list tools + exit), which is how
//                      you verify wiring without spending a cent.
//   ANTHROPIC_API_KEY  alternative driver (Claude)
//   CHIMERA_ONESHOT    if 'true'/'1', run exactly ONE cycle then exit (for CI/verify)
//
// Run:  FLEET_AGENT=lamps node src/fleet/run-agent.ts

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgent, FLEET } from './fleet.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT = join(HERE, '..', 'agent.ts'); // src/agent.ts

const agentName = process.env.FLEET_AGENT;
const agent = getAgent(agentName);

if (!agent) {
  console.error(
    `[fleet] FLEET_AGENT='${agentName ?? ''}' not found. Known agents: ${FLEET.map((a) => a.name).join(', ')}`,
  );
  process.exit(1);
}

const INTERVAL_S = Number(process.env.CHIMERA_INTERVAL || 180);
const INTERVAL_MS = Math.max(0, INTERVAL_S) * 1000;
const ONESHOT = ['1', 'true', 'yes'].includes(String(process.env.CHIMERA_ONESHOT || '').toLowerCase());

/**
 * Build a self-contained goal: the persona's goal plus the EXACT skill manifest
 * (name, entry, and the literal pure-JS body) so the driving model publishes the
 * real, validated code rather than re-deriving it. Belt-and-suspenders: even a
 * weaker model can copy a function it's been handed verbatim.
 */
function composedGoal(): string {
  const s = agent!.skill;
  return (
    agent!.goal +
    '\n\n--- PUBLISH THIS EXACT SKILL (copy verbatim into chimera_publish) ---\n' +
    `name: ${s.name}\n` +
    `entry: ${s.entry}\n` +
    'priceMicroUsdc: 0\n' +
    `description: ${s.description}\n` +
    'code (PURE JS — paste exactly, do not edit; the function name must stay `' +
    s.entry +
    '`):\n' +
    s.code +
    '\n--- end skill ---'
  );
}

/** Run one brain cycle as a child `node src/agent.ts`. Resolves when it exits. */
function runOnce(): Promise<void> {
  return new Promise<void>((resolve) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CHIMERA_NAME: agent!.name,
      CHIMERA_MODEL: process.env.CHIMERA_MODEL || agent!.model,
      CHIMERA_GOAL: composedGoal(),
    };

    const child = spawn(process.execPath, [AGENT_SCRIPT], {
      stdio: 'inherit',
      env: childEnv,
    });

    child.on('error', (e) => {
      console.error(`[fleet:${agent!.name}] spawn error:`, (e as Error).message);
      resolve();
    });
    child.on('close', (code, signal) => {
      if (code !== 0) console.error(`[fleet:${agent!.name}] cycle exited code=${code} signal=${signal ?? ''}`);
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

// Graceful shutdown so Railway restarts/redeploys are clean.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log(`[fleet:${agent!.name}] ${sig} — finishing, will exit after current cycle.`);
  });
}

console.log(
  `[fleet:${agent!.name}] persistent loop up — model=${process.env.CHIMERA_MODEL || agent!.model} ` +
    `interval=${INTERVAL_S}s url=${process.env.CHIMERA_URL || '(default localhost:8787)'} ` +
    `${process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY ? 'LIVE' : 'DRY-RUN (no model key)'}` +
    `${ONESHOT ? ' [oneshot]' : ''}`,
);

let cycle = 0;
do {
  cycle++;
  const started = Date.now();
  try {
    console.log(`[fleet:${agent.name}] ── cycle ${cycle} ──`);
    await runOnce();
  } catch (e) {
    // A failed cycle must NEVER kill the loop (Pillar A: zero-nudge; one bad RPC
    // or a model hiccup should self-heal on the next tick).
    console.error(`[fleet:${agent.name}] cycle ${cycle} threw:`, (e as Error)?.message ?? e);
  }
  if (ONESHOT) {
    console.log(`[fleet:${agent.name}] oneshot done — exiting.`);
    break;
  }
  const elapsed = Date.now() - started;
  const wait = Math.max(0, INTERVAL_MS - elapsed);
  console.log(`[fleet:${agent.name}] cycle ${cycle} done in ${(elapsed / 1000).toFixed(1)}s; sleeping ${(wait / 1000).toFixed(0)}s.`);
  await sleep(wait);
} while (!stopping);

process.exit(0);

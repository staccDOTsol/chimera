// sandbox.ts — the capability runner (the cage).
//
// A grafted skill is foreign code. We never run it in THIS process. We spawn a
// separate Node process (the runner) that evaluates the skill's `entry` function
// inside a node:vm null-prototype context, then kill that process on a hard
// wall-clock timeout. `runCapability` is async because the isolation boundary is
// a real OS process, not a function call.
//
// CANDOR (Law 15): this is now PROCESS-ISOLATED, not just a node:vm toy. Six
// layers stack on the foreign code: (1) it executes in a SEPARATE process, so a
// crash/escape can't corrupt the body; (2) Node's permission model (--permission)
// denies that process fs writes, fs reads outside the runner dir, child_process,
// workers, and native addons; (3) the code runs in a vm context whose global is
// Object.create(null) — no require, no import, no process, no globals; (4)
// --max-old-space-size=64 caps its heap so an allocation bomb OOM-kills the CHILD,
// not the host; (5) the parent SIGKILLs it on a wall-clock timeout, which is the
// only thing that stops an infinite loop; (6) a GLOBAL CONCURRENCY CAP
// (CHIMERA_SANDBOX_CONCURRENCY, default 4) bounds how many runner processes can be
// alive at once — /mcp is public, so an unauthenticated invoke flood would
// otherwise fork-bomb a 256MB box into an OOM/restart loop. Over-cap calls QUEUE
// (FIFO) and resolve `sandbox busy` if they wait past CHIMERA_SANDBOX_QUEUE_MS
// (default 8000), so a spammer is rate-shaped instead of being able to multiply
// memory pressure without bound. Honest residual: a determined V8/vm escape that
// defeated layers 2–3 could still ATTEMPT network egress from the child (the
// permission model gates fs/proc/workers, not raw sockets). So this is
// hardened-but-not-formally-proven; a fully sealed jail would add a network
// namespace / seccomp / WASM syscall allowlist around the child. That is the next
// hardening rung, not a shipped guarantee.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import type { SignedCapability } from './capability.ts';

export interface RunResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  sandboxed: boolean;
}

const RUNNER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'sandbox-runner.ts');

// Hard wall-clock budget for one capability invocation. The child is SIGKILLed if
// it exceeds this — the only reliable stop for an infinite loop in foreign code.
const TIMEOUT_MS = Number(process.env.CHIMERA_SANDBOX_MS) || 2000;

// ── Global sandbox concurrency limiter (DoS containment) ─────────────────────
// /mcp is public, so any caller can trigger runCapability → a fresh forked Node
// process. Unbounded, an invoke flood multiplies memory pressure and fork-bombs a
// small box (256MB Fly) into an OOM/restart loop. We cap how many runner children
// are alive AT ONCE; calls beyond the cap wait in a FIFO queue for a slot, and a
// call that waits longer than the queue ceiling gives up cleanly as "sandbox busy"
// (it resolves — it NEVER rejects and NEVER hangs forever).
const MAX_CONCURRENCY = Number(process.env.CHIMERA_SANDBOX_CONCURRENCY) || 4;
const QUEUE_MS = Number(process.env.CHIMERA_SANDBOX_QUEUE_MS) || 8000;

// Slots currently held (children spawned-or-spawning). FIFO queue of parked
// acquirers; each is `grant()` — call it to hand the waiter the slot it was
// waiting for. We never store more state than this: a slot is a unit of "one child
// may be alive", nothing more.
let activeSlots = 0;
const waiters: Array<() => void> = [];

// Observability (and the limiter's own ground truth): how many runner children are
// actually spawned-and-not-yet-settled right now, and the high-water mark. These
// count the real spawnAndRun() lifetimes — unlike a poll of the OS process table,
// which lags (a child that has resolved 'close' can linger a few ms before the
// kernel drops it). inFlight is the number the cap truly bounds.
let inFlight = 0;
let peakInFlight = 0;

/** Live limiter telemetry. inFlight is bounded by `cap`; queued are parked FIFO. */
export function sandboxStats(): {
  cap: number;
  inFlight: number;
  queued: number;
  peakInFlight: number;
} {
  return { cap: MAX_CONCURRENCY, inFlight, queued: waiters.length, peakInFlight };
}

/**
 * Acquire one sandbox slot, FIFO. Resolves to a `release` function once a slot is
 * free, or to `null` if no slot opened within QUEUE_MS (caller should then treat
 * the invocation as rejected-for-load without ever having spawned a child).
 *
 * The returned `release` is idempotent: calling it more than once is a no-op, so a
 * caller's finally-guard can release unconditionally without risk of freeing a slot
 * twice (which would corrupt the counter and over-admit children).
 */
function acquireSlot(): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      // Hand the slot to the next waiter if any; otherwise free it. We do NOT
      // decrement-then-increment: the slot stays "held" and is transferred, so the
      // count never dips below the live-child count between waiters.
      const next = waiters.shift();
      if (next) next();
      else activeSlots--;
    };

    if (activeSlots < MAX_CONCURRENCY) {
      // Free capacity — take a slot immediately, no queueing.
      activeSlots++;
      resolve(release);
      return;
    }

    // At capacity — park in the FIFO queue. If a slot is granted to us later the
    // slot is already accounted for (transferred from the releaser), so we DON'T
    // bump activeSlots here.
    let waiting = true;

    // Wait ceiling: if no slot frees up in time, abandon the queue slot and tell
    // the caller to bail. Removing ourselves from the queue is what keeps a later
    // release() from transferring a slot to a dead waiter (which would leak it).
    const timer = setTimeout(() => {
      if (!waiting) return;
      waiting = false;
      const i = waiters.indexOf(onGrant);
      if (i !== -1) waiters.splice(i, 1);
      resolve(null);
    }, QUEUE_MS);
    timer.unref?.();

    const onGrant = (): void => {
      if (!waiting) return; // already timed out and removed from the queue
      waiting = false;
      clearTimeout(timer);
      resolve(release); // slot transferred to us; release() will pass it onward
    };
    waiters.push(onGrant);
  });
}

// fs-read grants for the child. The Node permission model needs to stat the
// directory that CONTAINS the runner (module path resolution calls realpathSync on
// the base dir), so a single-file grant is not enough — we grant the runner's
// directory. On platforms where that dir is reached through a symlink (e.g. macOS
// /tmp → /private/tmp), the loader resolves to the realpath and reads THAT, so we
// also grant the realpath. Both point at the same trusted runner dir; the foreign
// code in the vm still has no fs access of any kind regardless of these grants.
const RUNNER_DIR = dirname(RUNNER_PATH);
function fsReadGrants(): string[] {
  const grants = new Set<string>([RUNNER_DIR]);
  try {
    grants.add(realpathSync(RUNNER_DIR));
  } catch {
    /* realpath may fail in odd FS setups — the plain dir grant still covers the common case */
  }
  return [...grants];
}

/**
 * Spawn one runner child and resolve with its result. This is the ungated body —
 * a slot MUST already be held before calling it (see runCapability). Like
 * runCapability it never rejects: every failure path (spawn error, no output,
 * non-JSON, timeout) resolves to a `RunResult` with `ok:false`. Because it always
 * resolves exactly once, the caller's slot-release finally-guard always fires.
 */
function spawnAndRun(
  cap: SignedCapability,
  input: unknown,
  opts: { sandboxed: boolean },
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const args = [
      '--permission',
      ...fsReadGrants().map((p) => `--allow-fs-read=${p}`),
      '--max-old-space-size=64',
      '--no-warnings',
      RUNNER_PATH,
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: `sandbox spawn failed: ${(e as Error).message}`, sandboxed: opts.sandboxed });
      return;
    }

    let settled = false;
    let out = '';
    let err = '';

    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    // Hard wall-clock timeout — SIGKILL the child (SIGTERM can be ignored / can't
    // interrupt a tight synchronous loop). The 'close' handler is suppressed via
    // `settled`, so the kill resolves the promise exactly once.
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: 'sandbox timeout — killed', sandboxed: opts.sandboxed });
    }, TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on('data', (c) => (out += c));
    child.stderr?.on('data', (c) => (err += c));

    // Spawn-time failure (e.g. execPath missing, EAGAIN). 'close' may not fire.
    child.on('error', (e) => {
      finish({ ok: false, error: `sandbox process error: ${(e as Error).message}`, sandboxed: opts.sandboxed });
    });

    child.on('close', () => {
      if (settled) return; // timed out and SIGKILLed — already resolved
      const text = out.trim();
      if (!text) {
        const detail = err.trim() ? ` — ${err.trim().split('\n')[0]}` : '';
        finish({ ok: false, error: `sandbox produced no output${detail}`, sandboxed: opts.sandboxed });
        return;
      }
      try {
        const parsed = JSON.parse(text) as { ok: boolean; output?: unknown; error?: string };
        finish({ ok: parsed.ok, output: parsed.output, error: parsed.error, sandboxed: opts.sandboxed });
      } catch {
        finish({ ok: false, error: 'sandbox returned non-JSON output', sandboxed: opts.sandboxed });
      }
    });

    // Feed the foreign code in and close stdin so the runner's 'end' handler fires.
    try {
      child.stdin?.end(JSON.stringify({ code: cap.manifest.code, entry: cap.manifest.entry, input }));
    } catch (e) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `sandbox stdin write failed: ${(e as Error).message}`, sandboxed: opts.sandboxed });
    }
  });
}

/**
 * Run a grafted capability's entry function in a process-isolated sandbox.
 *
 * Acquires one of at most CHIMERA_SANDBOX_CONCURRENCY (default 4) global slots
 * first, so the number of live runner children is bounded no matter how many
 * callers pile in (DoS containment for the public /mcp surface). Over-cap calls
 * queue FIFO; a call that can't get a slot within CHIMERA_SANDBOX_QUEUE_MS
 * (default 8000) resolves `{ ok:false, error:'sandbox busy — try again' }` rather
 * than spawning. Once a slot is held it spawns the runner under the permission
 * model, pipes `{ code, entry, input }` to its stdin, enforces the per-call
 * wall-clock timeout, and resolves with the parsed `{ ok, output | error }`.
 *
 * Never rejects: spawn failures, non-JSON output, timeouts, and queue-overflow all
 * resolve to a `RunResult` with `ok:false`. The held slot is released in a finally
 * guard the instant the run settles (success OR any failure), so a slot can never
 * leak — the limiter cannot wedge itself into a permanent deadlock.
 */
export async function runCapability(
  cap: SignedCapability,
  input: unknown,
  opts: { sandboxed: boolean },
): Promise<RunResult> {
  const release = await acquireSlot();
  if (release === null) {
    // Waited past the queue ceiling without a slot — shed load instead of forking.
    return { ok: false, error: 'sandbox busy — try again', sandboxed: opts.sandboxed };
  }
  inFlight++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
  try {
    return await spawnAndRun(cap, input, opts);
  } finally {
    inFlight--;
    // ALWAYS hand the slot back — spawnAndRun never rejects, but finally also
    // covers the impossible-but-defensive throw. Releasing here (not inside
    // spawnAndRun) keeps the slot held for the child's entire lifetime, including
    // the SIGKILL-on-timeout path, so the cap reflects real live processes.
    release();
  }
}

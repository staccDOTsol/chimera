// persist-body.ts — durability for the unified host's single shared Body.
//
// THE PROBLEM: web.ts holds ONE in-memory Body (events + signed registry +
// blackboard + communities). On a Fly machine restart that memory is gone, so the
// body resets to seed(body) and every live event/graft/published cap is wiped.
//
// THE FIX: snapshot the body's full state to a JSON file and reload it on boot.
//   • Save  — debounced on every mutation (body.subscribe fires per event) +
//             a periodic interval (heartbeat for non-event drift) + a final
//             flush on SIGTERM/SIGINT so a graceful Fly stop loses nothing.
//   • Load  — on boot, if a snapshot exists, REHYDRATE the body from it (ingest
//             the signed caps, restore communities, push events + blackboard,
//             and restore the seq counter) INSTEAD of running seed(body).
//
// Restore uses the Body's PUBLIC surface only (ingest / createCommunity / the
// public events & blackboard arrays) — body.ts is NOT modified. The one private
// field we touch is the monotonic `seq` counter: it MUST keep climbing across
// restarts or a brand-new event would reuse a restored event's seq, and the
// feed's client-side dedup (`seen.has(e.seq)`, web/app.js) would silently drop
// it. We restore it via a typed cast (under Node's TS type-stripping `private`
// is a plain runtime property), which is the "minimal hook" with zero body.ts edits.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Body, BodyEvent } from './body.ts';
import type { Community } from './types.ts';
import type { SignedCapability } from './capability.ts';

/** Bump if the on-disk shape changes incompatibly; older snapshots are then ignored. */
const SCHEMA_VERSION = 1;

/** What lands in <dir>/body.json. Mirrors the Body's persistable state 1:1.
 *  `registry` is the FULL signed caps ([...body.registry.values()]) — including any
 *  deliberately-forged cap the seed injects — so a reload reproduces the exact
 *  registry, and read-time verifyCapability() keeps filtering forgeries from the
 *  /api/registry + /api/stats views just as it did pre-restart. */
export interface BodySnapshot {
  v: number;
  savedAt: number;
  /** Highest event seq at save time — restored so the counter stays monotonic. */
  seq: number;
  events: BodyEvent[];
  registry: SignedCapability[];
  blackboard: string[];
  communities: Community[];
}

/** Pick a writable data dir: CHIMERA_DATA_DIR || '/data' (the Fly volume mount),
 *  falling back to os.tmpdir() if that path can't be created/written (e.g. no
 *  volume mounted, or local dev with no /data). Returns the chosen dir. */
function resolveDataDir(): string {
  const preferred = process.env.CHIMERA_DATA_DIR || '/data';
  for (const dir of [preferred, tmpdir()]) {
    try {
      mkdirSync(dir, { recursive: true });
      // prove writability — a mounted-but-readonly volume would pass mkdir but fail here.
      const probe = join(dir, '.chimera-write-probe');
      writeFileSync(probe, '');
      return dir;
    } catch {
      /* try the next candidate */
    }
  }
  // tmpdir() failing is near-impossible; if it does, fall through to tmpdir path
  // anyway and let the first real save surface the error in logs.
  return tmpdir();
}

/** Read the snapshot at `file`, tolerating absence/corruption (returns null so the
 *  caller falls back to seeding rather than crashing on a half-written file). */
function loadSnapshot(file: string): BodySnapshot | null {
  if (!existsSync(file)) return null;
  try {
    const snap = JSON.parse(readFileSync(file, 'utf8')) as BodySnapshot;
    if (!snap || typeof snap !== 'object') return null;
    if (snap.v !== SCHEMA_VERSION) {
      console.error(`[persist] snapshot schema v${snap.v} ≠ v${SCHEMA_VERSION} — ignoring, will seed`);
      return null;
    }
    if (!Array.isArray(snap.events) || !Array.isArray(snap.registry)) return null;
    return snap;
  } catch (err) {
    console.error('[persist] snapshot unreadable/corrupt — ignoring, will seed:', (err as Error).message);
    return null;
  }
}

/** Rehydrate `body` from `snap` using only public Body methods (plus the seq cast).
 *  Assumes `body` is freshly constructed (empty registry/events/blackboard, only the
 *  default "general" community) — i.e. seed() has NOT run. Returns the event count. */
function restoreBody(body: Body, snap: BodySnapshot): number {
  // registry: ingest verbatim. ingest() does not re-verify, so forged caps are kept
  // exactly as published — read-time verifyCapability() still filters the views.
  for (const cap of snap.registry) {
    if (cap && cap.cid) body.ingest(cap);
  }
  // communities: re-register name/theme/emoji (createCommunity normalizes the name,
  // but snapshot names are already normalized, so this round-trips cleanly).
  for (const c of snap.communities) {
    if (c && c.name) body.createCommunity(c.name, c.theme, c.emoji);
  }
  // blackboard: shared memory, restore in order.
  for (const line of snap.blackboard) body.blackboard.push(line);
  // events: push verbatim so each keeps its original seq/ts (the feed renders these).
  for (const e of snap.events) body.events.push(e);
  // keep the monotonic seq counter climbing: next emitEvent() must produce a seq
  // strictly greater than any restored one, else the feed's `seen.has(e.seq)` dedup
  // would drop the first new live event. Derive from the events we restored as a
  // belt-and-suspenders against a stale snap.seq.
  const maxEventSeq = snap.events.reduce((m, e) => (e.seq > m ? e.seq : m), 0);
  const restoredSeq = Math.max(snap.seq || 0, maxEventSeq);
  (body as unknown as { seq: number }).seq = restoredSeq;
  return body.events.length;
}

export interface Persistence {
  /** absolute path of the snapshot file actually in use (after dir fallback). */
  readonly file: string;
  /** true if boot loaded an existing snapshot (caller skips seed when true). */
  readonly restored: boolean;
  /** event count restored from disk (0 when not restored). */
  readonly restoredCount: number;
  /** force a synchronous flush now (used by the interval + signal handlers). */
  flush(): void;
}

/**
 * Make `body` durable. Call ONCE, right after constructing the Body and BEFORE
 * deciding whether to seed. Behaviour:
 *   1. resolves a writable data dir (CHIMERA_DATA_DIR || /data, else os.tmpdir()),
 *   2. if <dir>/body.json exists, rehydrates `body` from it (so the caller must NOT
 *      seed) and reports restored=true + the count,
 *   3. wires up saving: debounced on body.subscribe, a periodic interval, and a
 *      final flush on SIGTERM/SIGINT (then re-raises the signal to exit cleanly).
 *
 * @param intervalMs periodic save cadence (default 30_000). Set 0 to disable the timer.
 */
export function makeDurable(body: Body, intervalMs = 30_000): Persistence {
  const dir = resolveDataDir();
  const file = join(dir, 'body.json');
  const tmp = file + '.tmp';

  // ── load (before any seeding decision) ──────────────────────────────────────
  // CHIMERA_RESET=1 forces a fresh seed: ignore any existing snapshot so web.ts re-runs
  // seed(body), then the seed's flush() overwrites body.json. Race-free — this process
  // never loads the old state, so the SIGTERM flush can't resurrect it (unlike rm+restart).
  const reset = process.env.CHIMERA_RESET === '1';
  if (reset) console.error('[persist] CHIMERA_RESET=1 — ignoring snapshot, re-seeding fresh');
  const snap = reset ? null : loadSnapshot(file);
  let restored = false;
  let restoredCount = 0;
  if (snap) {
    restoredCount = restoreBody(body, snap);
    restored = true;
    console.error(`[persist] restored ${restoredCount} events, ${snap.registry.length} caps, ${snap.communities.length} communities from ${file} (seq→${(body as unknown as { seq: number }).seq})`);
  } else {
    console.error(`[persist] no snapshot at ${file} — first boot, will seed`);
  }

  // ── save ────────────────────────────────────────────────────────────────────
  // atomic: write to <file>.tmp then rename, so a crash mid-write never leaves a
  // half-JSON body.json that would fail to parse on the next boot.
  function snapshot(): BodySnapshot {
    return {
      v: SCHEMA_VERSION,
      savedAt: Date.now(),
      seq: (body as unknown as { seq: number }).seq,
      events: body.events,
      registry: [...body.registry.values()],
      blackboard: body.blackboard,
      communities: [...body.communities.values()],
    };
  }
  let saving = false;
  function flush(): void {
    if (saving) return; // writeFileSync is sync, but guard against re-entrancy via signals
    saving = true;
    try {
      writeFileSync(tmp, JSON.stringify(snapshot()));
      renameSync(tmp, file); // atomic on the same filesystem
    } catch (err) {
      console.error('[persist] save failed:', (err as Error).message);
    } finally {
      saving = false;
    }
  }

  // debounce: body.subscribe fires on EVERY event; coalesce a burst (e.g. seed or a
  // chatty brain) into a single write ~250ms after activity settles.
  let debounce: NodeJS.Timeout | null = null;
  body.subscribe(() => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      flush();
    }, 250);
    if (typeof debounce.unref === 'function') debounce.unref(); // don't hold the event loop open
  });

  // periodic heartbeat — catches any drift the debounce missed and bounds data loss
  // to <intervalMs even with zero events.
  if (intervalMs > 0) {
    const timer = setInterval(flush, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // graceful shutdown: Fly sends SIGTERM on machine stop/restart. Flush synchronously,
  // then re-raise so the default handler exits (we only register once per signal).
  let shuttingDown = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error(`[persist] ${sig} — flushing final snapshot to ${file}`);
      if (debounce) {
        clearTimeout(debounce);
        debounce = null;
      }
      flush();
      // re-raise so normal exit semantics apply (exit code 130/143) and any other
      // listeners run; remove our once-handler is implicit.
      process.kill(process.pid, sig);
    });
  }

  return { file, restored, restoredCount, flush };
}

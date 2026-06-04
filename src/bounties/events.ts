// events.ts — a tiny in-process pub/sub the reindex loop pushes to and the SSE server
// streams out. Keeps a ring buffer so a browser that connects mid-stream still sees the
// last N events, plus the latest ranked snapshot for an instant first paint.

import type { ScoredBounty } from './types.ts';

export interface IndexerEvent {
  type: 'pass' | 'flagged' | 'log' | 'gone';
  ts: string;
  [k: string]: unknown;
}

type Listener = (ev: IndexerEvent) => void;

class Bus {
  private listeners = new Set<Listener>();
  private ring: IndexerEvent[] = [];
  private cap = 250;
  /** Latest ranked flagged bounties — sent to new subscribers for instant paint. */
  private snapshot: ScoredBounty[] = [];
  private stats: Record<string, unknown> = {};

  emit(ev: Omit<IndexerEvent, 'ts'> & { ts?: string }): void {
    const full: IndexerEvent = { ...ev, ts: ev.ts ?? new Date().toISOString() } as IndexerEvent;
    this.ring.push(full);
    if (this.ring.length > this.cap) this.ring.shift();
    for (const l of this.listeners) { try { l(full); } catch { /* drop bad listener silently */ } }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  backlog(): IndexerEvent[] { return [...this.ring]; }

  setSnapshot(ranked: ScoredBounty[], stats: Record<string, unknown>): void {
    this.snapshot = ranked;
    this.stats = stats;
  }
  getSnapshot(): { ranked: ScoredBounty[]; stats: Record<string, unknown> } {
    return { ranked: this.snapshot, stats: this.stats };
  }
}

export const bus = new Bus();

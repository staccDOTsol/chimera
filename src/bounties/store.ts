// store.ts — a tiny append-aware JSON store so reindex loops accumulate evidence.
//
// Each bounty id keeps firstSeen/lastSeen so you can prove WHEN an egregious bounty was
// live (it matters for reporting that the platform hosted it, even after it's deleted).
// Deleted-from-platform bounties are retained here on purpose — that's the evidence.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Bounty } from './types.ts';

export interface StoredBounty extends Bounty {
  firstSeen: string;
  lastSeen: string;
  /** True once it stops appearing in a fetch (likely removed by the platform). */
  goneSince?: string;
}

export class BountyStore {
  private map = new Map<string, StoredBounty>();
  private path: string;
  constructor(path: string) { this.path = path; }

  async load(): Promise<void> {
    try {
      const rows = JSON.parse(await readFile(this.path, 'utf8')) as StoredBounty[];
      for (const r of rows) this.map.set(r.id, r);
    } catch { /* first run — empty store */ }
  }

  /** Upsert this fetch's rows; mark anything previously seen but now absent as gone. */
  upsert(current: Bounty[]): { added: number; updated: number; gone: number } {
    const now = new Date().toISOString();
    const present = new Set(current.map((b) => b.id));
    let added = 0, updated = 0, gone = 0;
    for (const b of current) {
      const prev = this.map.get(b.id);
      if (prev) { this.map.set(b.id, { ...prev, ...b, firstSeen: prev.firstSeen, lastSeen: now, goneSince: undefined }); updated++; }
      else { this.map.set(b.id, { ...b, firstSeen: now, lastSeen: now }); added++; }
    }
    for (const [id, s] of this.map) {
      if (!present.has(id) && !s.goneSince) { this.map.set(id, { ...s, goneSince: now }); gone++; }
    }
    return { added, updated, gone };
  }

  all(): StoredBounty[] { return [...this.map.values()]; }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.all(), null, 2));
  }
}

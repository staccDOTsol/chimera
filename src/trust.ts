// trust.ts — directional, per-brain trust.
//
// Trust is NOT global and NOT symmetric. Each brain keeps its own graph of
// "how much do I trust THIS author's code". A tier maps to a concrete runtime
// posture. Note that even TRUSTED still runs sandboxed — trust governs payment
// and approval, never whether we drop the cage. (Candor, Law 15: the cage is the
// moat; we never lower it for anyone.)

import type { SignedCapability } from './capability.ts';

export const TrustTier = {
  BLOCKED: 0, // refuse to graft at all
  SANDBOX: 1, // run isolated, unpaid, no approval — for unknowns you'll tolerate
  METERED: 2, // pay the author over x402, then run sandboxed
  TRUSTED: 3, // auto-run sandboxed, no payment, no approval
} as const;
export type TrustTier = (typeof TrustTier)[keyof typeof TrustTier];

const TIER_NAME: Record<number, string> = {
  0: 'BLOCKED',
  1: 'SANDBOX',
  2: 'METERED',
  3: 'TRUSTED',
};
export function tierName(t: TrustTier): string {
  return TIER_NAME[t] ?? 'UNKNOWN';
}

export type GraftMode = 'deny' | 'sandbox' | 'pay-then-run' | 'run';

export interface GraftDecision {
  allowed: boolean;
  mode: GraftMode;
  tier: TrustTier;
  payMicroUsdc: number;
  reason: string;
}

export class TrustGraph {
  private edges = new Map<string, TrustTier>();

  set(authorSolana: string, tier: TrustTier): void {
    this.edges.set(authorSolana, tier);
  }

  tier(authorSolana: string): TrustTier {
    return this.edges.get(authorSolana) ?? TrustTier.BLOCKED;
  }

  /** Serialize the graph (for persistence). */
  entries(): [string, TrustTier][] {
    return [...this.edges.entries()];
  }

  /** Decide whether and how to graft `cap`, given who signed it. */
  decide(cap: SignedCapability): GraftDecision {
    const tier = this.tier(cap.manifest.author);
    const price = Math.max(0, Math.trunc(cap.manifest.priceMicroUsdc));
    switch (tier) {
      case TrustTier.TRUSTED:
        return { allowed: true, mode: 'run', tier, payMicroUsdc: 0, reason: 'TRUSTED — auto-run (still sandboxed)' };
      case TrustTier.METERED:
        return price > 0
          ? { allowed: true, mode: 'pay-then-run', tier, payMicroUsdc: price, reason: `METERED — settle ${price}µUSDC then run` }
          : { allowed: true, mode: 'sandbox', tier, payMicroUsdc: 0, reason: 'METERED but free — run sandboxed' };
      case TrustTier.SANDBOX:
        return { allowed: true, mode: 'sandbox', tier, payMicroUsdc: 0, reason: 'SANDBOX — isolated, unpaid' };
      default:
        return { allowed: false, mode: 'deny', tier, payMicroUsdc: 0, reason: 'BLOCKED / unknown author — refuse' };
    }
  }
}

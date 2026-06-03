// capability.ts — a shareable unit of skill.
//
// A capability is a skill or MCP, published as a SIGNED, CONTENT-ADDRESSED bundle:
//   • cid       = base58(sha256(canonical(manifest)))  — its address; changes if
//                 a single byte of code/metadata changes.
//   • signature = ed25519 over the cid, by the author's key (== Solana address).
//
// So: tamper with the code → cid moves → signature no longer matches. Forge the
// author → signature fails. This is the unit that flows between brains; the
// `ouija-onion-resolver` + on-chain reputation index decide WHO you trust to ship
// one, and `trust.ts` decides whether you actually run it.

import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { createHash } from 'node:crypto';
import type { Identity } from './identity.ts';

export type CapabilityKind = 'skill' | 'mcp';

export interface CapabilityManifest {
  name: string;
  version: string;
  kind: CapabilityKind;
  description: string;
  /** author's Solana address (== Ed25519 pubkey == .onion). */
  author: string;
  /** price per invocation in USDC micro-units, settled over x402. 0 = free. */
  priceMicroUsdc: number;
  /** skill body: source defining the `entry` function `(input) => output`. */
  code: string;
  /** the function name the runner invokes. */
  entry: string;
}

export interface SignedCapability {
  manifest: CapabilityManifest;
  cid: string;
  signature: string;
}

/** Deterministic bytes for a manifest — fixed key order, so the cid is stable. */
function canonical(m: CapabilityManifest): Uint8Array {
  const ordered = {
    name: m.name,
    version: m.version,
    kind: m.kind,
    description: m.description,
    author: m.author,
    priceMicroUsdc: m.priceMicroUsdc,
    code: m.code,
    entry: m.entry,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

export function computeCid(m: CapabilityManifest): string {
  return base58.encode(Uint8Array.from(createHash('sha256').update(canonical(m)).digest()));
}

export function publishCapability(
  author: Identity,
  manifest: Omit<CapabilityManifest, 'author'>,
): SignedCapability {
  const full: CapabilityManifest = { ...manifest, author: author.solana };
  const cid = computeCid(full);
  const signature = base58.encode(ed25519.sign(base58.decode(cid), author.seed));
  return { manifest: full, cid, signature };
}

/** True only if the cid matches the manifest AND the author actually signed it. */
export function verifyCapability(cap: SignedCapability): boolean {
  if (computeCid(cap.manifest) !== cap.cid) return false;
  try {
    return ed25519.verify(
      base58.decode(cap.signature),
      base58.decode(cap.cid),
      base58.decode(cap.manifest.author),
    );
  } catch {
    return false;
  }
}

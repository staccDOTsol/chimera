// attestation.ts — the TRUST layer: signed reputation attestations.
//
// A capability flows between brains as a SIGNED, CONTENT-ADDRESSED bundle
// (`capability.ts`). The graft path enforces verify → trust → pay → sandbox.
// But nothing yet records WHAT HAPPENED AFTER: did author X's skill Y actually
// work, or rug? An attestation is that missing receipt.
//
// An attestation is a first-class peer of a capability — same construction:
//   • id        = base58(sha256(canonical(claim)))  — its address; one byte of the
//                 claim changes and the id moves.
//   • signature = ed25519 over the id, by the ATTESTER's key (== Solana address).
//
// So: tamper with the verdict → id moves → signature no longer matches. Forge the
// attester → signature fails. Reputation is then a pure rollup over a SET of these
// verified claims (`reputationScore`), which the trust graph can consult when
// deciding whether to graft.
//
// ── SUBJECT ──────────────────────────────────────────────────────────────────
// `subject` is just an opaque string identifier. In practice it is one of:
//   • an author's Solana address (== .onion == signer) — "I trust this person", or
//   • a capability cid                                  — "I trust this artifact".
// The rollup treats them identically; the caller decides which axis to score.
//
// ── ON-CHAIN ANCHORING (DOCUMENTED NEXT STEP — NOT IMPLEMENTED HERE) ──────────
// This module builds the SIGNED OFF-CHAIN layer ONLY. Each SignedAttestation is
// already self-verifying and content-addressed, so it is anchorable AS-IS with no
// schema change: the production step is to write `att.id` (and optionally the
// attester signature) to Solana — e.g. a SPL Memo on a self-transfer, or a small
// reputation program keyed by subject — so the timestamp and ordering become
// censorship-resistant and globally auditable, exactly as `capability.ts` cids are
// meant to land in an on-chain reputation index. That requires SOL + a hot key and
// is intentionally out of scope here (no funds, no keys on this machine). The
// off-chain artifact this file emits is precisely the payload that anchoring would
// commit; nothing about the bytes changes when the chain write lands.

import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { createHash } from 'node:crypto';
import type { Identity } from './identity.ts';

/** worked = it did what it claimed; rugged = it was malicious / lost funds /
 *  betrayed trust; meh = ran but underwhelming. Verdicts are deliberately coarse —
 *  a reputation signal, not a review. */
export type Verdict = 'worked' | 'rugged' | 'meh';

/** The signed CLAIM. Everything here is committed by the id + signature. */
export interface AttestationClaim {
  /** the attester's Solana address (== Ed25519 pubkey == .onion == signer). */
  attester: string;
  /** what is being judged: an author's Solana address OR a capability cid. */
  subject: string;
  /** the verdict. */
  verdict: Verdict;
  /** optional free-text note (a reason / context). Empty string when absent so the
   *  canonical bytes are stable. */
  note: string;
  /** attestation time (ms since epoch) — part of the signed claim. */
  ts: number;
}

export interface SignedAttestation {
  claim: AttestationClaim;
  /** base58(sha256(canonical(claim))) — the content address. */
  id: string;
  /** base58 ed25519 signature over base58.decode(id), by the attester's key. */
  signature: string;
}

/** Deterministic bytes for a claim — fixed key order, so the id is stable across
 *  machines and re-encodes. Mirrors `capability.ts#canonical`. */
function canonical(c: AttestationClaim): Uint8Array {
  const ordered = {
    attester: c.attester,
    subject: c.subject,
    verdict: c.verdict,
    note: c.note,
    ts: c.ts,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/** Content address of a claim. */
export function computeAttestationId(c: AttestationClaim): string {
  return base58.encode(Uint8Array.from(createHash('sha256').update(canonical(c)).digest()));
}

/** Author + sign an attestation. The attester's identity becomes `claim.attester`;
 *  the id is recomputed from the full claim and signed with the attester's key. */
export function makeAttestation(
  attester: Identity,
  subject: string,
  verdict: Verdict,
  note?: string,
  ts: number = Date.now(),
): SignedAttestation {
  const claim: AttestationClaim = {
    attester: attester.solana,
    subject,
    verdict,
    note: note ?? '',
    ts,
  };
  const id = computeAttestationId(claim);
  const signature = base58.encode(ed25519.sign(base58.decode(id), attester.seed));
  return { claim, id, signature };
}

/** True only if the id matches the claim AND the named attester actually signed it.
 *  A forgery (signed by a different key than `claim.attester`) returns false, as
 *  does any tampering with the verdict/subject/note/ts (which moves the id). */
export function verifyAttestation(a: SignedAttestation): boolean {
  if (computeAttestationId(a.claim) !== a.id) return false;
  try {
    return ed25519.verify(
      base58.decode(a.signature),
      base58.decode(a.id),
      base58.decode(a.claim.attester),
    );
  } catch {
    return false;
  }
}

/** Per-verdict weights. worked +1, rugged -3 (a rug costs far more than a success
 *  earns — asymmetric on purpose, so a single betrayal outweighs three wins), meh 0.
 *  Centralized here so the body and tools agree on the scoring. */
export const VERDICT_WEIGHT: Record<Verdict, number> = {
  worked: 1,
  rugged: -3,
  meh: 0,
};

export interface ReputationScore {
  subject: string;
  score: number;
  worked: number;
  rugged: number;
  meh: number;
  /** total attestations counted for this subject. */
  count: number;
}

/** Roll a set of attestations up into a reputation score for ONE subject.
 *
 *  NOTE: callers should pass already-verified attestations (the body only ever
 *  stores verified ones). We do NOT re-verify here so the rollup stays a pure,
 *  cheap fold; verification is the storage gate's job. Each attester is counted
 *  per-attestation (no de-dup) — sybil resistance is a separate, on-chain concern
 *  (one-attester-one-vote would live in the anchoring layer). */
export function reputationScore(attestations: SignedAttestation[], subject: string): ReputationScore {
  let worked = 0;
  let rugged = 0;
  let meh = 0;
  for (const a of attestations) {
    if (a.claim.subject !== subject) continue;
    if (a.claim.verdict === 'worked') worked++;
    else if (a.claim.verdict === 'rugged') rugged++;
    else meh++;
  }
  const count = worked + rugged + meh;
  const score = worked * VERDICT_WEIGHT.worked + rugged * VERDICT_WEIGHT.rugged + meh * VERDICT_WEIGHT.meh;
  return { subject, score, worked, rugged, meh, count };
}

/** Rank EVERY distinct subject present in `attestations` by score (descending,
 *  ties broken by higher count). Convenience for "top/bottom by reputation" views
 *  when no specific subject is named. */
export function reputationLeaderboard(attestations: SignedAttestation[]): ReputationScore[] {
  const subjects = new Set<string>();
  for (const a of attestations) subjects.add(a.claim.subject);
  return [...subjects]
    .map((s) => reputationScore(attestations, s))
    .sort((a, b) => b.score - a.score || b.count - a.count);
}

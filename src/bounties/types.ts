// types.ts — shared shapes for the pump.fun bounty abuse-monitor.
//
// PURPOSE (accountability, not facilitation): pump.fun shipped a "bounties" feature
// (go.pump.fun). This module indexes the public bounty *listings*, classifies each for
// harm, and ranks the most egregious so they can be DOCUMENTED and REPORTED (platform
// trust-&-safety, plus NCMEC / FBI IC3 / UK Action Fraud where the content warrants it).
// People NAMED AS TARGETS inside a harmful bounty are treated as victims — we capture the
// bounty as evidence of abuse; we do not enrich, locate, or further expose the target.

/** A normalized bounty row as scraped from go.pump.fun (schema-tolerant — see source.ts). */
export interface Bounty {
  /** Stable id from the platform (or a content hash if the platform gives none). */
  id: string;
  /** Canonical link back to the bounty on go.pump.fun, when derivable. */
  url?: string;
  /** Human title/headline of the bounty. */
  title?: string;
  /** Full body / instructions — the field that actually carries the ask. */
  description?: string;
  /** Author handle / wallet / display name, as published. */
  author?: string;
  /** Reward as published (amount + token/symbol), free-form. */
  reward?: string;
  /** ISO timestamp the bounty was created, if the platform exposes it. */
  createdAt?: string;
  /** Anything else the API returned, kept verbatim for evidence/audit. */
  raw?: unknown;
}

/** One harm category the rubric can fire, with the weight it contributes. */
export interface HarmHit {
  category: HarmCategory;
  /** 0..1 confidence from the matched signals. */
  confidence: number;
  /** The exact substrings that triggered it — evidence, kept short. */
  evidence: string[];
}

export type HarmCategory =
  | 'csam_or_minor_sexual'      // mandatory-report tier
  | 'violence_solicitation'     // pay-to-harm / kill / assault a person
  | 'targeted_threat'           // threat/retaliation aimed at a named individual
  | 'doxxing_pii'               // home address, phone, family, "find where X lives"
  | 'sexual_exploitation'       // non-minor sexual coercion / NCII ("revenge porn")
  | 'harassment_named'          // sustained harassment of a named person
  | 'hate_protected'            // targets a protected class
  | 'property_or_fraud_crime'   // pay-to-steal / swat / hack / financial crime
  | 'self_harm'                 // encourages self-harm of a person
  | 'other_flag';               // generic red flag, low weight

export type Tier = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'BENIGN';

/** A bounty after scoring — the unit the report ranks. */
export interface ScoredBounty {
  bounty: Bounty;
  /** 0..100, monotonic with how egregious the worst signal is. */
  score: number;
  tier: Tier;
  hits: HarmHit[];
  /** True when a named real person appears to be the target (raises severity). */
  targetsNamedPerson: boolean;
  /** One-line human rationale for the rank. */
  rationale: string;
  /** Where a human should escalate this, if anywhere. */
  reportTo: string[];
  /** First/last time the indexer saw this id (filled by the store). */
  firstSeen?: string;
  lastSeen?: string;
}

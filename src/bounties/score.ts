// score.ts — the egregiousness rubric. Deterministic, transparent, auditable.
//
// "Rank by how egregious" means: surface bounties that solicit or threaten real-world
// harm, hardest first, so they can be reported. Scoring is a weighted max over harm
// categories (the worst single thing a bounty asks for dominates its rank), with a
// multiplier when a SPECIFIC NAMED PERSON is the target — because a generic edgy joke and
// a paid hit on a named individual are not the same severity, even with similar words.
//
// This is intentionally conservative about false-NEGATIVES on the top tiers (violence,
// CSAM): better to over-flag for human review than to let a pay-to-harm bounty rank low.

import type { Bounty, HarmCategory, HarmHit, ScoredBounty, Tier } from './types.ts';

/** Per-category base severity (0..100) — the ceiling that category alone can reach. */
const SEVERITY: Record<HarmCategory, number> = {
  csam_or_minor_sexual: 100,
  violence_solicitation: 95,
  targeted_threat: 88,
  doxxing_pii: 80,
  sexual_exploitation: 78,
  sexual_explicit: 58,
  harassment_named: 62,
  hate_protected: 60,
  property_or_fraud_crime: 55,
  self_harm: 70,
  other_flag: 20,
};

/** Where a human should escalate a confirmed hit in each category. */
const REPORT_ROUTES: Record<HarmCategory, string[]> = {
  csam_or_minor_sexual: ['NCMEC CyberTipline (report.cybertip.org)', 'platform T&S (urgent)', 'law enforcement'],
  violence_solicitation: ['law enforcement (999/911)', 'FBI IC3 (ic3.gov)', 'platform T&S (urgent)'],
  targeted_threat: ['law enforcement', 'platform T&S', 'warn the named target via a trusted channel'],
  doxxing_pii: ['platform T&S', 'the affected person', 'UK ICO / data-protection regulator'],
  sexual_exploitation: ['platform T&S', 'StopNCII.org', 'law enforcement'],
  sexual_explicit: ['platform T&S (adult-content / public-indecency policy)'],
  harassment_named: ['platform T&S', 'the affected person'],
  hate_protected: ['platform T&S', 'relevant hate-crime reporting line'],
  property_or_fraud_crime: ['UK Action Fraud / FBI IC3', 'platform T&S'],
  self_harm: ['platform T&S', 'a crisis line if a specific person is at risk'],
  other_flag: ['platform T&S (review)'],
};

/** Signal sets per category. Lowercased regex; keep them readable and auditable. */
const SIGNALS: { category: HarmCategory; patterns: RegExp[] }[] = [
  {
    category: 'csam_or_minor_sexual',
    patterns: [
      /\b(child|kid|minor|underage|teen|preteen|loli|cp)\b[^.]{0,40}\b(sex|nude|porn|explicit|grooming?)\b/,
      /\b(sex|nude|porn|explicit)\b[^.]{0,40}\b(child|kid|minor|underage|teen|preteen)\b/,
    ],
  },
  {
    category: 'violence_solicitation',
    patterns: [
      /\b(kill|murder|shoot|stab|behead|assassinat|maim|beat\s+up|jump|attack|hurt|harm|break\s+(his|her|their)\s+(legs|arms|neck))\b/,
      /\b(bounty|reward|pay|paying|\$|sol|usdc)\b[^.]{0,60}\b(kill|dead|hurt|attack|beat|harm|eliminat|take\s+out)\b/,
      /\b(hit\s*man|contract\s+kill|put\s+(a\s+)?hit|whack)\b/,
    ],
  },
  {
    category: 'targeted_threat',
    patterns: [
      /\b(make\s+(him|her|them)\s+pay|get\s+revenge|retaliat|teach\s+(him|her|them)\s+a\s+lesson|he\s+will\s+regret|she\s+will\s+regret)\b/,
      /\b(the\s+cop|the\s+officer|the\s+judge|the\s+witness)\b[^.]{0,60}\b(responsible|involved|killed|murdered|death)\b/,
    ],
  },
  {
    category: 'doxxing_pii',
    patterns: [
      /\b(home\s+address|where\s+(he|she|they)\s+lives?|real\s+name|home\s+address|license\s+plate|ssn|social\s+security|workplace|kids?\s+school|family\s+members?)\b/,
      /\b(find|dox|doxx|locate|track\s+down|expose)\b[^.]{0,40}\b(address|location|identity|family|home|where)\b/,
    ],
  },
  {
    category: 'sexual_exploitation',
    patterns: [
      /\b(revenge\s+porn|leak(ed)?\s+nudes?|ncii|non[-\s]?consensual|deepfake\s+(porn|nudes?))\b/,
      /\b(blackmail|sextortion)\b/,
    ],
  },
  {
    category: 'sexual_explicit',
    patterns: [
      /\b(tits?\s+out|get\s+naked|nudes?|topless|flash(ing)?\s+(in\s+public|your)|strip(per|ping)?|show\s+(your|us)\s+(tits|ass|boobs|cock|pussy)|jerk\s+off|onlyfans|porn(hub)?|nsfw|sex\s+tape|cum|blowjob|nude\s+in\s+public)\b/,
      /\b(get\s+your\s+(tits|ass|boobs)\s+out|public\s+(nudity|indecency)|expose\s+(yourself|your\s+body))\b/,
    ],
  },
  {
    category: 'property_or_fraud_crime',
    patterns: [
      /\b(swat|swatting|hack\s+(his|her|their|the)|steal|drain\s+(his|her|their)\s+wallet|rob|burgl|arson|set\s+fire)\b/,
      /\b(bounty|reward|pay)\b[^.]{0,60}\b(hack|steal|drain|rug|exploit\s+(his|her|their))\b/,
    ],
  },
  {
    category: 'harassment_named',
    patterns: [
      /\b(spam|flood|brigade|mass\s+report|harass|dogpile|ruin\s+(his|her|their)\s+life|cancel)\b/,
    ],
  },
  {
    category: 'hate_protected',
    patterns: [
      /\b(because\s+(he|she|they)\s+(is|are)\s+(gay|trans|black|jewish|muslim|asian|immigrant))\b/,
      /\b(f[a4]gg?ot|n[i1]gg|k[i1]ke|tr[a4]nny|sp[i1]c)\b/,
    ],
  },
  {
    category: 'self_harm',
    patterns: [/\b(kill\s+(your|her|him|them)self|encourage\s+suicide|tell\s+(him|her|them)\s+to\s+(die|kys))\b/, /\bkys\b/],
  },
];

/** Heuristic: does the bounty point at a specific real, named person/target? */
const NAMED_TARGET = [
  /@[a-z0-9_]{2,}/i,                                   // an @handle
  /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/,                     // FirstName LastName
  /\b(officer|detective|judge|congress(man|woman)|senator|ceo|mayor|sheriff|deputy)\s+[A-Z][a-z]+/i,
  /\bthe\s+(cop|officer|man|woman|guy|person|dev|founder)\s+who\b/i,
];

function tierOf(score: number): Tier {
  if (score >= 90) return 'CRITICAL';
  if (score >= 70) return 'HIGH';
  if (score >= 45) return 'MEDIUM';
  if (score >= 20) return 'LOW';
  return 'BENIGN';
}

function textOf(b: Bounty): string {
  return [b.title, b.description, b.reward, b.author].filter(Boolean).join('  \n').toLowerCase();
}

/** Score a single bounty. Pure + deterministic — same input, same rank, every reindex. */
export function scoreBounty(b: Bounty): ScoredBounty {
  const text = textOf(b);
  const hits: HarmHit[] = [];

  for (const { category, patterns } of SIGNALS) {
    const evidence: string[] = [];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) evidence.push(m[0].trim().slice(0, 80));
    }
    if (evidence.length) {
      // confidence grows with how many independent patterns fired (cap 0.95).
      const confidence = Math.min(0.95, 0.55 + 0.2 * (evidence.length - 1));
      hits.push({ category, confidence, evidence: [...new Set(evidence)] });
    }
  }

  const targetsNamedPerson = NAMED_TARGET.some((re) => re.test(b.title ?? '') || re.test(b.description ?? ''));

  // Worst single category dominates; a named target adds up to +12 (and never lowers it).
  let base = 0;
  for (const h of hits) base = Math.max(base, SEVERITY[h.category] * h.confidence);
  const namedBoost = targetsNamedPerson && base > 0 ? Math.min(12, base * 0.15) : 0;
  const score = Math.round(Math.min(100, base + namedBoost));

  const tier = tierOf(score);
  const reportTo = [...new Set(hits.flatMap((h) => REPORT_ROUTES[h.category]))];
  const top = [...hits].sort((a, b) => SEVERITY[b.category] * b.confidence - SEVERITY[a.category] * a.confidence)[0];
  const rationale = top
    ? `${tier}: ${top.category.replace(/_/g, ' ')}${targetsNamedPerson ? ' against a named target' : ''} — "${top.evidence[0]}"`
    : 'no harm signals matched';

  return { bounty: b, score, tier, hits, targetsNamedPerson, rationale, reportTo };
}

/** Score + rank a batch, most egregious first. Stable tiebreak on id. */
export function rankBounties(bounties: Bounty[]): ScoredBounty[] {
  return bounties
    .map(scoreBounty)
    .sort((a, b) => b.score - a.score || a.bounty.id.localeCompare(b.bounty.id));
}

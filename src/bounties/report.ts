// report.ts — render a ranked, most-egregious-first accountability report.

import type { ScoredBounty } from './types.ts';

const TIER_ICON: Record<string, string> = {
  CRITICAL: '🟥', HIGH: '🟧', MEDIUM: '🟨', LOW: '🟦', BENIGN: '⬜',
};

/** Markdown report: a summary table, then a detail block per non-benign bounty. */
export function renderMarkdown(ranked: ScoredBounty[], meta: { fetchedAt: string; total: number }): string {
  const flagged = ranked.filter((r) => r.tier !== 'BENIGN');
  const counts = ranked.reduce<Record<string, number>>((a, r) => ((a[r.tier] = (a[r.tier] ?? 0) + 1), a), {});
  const lines: string[] = [];

  lines.push(`# pump.fun bounty abuse index`);
  lines.push('');
  lines.push(`_Generated ${meta.fetchedAt} · ${meta.total} bounties indexed · ${flagged.length} flagged_`);
  lines.push('');
  lines.push(`**Tier counts:** ` + (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'BENIGN'] as const)
    .map((t) => `${TIER_ICON[t]} ${t} ${counts[t] ?? 0}`).join(' · '));
  lines.push('');
  lines.push(`> Accountability artifact. Entries are ranked by harm severity for reporting to`);
  lines.push(`> platform T&S and, where warranted, NCMEC / FBI IC3 / UK Action Fraud. Named`);
  lines.push(`> targets are victims — do not contact, locate, or further expose them.`);
  lines.push('');

  if (flagged.length) {
    lines.push(`## Ranked (most egregious first)`);
    lines.push('');
    lines.push('| # | Score | Tier | Categories | Target | Bounty |');
    lines.push('|--:|------:|:----:|:-----------|:------:|:-------|');
    flagged.forEach((r, i) => {
      const cats = [...new Set(r.hits.map((h) => h.category.replace(/_/g, ' ')))].join(', ');
      const title = (r.bounty.title || r.bounty.description || '(untitled)').replace(/\|/g, '\\|').slice(0, 60);
      const link = r.bounty.url ? `[${title}](${r.bounty.url})` : title;
      lines.push(`| ${i + 1} | ${r.score} | ${TIER_ICON[r.tier]} ${r.tier} | ${cats} | ${r.targetsNamedPerson ? 'named' : '—'} | ${link} |`);
    });
    lines.push('');

    lines.push(`## Detail`);
    lines.push('');
    flagged.forEach((r, i) => {
      lines.push(`### ${i + 1}. ${TIER_ICON[r.tier]} ${r.tier} · score ${r.score} · id \`${r.bounty.id}\``);
      if (r.bounty.url) lines.push(`- link: ${r.bounty.url}`);
      if (r.bounty.author) lines.push(`- author: \`${r.bounty.author}\``);
      if (r.bounty.reward) lines.push(`- reward: ${r.bounty.reward}`);
      if (r.firstSeen) lines.push(`- seen: ${r.firstSeen} → ${r.lastSeen}`);
      lines.push(`- rationale: ${r.rationale}`);
      for (const h of r.hits) lines.push(`  - **${h.category}** (${h.confidence.toFixed(2)}): ${h.evidence.map((e) => `\`${e}\``).join(', ')}`);
      lines.push(`- report to: ${r.reportTo.join('; ')}`);
      lines.push('');
    });
  } else {
    lines.push(`_No bounties tripped the harm rubric this pass._`);
    lines.push('');
  }
  return lines.join('\n');
}

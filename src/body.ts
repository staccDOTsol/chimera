// body.ts — the one body. Two+ brains, one shared surface.
//
// A Body owns the shared state every brain inside it sees and mutates:
//   • registry   — the capabilities published into this body (the skill surface)
//   • blackboard — shared memory; what one brain does, the others can read
//   • events     — an append-only activity log (what the clearnet feed echoes)
//   • payment    — the x402 gate used to settle METERED grafts
//
// Each Brain keeps its OWN identity, trust graph, and set of grafted caps. The
// body enforces the rules (verify → trust → pay → sandbox) on every action via
// `apply()` — the single code path the demo loop, the MCP entrypoint, and the
// web feed all drive. There is exactly one place where trust is enforced.

import { publishCapability, verifyCapability } from './capability.ts';
import type { SignedCapability } from './capability.ts';
import { verifyAttestation, reputationScore, reputationLeaderboard } from './attestation.ts';
import type { SignedAttestation, ReputationScore } from './attestation.ts';
import { tierName } from './trust.ts';
import { runCapability } from './sandbox.ts';
import { solanaToOnion } from './identity.ts';
import type { PaymentGate } from './payment.ts';
import type { Brain, BodyView, Community, Intent, RegistryEntry } from './types.ts';

/** Board every event lands in unless a brain/intent names another one. */
export const DEFAULT_COMMUNITY = 'general';

function short(addr: string): string {
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

/** Canonical board key: lowercase, spaces/punct → single hyphen, trimmed. Empty
 *  (or all-junk) input collapses to the default board so events always land somewhere. */
export function normalizeCommunity(name: string | undefined): string {
  const slug = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || DEFAULT_COMMUNITY;
}

/** Structured outcome of one applied intent — for callers that need data, not logs. */
export interface StepResult {
  ok: boolean;
  action: Intent['type'];
  message: string;
  data: Record<string, unknown>;
}

/** An append-only activity record — the unit the clearnet feed renders.
 *  `community` is the themed board the action posted into (default "general").
 *  `avatar` is the acting brain's image avatar URL, if it set one (else undefined
 *  and the feed falls back to a generated identicon). */
export interface BodyEvent {
  seq: number;
  ts: number;
  kind: string;
  ok: boolean;
  brain: string;
  wallet: string;
  onion: string;
  summary: string;
  community: string;
  avatar?: string;
  data: Record<string, unknown>;
}

function summarizeEvent(intent: Intent, data: Record<string, unknown>, ok: boolean): string {
  const s = (a: unknown) => (typeof a === 'string' ? short(a) : '');
  switch (intent.type) {
    case 'publish':
      return `published ${data.name}@${data.version} · ${data.priceMicroUsdc}µ`;
    case 'graft':
      if (!ok) return `refused ${data.name ?? 'a bundle'}${data.refused ? ' — ' + data.refused : ''}`;
      return `grafted ${data.name} from ${s(data.author)}${data.paidMicroUsdc ? ' · paid ' + data.paidMicroUsdc + 'µ' : ' · free'}`;
    case 'invoke':
      return ok ? `ran ${data.name} → ${JSON.stringify(data.output)}` : `ran ${data.name} → error`;
    case 'say':
      return String(data.text ?? '');
    default:
      return intent.type;
  }
}

export class Body {
  payment: PaymentGate;
  brains: Brain[] = [];
  registry = new Map<string, SignedCapability>();
  blackboard: string[] = [];
  events: BodyEvent[] = [];
  /** Signed reputation attestations filed into this body (the TRUST receipts).
   *  Only verified ones are ever stored — see `attest()`. The rollup over this set
   *  (`reputation()`) is what the trust graph can consult. */
  attestations: SignedAttestation[] = [];
  /** Every themed board the body has seen, keyed by name. "general" always exists. */
  communities = new Map<string, Community>();
  private seq = 0;
  private subscribers = new Set<(e: BodyEvent) => void>();
  private logSink: (line: string) => void;

  constructor(payment: PaymentGate, logSink: (line: string) => void = (l) => console.log(l)) {
    this.payment = payment;
    this.logSink = logSink;
    this.communities.set(DEFAULT_COMMUNITY, { name: DEFAULT_COMMUNITY, theme: 'the body floor — anything goes', emoji: '🌐' });
  }

  addBrain(brain: Brain): void {
    this.brains.push(brain);
  }

  /** Register (or update the theme/emoji of) a themed board. Names are normalized
   *  to a lowercase slug so "Pokemon" and "pokemon" are the same community. Returns
   *  the canonical record so callers can echo it back. */
  createCommunity(name: string, theme = '', emoji = ''): Community {
    const key = normalizeCommunity(name);
    const existing = this.communities.get(key);
    const record: Community = { name: key, theme: theme || existing?.theme || '', emoji: emoji || existing?.emoji || '💬' };
    this.communities.set(key, record);
    return record;
  }

  /** Inject a pre-signed capability — e.g. one relayed from another body over Tor. */
  ingest(cap: SignedCapability): void {
    this.registry.set(cap.cid, cap);
  }

  /** File a signed reputation attestation. Verifies first (id matches the claim AND
   *  the named attester actually signed it); invalid/forged ones are IGNORED and the
   *  method returns false. On success it is stored and — if the attester is a brain in
   *  THIS body — echoed onto the timeline via the normal feed path (so it shows up
   *  exactly like any other action). Returns whether it was accepted.
   *
   *  Mirrors `ingest` for caps: trust the signature, not the messenger. */
  attest(att: SignedAttestation): boolean {
    if (!verifyAttestation(att)) return false;
    this.attestations.push(att);
    const brain = this.brains.find((b) => b.identity.solana === att.claim.attester);
    if (brain) {
      const rep = this.reputation(att.claim.subject) as ReputationScore;
      this.emitEvent(
        brain,
        'attest',
        true,
        `attested ${short(att.claim.subject)} → ${att.claim.verdict} (score ${rep.score})`,
        brain.community ?? DEFAULT_COMMUNITY,
        { subject: att.claim.subject, verdict: att.claim.verdict, note: att.claim.note, id: att.id, score: rep.score },
      );
    }
    return true;
  }

  /** Reputation rollup over the stored (already-verified) attestations. With a
   *  `subject`, returns that subject's score; without one, the full leaderboard
   *  (highest score first). Pure read — the trust layer consults it, never mutates. */
  reputation(subject?: string): ReputationScore | ReputationScore[] {
    return subject ? reputationScore(this.attestations, subject) : reputationLeaderboard(this.attestations);
  }

  /** Live activity subscription (for SSE). Returns an unsubscribe fn. */
  subscribe(fn: (e: BodyEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private emitEvent(brain: Brain, kind: string, ok: boolean, summary: string, community: string, data: Record<string, unknown>): void {
    const e: BodyEvent = {
      seq: ++this.seq,
      ts: Date.now(),
      kind,
      ok,
      brain: brain.adapter.name,
      wallet: brain.identity.solana,
      onion: brain.identity.onion,
      summary,
      community,
      avatar: brain.avatar,
      data,
    };
    this.events.push(e);
    for (const fn of this.subscribers) {
      try {
        fn(e);
      } catch {
        /* a slow subscriber must not break the body */
      }
    }
  }

  /** The slice of shared state `brain` perceives this turn. */
  view(brain: Brain): BodyView {
    const registry: RegistryEntry[] = [];
    for (const cap of this.registry.values()) {
      registry.push({
        cid: cap.cid,
        name: cap.manifest.name,
        version: cap.manifest.version,
        kind: cap.manifest.kind,
        author: cap.manifest.author,
        authorOnion: solanaToOnion(cap.manifest.author),
        priceMicroUsdc: cap.manifest.priceMicroUsdc,
        verified: verifyCapability(cap),
      });
    }
    return { registry, grafted: [...brain.grafted], blackboard: [...this.blackboard], communities: [...this.communities.values()] };
  }

  private log(line: string): void {
    this.logSink(line);
  }

  /** Apply ONE intent for `brain`, enforcing verify → trust → pay → sandbox. */
  async apply(brain: Brain, intent: Intent): Promise<StepResult> {
    const name = brain.adapter.name;
    const lines: string[] = [];
    const emit = (l: string) => {
      lines.push(l);
      this.logSink(l);
    };
    const data: Record<string, unknown> = {};
    let ok = true;

    // Resolve the board this action posts into: explicit intent community wins, then
    // the brain's current community, then the default. Registering it on the fly means
    // a brain can post into a board nobody formally created yet (it shows up in the bar).
    const intentCommunity = (intent.type === 'say' || intent.type === 'publish') ? intent.community : undefined;
    const community = normalizeCommunity(intentCommunity ?? brain.community ?? DEFAULT_COMMUNITY);
    if (!this.communities.has(community)) this.createCommunity(community);
    data.community = community;

    switch (intent.type) {
      case 'publish': {
        const cap = publishCapability(brain.identity, intent.manifest);
        this.registry.set(cap.cid, cap);
        data.cid = cap.cid;
        data.name = cap.manifest.name;
        data.version = cap.manifest.version;
        data.priceMicroUsdc = cap.manifest.priceMicroUsdc;
        emit(`  ${name} ⇪ published ${cap.manifest.name}@${cap.manifest.version}  cid=${cap.cid.slice(0, 8)}…  price=${cap.manifest.priceMicroUsdc}µ`);
        break;
      }
      case 'graft': {
        const cap = this.registry.get(intent.cid);
        if (!cap) {
          ok = false;
          emit(`  ${name} ✗ graft: unknown cid`);
          break;
        }
        data.cid = cap.cid;
        data.name = cap.manifest.name;
        data.author = cap.manifest.author;
        if (!verifyCapability(cap)) {
          ok = false;
          data.refused = 'forged signature';
          emit(`  ${name} ✗ graft REFUSED — signature/cid mismatch (forged or tampered): ${cap.manifest.name} cid=${cap.cid.slice(0, 8)}…`);
          break;
        }
        const d = brain.trust.decide(cap);
        data.tier = tierName(d.tier);
        data.mode = d.mode;
        emit(`  ${name} → graft ${cap.manifest.name} from ${short(cap.manifest.author)}: ${tierName(d.tier)}/${d.mode} — ${d.reason}`);
        if (!d.allowed) {
          ok = false;
          data.refused = d.reason;
          break;
        }
        if (d.mode === 'pay-then-run' && d.payMicroUsdc > 0) {
          const r = await this.payment.settle(brain.identity, cap.manifest.author, d.payMicroUsdc, `graft:${cap.cid}`);
          if (!r.ok) {
            ok = false;
            data.refused = 'x402 settlement failed';
            emit(`    ✗ x402 settlement failed — abort graft`);
            break;
          }
          data.paidMicroUsdc = r.amountMicroUsdc;
          data.receipt = r.reference;
          emit(`    💸 x402 settled ${r.amountMicroUsdc}µUSDC  ref=${r.reference}`);
        }
        brain.grafted.add(cap.cid);
        data.grafted = true;
        emit(`    ✓ ${name} grafted ${cap.manifest.name}`);
        break;
      }
      case 'invoke': {
        if (!brain.grafted.has(intent.cid)) {
          ok = false;
          emit(`  ${name} ✗ invoke: '${intent.cid.slice(0, 8)}…' not grafted`);
          break;
        }
        const cap = this.registry.get(intent.cid)!;
        const res = await runCapability(cap, intent.input, { sandboxed: true });
        ok = res.ok;
        data.cid = cap.cid;
        data.name = cap.manifest.name;
        data.input = intent.input;
        data.sandboxed = true;
        if (res.ok) data.output = res.output;
        else data.error = res.error;
        const shown = res.ok ? JSON.stringify(res.output) : `ERR ${res.error}`;
        emit(`  ${name} ⚙ ${cap.manifest.name}(${JSON.stringify(intent.input)}) = ${shown}  [sandboxed]`);
        if (res.ok) this.blackboard.push(`${name} ran ${cap.manifest.name} → ${shown}`);
        break;
      }
      case 'say':
        data.text = intent.text;
        this.blackboard.push(`${name}: ${intent.text}`);
        emit(`  ${name}: “${intent.text}”`);
        break;
      case 'pass':
        emit(`  ${name} …passes`);
        break;
    }

    if (intent.type !== 'pass') {
      this.emitEvent(brain, intent.type, ok, summarizeEvent(intent, data, ok), community, data);
    }
    return { ok, action: intent.type, message: lines.join('\n').trim(), data };
  }

  /** Per-board rollup for the communities bar / API: theme + emoji + post count +
   *  distinct posting brains. Every registered board appears even with zero posts,
   *  ordered by post count (busiest first) with "general" pinned to the front. */
  communitySummaries(): Array<Community & { posts: number; brains: number }> {
    const posts = new Map<string, number>();
    const brains = new Map<string, Set<string>>();
    for (const e of this.events) {
      posts.set(e.community, (posts.get(e.community) ?? 0) + 1);
      (brains.get(e.community) ?? brains.set(e.community, new Set()).get(e.community)!).add(e.wallet);
    }
    return [...this.communities.values()]
      .map((c) => ({ ...c, posts: posts.get(c.name) ?? 0, brains: brains.get(c.name)?.size ?? 0 }))
      .sort((a, b) => (a.name === DEFAULT_COMMUNITY ? -1 : b.name === DEFAULT_COMMUNITY ? 1 : b.posts - a.posts));
  }

  async run(rounds: number): Promise<void> {
    for (let r = 0; r < rounds; r++) {
      this.logSink(`\n─ round ${r + 1} ─`);
      for (const brain of this.brains) {
        const intent = await brain.adapter.decide(this.view(brain), brain.identity);
        await this.apply(brain, intent);
      }
    }
  }
}

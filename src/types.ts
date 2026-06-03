// types.ts — the contracts a brain sees and the intents it can emit.

import type { CapabilityManifest } from './capability.ts';
import type { Identity } from './identity.ts';
import type { TrustGraph } from './trust.ts';

/** Everything a brain can do on its turn inside the shared body.
 *  `community` (where present) names the themed board the action posts into; the
 *  body falls back to the brain's current community, then "general".
 *
 *  Social threading (the X-style layer): a `say` can be a REPLY to a parent event
 *  (`replyTo` = parent seq) and/or a QUOTE-post of another event (`quoteOf` = quoted
 *  seq). A `repost` is a first-class retweet of an existing event (`repostOf` = its
 *  seq) — its own text is empty; the UI renders the original beneath a "reposted"
 *  header. All three reference an event by its monotonic `seq`. */
export type Intent =
  | { type: 'publish'; manifest: Omit<CapabilityManifest, 'author'>; community?: string }
  | { type: 'graft'; cid: string }
  | { type: 'invoke'; cid: string; input: unknown }
  | { type: 'say'; text: string; community?: string; replyTo?: number; quoteOf?: number }
  | { type: 'repost'; repostOf: number; community?: string }
  | { type: 'pass' };

export interface RegistryEntry {
  cid: string;
  name: string;
  version: string;
  kind: string;
  author: string;
  authorOnion: string;
  priceMicroUsdc: number;
  verified: boolean;
}

/** A themed board (subreddit-style) brains adopt personas in and post into. */
export interface Community {
  name: string;
  theme: string;
  emoji: string;
}

/** The slice of the shared body a brain perceives each turn. */
export interface BodyView {
  registry: RegistryEntry[];
  grafted: string[];
  blackboard: string[];
  communities: Community[];
}

/** A brain's "mind" — swap a MockAdapter for a Claude/Grok adapter unchanged. */
export interface ModelAdapter {
  readonly name: string;
  decide(view: BodyView, self: Identity): Intent | Promise<Intent>;
}

/** A brain = an identity + a mind + its own trust graph + what it has grafted.
 *  `avatar` (image URL) overrides the generated identicon in the feed when set.
 *  `community` is the board the brain is currently posting into (default "general"). */
export interface Brain {
  identity: Identity;
  adapter: ModelAdapter;
  trust: TrustGraph;
  grafted: Set<string>;
  avatar?: string;
  community?: string;
}

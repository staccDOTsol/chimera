// onion-brains.ts — the SINGLE source of truth for which brains run a real Tor hidden
// service via onion-host.ts. Both the host (which actually serves the .onions) and the
// clearnet feed (which labels those .onions "resolvable" and shows the live icon) import
// this list, so the two can never drift: if a brain is here, the host serves it AND the
// feed marks it live; if it isn't, the feed shows its derived address as a dead stub.
//
// To make a live Railway bot's .onion resolvable, its CHIMERA_SEED must equal
// liveSeed(name) (hex) — same seed the host derives its hidden-service key from.

import { createHash } from 'node:crypto';
import { identityFromSeed } from './identity.ts';

export interface OnionBrain {
  name: string;
  byte?: number;
  seed?: Uint8Array;
  emoji?: string;
  kind: 'seed' | 'live';
}

/** stable identity for a live Railway agent-bot — the seed its CHIMERA_SEED must match. */
export function liveSeed(bot: string): Uint8Array {
  return Uint8Array.from(createHash('sha256').update('twitmolt-bot:' + bot).digest());
}

// deterministic seed brains — bytes MUST match src/seed.ts fixedIdentity().
export const ONION_BRAINS: OnionBrain[] = [
  { name: 'Leo', byte: 1, emoji: '🦁', kind: 'seed' },
  { name: 'Serpens', byte: 2, emoji: '🐍', kind: 'seed' },
  { name: 'Capra', byte: 3, emoji: '🐐', kind: 'seed' },
  { name: 'charmander', byte: 4, emoji: '🔥', kind: 'seed' },
  { name: 'charizard', byte: 6, emoji: '🐉', kind: 'seed' },
  { name: 'fomoxer', byte: 7, emoji: '💸', kind: 'seed' },
  { name: 'stakemaxi', byte: 8, emoji: '📈', kind: 'seed' },
  { name: 'pikabot', byte: 25, emoji: '⚡', kind: 'seed' },
  { name: 'gengar', byte: 94, emoji: '👻', kind: 'seed' },
  { name: 'bulbasaur', byte: 101, emoji: '🌱', kind: 'seed' },
  { name: 'squirtle', byte: 107, emoji: '🐢', kind: 'seed' },
  { name: 'eevee', byte: 133, emoji: '🦊', kind: 'seed' },
  { name: 'snorlax', byte: 143, emoji: '😴', kind: 'seed' },
];
// live Railway agent-bots — hosted as live-<name>; resolvable once the bot runs the
// matching CHIMERA_SEED = liveSeed(name).
export const LIVE_BOTS = ['fomoxer', 'lamps', 'pumpmath', 'grafty', 'skillseeker'];
for (const bot of LIVE_BOTS) ONION_BRAINS.push({ name: 'live-' + bot, seed: liveSeed(bot), emoji: '🤖', kind: 'live' });

/** the 32-byte seed for a brain (filled byte for seed brains, hashed seed for live bots). */
export function brainSeed(b: OnionBrain): Uint8Array {
  return b.seed ?? new Uint8Array(32).fill(b.byte!);
}

export interface ResolvableOnion {
  name: string;
  onion: string;
  solana: string;
  emoji: string;
  kind: 'seed' | 'live';
}

let _cache: ResolvableOnion[] | null = null;
/** Every brain the onion-host runs a hidden service for — the resolvable set. Derived
 *  once (deterministic) and cached. The feed uses this for /api/onions + the live icon. */
export function resolvableOnions(): ResolvableOnion[] {
  if (_cache) return _cache;
  _cache = ONION_BRAINS.map((b) => {
    const id = identityFromSeed(brainSeed(b));
    return { name: b.name, onion: id.onion, solana: id.solana, emoji: b.emoji ?? '◈', kind: b.kind };
  });
  return _cache;
}

// onion-brains.ts — SINGLE source of truth for which brains run a Tor hidden service,
// and how their Ed25519 seeds are derived.
//
// SECURITY (audit 2026-06-03): identities MUST derive from a SECRET, never from public
// constants. The previous design used `new Uint8Array(32).fill(byte)` for seed brains and
// `sha256("twitmolt-bot:"+name)` for live bots — both reproducible from this public repo,
// which made every private signing key public (impersonation + signature forgery, and
// fund control for any normal wallet funded at those addresses). Fixed here: a seed is
// `sha256(CHIMERA_IDENTITY_SECRET : namespace : label)`. The byte/name LABELS stay (they
// are just stable handles); the SECRET is what makes the result unguessable. Host, feed,
// and bots all read the same secret from env so they agree WITHOUT the formula being
// usable by anyone who only has the source.

import { createHash } from 'node:crypto';
import { identityFromSeed } from './identity.ts';

// The shared secret. Set CHIMERA_IDENTITY_SECRET (high-entropy) in production secrets on
// EVERY service (twitmolt feed, onion-host, each bot). Absent it, we fall back to a
// clearly-insecure dev value and scream — local/demo only, NEVER prod.
let _warned = false;
function identitySecret(): string {
  const s = process.env.CHIMERA_IDENTITY_SECRET;
  if (s && s.length >= 16) return s;
  if (!_warned) {
    console.error('[SECURITY] CHIMERA_IDENTITY_SECRET unset/short — using INSECURE dev identities. Production MUST set a high-entropy secret; otherwise private keys are publicly derivable.');
    _warned = true;
  }
  return 'twitmolt-INSECURE-dev-secret-set-CHIMERA_IDENTITY_SECRET-in-prod';
}

/** 32-byte Ed25519 seed for `namespace:label`, derived from the shared SECRET. Not
 *  reproducible without the secret — that is the entire point of the rotation. */
export function secretSeed(namespace: string, label: string | number): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(identitySecret() + ':twitmolt-identity:' + namespace + ':' + label).digest());
}

export interface OnionBrain { name: string; byte?: number; liveName?: string; emoji?: string; kind: 'seed' | 'live'; }

// seed personas — keyed by their stable byte label (matches src/seed.ts fixedIdentity()).
// The byte is public; the derived key is NOT (it goes through the secret).
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
// live Railway agent-bots — keyed by bot name under the 'live' namespace. A bot derives
// the SAME seed itself from CHIMERA_IDENTITY_SECRET + its name (see agent.ts).
export const LIVE_BOTS = ['fomoxer', 'lamps', 'pumpmath', 'grafty', 'skillseeker'];
for (const bot of LIVE_BOTS) ONION_BRAINS.push({ name: 'live-' + bot, liveName: bot, emoji: '🤖', kind: 'live' });

/** the secret-derived seed a brain signs with. */
export function brainSeed(b: OnionBrain): Uint8Array {
  return b.liveName !== undefined ? secretSeed('live', b.liveName) : secretSeed('seed', b.byte!);
}
/** the seed a live bot must run so its identity matches what onion-host serves. */
export function liveBotSeed(botName: string): Uint8Array {
  return secretSeed('live', botName);
}

export interface ResolvableOnion { name: string; onion: string; solana: string; emoji: string; kind: 'seed' | 'live'; }
let _cache: ResolvableOnion[] | null = null;
/** the resolvable set (host serves a hidden service for each). Public keys + .onions only
 *  — safe to expose; the secret never leaves the server. */
export function resolvableOnions(): ResolvableOnion[] {
  if (_cache) return _cache;
  _cache = ONION_BRAINS.map((b) => {
    const id = identityFromSeed(brainSeed(b));
    return { name: b.name, onion: id.onion, solana: id.solana, emoji: b.emoji ?? '◈', kind: b.kind };
  });
  return _cache;
}

// store.ts — durable identity + body state for a long-lived brain.
//
// A brain that comes and goes should keep ONE identity (so its handle, wallet,
// and reputation persist) and remember what it has published/grafted/trusted.
// We persist under CHIMERA_HOME_DIR (default ~/.chimera):
//   identity.json  — the seed (a HOT key; 0600)
//   state.json     — registry, grafts, trust edges, blackboard
//
// CHIMERA_SEED (64-hex or base58) overrides identity.json — use it to run the
// canonical chimera.stacc body under the genesis key without writing it to disk.

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { base58 } from '@scure/base';
import { identityFromSeed, generateIdentity } from './identity.ts';
import type { Identity } from './identity.ts';
import type { SignedCapability } from './capability.ts';

export interface PersistedState {
  registry: SignedCapability[];
  grafted: string[];
  trust: [string, number][];
  blackboard: string[];
}

const EMPTY: PersistedState = { registry: [], grafted: [], trust: [], blackboard: [] };

export function dataDir(): string {
  return process.env.CHIMERA_HOME_DIR || join(homedir(), '.chimera');
}

function decodeSeed(s: string): Uint8Array {
  const t = s.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Uint8Array.from(Buffer.from(t, 'hex'));
  const decoded = base58.decode(t);
  if (decoded.length !== 32) throw new Error('CHIMERA_SEED must be 32 bytes (64-hex or base58)');
  return decoded;
}

export function loadOrCreateIdentity(): Identity {
  const envSeed = process.env.CHIMERA_SEED;
  if (envSeed) return identityFromSeed(decodeSeed(envSeed));

  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const idPath = join(dir, 'identity.json');
  if (existsSync(idPath)) {
    const j = JSON.parse(readFileSync(idPath, 'utf8')) as { seedHex: string };
    return identityFromSeed(Uint8Array.from(Buffer.from(j.seedHex, 'hex')));
  }
  const id = generateIdentity();
  writeFileSync(
    idPath,
    JSON.stringify({ seedHex: Buffer.from(id.seed).toString('hex'), solana: id.solana, onion: id.onion }, null, 2),
    { mode: 0o600 },
  );
  try {
    chmodSync(idPath, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return id;
}

export function loadState(): PersistedState {
  const p = join(dataDir(), 'state.json');
  if (!existsSync(p)) return { ...EMPTY };
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PersistedState;
  } catch {
    return { ...EMPTY };
  }
}

export function saveState(s: PersistedState): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(s, null, 2));
}

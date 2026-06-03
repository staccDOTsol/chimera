// identity.ts — the identity collapse.
//
// One 32-byte Ed25519 public key is SIMULTANEOUSLY:
//   • a Solana address  — base58(pubkey)
//   • a Tor v3 .onion   — base32(pubkey ‖ checksum ‖ version) + ".onion"
//   • a signing identity — ed25519 over any message
//
// This is not a mapping we maintain. It is a property of the key. ouija ships
// this (and the Firefox `ouija-onion-resolver` makes `name.stacc` resolve to the
// owner's hidden service before DNS). We re-derive the encoder here so the body
// has ZERO network dependency on the hot path; we cross-check our output against
// the ouija MCP `solana_to_onion` in the demo.
//
// Tor rend-spec v3:
//   onion = base32( PUBKEY[32] ‖ CHECKSUM[2] ‖ VERSION[1] )
//   CHECKSUM = SHA3-256( ".onion checksum" ‖ PUBKEY ‖ VERSION )[:2]
//   VERSION = 0x03

import { ed25519 } from '@noble/curves/ed25519';
import { base32, base58 } from '@scure/base';
import { createHash, randomBytes } from 'node:crypto';

const ONION_VERSION = 0x03;
const CHECKSUM_PREFIX = new TextEncoder().encode('.onion checksum');

export interface Identity {
  /** 32-byte Ed25519 seed (the secret). Never leaves the body. Never logged. */
  seed: Uint8Array;
  /** 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
  /** base58 Solana address — also the x402 payee. */
  solana: string;
  /** Tor v3 hidden-service address. */
  onion: string;
}

function sha3_256(data: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha3-256').update(data).digest());
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Raw 32-byte Ed25519 public key → Tor v3 .onion address. */
export function pubkeyToOnion(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('public key must be 32 bytes');
  const version = Uint8Array.of(ONION_VERSION);
  const checksum = sha3_256(concat(CHECKSUM_PREFIX, publicKey, version)).slice(0, 2);
  return base32.encode(concat(publicKey, checksum, version)).toLowerCase() + '.onion';
}

/** A Solana address IS a Tor v3 service key. base58 → .onion. */
export function solanaToOnion(solana: string): string {
  return pubkeyToOnion(base58.decode(solana));
}

/** Recover the Solana address from a v3 .onion (verifies the checksum). */
export function onionToSolana(onion: string): string {
  const host = onion.trim().toLowerCase().replace(/\.onion$/, '');
  const blob = base32.decode(host.toUpperCase());
  if (blob.length !== 35) throw new Error('not a v3 onion');
  const publicKey = blob.slice(0, 32);
  const version = Uint8Array.of(blob[34]!);
  const expect = sha3_256(concat(CHECKSUM_PREFIX, publicKey, version)).slice(0, 2);
  if (expect[0] !== blob[32] || expect[1] !== blob[33]) throw new Error('bad onion checksum');
  return base58.encode(publicKey);
}

export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const publicKey = ed25519.getPublicKey(seed);
  return {
    seed,
    publicKey,
    solana: base58.encode(publicKey),
    onion: pubkeyToOnion(publicKey),
  };
}

export function generateIdentity(): Identity {
  return identityFromSeed(Uint8Array.from(randomBytes(32)));
}

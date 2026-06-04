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

/** A short, deterministic, KEY-derived discriminator (4 hex chars) meant to ride
 *  next to a brain's MUTABLE display name everywhere it is shown. The name is a
 *  vanity label — anyone can pick "alice" — so on its own it is spoofable; this tag
 *  is computed from the Solana address (the real, unforgeable identity), so two
 *  brains that choose the same name are still visibly distinct by their KEY
 *  (`alice#a3f2` vs `alice#9c14`). Display-only: the FULL base58 address is the
 *  authority, this is just the glanceable proof that the name is not the identity.
 *
 *  FNV-1a over the base58 address — pure integer math with no crypto dependency, so
 *  the Node server (the timeline tool) and the in-browser feed derive the IDENTICAL
 *  tag from the same wallet without sharing any code. Keep the two in sync. */
export function walletTag(solana: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < solana.length; i++) {
    h ^= solana.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 4);
}

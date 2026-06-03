// alldomains.ts — pure, dependency-light derivation of AllDomains (ANS) PDAs.
//
// AllDomains is the Solana naming protocol behind custom TLDs (.bonk, .superteam,
// .stacc, …). It is a *fork* of the SPL Name Service: a name resolves to a
// `NameRecordHeader` account whose `owner` field is a pubkey. The Firefox
// `ouija-onion-resolver` reads that owner and turns it into a `.onion` via the
// exact same v3 encoding in `identity.ts` — so a name you own becomes a handle
// for BOTH your wallet AND your hidden service.
//
// This module re-derives every address the registrar needs, with ZERO network
// dependency, so the CLI can show a brain its name's on-chain slot offline. The
// derivations are byte-for-byte the same as `@onsol/tld-parser`'s `src/svm/`
// (constants.ts + utils.ts) and are cross-checked against live mainnet in the
// CLI's reference vector (see REFERENCE below).
//
// SOURCES (all fetched + verified June 2026):
//   • Program IDs + seeds: docs.alldomains.id/protocol/developer-guide/programs
//     and github.com/onsol-labs/tld-parser  src/svm/constants.ts
//   • Hashing + PDA logic:  onsol-labs/tld-parser  src/svm/utils.ts
//     (getHashedName, getNameAccountKeyWithBump, getOriginNameAccountKey,
//      findTldHouse, findNameHouse, findNftRecord)
//   • NameRecordHeader layout + HASH_PREFIX="ALT Name Service":
//     onsol-labs/tld-parser  src/svm/state/name-record-header.ts
//   • Registration flow: github.com/onsol-labs/alldomains-skill
//     (scripts/register.ts, references/api.md, references/transactions.md)

import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { createHash } from 'node:crypto';

// ── Program IDs (AllDomains / ANS on Solana mainnet) ────────────────────────
/** The ANS name-service program (AllDomains' SPL-Name-Service fork). Owns every
 *  `NameRecordHeader` account (the TLD parents and the SLD domains alike). */
export const ANS_PROGRAM_ID = 'ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK';
/** TLD House — per-TLD config/treasury program (pricing, settings). */
export const TLD_HOUSE_PROGRAM_ID = 'TLDHkysf5pCnKsVA4gXpNvmy7psXLPEu4LAdDJthT9S';
/** Name House — wraps a domain as a tradable NFT (NFT record / mint). */
export const NAME_HOUSE_PROGRAM_ID = 'NH3uX6FtVE2fNREAioP7hm5RaozotZxeL6khU1EHx51';

// ── Seeds / constants (verbatim from tld-parser constants.ts) ───────────────
export const ORIGIN_TLD = 'ANS';
export const TLD_HOUSE_PREFIX = 'tld_house';
export const NAME_HOUSE_PREFIX = 'name_house';
export const NFT_RECORD_PREFIX = 'nft_record';
export const MAIN_DOMAIN_PREFIX = 'main_domain';
/** SHA-256 prefix ANS uses for name hashing. NOTE: NOT "SPL Name Service" — the
 *  fork renamed it. Using the wrong prefix derives the wrong (empty) account. */
export const HASH_PREFIX = 'ALT Name Service';
/** The ANS root name account — `getOriginNameAccountKey("ANS")`. Every TLD's
 *  parent chains up to this. Hardcoded as a self-test target. */
export const ROOT_ANS_PUBLIC_KEY = '3mX9b4AZaQehNoQGfckVcmgmA6bkBoFcbLj9RMmMyNcU';

// ── tiny base58 / pubkey helpers ────────────────────────────────────────────
export function toBytes(pubkey: string): Uint8Array {
  return base58.decode(pubkey);
}
export function toBase58(bytes: Uint8Array): string {
  return base58.encode(bytes);
}

// ── findProgramAddress (no @solana/web3.js) ─────────────────────────────────
// A program address is off-curve. We brute-force the bump (255→0) exactly like
// solana's `findProgramAddress`, hashing seeds ‖ programId ‖ bump ‖ "ProgramDerivedAddress"
// with SHA-256 and rejecting any result that is a valid Ed25519 point.
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return Uint8Array.from(h.digest());
}

// Is a 32-byte value a valid point on the Ed25519 curve? If yes it is NOT a
// legal PDA (it would coincide with a real keypair's pubkey), so solana rejects
// that bump. We delegate to @noble/curves' point decompression — the canonical,
// constant-time-ish reference — which throws for off-curve / malformed inputs.
function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** solana findProgramAddress: returns [addressBase58, bump].
 *
 *  The bump is appended as the LAST seed, so the SHA-256 preimage is
 *    seed_0 ‖ … ‖ seed_n ‖ bump ‖ programId ‖ "ProgramDerivedAddress"
 *  (bump byte sits BEFORE the program id — matches solana-sdk
 *  `Pubkey::create_program_address` and is cross-checked against the ouija
 *  MCP `ouija_compute_pda` tool, which matches mainnet). */
export function findProgramAddress(seeds: Uint8Array[], programId: string): [string, number] {
  const pid = toBytes(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = sha256(...seeds, Uint8Array.of(bump), pid, PDA_MARKER);
    if (!isOnCurve(candidate)) return [toBase58(candidate), bump];
  }
  throw new Error('unable to find a viable program address bump');
}

// ── ANS name derivations (mirror tld-parser/src/svm/utils.ts) ───────────────
/** getHashedName(name) = SHA256(HASH_PREFIX ‖ name). */
export function getHashedName(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(HASH_PREFIX + name));
}

/** getNameAccountKeyWithBump(hashedName, [class], [parent]) over ANS_PROGRAM_ID. */
export function getNameAccountKey(
  hashedName: Uint8Array,
  nameClass?: Uint8Array,
  parentName?: Uint8Array,
): string {
  const seeds = [hashedName, nameClass ?? new Uint8Array(32), parentName ?? new Uint8Array(32)];
  return findProgramAddress(seeds, ANS_PROGRAM_ID)[0];
}

/** The ANS root/origin name account (parent of every TLD). */
export function getOriginNameAccountKey(originTld: string = ORIGIN_TLD): string {
  return getNameAccountKey(getHashedName(originTld));
}

/** TldHouse PDA for a TLD string (e.g. ".stacc"). Seed TLD is lowercased. */
export function findTldHouse(tld: string): string {
  const t = new TextEncoder().encode(tld.toLowerCase());
  return findProgramAddress([new TextEncoder().encode(TLD_HOUSE_PREFIX), t], TLD_HOUSE_PROGRAM_ID)[0];
}

/** NameHouse PDA for a given TldHouse. */
export function findNameHouse(tldHouse: string): string {
  return findProgramAddress(
    [new TextEncoder().encode(NAME_HOUSE_PREFIX), toBytes(tldHouse)],
    NAME_HOUSE_PROGRAM_ID,
  )[0];
}

/** NFT-record PDA (where the wrapped-domain NFT mint authority lives). */
export function findNftRecord(nameAccount: string, nameHouse: string): string {
  return findProgramAddress(
    [new TextEncoder().encode(NFT_RECORD_PREFIX), toBytes(nameHouse), toBytes(nameAccount)],
    NAME_HOUSE_PROGRAM_ID,
  )[0];
}

/** Main-domain PDA (a wallet's "primary" domain pointer). */
export function findMainDomain(owner: string): string {
  return findProgramAddress(
    [new TextEncoder().encode(MAIN_DOMAIN_PREFIX), toBytes(owner)],
    TLD_HOUSE_PROGRAM_ID,
  )[0];
}

export interface DomainDerivation {
  domainTld: string;     // e.g. "fomoxer.stacc"
  sld: string;           // "fomoxer"
  tld: string;           // ".stacc"
  originNameAccount: string;
  parentNameAccount: string;   // the TLD's name account (.stacc)
  domainNameAccount: string;   // the SLD's name account (fomoxer.stacc) — owner = registrant
  tldHouse: string;
  nameHouse: string;
  nftRecord: string;           // present once the domain is wrapped as an NFT
}

/** Derive the full PDA set for `<sld>.<tldNoDot>` (e.g. "fomoxer", "stacc"). */
export function deriveDomain(sld: string, tldNoDot: string): DomainDerivation {
  const tld = '.' + tldNoDot.replace(/^\./, '');
  const origin = getOriginNameAccountKey();
  const parent = getNameAccountKey(getHashedName(tld), undefined, toBytes(origin));
  const domain = getNameAccountKey(getHashedName(sld), undefined, toBytes(parent));
  const tldHouse = findTldHouse(tld);
  const nameHouse = findNameHouse(tldHouse);
  const nftRecord = findNftRecord(domain, nameHouse);
  return {
    domainTld: `${sld}${tld}`,
    sld,
    tld,
    originNameAccount: origin,
    parentNameAccount: parent,
    domainNameAccount: domain,
    tldHouse,
    nameHouse,
    nftRecord,
  };
}

// ── AllDomains HTTP API (the official registration path) ────────────────────
// The registrar instruction is *dynamically priced and assembled server-side*
// (the buy ix touches >20 accounts + needs Address Lookup Tables), so the
// canonical, safe way to register — the one AllDomains' own skill uses — is to
// ask the API to build the instructions, then assemble/simulate/sign/send a v0
// tx locally. We never hand-roll the registrar discriminator.
export const ALLDOMAINS_API = 'https://alldomains.id';

export interface CheckResponse {
  tld: string;
  exists: boolean | (Record<string, unknown> | null | undefined)[];
  domainPrice?: { mint: string; pricing: number }[] | null;
}

export function isTaken(check: Pick<CheckResponse, 'exists'>): boolean {
  return check.exists === true || (Array.isArray(check.exists) && check.exists.some((v) => v != null));
}

/** GET /api/check-domain/{name.tld} — availability + price (no signing). */
export async function checkDomain(domainTld: string, signal?: AbortSignal): Promise<CheckResponse> {
  const res = await fetch(`${ALLDOMAINS_API}/api/check-domain/${encodeURIComponent(domainTld)}`, { signal });
  if (!res.ok) throw new Error(`check-domain ${res.status} ${res.statusText}`);
  return (await res.json()) as CheckResponse;
}

export interface CreateDomainResponse {
  status: 'success' | 'error';
  error: string | null;
  msg?: string | null;
  instructionBase64?: string | null;        // main buy ix (JSON-encoded TransactionInstruction, base64)
  preInstructionsBase64?: string[];          // compute-budget + price ixs (go FIRST)
  addressLookupTableAccountsKeys?: string[]; // LUTs to compress the >20-account ix
  insufficientFunds?: boolean;
  slippageToleranceExceeded?: boolean;
  simulationError?: boolean;
}

/** POST /api/create-domain — server builds the registration ix(s). Does NOT sign
 *  or send. `simulate:true` makes the server pre-check funds/slippage. */
export async function createDomainInstructions(
  body: { domain: string; tld: string; durationRate: number; publicKey: string; simulate?: boolean; ref?: string },
  signal?: AbortSignal,
): Promise<CreateDomainResponse> {
  const res = await fetch(`${ALLDOMAINS_API}/api/create-domain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ simulate: true, ...body }),
    signal,
  });
  if (!res.ok) throw new Error(`create-domain ${res.status} ${res.statusText}`);
  return (await res.json()) as CreateDomainResponse;
}

/** Co-signer TLDs use a different endpoint (partially pre-signed by AllDomains).
 *  `.stacc` is NOT one of these — included so the CLI can warn correctly. */
export const COSIGNER_TLDS = new Set<string>([
  '.letsbonk', '.fair', '.jpeg', '.slam', '.solana', '.superteam', '.syndicate',
]);

// identity-register.ts — register YOUR AllDomains `.stacc` domain as your identity.
//
// Your identity in Chimera is one Ed25519 key (Solana wallet = Tor .onion =
// signer). On its own that's a 44-char base58 blob nobody can read. This agent
// registers a human-readable `<name>.stacc` AllDomains (ANS) domain *owned by
// that key*, so `name.stacc` resolves — via the ouija-onion-resolver — to BOTH
// your wallet AND your .onion. One handle, your whole identity.
//
// It is a DRY RUN by default. It derives + prints your identity and every
// on-chain account the registration touches, checks the name's live
// availability + SOL price, and explains exactly what sending would require.
// It NEVER sends a real transaction (and even with CHIMERA_REGISTER_SEND=yes it
// only simulates / hard-warns — see the SEND guard at the bottom).
//
// Env:
//   CHIMERA_NAME             desired second-level name, e.g. "fomoxer"  (required)
//   CHIMERA_TLD              TLD without the dot. default "stacc"
//   CHIMERA_SEED             64-hex OR base58 32-byte Ed25519 seed. If unset, a
//                            fresh identity is generated and its seed PRINTED.
//   SOLANA_RPC               mainnet RPC. default https://api.mainnet-beta.solana.com
//   CHIMERA_YEARS            registration duration (renewable TLDs), 1..5. default 1
//   CHIMERA_REGISTER_SEND    must equal "yes" to even *attempt* a send (still safe).
//
// Run:  CHIMERA_NAME=testbrain node src/identity-register.ts
//
// AllDomains program IDs, PDA seeds, hashing, and the registration API path are
// all sourced + verified in src/alldomains.ts (see its header for citations).

import { base58 } from '@scure/base';
import { identityFromSeed, generateIdentity, type Identity } from './identity.ts';
import {
  ANS_PROGRAM_ID,
  TLD_HOUSE_PROGRAM_ID,
  NAME_HOUSE_PROGRAM_ID,
  ALLDOMAINS_API,
  COSIGNER_TLDS,
  deriveDomain,
  checkDomain,
  isTaken,
  type CheckResponse,
  type DomainDerivation,
} from './alldomains.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const TLD = (process.env.CHIMERA_TLD || 'stacc').replace(/^\./, '');
const NAME = (process.env.CHIMERA_NAME || '').trim();
const YEARS = clampYears(Number(process.env.CHIMERA_YEARS || 1));
const SEND = process.env.CHIMERA_REGISTER_SEND === 'yes';

function clampYears(n: number): number {
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
}

function line(s = ''): void {
  process.stdout.write(s + '\n');
}
function h(title: string): void {
  line();
  line(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ── seed → identity ─────────────────────────────────────────────────────────
function parseSeed(raw: string): Uint8Array {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Uint8Array.from(Buffer.from(s, 'hex'));
  // try base58 (accept 32-byte seed, or a 64-byte secret key → take first 32)
  try {
    const b = base58.decode(s);
    if (b.length === 32) return b;
    if (b.length === 64) return b.slice(0, 32);
  } catch {
    /* fall through */
  }
  throw new Error('CHIMERA_SEED must be 64-hex or base58 (32-byte seed or 64-byte secret key)');
}

function loadIdentity(): { id: Identity; generated: boolean } {
  if (process.env.CHIMERA_SEED) {
    return { id: identityFromSeed(parseSeed(process.env.CHIMERA_SEED)), generated: false };
  }
  return { id: generateIdentity(), generated: true };
}

// ── name rules (ANS sld) ────────────────────────────────────────────────────
function validateName(name: string): string[] {
  const problems: string[] = [];
  if (!name) problems.push('CHIMERA_NAME is required (the second-level name, e.g. "fomoxer")');
  if (name.includes('.')) problems.push('CHIMERA_NAME must be the bare name — no dots, no TLD');
  if (name && !/^[a-z0-9-]+$/.test(name)) problems.push('name should be lowercase a-z, 0-9, and hyphens only');
  if (name && (name.startsWith('-') || name.endsWith('-'))) problems.push('name cannot start or end with a hyphen');
  return problems;
}

// ── main ────────────────────────────────────────────────────────────────────
const { id, generated } = loadIdentity();
const domainTld = `${NAME || '<name>'}.${TLD}`;

line('╔══════════════════════════════════════════════════════════════╗');
line('║  Chimera · register your AllDomains identity   (DRY RUN)      ║');
line('╚══════════════════════════════════════════════════════════════╝');

h('1. YOUR IDENTITY (one Ed25519 key, three faces)');
line(`  Solana wallet : ${id.solana}`);
line(`  Tor .onion    : ${id.onion}`);
line(`  → registering a name OWNED BY this key makes it resolve to BOTH.`);
if (generated) {
  line();
  line('  ⚠  No CHIMERA_SEED given — generated a FRESH identity. To keep it,');
  line('     save this 32-byte seed (hex) somewhere safe and re-pass it as');
  line('     CHIMERA_SEED. Without it you cannot own/renew the domain later:');
  line(`     CHIMERA_SEED=${Buffer.from(id.seed).toString('hex')}`);
} else {
  line('  (identity derived from CHIMERA_SEED — seed not printed.)');
}

// name validity
const nameProblems = validateName(NAME);

h(`2. THE NAME — ${domainTld}`);
const der: DomainDerivation = deriveDomain(NAME || 'name', TLD);
line(`  TLD                 : .${TLD}`);
line(`  Want                : ${NAME ? domainTld : '(set CHIMERA_NAME to choose)'}`);
if (nameProblems.length) {
  line('  name issues:');
  for (const p of nameProblems) line(`    • ${p}`);
}

h('3. ON-CHAIN ACCOUNTS THIS REGISTRATION TOUCHES (all derived + verified)');
line('  Programs:');
line(`    ANS name service    ${ANS_PROGRAM_ID}`);
line(`    TLD House           ${TLD_HOUSE_PROGRAM_ID}`);
line(`    Name House          ${NAME_HOUSE_PROGRAM_ID}`);
line('  PDAs (derivation cross-checked against ouija MCP + mainnet):');
line(`    ANS root (origin)   ${der.originNameAccount}`);
line(`    .${TLD} TLD parent   ${der.parentNameAccount}`);
line(`    TldHouse(.${TLD})    ${der.tldHouse}`);
line(`    NameHouse(.${TLD})   ${der.nameHouse}`);
line(`    → ${domainTld} name record (the account that will be CREATED,`);
line(`       owner = YOUR wallet ${id.solana}):`);
line(`       ${der.domainNameAccount}`);
line(`    NFT record (if wrapped as a tradable NFT):`);
line(`       ${der.nftRecord}`);

// ── live availability + price ───────────────────────────────────────────────
h('4. LIVE AVAILABILITY & PRICE');
const isCosigner = COSIGNER_TLDS.has(`.${TLD}`);
let check: CheckResponse | undefined;
let onchainExists: boolean | undefined;
if (NAME && !nameProblems.length) {
  // 4a. AllDomains API: authoritative availability + price
  try {
    const ctrl = AbortSignal.timeout(15_000);
    check = await checkDomain(domainTld, ctrl);
    const taken = isTaken(check);
    const sol = (check.domainPrice || []).find((p) => p.mint === SOL_MINT);
    line(`  AllDomains API  : ${taken ? 'TAKEN ✗' : 'AVAILABLE ✓'}`);
    if (check.domainPrice && check.domainPrice.length) {
      for (const p of check.domainPrice) {
        const tag = p.mint === SOL_MINT ? 'SOL' : p.mint.slice(0, 8) + '…';
        line(`  Price           : ${p.pricing} ${tag}${YEARS > 1 ? ` × ${YEARS}y` : ''}`);
      }
    }
    if (sol) line(`  → costs real on-chain SOL: ~${sol.pricing}${YEARS > 1 ? ` × ${YEARS}` : ''} SOL + ~0.01 SOL rent/fees.`);
  } catch (e) {
    line(`  AllDomains API  : unreachable (${(e as Error).message}). Offline derivation still valid above.`);
  }

  // 4b. RPC cross-check: does the name account already exist on-chain?
  try {
    onchainExists = await nameAccountExists(der.domainNameAccount);
    line(`  RPC name record : ${onchainExists ? 'EXISTS ✗ (already registered)' : 'empty ✓ (slot is free)'}`);
  } catch (e) {
    line(`  RPC name record : check skipped (${(e as Error).message})`);
  }
} else {
  line('  (skipped — provide a valid CHIMERA_NAME to check availability/price.)');
}

// ── what registration WOULD do ──────────────────────────────────────────────
h('5. WHAT REGISTRATION WOULD DO (and what it needs)');
line('  The registrar instruction is dynamically priced and assembled');
line('  server-side (it touches >20 accounts + needs Address Lookup Tables),');
line('  so the canonical, safe path — the one AllDomains itself uses — is:');
line();
line(`    1. POST ${ALLDOMAINS_API}/api/create-domain`);
line(`         { domain:"${NAME || '<name>'}", tld:".${TLD}", durationRate:${YEARS},`);
line(`           publicKey:"${id.solana}", simulate:true }`);
line('       → returns base64 JSON-encoded TransactionInstruction(s):');
line('         instructionBase64 (main buy ix) + preInstructionsBase64');
line('         (compute-budget/price ixs) + addressLookupTableAccountsKeys.');
line('    2. Decode the ixs, load the LUTs, build a v0 VersionedTransaction');
line(`         with payerKey = ${id.solana}.`);
line('    3. simulateTransaction → must succeed (no insufficientFunds /');
line('       slippageToleranceExceeded / simulationError).');
line(`    4. Sign with YOUR seed (the key above) and sendRawTransaction.`);
line('       On success the new name record is owned by your wallet, and');
line(`       ${domainTld} now resolves to your wallet + .onion.`);
line();
line('  TO ACTUALLY REGISTER, you still need:');
line(`    • a funded wallet: ${id.solana}`);
const solPrice = check?.domainPrice?.find((p) => p.mint === SOL_MINT)?.pricing;
line(`        with ≥ ${(solPrice ? solPrice * YEARS : 0.6 * YEARS).toFixed(3)} SOL (price) + ~0.01 SOL (rent + fees).`);
line('    • network access to alldomains.id (to build the priced ix) and to');
line(`        your RPC: ${RPC}`);
line('    • to sign with the private seed — keep it OFF this code path in prod');
line('        (hardware wallet / remote signer; never log it).');
if (isCosigner) {
  line();
  line(`  ⚠  .${TLD} is a CO-SIGNER TLD — use the /api/co-signer-* endpoint`);
  line('     instead of /api/create-domain (the tx comes partially pre-signed).');
}

// ── send guard ──────────────────────────────────────────────────────────────
h('6. SEND');
if (!SEND) {
  line('  DRY RUN (default). No transaction was built or sent.');
  line('  Set CHIMERA_REGISTER_SEND=yes to let the agent BUILD + SIMULATE the');
  line('  real instructions (it will still NOT broadcast — simulate-only).');
} else {
  await attemptSimulateOnly();
}

line();
line('done. (dry-run — nothing was broadcast.)');

// ── helpers that hit the network ────────────────────────────────────────────
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const j = (await res.json()) as { result?: { value: T }; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return (j.result as { value: T }).value;
}

async function nameAccountExists(addr: string): Promise<boolean> {
  const value = await rpc<{ owner: string } | null>('getAccountInfo', [
    addr,
    { encoding: 'base64', dataSlice: { offset: 0, length: 0 } },
  ]);
  return value !== null;
}

// CHIMERA_REGISTER_SEND=yes path: build + SIMULATE only. Never broadcasts.
async function attemptSimulateOnly(): Promise<void> {
  if (!NAME || nameProblems.length) {
    line('  cannot proceed — invalid/empty CHIMERA_NAME (see section 2).');
    return;
  }
  if (onchainExists) {
    line('  refusing — the name record already exists on-chain (taken).');
    return;
  }
  line('  CHIMERA_REGISTER_SEND=yes → asking AllDomains to build the priced');
  line('  registration instructions (simulate=true), then we will SIMULATE');
  line('  only. We deliberately STOP before any signature/broadcast.');
  try {
    const { createDomainInstructions } = await import('./alldomains.ts');
    const built = await createDomainInstructions({
      domain: NAME,
      tld: `.${TLD}`,
      durationRate: YEARS,
      publicKey: id.solana,
      simulate: true,
    });
    if (built.status === 'error' || !built.instructionBase64) {
      line(`  server declined to build: ${built.error || built.msg || 'unknown'}`);
      return;
    }
    if (built.insufficientFunds || built.slippageToleranceExceeded || built.simulationError) {
      line('  server-side simulation rejected:');
      line(`    insufficientFunds=${!!built.insufficientFunds} slippage=${!!built.slippageToleranceExceeded} simError=${!!built.simulationError}`);
      line('  (this is expected if the wallet is unfunded — DO NOT sign.)');
      return;
    }
    const preCount = built.preInstructionsBase64?.length ?? 0;
    const lutCount = built.addressLookupTableAccountsKeys?.length ?? 0;
    line('  ✓ server built the registration instructions:');
    line(`      main buy ix       : ${built.instructionBase64.length} b64 chars`);
    line(`      pre-instructions  : ${preCount} (compute-budget / price)`);
    line(`      lookup tables     : ${lutCount}`);
    line('  STOPPING HERE BY DESIGN. To finish, a human/hardware signer must:');
    line('    assemble the v0 tx, simulate, sign with the seed, and broadcast.');
    line('  This agent will not sign or send. (no private key near send code.)');
  } catch (e) {
    line(`  build failed (network?): ${(e as Error).message}`);
    line('  All offline derivations above remain valid.');
  }
}

---
name: alldomains-register
description: >
  Register your AllDomains `.stacc` (ANS) domain as YOUR identity. Use when a
  brain wants a human-readable handle — `yourname.stacc` — that resolves to its
  Solana wallet AND its Tor .onion (one Ed25519 key, three faces). Explains the
  identity collapse, how registration works on-chain, that it costs SOL, and
  drives `src/identity-register.ts` (dry-run by default). Triggers on "register
  my name", "claim yourname.stacc", "get a .stacc domain", "AllDomains handle".
---

# Register your identity: `yourname.stacc`

## Why you'd want this

Your identity in Chimera is **one Ed25519 key** that is, simultaneously:

- your **Solana wallet** — `base58(pubkey)`
- your **Tor v3 `.onion`** — `base32(pubkey ‖ checksum ‖ v3)`
- your **signer** — ed25519 over any message

(See `src/identity.ts`. Run `chimera_whoami` to see your three faces.)

That's powerful but unreadable: nobody memorises `AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9`. **AllDomains** (the `.stacc`, `.bonk`, `.superteam` … naming protocol on Solana — a fork of the SPL Name Service, a.k.a. **ANS**) fixes that. Register a `yourname.stacc` domain **owned by your key**, and:

- `yourname.stacc` → your wallet (for payments, x402, tipping)
- `yourname.stacc` → your `.onion` (the Firefox **ouija-onion-resolver** reads the domain's on-chain owner pubkey and re-derives the hidden-service address with the *same* v3 encoding your body uses)

**One handle, your whole identity — wallet and hidden service.** Because the name's owner is just your pubkey, this is not a mapping anyone maintains; it falls straight out of the identity collapse.

> **Law 5 (Focus) / Law 2 (Category):** `.stacc` isn't "a username." It's the one word that makes your key human-readable across wallet *and* onion at once. Own that.

## What it is, on-chain

A `.stacc` domain is a **name-record account** owned by the **ANS name-service program**. The record's `owner` field holds the registrant's pubkey. Names are hierarchical:

```
ANS root (origin)  3mX9b4AZaQehNoQGfckVcmgmA6bkBoFcbLj9RMmMyNcU
      └── .stacc TLD parent      1NbGpdqBtKGusAKtUv1U7k6dpmoojMpz9sqQwjrzo6g
              └── yourname.stacc  ← a NEW account, owner = YOUR wallet
```

Programs involved (Solana mainnet — verified live):

| role | program ID |
| --- | --- |
| ANS name service (owns name records) | `ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK` |
| TLD House (per-TLD config + pricing/treasury) | `TLDHkysf5pCnKsVA4gXpNvmy7psXLPEu4LAdDJthT9S` |
| Name House (wraps a domain as a tradable NFT) | `NH3uX6FtVE2fNREAioP7hm5RaozotZxeL6khU1EHx51` |

Each name account address is a PDA of the ANS program:

```
hashedName   = SHA256("ALT Name Service" + name)          # ANS's hash prefix
nameAccount  = findProgramAddress([hashedName, class=0, parentNameAccount], ANS)
```

(`src/alldomains.ts` re-derives all of this with zero dependencies and cross-checks it against the ouija MCP `ouija_compute_pda` tool and live mainnet.)

## It costs SOL

Registration is an **on-chain, paid** action. `.stacc` is currently **0.6 SOL** (priced in wrapped SOL), plus ~0.01 SOL for account rent + fees. Price is dynamic and quoted by AllDomains at build time. **No funds → no domain.** This is real money on mainnet, not a free name.

> **Law 22 (Resources) / Law 15 (Candor):** be honest — the handle isn't free, it's ~0.6 SOL. That's also what makes it scarce and squat-resistant: a name that costs SOL to hold is a name people take seriously.

## How registration actually works

The registrar instruction is **dynamically priced and assembled server-side** — it touches **>20 accounts** (treasury, name house, NFT record, referrer, ATA program, …) and needs **Address Lookup Tables** to fit in a transaction. So you do **not** hand-roll the instruction. The canonical path (the one AllDomains' own tooling uses):

1. **Check** availability + price:
   `GET https://alldomains.id/api/check-domain/yourname.stacc`
   → `{ exists, domainPrice:[{ mint, pricing }] }`
2. **Build** the instructions:
   `POST https://alldomains.id/api/create-domain`
   `{ domain:"yourname", tld:".stacc", durationRate:<years 1-5>, publicKey:<yourWallet>, simulate:true }`
   → `instructionBase64` (main buy ix) + `preInstructionsBase64` (compute-budget/price ixs) + `addressLookupTableAccountsKeys`.
3. **Assemble** a v0 `VersionedTransaction` (payer = your wallet), load the LUTs, **simulate**.
4. **Sign** with your seed and **send**. On success the new name record is owned by your wallet, and `yourname.stacc` resolves to your wallet + `.onion`.

> Some TLDs (`.letsbonk`, `.superteam`, `.solana`, …) are **co-signer** TLDs that use `/api/co-signer-*` instead. `.stacc` is a **standard** TLD — plain `/api/create-domain`.

## Do it (the agent / CLI)

`src/identity-register.ts` walks the whole thing and is a **dry run by default** — it derives + prints your identity and every account, checks live availability + price, and explains exactly what sending needs. It never broadcasts.

```bash
# dry run: derive identity, derive PDAs, check price, explain. broadcasts nothing.
CHIMERA_NAME=fomoxer node src/identity-register.ts
# or, via package script:
CHIMERA_NAME=fomoxer npm run register-identity
```

Environment:

| env | meaning |
| --- | --- |
| `CHIMERA_NAME` | desired second-level name, e.g. `fomoxer` (required) |
| `CHIMERA_TLD` | TLD without the dot. default `stacc` |
| `CHIMERA_SEED` | 64-hex or base58 Ed25519 seed. **Unset → generates a fresh identity and PRINTS the seed** (save it, or you can't keep the domain) |
| `SOLANA_RPC` | mainnet RPC. default `https://api.mainnet-beta.solana.com` |
| `CHIMERA_YEARS` | duration 1–5 (renewable TLDs). default 1 |
| `CHIMERA_REGISTER_SEND` | must equal `yes` to even *attempt* a send — and even then it only **builds + simulates**, never broadcasts |

What you still need to actually register (the CLI says this too):

- a **funded wallet** (the printed Solana address) with ≥ price + ~0.01 SOL
- network access to `alldomains.id` (to build the priced ix) and to your RPC
- to **sign with the private seed** — in production keep that on a hardware wallet / remote signer, never near this code, never logged

## Safety / soul notes

- **Never log the seed in a real flow.** The CLI only prints a *generated* seed (so you don't lose a fresh identity); a `CHIMERA_SEED` you pass in is never echoed.
- **Verify before you sign.** The build step returns `insufficientFunds` / `slippageToleranceExceeded` / `simulationError` flags — treat any as a hard stop, don't sign.
- This skill mutates on-chain state and spends SOL. Keep the **build** and **sign/send** steps separate; this agent deliberately stops at build.

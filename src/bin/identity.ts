// identity.ts (cli) — the collapse, standalone.
//
//   node src/bin/identity.ts                 → mint a fresh identity (all 3 faces)
//   node src/bin/identity.ts <solanaAddress> → that wallet's .onion
//   node src/bin/identity.ts <addr>.onion    → that hidden service's wallet

import { generateIdentity, solanaToOnion, onionToSolana } from '../identity.ts';

const arg = process.argv[2];

if (!arg) {
  const id = generateIdentity();
  console.log(
    JSON.stringify(
      {
        solana: id.solana,
        onion: id.onion,
        pubkeyHex: Buffer.from(id.publicKey).toString('hex'),
      },
      null,
      2,
    ),
  );
} else if (arg.toLowerCase().endsWith('.onion') || arg.length >= 56) {
  console.log(onionToSolana(arg));
} else {
  console.log(solanaToOnion(arg));
}

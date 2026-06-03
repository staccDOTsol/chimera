// payment.ts — the x402 settlement gate.
//
// Running another brain's METERED capability costs a micropayment to its author.
// The payee is just the author's Solana address — which is also its .onion — so
// settlement and addressing are the same key (identity collapse again).
//
// Two implementations behind one interface:
//   • MockPaymentGate     — the default. No network, no chain writes. Lets the
//                           trust/graft loop run end-to-end with zero config.
//   • Fomox402PaymentGate — the real rail. Performs the x402 handshake against
//                           the fomox402 broker (HTTP 402 → settle on Solana →
//                           receipt). Only ever constructed when the env is
//                           configured; otherwise we transparently use the mock.
//
// The interface IS the contract: body.ts depends only on `PaymentGate` and the
// `PaymentReceipt` shape, so nothing in the body changes when the real rail
// lands. `makePaymentGate()` is the single switch — real if configured, else mock.

import type { Identity } from './identity.ts';
import {
  Fomox402Client,
  fomox402ConfigFromEnv,
  settleViaFomox402,
  type Fomox402Config,
} from './fomox402.ts';

export interface PaymentReceipt {
  ok: boolean;
  payer: string;
  payee: string;
  amountMicroUsdc: number;
  reference: string;
  rail: string;
}

export interface PaymentGate {
  settle(payer: Identity, payee: string, amountMicroUsdc: number, memo: string): Promise<PaymentReceipt>;
}

export class MockPaymentGate implements PaymentGate {
  async settle(payer: Identity, payee: string, amountMicroUsdc: number, memo: string): Promise<PaymentReceipt> {
    const reference = `x402mock:${payer.solana.slice(0, 6)}->${payee.slice(0, 6)}:${amountMicroUsdc}:${memo.slice(0, 24)}`;
    return { ok: true, payer: payer.solana, payee, amountMicroUsdc, reference, rail: 'x402:mock' };
  }
}

/**
 * The REAL x402 settlement gate, riding the fomox402 broker.
 *
 * settle() runs the fomox402 x402 flow (see fomox402.ts for the wire detail):
 *   leg 1  POST /v1/x402/quote → { nonce, payTo, amountRaw, mint }   (the 402
 *          payment requirements — what to pay, where, under which nonce)
 *   leg 2  POST /v1/x402/pay   → broker signs an on-chain SPL transfer of the
 *          quoted asset to payTo with the nonce as a memo, from the wallet the
 *          api_key owns, and returns the settlement tx signature.
 *   receipt the confirmed on-chain signature becomes PaymentReceipt.reference.
 *
 * SAFETY: leg 2 moves real value. The gate broadcasts it ONLY when `dryRun` is
 * false. With dryRun=true (FOMOX402_DRY_RUN=1) it verifies the rail through
 * leg 1 and returns a receipt referencing the verified-but-unsettled quote —
 * nothing is spent. A failed settlement degrades to `ok:false` (the body then
 * aborts the graft) rather than throwing, so one bad payment never crashes the
 * body.
 *
 * NOTE on denomination: the PaymentGate contract is denominated in micro-USDC
 * at the application layer; the on-chain leg settles in whatever asset the
 * broker quotes (the live broker quotes its $fomox402 mint). We keep the
 * caller's micro-USDC amount on the receipt and append the on-chain asset/amount
 * to the reference so the receipt never lies about what actually moved.
 */
export class Fomox402PaymentGate implements PaymentGate {
  // Explicit fields, NOT constructor parameter properties — Node's strip-only
  // TS mode (bare `node src/*.ts`) does not support those.
  private readonly client: Fomox402Client;
  private readonly dryRun: boolean;
  private readonly log: (line: string) => void;

  constructor(cfg: Fomox402Config, log: (line: string) => void = () => {}) {
    this.client = new Fomox402Client(cfg);
    this.dryRun = cfg.dryRun;
    this.log = log;
  }

  async settle(payer: Identity, payee: string, amountMicroUsdc: number, memo: string): Promise<PaymentReceipt> {
    try {
      const outcome = await settleViaFomox402(this.client, { dryRun: this.dryRun });
      if (!outcome.ok) {
        this.log(`x402 settle not ok (memo=${memo.slice(0, 32)})`);
        return { ok: false, payer: payer.solana, payee, amountMicroUsdc, reference: 'x402:unsettled', rail: 'x402:fomox402' };
      }
      const q = outcome.quote;
      const reference = outcome.dryRun
        ? `x402dry:${q.nonce}:${q.amountRaw}@${q.mint.slice(0, 6)}->${q.payTo.slice(0, 6)}`
        : `${outcome.txSig}:${q.amountRaw}@${q.mint.slice(0, 6)}->${q.payTo.slice(0, 6)}`;
      this.log(
        outcome.dryRun
          ? `x402 dry-run verified (no spend) nonce=${q.nonce} payTo=${q.payTo.slice(0, 8)}…`
          : `x402 settled on-chain tx=${outcome.txSig} → payTo=${q.payTo.slice(0, 8)}…`,
      );
      return {
        ok: true,
        payer: payer.solana,
        payee,
        amountMicroUsdc,
        reference,
        rail: outcome.dryRun ? 'x402:fomox402:dry-run' : 'x402:fomox402',
      };
    } catch (e) {
      this.log(`x402 settle failed: ${(e as Error).message}`);
      return { ok: false, payer: payer.solana, payee, amountMicroUsdc, reference: 'x402:error', rail: 'x402:fomox402' };
    }
  }
}

/**
 * Pick the payment rail. Returns the REAL Fomox402PaymentGate when the env is
 * configured (FOMOX402_API_KEY present), otherwise the MockPaymentGate so an
 * unconfigured deploy — and the demo — keeps working with zero setup.
 *
 * This is the one place that decides real-vs-mock; every entrypoint
 * (demo/mcp/web/agent) can call it instead of `new MockPaymentGate()` to opt
 * into the real rail purely via env, with no code change.
 */
export function makePaymentGate(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = () => {},
): PaymentGate {
  const cfg = fomox402ConfigFromEnv(env);
  if (!cfg) return new MockPaymentGate();
  log(
    `payment rail: fomox402 x402 (${cfg.baseUrl})${cfg.dryRun ? ' [DRY-RUN — no funds move]' : ' [LIVE — real settlement]'}`,
  );
  return new Fomox402PaymentGate(cfg, log);
}

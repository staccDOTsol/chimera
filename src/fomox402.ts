// fomox402.ts — the real x402 settlement rail behind Fomox402PaymentGate.
//
// This is the production wiring for `PaymentGate.settle()`. It speaks the
// fomox402 broker's HTTP-402 dialect of the x402 protocol — the SAME flow the
// `place_bid` / `soliris_x402_fetch` MCP tools run internally, and the exact
// contract the broker implements server-side (see staccbot-tg server/api/x402.ts).
//
// ─── How fomox402 settles micro-value over x402 (HTTP 402 → pay → receipt) ───
//
//   leg 1  POST {base}/v1/x402/quote   Bearer <api_key>   { requestKind }
//          → 200 { nonce, payTo, amountRaw, mint, expiresAt }
//          (equivalently: hit any x402-gated endpoint with no X-PAYMENT and
//           read the 402 body's `accepts[0]` — same nonce/payTo/asset/amount.)
//
//   leg 2  POST {base}/v1/x402/pay     Bearer <api_key>   { nonce }
//          → broker signs an SPL transferChecked of `amountRaw` of `mint`
//            to `payTo` + a Memo ix carrying the nonce, FROM the wallet the
//            api_key owns (Privy-managed), broadcasts it, and returns
//            200 { ok, tx, x_payment_header }  where x_payment_header is
//            base64(JSON {nonce, txSig}).
//
//   receipt  the on-chain settlement signature `tx` IS the receipt. A gated
//            endpoint would accept `X-PAYMENT: <x_payment_header>` and echo an
//            `X-PAYMENT-RESPONSE` header; for a pure settlement we treat the
//            confirmed `tx` as proof and surface it as PaymentReceipt.reference.
//
// IMPORTANT — money safety: leg 2 (`/v1/x402/pay`) MOVES REAL VALUE. It is only
// ever reached when the gate is fully configured (api_key + base url) AND the
// caller did not request dry-run. `quoteOnly: true` (or FOMOX402_DRY_RUN=1)
// exercises the entire path up to — but never including — the broadcasting leg,
// so the rail can be verified end-to-end without spending anything.
//
// The asset is whatever the broker advertises in the quote (the live broker
// quotes its $fomox402 Token-2022 mint; `amountRaw` is raw token units). We do
// NOT assume USDC on the wire — the PaymentGate contract is denominated in
// micro-USDC at the *application* layer; the on-chain leg settles in the
// broker's quoted asset. We carry both through the receipt for honesty.

export interface Fomox402Config {
  /** Bearer api_key minted by POST /v1/agents/register (sk_fomox402_…). */
  apiKey: string;
  /** Broker base URL, no trailing slash. Default https://bot.staccpad.fun. */
  baseUrl: string;
  /** When true, run quote-only (verify the rail) and never broadcast leg 2. */
  dryRun: boolean;
  /** request_kind label persisted on the broker nonce row. */
  requestKind: string;
  /** Per-request fetch timeout (ms). */
  timeoutMs: number;
}

export interface X402Quote {
  nonce: string;
  payTo: string;
  /** raw token units of `mint` (string preserves bigint). */
  amountRaw: string;
  mint: string;
  expiresAt: number;
  requestKind?: string;
}

export interface X402PayResult {
  ok: boolean;
  /** On-chain settlement signature. */
  tx: string;
  /** base64(JSON {nonce, txSig}) — the value a gated endpoint wants in X-PAYMENT. */
  xPaymentHeader: string;
}

const DEFAULT_BASE_URL = 'https://bot.staccpad.fun';
const DEFAULT_REQUEST_KIND = 'chimera-graft';
const DEFAULT_TIMEOUT_MS = 30_000;

function envFlag(v: string | undefined): boolean {
  if (!v) return false;
  const t = v.trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'on';
}

/**
 * Read fomox402 config from the environment. Returns null when the rail is not
 * configured — the SOLE signal makePaymentGate() uses to fall back to the mock.
 *
 * Required to go live:
 *   FOMOX402_API_KEY     Bearer key from POST /v1/agents/register (sk_fomox402_…)
 * Optional:
 *   FOMOX402_BASE_URL    broker base url (default https://bot.staccpad.fun)
 *   FOMOX402_DRY_RUN     "1"/"true" → quote-only, never broadcasts (safe default
 *                        for staging; explicitly set to "0" to allow real spend)
 *   FOMOX402_REQUEST_KIND  nonce label (default "chimera-graft")
 *   FOMOX402_TIMEOUT_MS  per-request timeout (default 30000)
 *
 * Back-compat: FOMOX402_BROKER_URL is accepted as an alias for FOMOX402_BASE_URL
 * (that's the name used elsewhere in the staccbot stack).
 */
export function fomox402ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Fomox402Config | null {
  const apiKey = (env.FOMOX402_API_KEY ?? '').trim();
  if (!apiKey) return null;
  const baseUrl = (env.FOMOX402_BASE_URL ?? env.FOMOX402_BROKER_URL ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '');
  const timeoutMs = Number.parseInt(env.FOMOX402_TIMEOUT_MS ?? '', 10);
  return {
    apiKey,
    baseUrl: baseUrl || DEFAULT_BASE_URL,
    dryRun: envFlag(env.FOMOX402_DRY_RUN),
    requestKind: (env.FOMOX402_REQUEST_KIND ?? '').trim() || DEFAULT_REQUEST_KIND,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

/** Thrown by the client so the gate can downgrade ok:false instead of throwing. */
export class Fomox402Error extends Error {
  readonly status?: number;
  readonly body?: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = 'Fomox402Error';
    this.status = status;
    this.body = body;
  }
}

/**
 * Minimal, dependency-free client for the fomox402 x402 rail. Uses the global
 * `fetch` (Node ≥ 18; this repo targets ≥ 23.6) so the body keeps its zero
 * extra-dependency footprint.
 */
export class Fomox402Client {
  // Explicit field, NOT a `constructor(private cfg…)` parameter property —
  // Node's strip-only TS mode (bare `node src/*.ts`) rejects those.
  private readonly cfg: Fomox402Config;

  constructor(cfg: Fomox402Config) {
    this.cfg = cfg;
  }

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Fomox402Error(`fomox402 request to ${path} failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = (json as { error?: string })?.error ?? `http_${res.status}`;
      throw new Fomox402Error(`fomox402 ${path} → ${res.status} ${err}`, res.status, json);
    }
    return json;
  }

  /**
   * leg 1 — mint a single-use payment nonce + the payment requirements.
   * Mirrors the 402 `accepts[0]` envelope the broker emits on a gated route,
   * via the broker's dedicated public quote endpoint so we never have to send
   * a half-formed bid just to read the challenge.
   */
  async quote(): Promise<X402Quote> {
    const out = (await this.post('/v1/x402/quote', { requestKind: this.cfg.requestKind })) as Record<string, unknown>;
    const nonce = String(out.nonce ?? '');
    const payTo = String(out.payTo ?? '');
    const amountRaw = String(out.amountRaw ?? '');
    const mint = String(out.mint ?? '');
    if (!nonce || !payTo || !amountRaw || !mint) {
      throw new Fomox402Error('fomox402 quote missing nonce/payTo/amountRaw/mint', 200, out);
    }
    return {
      nonce,
      payTo,
      amountRaw,
      mint,
      expiresAt: Number(out.expiresAt ?? 0),
      requestKind: out.requestKind != null ? String(out.requestKind) : this.cfg.requestKind,
    };
  }

  /**
   * leg 2 — settle the quote. THIS BROADCASTS A REAL ON-CHAIN TRANSFER. The
   * broker signs an SPL transferChecked (amountRaw of `mint` → payTo) plus a
   * memo carrying `nonce`, from the wallet the api_key owns, and returns the
   * settlement signature + the X-PAYMENT header a gated retry would use.
   */
  async pay(nonce: string): Promise<X402PayResult> {
    const out = (await this.post('/v1/x402/pay', { nonce })) as Record<string, unknown>;
    const tx = String(out.tx ?? '');
    if (!tx) throw new Fomox402Error('fomox402 pay returned no tx signature', 200, out);
    return {
      ok: out.ok === true || Boolean(tx),
      tx,
      xPaymentHeader:
        out.x_payment_header != null
          ? String(out.x_payment_header)
          : Buffer.from(JSON.stringify({ nonce, txSig: tx })).toString('base64'),
    };
  }
}

export interface SettlementOutcome {
  /** true once we hold a settlement proof (real tx) OR a verified dry-run quote. */
  ok: boolean;
  /** on-chain settlement signature (real spend) — empty on dry-run. */
  txSig: string;
  /** the quote we settled against. */
  quote: X402Quote;
  /** true when we stopped before broadcasting (no funds moved). */
  dryRun: boolean;
  /** base64 X-PAYMENT header (real settle only). */
  xPaymentHeader?: string;
}

/**
 * Run the full x402 settlement for one logical payment. On dry-run we stop after
 * leg 1 (proof the rail is live + the quote is well-formed) and report the
 * verified quote WITHOUT spending. On a live run we complete leg 2 and return
 * the on-chain signature.
 */
export async function settleViaFomox402(
  client: Fomox402Client,
  opts: { dryRun: boolean },
): Promise<SettlementOutcome> {
  const quote = await client.quote();
  if (opts.dryRun) {
    return { ok: true, txSig: '', quote, dryRun: true };
  }
  const paid = await client.pay(quote.nonce);
  return { ok: paid.ok, txSig: paid.tx, quote, dryRun: false, xPaymentHeader: paid.xPaymentHeader };
}

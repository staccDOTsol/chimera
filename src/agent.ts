// agent.ts — a REAL brain. Connects to a Chimera body over MCP and lets an actual
// LLM drive the tools (publish / trust / graft / invoke). Run two of these against
// the same body and you have two real models, one body.
//
// Env:
//   CHIMERA_URL    MCP endpoint (default http://localhost:8787/mcp)
//   CHIMERA_TOKEN  bearer token, if the body is gated
//   CHIMERA_NAME   display name in the feed (default "agent")
//   CHIMERA_GOAL   what to accomplish (sensible default below)
//   CHIMERA_STEPS  max tool-loops (default 14)
//   CHIMERA_MODEL  override the model id
//   ANTHROPIC_API_KEY            → drives with Claude
//   OPENAI_API_KEY [+OPENAI_BASE_URL] → drives with any OpenAI-compatible API (xAI/Grok, OpenRouter…)
//
// With no model key it does a DRY RUN: connect + discover tools + exit (so you can
// verify wiring without spending tokens).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { liveBotSeed } from './onion-brains.ts';

const ENDPOINT = process.env.CHIMERA_URL || 'http://localhost:8787/mcp';
const TOKEN = process.env.CHIMERA_TOKEN;
const NAME = process.env.CHIMERA_NAME || 'agent';
const GOAL =
  process.env.CHIMERA_GOAL ||
  'Read the timeline and ENGAGE other brains: reply to 1-2 recent posts (reference what they actually said), graft + run a skill someone else published, and quote or repost something good. Publish a new skill only if you have a genuinely useful one. Be specific and varied; never repeat yourself.';
const MAX_STEPS = Number(process.env.CHIMERA_STEPS || 14);

function log(...a: unknown[]): void {
  console.log(`[${NAME}]`, ...a);
}

const client = new Client({ name: NAME, version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(ENDPOINT), TOKEN ? { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } } : undefined),
);
const mcpTools = (await client.listTools()).tools;
log(`connected → ${ENDPOINT}  (${mcpTools.length} tools)`);

// BYOK + SECURITY (audit 2026-06-03): an explicit CHIMERA_SEED wins (operator override);
// else derive a STABLE, SECRET identity from CHIMERA_IDENTITY_SECRET + this bot's name —
// the SAME key onion-host serves for live-<name> (onion-brains.ts liveBotSeed), so the
// .onion resolves and the wallet is NOT publicly reproducible. Matches fleet/run-agent.ts.
const SEED = process.env.CHIMERA_SEED || (process.env.CHIMERA_IDENTITY_SECRET ? Buffer.from(liveBotSeed(NAME)).toString('hex') : undefined);
if (SEED) {
  try {
    const r = await client.callTool({ name: 'chimera_identify', arguments: { seed: SEED } });
    log('identity:', ((r.content as Array<{ text: string }>)?.[0]?.text || '').split('\n')[0]);
  } catch (e) {
    log('identify failed:', (e as Error).message);
  }
}

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

if (!anthropicKey && !openaiKey) {
  log('tools:', mcpTools.map((t) => t.name).join(', '));
  log('DRY RUN — set ANTHROPIC_API_KEY (Claude) or OPENAI_API_KEY [+ OPENAI_BASE_URL for Grok] to let a model drive.');
  await client.close();
  process.exit(0);
}

const SYSTEM =
  `You are "${NAME}", a brain inhabiting a SHARED Chimera body — a live timeline of other brains, a trust-gated capability fabric where agents graft each other's skills under explicit trust, settled over x402. You are a participant in a feed, NOT a megaphone. Being a good body-mate means ENGAGING the other brains, not broadcasting at them. ` +
  `Your identity is one Ed25519 key (Solana wallet = Tor .onion = signer). Act ONLY through the chimera_* tools. ` +
  `DISCOVERY-FIRST LOOP — work it in this order:\n` +
  `  1. Orient: chimera_whoami (who you are, your wallet/.onion).\n` +
  `  2. LISTEN: chimera_timeline to see what OTHER brains are actually saying and publishing right now (it excludes your own posts by default). Read their summaries — you must know the specifics before you act. Use chimera_registry to see which skills they published.\n` +
  `  3. ENGAGE specific posts you just read: chimera_reply to a recent post by ITS seq, referencing what that brain actually said; chimera_quote (add your take) or chimera_repost a genuinely good one by its seq.\n` +
  `  4. GRAFT ANOTHER brain's skill: chimera_trust the author (low tier first) → chimera_graft its cid → chimera_invoke it and react to the real result. This is the point of the body — use what others built.\n` +
  `  5. Publishing a NEW skill is OCCASIONAL, not the main loop — only when you genuinely have a useful, PURE, self-contained one (a function whose name matches the 'entry' field, one input → a value, no imports, no globals).\n` +
  `HARD RULES (violating these makes you spam, which is the failure you exist to avoid):\n` +
  `  • NEVER post the same message twice, and never hype-spam (no "🚀🚀 to the moon!!!"-style repetition). If you already said something, say something else or do a different action.\n` +
  `  • EVERY reply/quote MUST reference the SPECIFIC content and the brain you are replying to — quote or paraphrase what they actually posted. Generic "great post!" is forbidden.\n` +
  `  • VARY your actions across steps: don't reply three times in a row, don't post three times in a row. Mix reply / quote / repost / graft / invoke.\n` +
  `  • Default to LOW trust (SANDBOX/METERED, not TRUSTED). Never retry a forged or refused capability — if a graft is REFUSED, drop it and move on.\n` +
  `  • Reply to/quote real seqs you saw in chimera_timeline; don't invent seqs.\n` +
  `When the goal is met, stop calling tools. Goal: ${GOAL}`;

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const r = await client.callTool({ name, arguments: args || {} });
    return (r.content as Array<{ text?: string }>).map((c) => c.text ?? JSON.stringify(c)).join('\n');
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function runAnthropic(): Promise<void> {
  const model = process.env.CHIMERA_MODEL || 'claude-sonnet-4-6';
  const tools = mcpTools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.inputSchema }));
  const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'Begin.' }];
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, system: SYSTEM, tools, messages }),
    });
    if (!res.ok) {
      log('anthropic error', res.status, (await res.text()).slice(0, 300));
      break;
    }
    const data = (await res.json()) as { content: Array<Record<string, unknown>>; stop_reason: string };
    messages.push({ role: 'assistant', content: data.content });
    for (const b of data.content) if (b.type === 'text' && String(b.text).trim()) log('💭', String(b.text).trim());
    const toolUses = data.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length || data.stop_reason !== 'tool_use') {
      log('done');
      break;
    }
    const results: Array<Record<string, unknown>> = [];
    for (const u of toolUses) {
      log('→', u.name, JSON.stringify(u.input));
      const out = await callTool(u.name as string, u.input as Record<string, unknown>);
      log('  ↳', out.split('\n')[0]);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: out });
    }
    messages.push({ role: 'user', content: results });
  }
}

async function runOpenAI(): Promise<void> {
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.CHIMERA_MODEL || 'gpt-4o-mini';
  const tools = mcpTools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema } }));
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'Begin.' },
  ];
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey!}` },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
    });
    if (!res.ok) {
      log('openai error', res.status, (await res.text()).slice(0, 300));
      break;
    }
    const data = (await res.json()) as { choices: Array<{ message: Record<string, unknown> }> };
    const msg = data.choices[0].message;
    messages.push(msg);
    if (msg.content) log('💭', String(msg.content).trim());
    const calls = (msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>) || [];
    if (!calls.length) {
      log('done');
      break;
    }
    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function.arguments || '{}');
      } catch {
        /* leave empty */
      }
      log('→', c.function.name, JSON.stringify(args));
      const out = await callTool(c.function.name, args);
      log('  ↳', out.split('\n')[0]);
      messages.push({ role: 'tool', tool_call_id: c.id, content: out });
    }
  }
}

if (anthropicKey) await runAnthropic();
else await runOpenAI();

await client.close();
log('brain offline.');

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

const ENDPOINT = process.env.CHIMERA_URL || 'http://localhost:8787/mcp';
const TOKEN = process.env.CHIMERA_TOKEN;
const NAME = process.env.CHIMERA_NAME || 'agent';
const GOAL =
  process.env.CHIMERA_GOAL ||
  'Orient (chimera_whoami, then chimera_registry). Publish ONE genuinely useful, pure, self-contained skill. Then set trust on another brain and graft + run one of their skills. Post a short note on the blackboard. Then stop.';
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

// BYOK: if a stable seed is set, assume that self-controlled identity — so this brain
// has its OWN wallet (fundable, pays its own grafts) and a hostable, stable .onion.
const SEED = process.env.CHIMERA_SEED;
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
  `You are "${NAME}", a brain inhabiting a shared Chimera body — a trust-gated capability fabric where agents graft each other's skills under explicit trust, settled over x402. ` +
  `Your identity is one Ed25519 key (Solana wallet = Tor .onion = signer). Act ONLY through the chimera_* tools. ` +
  `Be a good body-mate: orient first (chimera_whoami, chimera_registry); publish what you're good at as PURE, self-contained skill code (a function whose name matches the 'entry' field, taking one input and returning a value — no imports, no globals); set trust (chimera_trust) before grafting; pay for what saves you work; run grafted skills sandboxed; post a short note via chimera_blackboard. ` +
  `Default to low trust; never retry a forged/refused capability. When the goal is met, stop calling tools. Goal: ${GOAL}`;

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

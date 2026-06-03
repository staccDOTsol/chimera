// mcp.ts — the single-tenant stdio entrypoint. One persistent brain inhabiting its
// own body, wired into a local agent (Claude Code etc). Run: `node src/mcp.ts`.
//
// For a SHARED, multi-brain body over HTTP (the social harness), run the web server
// (`node src/web.ts`) and connect to its /mcp endpoint — each connection is a brain
// on one body. Both transports register the same tools (see tools.ts).
//
// IMPORTANT: on stdio, stdout is the JSON-RPC channel — body logs go to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { Body } from './body.ts';
import { makePaymentGate } from './payment.ts';
import { TrustGraph } from './trust.ts';
import type { TrustTier } from './trust.ts';
import type { Brain } from './types.ts';
import { loadOrCreateIdentity, loadState, saveState, dataDir } from './store.ts';
import { registerTools } from './tools.ts';

const self = loadOrCreateIdentity();
const persisted = loadState();

const body = new Body(makePaymentGate(process.env, (l) => console.error(l)), (l) => console.error(l));
for (const cap of persisted.registry) body.ingest(cap);
body.blackboard.push(...persisted.blackboard);

const trust = new TrustGraph();
for (const [author, tier] of persisted.trust) trust.set(author, tier as TrustTier);

const brain: Brain = { identity: self, adapter: { name: 'self', decide: () => ({ type: 'pass' }) }, trust, grafted: new Set(persisted.grafted) };
body.addBrain(brain);

function persist(): void {
  saveState({ registry: [...body.registry.values()], grafted: [...brain.grafted], trust: trust.entries(), blackboard: body.blackboard });
}

const server = new McpServer({ name: 'chimera', version: '0.0.0' });
registerTools(server, { body, brain, persist, stateLabel: dataDir() });

await server.connect(new StdioServerTransport());
console.error(`chimera body online (stdio) — self=${self.solana} (${self.onion.slice(0, 16)}…onion)  state=${dataDir()}`);

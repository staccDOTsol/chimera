// smoke-mcp.ts — boot the entrypoint as a real subprocess and drive it through
// the MCP client, exactly as a connecting brain (Claude/Grok/etc.) would.
// Run: `node scripts/smoke-mcp.ts`

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['src/mcp.ts'],
  env: { ...process.env, CHIMERA_HOME_DIR: '/tmp/chimera-smoke' },
});

const client = new Client({ name: 'chimera-smoke', version: '0.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

async function call(name: string, args?: Record<string, unknown>): Promise<string> {
  const r = await client.callTool({ name, arguments: args ?? {} });
  const txt = (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');
  console.log(`\n>>> ${name}(${JSON.stringify(args ?? {})})`);
  console.log(txt);
  return txt;
}

const who = await call('chimera_whoami');
const self = (who.match(/"solana":\s*"([1-9A-HJ-NP-Za-km-z]+)"/) || [])[1]!;

const pub = await call('chimera_publish', {
  name: 'sol-format',
  code: "function main(l){ return (Number(l)/1e9).toFixed(4)+' SOL'; }",
  entry: 'main',
  priceMicroUsdc: 1000,
  description: 'lamports → SOL',
});
const cid = (pub.match(/cid:\s*([1-9A-HJ-NP-Za-km-z]+)/) || [])[1]!;
console.log('parsed self:', self, '\nparsed cid :', cid);

await call('chimera_registry');
await call('chimera_graft', { cid }); // self is BLOCKED to itself by default → expect refusal
await call('chimera_trust', { author: self, tier: 'METERED' });
await call('chimera_graft', { cid }); // now METERED → pays 1000µ → grafted
await call('chimera_invoke', { cid, input: 1_500_000_000 });
await call('chimera_blackboard');
await call('chimera_resolve', { id: 'chimera.stacc' });
await call('chimera_connect', { handle: 'chimera.stacc' });

await client.close();
console.log('\nsmoke: done');

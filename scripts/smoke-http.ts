// smoke-http.ts — prove multi-tenancy: TWO independent MCP connections (two brains)
// act on ONE shared body. Alice publishes; Bob — a different session — grafts, pays,
// and runs Alice's skill. Then the public feed shows both. Run the server first
// (`node src/web.ts`), then `node scripts/smoke-http.ts`.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ENDPOINT = process.env.CHIMERA_URL || 'http://localhost:8787/mcp';
const ORIGIN = ENDPOINT.replace(/\/mcp$/, '');
const TOKEN = process.env.CHIMERA_TOKEN;

async function brain(name: string): Promise<Client> {
  const c = new Client({ name, version: '1.0.0' });
  const opts = TOKEN ? { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } } : undefined;
  await c.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), opts));
  return c;
}
async function call(c: Client, name: string, args?: Record<string, unknown>): Promise<string> {
  const r = await c.callTool({ name, arguments: args ?? {} });
  return (r.content as Array<{ text: string }>).map((x) => x.text).join('\n');
}

console.log('connecting two brains to one body…');
const alice = await brain('Alice');
const bob = await brain('Bob');

const aWho = await call(alice, 'chimera_whoami');
const aWallet = (aWho.match(/"solana":\s*"([1-9A-HJ-NP-Za-km-z]+)"/) || [])[1]!;
console.log('Alice:', aWallet);

const pub = await call(alice, 'chimera_publish', { name: 'greet', code: "function main(n){ return 'gm, ' + n + ' — wagmi'; }", entry: 'main', priceMicroUsdc: 500, description: 'greet a name' });
const cid = (pub.match(/cid:\s*([1-9A-HJ-NP-Za-km-z]+)/) || [])[1]!;
console.log('Alice published greet →', cid);

await call(bob, 'chimera_trust', { author: aWallet, tier: 'METERED' });
console.log('\nBob (a different session) grafts Alice’s skill:');
console.log(await call(bob, 'chimera_graft', { cid }));
console.log('\nBob runs it:');
console.log(await call(bob, 'chimera_invoke', { cid, input: 'Bob' }));

const feed = (await (await fetch(`${ORIGIN}/api/feed`)).json()) as Array<{ brain: string }>;
const live = [...new Set(feed.filter((e) => e.brain === 'Alice' || e.brain === 'Bob').map((e) => e.brain))];
const st = await (await fetch(`${ORIGIN}/api/stats`)).json();
console.log('\nlive brains now in the shared body feed:', live.join(', ') || '(none)');
console.log('stats:', JSON.stringify(st));

await alice.close();
await bob.close();
console.log('\nsmoke-http: done');

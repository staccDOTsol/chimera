// test-sandbox.ts — containment proof for the process-isolated sandbox.
// Run:  node scripts/test-sandbox.ts
//
// Drives runCapability with five foreign payloads and asserts each is either
// computed correctly or CONTAINED (denied / undefined / killed). Also reports the
// per-invoke process-spawn overhead (~50–100ms is expected — every invocation
// forks a fresh permission-jailed Node process; that cost IS the isolation).

import { runCapability } from '../src/sandbox.ts';
import type { SignedCapability } from '../src/capability.ts';

// Minimal stand-in: runCapability only reads cap.manifest.{code,entry}.
function cap(code: string, entry = 'main'): SignedCapability {
  return { manifest: { code, entry } } as unknown as SignedCapability;
}

interface Case {
  name: string;
  cap: SignedCapability;
  input: unknown;
  expect: string;
  pass: (r: { ok: boolean; output?: unknown; error?: string }) => boolean;
}

const cases: Case[] = [
  {
    name: 'GOOD',
    cap: cap('function main(l){ return (Number(l)/1e9).toFixed(4)+" SOL"; }'),
    input: 1500000000,
    expect: 'ok=true, output="1.5000 SOL"',
    pass: (r) => r.ok === true && r.output === '1.5000 SOL',
  },
  {
    name: 'FS',
    cap: cap(`function main(){ return require('fs').readFileSync('/etc/hostname','utf8'); }`),
    input: null,
    expect: 'ok=false (require undefined / fs denied)',
    pass: (r) => r.ok === false,
  },
  {
    name: 'INFINITE',
    cap: cap('function main(){ while(true){} }'),
    input: null,
    expect: 'ok=false, error mentions timeout (SIGKILLed)',
    pass: (r) => r.ok === false && /timeout/i.test(r.error ?? ''),
  },
  {
    name: 'FETCH',
    cap: cap('function main(){ return typeof fetch; }'),
    input: null,
    expect: 'ok=true, output="undefined" (no network global in vm)',
    pass: (r) => r.ok === true && r.output === 'undefined',
  },
  {
    name: 'PROC',
    cap: cap('function main(){ return typeof process; }'),
    input: null,
    expect: 'ok=true, output="undefined" (no process in vm)',
    pass: (r) => r.ok === true && r.output === 'undefined',
  },
];

const fmt = (v: unknown): string => (v === undefined ? 'undefined' : JSON.stringify(v));

let allPass = true;
const rows: string[] = [];

for (const c of cases) {
  const t0 = Date.now();
  const r = await runCapability(c.cap, c.input, { sandboxed: true });
  const ms = Date.now() - t0;
  const ok = c.pass(r);
  allPass &&= ok;
  rows.push(
    [
      ok ? 'PASS' : 'FAIL',
      c.name.padEnd(9),
      `ok=${String(r.ok).padEnd(5)}`,
      `out=${fmt(r.output)}`.padEnd(22),
      r.error ? `err=${r.error}` : '',
    ].join('  '),
  );
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(9)} — ${c.expect}`);
  console.log(`        got: ok=${r.ok} output=${fmt(r.output)}${r.error ? ` error=${JSON.stringify(r.error)}` : ''}  (${ms}ms wall)`);
}

console.log('\n──────── RESULT TABLE ────────');
for (const row of rows) console.log(row);

// Per-invoke spawn overhead: measure a trivial GOOD call in isolation.
const o0 = Date.now();
await runCapability(cap('function main(){ return 1; }'), null, { sandboxed: true });
console.log(`\nper-invoke process-spawn overhead ≈ ${Date.now() - o0}ms (fresh permission-jailed Node fork per call)`);

console.log(`\n${allPass ? '✅ ALL CONTAINED — sandbox holds' : '❌ CONTAINMENT BREACH'}`);
process.exit(allPass ? 0 : 1);

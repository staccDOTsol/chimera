// sandbox-runner.ts — the child process that actually runs foreign capability code.
// Spawned by sandbox.ts as:  node --permission --allow-fs-read=<this> --max-old-space-size=64 sandbox-runner.ts
//
// The permission model denies this process fs (except reading its own file), child
// processes, workers, and native addons. We ALSO strip network globals and run the
// code in a vm null-prototype context (no require, no import, no globals). So a
// capability that escapes the vm still lands in a process that can't touch the disk,
// spawn a shell, or (practically) reach the network. The PARENT kills us on timeout,
// which is the only thing that stops an infinite loop in the called function.

import vm from 'node:vm';

// defense in depth: remove host/network globals before any foreign code runs
for (const k of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']) {
  try {
    delete (globalThis as Record<string, unknown>)[k];
  } catch {
    /* non-configurable — ignore */
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let res: { ok: boolean; output?: unknown; error?: string };
  try {
    const { code, entry, input } = JSON.parse(raw) as { code: string; entry: string; input: unknown };
    const context = vm.createContext(Object.create(null));
    const src = `(() => { ${code}\n; return typeof ${entry} === 'function' ? ${entry} : null; })()`;
    const fn = vm.runInContext(src, context, { timeout: 1000 }) as ((i: unknown) => unknown) | null;
    if (typeof fn !== 'function') res = { ok: false, error: `entry '${entry}' is not a function` };
    else res = { ok: true, output: fn(input) };
  } catch (e) {
    res = { ok: false, error: (e as Error).message };
  }
  try {
    process.stdout.write(JSON.stringify(res));
  } catch {
    process.stdout.write('{"ok":false,"error":"capability returned an unserializable value"}');
  }
  process.exit(0);
});

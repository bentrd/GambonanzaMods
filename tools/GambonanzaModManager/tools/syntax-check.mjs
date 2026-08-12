#!/usr/bin/env node
// `node --check` over every JS file in the app - a zero-dependency lint that
// catches the "committed a file with a stray brace" class of mistake in CI
// without dragging in a linter toolchain.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|mjs)$/.test(entry.name)) yield full;
  }
}

let failures = 0;
for (const file of walk(root)) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failures++;
    console.error(`✗ ${path.relative(root, file)}`);
    console.error(String(err.stderr));
  }
}

if (failures) {
  console.error(`${failures} file(s) failed the syntax check.`);
  process.exit(1);
}
console.log('All files parse cleanly.');

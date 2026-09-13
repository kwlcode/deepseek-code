#!/usr/bin/env node
// Cross-version test entry point.
//
// `node --test` accepts neither a glob (Node < 21) nor a directory argument
// (Node >= 22) on every supported release, and npm runs scripts through cmd.exe
// on Windows, where the shell does not expand globs. So discover the test files
// here and hand the explicit paths to the runner: works on Node 18.17+ on
// Windows, macOS and Linux, with no dependencies.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const testDir = new URL('../test/', import.meta.url);
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => fileURLToPath(new URL(name, testDir)));

if (files.length === 0) {
  console.error(`No *.test.js files found in ${fileURLToPath(testDir)}`);
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
const result = spawnSync(process.execPath, ['--test', ...extraArgs, ...files], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);

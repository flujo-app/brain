#!/usr/bin/env node
// Cut a brain release in one command. There is nothing to `npm publish` -
// brain ships as a git tag: CI (.github/workflows/installer.yml) sees the
// tag, builds brain-setup.exe, and attaches it to the GitHub release.
//
//   npm run release                 patch bump (0.1.0 -> 0.1.1)
//   npm run release minor           0.1.0 -> 0.2.0
//   npm run release major           0.1.0 -> 1.0.0
//   npm run release 1.2.3           exactly 1.2.3
//   npm run release -- --dry-run    preflight checks only, changes nothing
//
// Steps: preflight (on main, clean tree, in sync with origin) ->
// `npm version` (bumps package.json + lockfile, commits, tags v<version>) ->
// push with the tag -> watch the CI build and print the release URL.

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const show = (cmd) => { console.log(`\n> ${cmd}`); execSync(cmd, { stdio: 'inherit' }); };
const fail = (msg) => { console.error(`\nx ${msg}`); process.exit(1); };

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bump = args.find((a) => !a.startsWith('--')) ?? 'patch';
if (!/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  fail(`Unknown bump '${bump}' - use patch, minor, major, or an exact x.y.z version.`);
}

// --- preflight ---------------------------------------------------------------
const branch = run('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') fail(`Releases are cut from main (you are on '${branch}').`);

if (run('git status --porcelain') !== '') fail('Working tree is not clean - commit or stash first.');

console.log('Fetching origin ...');
run('git fetch origin main --tags');
if (run('git rev-parse main') !== run('git rev-parse origin/main')) {
  fail('main and origin/main differ - pull/push first so the release builds exactly what is on GitHub.');
}

const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
console.log(`Current version: ${current}`);

if (dryRun) {
  console.log(`\nDry run - preflight passed. Would run: npm version ${bump}, git push origin main --follow-tags, then watch CI.`);
  process.exit(0);
}

// --- bump + tag + push ---------------------------------------------------------
show(`npm version ${bump} -m "Release v%s"`);
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tag = `v${version}`;
show('git push origin main --follow-tags');

// --- watch CI (optional, needs the GitHub CLI) ---------------------------------
if (spawnSync('gh', ['--version'], { shell: true, stdio: 'ignore' }).status !== 0) {
  console.log(`\nPushed ${tag}. Install the GitHub CLI (gh) to watch the build from here; meanwhile:`);
  console.log('    https://github.com/flujo-app/brain/actions');
  process.exit(0);
}

console.log(`\nWaiting for the "Build setup.exe" run for ${tag} ...`);
let runId = '';
for (let i = 0; i < 12 && !runId; i++) {
  try {
    // For tag pushes the run's head branch is the tag name.
    runId = run(`gh run list --workflow=installer.yml --branch ${tag} --limit 1 --json databaseId --jq ".[0].databaseId"`);
  } catch { /* run not visible yet */ }
  if (!runId) await new Promise((r) => setTimeout(r, 5000));
}
if (!runId) fail(`No CI run appeared for ${tag} - check https://github.com/flujo-app/brain/actions`);

show(`gh run watch ${runId} --exit-status`);
console.log(`\nReleased ${tag}: https://github.com/flujo-app/brain/releases/tag/${tag}`);

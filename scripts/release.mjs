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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const githubRepo = 'flujo-app/brain';

async function waitForWorkflow(workflow, branch, label) {
  console.log(`\nWaiting for ${label} ...`);
  let runId = '';
  for (let i = 0; i < 24 && !runId; i += 1) {
    try {
      runId = run(
        `gh run list -R ${githubRepo} --workflow=${workflow} --branch ${branch} --event push --limit 1 --json databaseId --jq ".[0].databaseId"`,
      );
    } catch { /* run not visible yet */ }
    if (!runId) await sleep(5000);
  }
  if (!runId) fail(`${label} did not appear; inspect https://github.com/${githubRepo}/actions.`);
  try {
    show(`gh run watch ${runId} -R ${githubRepo} --exit-status`);
  } catch {
    fail(`${label} failed: https://github.com/${githubRepo}/actions/runs/${runId}`);
  }
}

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
// Tags occasionally get replaced on origin (for example, when a failed release
// is re-cut). A normal fetch refuses to overwrite the stale local tag and blocks
// every later release. Origin is authoritative for published release tags, so
// allow tag refs to be refreshed while fetching the branch.
run('git fetch origin main "+refs/tags/*:refs/tags/*"');
if (run('git rev-parse main') !== run('git rev-parse origin/main')) {
  fail('main and origin/main differ - pull/push first so the release builds exactly what is on GitHub.');
}

if (spawnSync('gh', ['--version'], { shell: true, stdio: 'ignore' }).status !== 0) {
  fail('GitHub CLI is required so release cannot report success before its images exist. Install and authenticate `gh`.');
}
try {
  run('gh auth status');
} catch {
  fail('GitHub CLI authentication failed; run `gh auth login`.');
}

const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
console.log(`Current version: ${current}`);

if (dryRun) {
  console.log(`\nDry run - preflight passed. Would run: npm version ${bump}, push main and the tag, then wait for both image and installer CI.`);
  process.exit(0);
}

// --- bump + tag + push ---------------------------------------------------------
show(`npm version ${bump} -m "Release v%s"`);
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tag = `v${version}`;
show('git push origin main --follow-tags');

// The tag event has its own image workflow run even though pushing main also
// starts one. Waiting for the tag-scoped run guarantees both `brain:latest` and
// `flujo-browser:latest` exist before this command reports success.
await waitForWorkflow('brain-release.yml', tag, `the ${tag} brain image build`);
await waitForWorkflow('installer.yml', tag, `the ${tag} Windows installer build`);
console.log(`\nReleased ${tag}: https://github.com/flujo-app/brain/releases/tag/${tag}`);

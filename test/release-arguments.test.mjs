import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseReleaseArguments } from '../scripts/release-arguments.mjs';

const entrypoint = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url));
const stubs = new URL('./fixtures/release-command-stubs.mjs', import.meta.url).href;

function runRelease(t, args, overrides = {}) {
  const tempRoot = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(tempRoot, 'brain-release-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith('brain-release-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  const commandLog = path.join(directory, 'commands.jsonl');
  writeFileSync(commandLog, '');
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '0.0.1' }));
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === 'npm_config_dry_run' || name === 'NODE_OPTIONS') delete env[name];
  }
  const result = spawnSync(process.execPath, ['--import', stubs, entrypoint, ...args], {
    cwd: directory,
    env: { ...env, ...overrides, RELEASE_TEST_COMMAND_LOG: commandLog },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  const commands = readFileSync(commandLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { ...result, commands };
}

for (const setting of ['true', 'TRUE', '1']) {
  test(`npm environment dry-run ${setting} cannot version or push`, (t) => {
    const result = runRelease(t, [], { npm_config_dry_run: setting });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run - preflight passed/);
    assert.ok(result.commands.includes('git fetch origin main "+refs/tags/*:refs/tags/*"'));
    assert.ok(result.commands.every((command) => !/\b(version|push|publish)\b/.test(command.replace('gh --version', ''))));
  });
}

test('explicit dry-run remains safe when npm environment is false', (t) => {
  const result = runRelease(t, ['minor', '--dry-run'], { npm_config_dry_run: 'false' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would run: npm version minor/);
  assert.ok(result.commands.every((command) => !command.startsWith('npm ') && !command.startsWith('git push')));
});

for (const args of [['--dryrun'], ['--unknown'], ['--dry-run=true'], ['patch', 'minor'], ['patch', '1.2.3'], ['nope']]) {
  test(`invalid arguments ${args.join(' ')} invoke no commands`, (t) => {
    const result = runRelease(t, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option|Specify only one|Unknown bump/);
    assert.deepEqual(result.commands, []);
  });
}

for (const argument of ['--help', '-h']) {
  test(`${argument} invokes no commands`, (t) => {
    const result = runRelease(t, [argument]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.deepEqual(result.commands, []);
  });
}

test('invalid npm dry-run setting fails before any command', (t) => {
  const result = runRelease(t, [], { npm_config_dry_run: 'tru' });
  assert.equal(result.status, 1);
  assert.deepEqual(result.commands, []);
  assert.match(result.stderr, /Invalid npm_config_dry_run setting/);
});

test('default and explicit releases retain version selection', () => {
  assert.deepEqual(parseReleaseArguments([], {}), { bump: 'patch', dryRun: false, help: false });
  for (const bump of ['patch', 'minor', 'major', '1.2.3']) {
    assert.equal(parseReleaseArguments([bump], {}).bump, bump);
  }
  for (const setting of ['', 'false', 'FALSE', '0']) {
    assert.equal(parseReleaseArguments([], { npm_config_dry_run: setting }).dryRun, false);
  }
  assert.equal(parseReleaseArguments([], { NPM_CONFIG_DRY_RUN: 'true' }).dryRun, true);
});

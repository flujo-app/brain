import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
const generated = new URL('../.vite/swarm-tests/', import.meta.url);
await mkdir(generated, { recursive: true });
for (const name of ['model', 'preview']) {
  const source = await readFile(new URL(`../src/swarm/${name}.ts`, import.meta.url), 'utf8');
  await writeFile(new URL(`${name}.mjs`, generated), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
}
const { parseSwarm, SwarmIndex, nodeKey, activities } = await import(new URL('model.mjs', generated));
const { swarmPreview } = await import(new URL('preview.mjs', generated));

test('same bare root/task/effect identities remain distinct across authorities and registration is separate', () => {
  const swarm = parseSwarm(swarmPreview());
  const index = new SwarmIndex(swarm);
  const keys = swarm.sources.map(source => nodeKey(source, 'cell', 'root'));
  assert.equal(new Set(keys).size, 3);
  for (const source of swarm.sources) {
    const root = index.nodeFor({ sourceId: source.id, kind: 'cell', id: 'root' });
    assert.equal(root.source.factoryId, source.factoryId);
    assert.equal(index.ancestors(root.key)[0].selection.kind, 'source');
    assert.ok(index.ancestors(root.key).every(node => node.source.id === source.id));
    assert.equal(index.nodeFor({ sourceId: source.id, kind: 'task', id: 'exploration' }).source.id, source.id);
  }
});
test('10,000-level delegation can be indexed, searched, selected and drawn without recursive overflow or losing focus', () => {
  const swarm = swarmPreview(10000), source = swarm.sources[0];
  swarm.sources = [source];
  const template = source.snapshot.snapshot.cells[0];
  source.snapshot.snapshot.cells = Array.from({ length: 10000 }, (_, index) => ({ ...template, id: index ? `deep-${index}` : 'root', parentId: index === 0 ? null : index === 1 ? 'root' : `deep-${index - 1}`, depth: index }));
  const start = performance.now(), index = new SwarmIndex(parseSwarm(swarm));
  const target = index.nodeFor({ sourceId: source.id, kind: 'cell', id: 'deep-9999' });
  assert.ok(target);
  assert.equal(index.ancestors(target.key).length, 10001);
  assert.equal(index.search('deep-9999')[0].id, 'deep-9999');
  const visible = index.visible(target.key);
  assert.ok(visible.length <= 600);
  assert.ok(visible.some(node => node.key === target.key));
  assert.ok(Number.isFinite(target.point.x));
  console.log(`Deep-swarm model qualification: ${Math.round(performance.now() - start)}ms, ${index.nodes.size} indexed / ${visible.length} drawn.`);
});
test('10,000 siblings remain reachable across bounded child pages rather than being silently truncated', () => {
  const swarm = swarmPreview(10000), source = swarm.sources[0]; swarm.sources = [source];
  const template = source.snapshot.snapshot.cells[0];
  source.snapshot.snapshot.cells = Array.from({ length: 10000 }, (_, index) => ({ ...template, id: index ? `wide-${index}` : 'root', parentId: index ? 'root' : null, depth: index ? 1 : 0 }));
  const index = new SwarmIndex(parseSwarm(swarm)), root = nodeKey(source, 'cell', 'root'), reached = new Set();
  for (let page = 0; page < Math.ceil(9999 / 128); page++) {
    const visible = index.visible(root, page); assert.ok(visible.length <= 600);
    for (const node of visible) if (node.cell?.id !== 'root' && node.cell) reached.add(node.cell.id);
  }
  assert.equal(reached.size, 9999);
  assert.ok(index.search('wide-9999').some(selection => selection.id === 'wide-9999'));
});
test('spatial positions survive heartbeat and recorded-status updates', () => {
  const swarm = parseSwarm(swarmPreview()), before = new SwarmIndex(swarm);
  swarm.sources[0].snapshot.snapshot.cells[1].heartbeat = new Date(Date.now() + 1000).toISOString();
  swarm.sources[0].snapshot.snapshot.tasks[0].status = 'cancelled';
  const after = new SwarmIndex(swarm);
  for (const [key, node] of before.nodes) assert.deepEqual(after.nodes.get(key).point, node.point);
});
test('observation freshness never renews worker evidence, and terminal states do not activate it', () => {
  const swarm = parseSwarm(swarmPreview()), source = swarm.sources[0], now = Date.parse(source.snapshot.observedAt);
  assert.equal(activities(source, now).get('cell-1'), 'recent');
  assert.equal(activities(source, now + 16000).get('cell-1'), 'uncertain');
  source.snapshot.observedAt = new Date(now + 61000).toISOString();
  assert.equal(activities(source, now + 61000).get('cell-1'), 'uncertain');
  source.snapshot.snapshot.tasks[0].status = 'completed';
  assert.equal(activities(source, now + 61000).get('cell-1'), 'idle');
  source.snapshot.snapshot.tasks[0].status = 'cancelled';
  assert.equal(activities(source, now + 61000).get('cell-1'), 'idle');
  source.snapshot.snapshot.tasks[0].status = 'running'; source.status = 'stale';
  assert.equal(activities(source, now).get('cell-1'), 'uncertain');
  source.status = 'observed'; source.snapshot.snapshot.control.status = 'paused';
  assert.equal(activities(source, now).get('cell-1'), 'uncertain');
});
test('consumer drops private extensions and fails closed on capabilities/identity/duplicate records', () => {
  const input = swarmPreview(); input.token = 'private'; input.sources[0].origin = 'private'; input.sources[0].snapshot.snapshot.tasks[2].candidate.path = 'private'; input.sources[0].snapshot.snapshot.paidBudget = { token: 'private' };
  assert.equal(JSON.stringify(parseSwarm(input)).includes('private'), false);
  input.sources[0].snapshot.capabilities.commands = true; assert.throws(() => parseSwarm(input));
  input.sources[0].snapshot.capabilities.commands = false; input.sources[0].snapshot.factoryId = 'wrong'; assert.throws(() => parseSwarm(input));
  input.sources[0].snapshot.factoryId = input.sources[0].factoryId; input.sources.push(input.sources[0]); assert.throws(() => parseSwarm(input));
});
test('unavailable source remains in the registry without invented cells; historical hashes are preserved', () => {
  const input = swarmPreview(); input.sources[1].snapshot = null; input.sources[1].status = 'unavailable';
  const swarm = parseSwarm(input), index = new SwarmIndex(swarm);
  assert.equal(index.sources.size, 3);
  assert.equal([...index.nodes.values()].filter(node => node.source.id === input.sources[1].id).length, 1);
  const task = swarm.sources[0].snapshot.snapshot.tasks.find(task => task.status === 'cancelled');
  assert.equal(task.review.candidateDigest, task.candidate.sha256);
});

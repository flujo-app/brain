import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import ts from 'typescript';
const generated = new URL('../.vite/insights-tests/', import.meta.url);
await mkdir(generated, { recursive: true });
for (const name of ['insights-model', 'insights-preview']) {
  const code = await readFile(new URL(`../src/swarm/${name}.ts`, import.meta.url), 'utf8');
  const result = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace("'./insights-model'", "'./insights-model.mjs'");
  await writeFile(new URL(`${name}.mjs`, generated), result);
}
const { parseObservatory, ObservationFloors } = await import(new URL('insights-model.mjs', generated));
const { observatoryPreview } = await import(new URL('insights-preview.mjs', generated));
const sources = [{ id: 'one', factoryId: 'factory-one' }, { id: 'two', factoryId: 'factory-two' }];
test('reused worker, node, conversation and resource IDs stay independent under exact source/factory authority', () => {
  const data = parseObservatory(observatoryPreview(sources), sources);
  assert.equal(data.sources[0].workers[0].id, data.sources[1].workers[0].id);
  assert.notEqual(data.sources[0].factoryId, data.sources[1].factoryId);
  const swapped = structuredClone(data); swapped.sources[0].factoryId = 'factory-two'; assert.throws(() => parseObservatory(swapped, sources), /not registered/);
  const duplicate = structuredClone(data); duplicate.sources.push(duplicate.sources[0]); assert.throws(() => parseObservatory(duplicate, sources), /Duplicate/);
  const forged = structuredClone(data); forged.sources[0].machines[0].key = data.sources[0].machines[1].key; assert.throws(() => parseObservatory(forged, sources), /namespace/);
});
test('paid floors survive failed detail and repeated rollback, then reset on authority replacement or access erasure', () => {
  const floors = new ObservationFloors(), data = observatoryPreview(sources);
  assert.equal(floors.accept(data, sources).sources[0].budget.revision, 12);
  data.sources[0].budget.revision = 11;
  assert.equal(floors.accept(data, sources).sources[0].budget, null);
  assert.equal(floors.accept({ ...data, sources: [] }, sources).sources.length, 0);
  assert.equal(floors.accept(data, sources).sources[0].budget, null);
  floors.accept({ ...data, sources: [] }, []);
  assert.equal(floors.accept(data, sources).sources[0].budget.revision, 11);
  floors.reset(); assert.equal(floors.accept(data, sources).sources[0].budget.revision, 11);
});
test('positive projection strips private extensions and rejects system messages, executable authority and unbound graph edges', () => {
  const data = observatoryPreview(sources); data.token = 'PRIVATE'; data.sources[0].workers[0].origin = 'PRIVATE'; data.sources[0].workers[0].flows[0].nodes[0].properties = { prompt: 'PRIVATE' };
  assert.equal(JSON.stringify(parseObservatory(data, sources)).includes('PRIVATE'), false);
  data.commands = true; assert.throws(() => parseObservatory(data, sources)); data.commands = false;
  data.sources[0].workers[0].conversations[0].messages[0].role = 'system'; assert.throws(() => parseObservatory(data, sources));
  data.sources[0].workers[0].conversations[0].messages[0].role = 'user'; data.sources[0].workers[0].flows[0].edges.push({ source: 'foreign-node', target: 'build' }); assert.throws(() => parseObservatory(data, sources), /Unbound/);
});
test('failed transcript access erases content, and windows/paid holds remain bounded without converting unknown spend to zero', () => {
  const data = observatoryPreview(sources); assert.equal(parseObservatory(data, sources).sources[0].budget.meteredCents, null);
  const w = data.sources[0].workers[0]; w.conversationStatus = 'unavailable'; assert.throws(() => parseObservatory(data, sources), /erased/); w.conversations = []; assert.equal(parseObservatory(data, sources).sources[0].workers[0].conversations.length, 0);
  w.flows[0].nodes = Array.from({ length: 513 }, (_, i) => ({ id: String(i), label: String(i), type: 'process' })); assert.throws(() => parseObservatory(data, sources), /bound/);
  w.flows = []; data.sources[0].budget.heldCents = 11000; data.sources[0].budget.availableCents = 0; data.sources[0].budget.reservations[0].heldCents = 9300; assert.equal(parseObservatory(data, sources).sources[0].budget.heldCents, 11000);
});

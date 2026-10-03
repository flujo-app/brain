import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const generated = new URL('../.vite/insights-dom-tests/', import.meta.url);
await mkdir(generated, { recursive: true });
for (const name of ['insights', 'insights-model', 'model', 'preview', 'insights-preview']) {
  const code = await readFile(new URL(`../src/swarm/${name}.ts`, import.meta.url), 'utf8');
  const result = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/import '\.\/insights\.css';/, '')
    .replace(/from '(\.\/[^']+)'/g, "from '$1.mjs'");
  await writeFile(new URL(`${name}.mjs`, generated), result);
}
const { mountInsights } = await import(new URL('insights.mjs', generated));
const { swarmPreview } = await import(new URL('preview.mjs', generated));
const { observatoryPreview } = await import(new URL('insights-preview.mjs', generated));
const { activities } = await import(new URL('model.mjs', generated));

test('same-object render expires leased analytics; idle ticks expire worker/provider freshness without rebuilding transcripts', t => {
  const originalDocument = globalThis.document, originalNow = Date.now, base = originalNow(); let now = base;
  const dom = new JSDOM('<main id="swarm-app"><input id="swarm-find"><footer></footer></main>');
  globalThis.document = dom.window.document; Date.now = () => now;
  t.after(() => { globalThis.document = originalDocument; Date.now = originalNow; dom.window.close(); });
  const swarm = swarmPreview(9); swarm.sample = false;
  for (const s of swarm.sources) {
    s.snapshot.observedAt = new Date(base).toISOString();
    for (const c of s.snapshot.snapshot.cells) c.heartbeat = s.snapshot.observedAt;
    for (const task of s.snapshot.snapshot.tasks) if (task.status === 'running') task.leaseExpiry = new Date(base + 1000).toISOString();
  }
  const detail = observatoryPreview(swarm.sources);
  for (const s of detail.sources) {
    for (const w of s.workers) w.observedAt = new Date(base).toISOString();
    for (const m of s.machines) m.observedAt = new Date(base).toISOString();
  }
  const view = mountInsights(() => {}), selection = { sourceId: swarm.sources[0].id, kind: 'source', id: swarm.sources[0].id };
  const metric = label => [...document.querySelectorAll('.metric-card')].find(c => c.querySelector('p').textContent === label);
  view.observe(detail, swarm); view.render(swarm, selection);
  assert.equal(metric('Recent leased cells').querySelector('strong').textContent, '1');
  assert.match(document.querySelector('#insights-workers').textContent, /REPORTED RUNNING HERE/);
  const transcript = document.querySelector('.transcript'), tool = transcript.querySelector('details'), timeline = document.querySelector('.insight-timeline'); tool.open = false; transcript.scrollTop = 23;
  now = base + 2000; view.render(swarm, selection);
  assert.equal(activities(swarm.sources[0], now).get('cell-1'), 'uncertain');
  assert.equal(metric('Recent leased cells').querySelector('strong').textContent, '0');
  now = base + 15001; view.tick();
  assert.match(metric('Sources').querySelector('small').textContent, /1 stale or unavailable/);
  assert.match(document.querySelector('#insights-workers').textContent, /stale observation/);
  assert.match(document.querySelector('#insights-workers').textContent, /LAST RECORDED POSITION/);
  assert.doesNotMatch(document.querySelector('#insights-workers').textContent, /REPORTED RUNNING HERE/);
  assert.match(document.querySelector('#insights-machines').textContent, /STALE PROVIDER OBSERVATION/);
  assert.equal(document.querySelector('.transcript'), transcript);
  assert.equal(document.querySelector('.insight-timeline'), timeline);
  assert.equal(tool.open, false); assert.equal(transcript.scrollTop, 23);
  const metrics = document.querySelector('.metrics-grid'); now++; view.tick();
  assert.equal(document.querySelector('.metrics-grid'), metrics, 'unchanged temporal evidence does not repaint');
});

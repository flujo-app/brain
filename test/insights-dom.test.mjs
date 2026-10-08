import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const generated = new URL('../.vite/insights-dom-tests/', import.meta.url);
await mkdir(generated, { recursive: true });
for (const name of ['insights', 'insights-model', 'model', 'preview', 'insights-preview', 'marks']) {
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
const { flowDiagram } = await import(new URL('marks.mjs', generated));

test('section navigation retains authority fragments and completed operations stay distinct from deliveries', t => {
  const previous = globalThis.document;
  const dom = new JSDOM('<main id="swarm-app"><input id="swarm-find"><footer></footer></main>', { url: 'http://localhost/swarm.html#source=source-1&factory=design-authority-1&kind=source&id=source-1' });
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  let scrolled = false, selections = 0;
  const view = mountInsights(() => selections++), swarm = swarmPreview();
  view.observe(observatoryPreview(swarm.sources), swarm); view.render(swarm, null);
  document.getElementById('insights-history').scrollIntoView = () => { scrolled = true; };
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  document.querySelector('a[href="#insights-history"]').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); assert.equal(scrolled, true); assert.equal(selections, 0);
  assert.match(dom.window.location.hash, /factory=design-authority-1/);
  const tasks = [...document.querySelectorAll('.metric-card')].find(card => card.querySelector('p').textContent === 'Tasks');
  assert.match(tasks.querySelector('small').textContent, /0 delivered · 3 completed/);
});

test('cyclic and disconnected recorded flows keep every node inside the drawing with full identities', t => {
  const previous = globalThis.document, dom = new JSDOM(); globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  const nodes = ['a', 'b', 'c', 'unconnected'].map(id => ({ id, label: `Full recorded label for ${id}`, type: 'process' }));
  const flow = { nodes, edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'a' }] };
  const art = flowDiagram(flow, 'b', 'LAST RECORDED POSITION'), [, , width, height] = art.getAttribute('viewBox').split(' ').map(Number);
  assert.equal(art.querySelectorAll('.flow-art-edge').length, flow.edges.length);
  for (const group of art.querySelectorAll('.flow-art-node')) {
    const [x, y] = group.getAttribute('transform').match(/[\d.]+/g).map(Number), rect = group.querySelector('rect');
    assert.ok(x >= 0 && x + Number(rect.getAttribute('width')) <= width);
    assert.ok(y >= 0 && y + Number(rect.getAttribute('height')) <= height);
    assert.match(group.querySelector('title').textContent, /Full recorded label for/);
  }
  assert.equal(art.querySelectorAll('.flow-art-node').length, nodes.length);
  assert.match(art.querySelector('.is-current title').textContent, /LAST RECORDED POSITION/);
});

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

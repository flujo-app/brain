// Reads a FLUJO data directory and distills it into public/data/flows.json,
// the bundled snapshot the brain renders when no live FLUJO instance is reachable.
//
// Resolution order for the FLUJO db directory:
//   1. $FLUJO_DB                (explicit path to a `db` folder)
//   2. $FLUJO_HOME/db
//   3. a set of common local checkout / home locations
//
// The snapshot keeps flows in their raw FLUJO shape so the browser can run the
// exact same distill logic on live `/api/flow` data.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'public', 'data', 'flows.json');

function candidateDbDirs() {
  const c = [];
  if (process.env.FLUJO_DB) c.push(process.env.FLUJO_DB);
  if (process.env.FLUJO_HOME) c.push(join(process.env.FLUJO_HOME, 'db'));
  const home = homedir();
  c.push(
    join(home, 'Documents', 'GitHub', 'FLUJO', 'db'),
    join(home, 'FLUJO', 'db'),
    join(home, '.flujo', 'db'),
    resolve(__dirname, '..', '..', 'FLUJO', 'db'),
  );
  return c;
}

function findDb() {
  for (const dir of candidateDbDirs()) {
    if (dir && existsSync(join(dir, 'flows'))) return dir;
  }
  return null;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function buildModelLookup(db) {
  const raw = readJson(join(db, 'models.json'), []);
  const list = Array.isArray(raw) ? raw : raw.models ?? [];
  const map = {};
  for (const m of list) {
    if (!m || !m.id) continue;
    map[m.id] = { name: m.name ?? m.displayName ?? m.id, provider: m.provider ?? 'unknown' };
  }
  return map;
}

function buildServerLookup(db) {
  const raw = readJson(join(db, 'mcp_servers.json'), {});
  const map = {};
  // Stored as { serverName: config } — a snapshot only knows disabled vs configured.
  for (const [name, cfg] of Object.entries(raw)) {
    if (!cfg || typeof cfg !== 'object') continue;
    map[name] = { status: cfg.disabled ? 'disabled' : 'unknown' };
  }
  return map;
}

/**
 * Strip properties the brain never reads before they end up in a (possibly
 * public) snapshot — prompt templates in particular can contain sensitive
 * instructions. Only the bindings that drive the visualization are kept.
 */
const KEPT_PROPS = ['boundServer', 'boundModel', 'modelName', 'subflowId'];

function sanitizeFlow(flow) {
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    folder: flow.folder,
    nodes: (flow.nodes ?? []).map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: {
        label: n.data?.label,
        type: n.data?.type,
        properties: Object.fromEntries(
          KEPT_PROPS.filter((k) => n.data?.properties?.[k] !== undefined).map((k) => [k, n.data.properties[k]]),
        ),
      },
    })),
    edges: (flow.edges ?? []).map((e) => ({ source: e.source, target: e.target })),
  };
}

function loadFlows(db) {
  const dir = join(db, 'flows');
  const flows = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const flow = readJson(join(dir, f), null);
    if (flow && flow.id && Array.isArray(flow.nodes)) flows.push(sanitizeFlow(flow));
  }
  return flows;
}

function main() {
  const db = findDb();
  if (!db) {
    console.error('[brain] No FLUJO db found. Set FLUJO_DB or FLUJO_HOME.');
    console.error('[brain] Writing an empty snapshot so the build still succeeds.');
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ generatedAt: null, source: 'none', models: {}, servers: {}, flows: [] }, null, 2));
    return;
  }

  const models = buildModelLookup(db);
  const flows = loadFlows(db);

  // The generator does not embed a real timestamp so the snapshot is
  // reproducible in CI; the UI shows "live" vs "snapshot" instead.
  const servers = buildServerLookup(db);
  const snapshot = { generatedAt: null, source: 'snapshot', models, servers, flows };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot));
  const nodes = flows.reduce((n, f) => n + f.nodes.length, 0);
  console.log(`[brain] Snapshot written: ${flows.length} flows, ${nodes} nodes, ${Object.keys(models).length} models`);
  console.log(`[brain] -> ${OUT}`);
}

main();

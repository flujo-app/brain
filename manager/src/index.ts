import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Registry, newBrainRecord } from './registry.js';
import { buildBrainstemServer } from './brainstem.js';
import { FlujoClient } from './flujo.js';
import { provisionBrain, deprovisionBrain } from './provision.js';
import { dockerAvailable, removeFlujoContainer } from './docker.js';
import type { CreateBrainRequest } from './types.js';

const PORT = Number(process.env.PORT ?? 8090);
const FLUJO_DEFAULT_URL = process.env.FLUJO_DEFAULT_URL ?? 'http://localhost:4200';
const OLLAMA_URL = process.env.OLLAMA_URL;
const UI_DIR = process.env.UI_DIR ?? path.join(process.cwd(), '..', 'dist');

const registry = new Registry();
await registry.load();

const app = express();
app.disable('x-powered-by');

// ---------- proxies (mounted before any body parsing so streams pass through) ----------

/** Minimal reverse proxy — streams request and response, SSE-safe. */
function proxy(targetBase: string, strippedPrefix: string) {
  return (req: Request, res: Response) => {
    const targetPath = req.originalUrl.slice(strippedPrefix.length) || '/';
    const url = new URL(targetPath, targetBase);
    const upstream = http.request(
      url,
      {
        method: req.method,
        headers: { ...req.headers, host: url.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.status(502).json({ error: `upstream unreachable: ${url.origin}` });
      else res.end();
    });
    req.pipe(upstream);
  };
}

/** Same-origin path to the DEFAULT FLUJO instance (single-brain mode). */
app.use('/flujo', (req, res) => proxy(FLUJO_DEFAULT_URL, '/flujo')(req, res));

/** Per-brain FLUJO proxy: /brains/:id/flujo/* → that brain's instance. */
app.use(/^\/brains\/([^/]+)\/flujo(\/.*)?$/, (req, res) => {
  const m = req.originalUrl.match(/^\/brains\/([^/]+)\/flujo/);
  const brain = m && registry.get(m[1]);
  if (!brain) return res.status(404).json({ error: 'no such brain' });
  proxy(brain.flujoUrl, `/brains/${brain.id}/flujo`)(req, res);
});

// ---------- brain-stem MCP endpoint (stateless Streamable HTTP) ----------

app.post('/brains/:id/mcp/:token', express.json({ limit: '4mb' }), async (req, res) => {
  const brain = registry.get(req.params.id);
  if (!brain || req.params.token !== brain.token) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const server = buildBrainstemServer(brain, new FlujoClient(brain.flujoUrl));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
  }
});
// Stateless server: no session streams to GET, nothing to DELETE.
app.get('/brains/:id/mcp/:token', (_req, res) => res.status(405).end());
app.delete('/brains/:id/mcp/:token', (_req, res) => res.status(405).end());

// ---------- management API ----------

const api = express.Router();
api.use(express.json({ limit: '1mb' }));

const publicBrain = (b: ReturnType<Registry['list']>[number]) => {
  const { token: _token, ...rest } = b;
  return rest;
};

api.get('/health', (_req, res) => res.json({ ok: true }));

api.get('/brains', async (_req, res) => {
  res.json({
    brains: registry.list().map(publicBrain),
    docker: await dockerAvailable(),
    defaultFlujo: FLUJO_DEFAULT_URL,
    ollama: Boolean(OLLAMA_URL),
  });
});

api.get('/brains/:id', (req, res) => {
  const brain = registry.get(req.params.id);
  if (!brain) return res.status(404).json({ error: 'no such brain' });
  res.json(publicBrain(brain));
});

api.post('/brains', async (req, res) => {
  const body = req.body as CreateBrainRequest;
  if (!body?.name?.trim() || !body?.lifeGoal?.trim() || !body?.model) {
    return res.status(400).json({ error: 'name, lifeGoal and model are required' });
  }
  if (registry.list().some((b) => b.name === body.name.trim())) {
    return res.status(409).json({ error: 'a brain with that name already exists' });
  }
  // 'default' = adopt the stack's default FLUJO without the browser needing
  // to know its internal URL.
  if (body.adoptUrl === 'default') body.adoptUrl = FLUJO_DEFAULT_URL;
  const brain = newBrainRecord(body.name.trim(), body.lifeGoal.trim());
  await registry.put(brain);
  void provisionBrain(registry, brain, body); // runs in background; lobby polls status
  res.status(202).json(publicBrain(brain));
});

api.delete('/brains/:id', async (req, res) => {
  const brain = registry.get(req.params.id);
  if (!brain) return res.status(404).json({ error: 'no such brain' });
  const notes = await deprovisionBrain(brain);
  if (brain.kind === 'managed' && brain.containerId) {
    try {
      await removeFlujoContainer(brain.containerId, brain.id, req.query.purge === '1');
      notes.push(req.query.purge === '1' ? 'container + volumes removed' : 'container removed (volumes kept)');
    } catch (err) {
      notes.push(`container: ${(err as Error).message}`);
    }
  }
  await registry.remove(brain.id);
  res.json({ removed: brain.id, notes });
});

/** Ollama tags for the lobby's model picker. ?url= asks an Ollama elsewhere
 *  in the user's network instead of the stack's own (also serves as the
 *  wizard's reachability check, CORS-free). */
api.get('/ollama/tags', async (req, res) => {
  const base = typeof req.query.url === 'string' && req.query.url ? req.query.url.replace(/\/+$/, '') : OLLAMA_URL;
  if (!base) return res.status(503).json({ error: 'OLLAMA_URL not configured' });
  if (!/^https?:\/\//.test(base)) return res.status(400).json({ error: 'url must start with http:// or https://' });
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/** Models already present in the default FLUJO (for adopted brains). */
api.get('/default-flujo/models', async (_req, res) => {
  try {
    res.json(await new FlujoClient(FLUJO_DEFAULT_URL).listModels());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.use('/api', api);

// ---------- static UI ----------

if (fs.existsSync(UI_DIR)) {
  app.use(express.static(UI_DIR));
  app.get(/^\/(?!api|brains|flujo).*/, (_req, res) => res.sendFile(path.join(UI_DIR, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`brain-manager listening on :${PORT}`);
  console.log(`  default FLUJO: ${FLUJO_DEFAULT_URL}`);
  console.log(`  ui dir: ${fs.existsSync(UI_DIR) ? UI_DIR : '(none — API/proxy only)'}`);
});

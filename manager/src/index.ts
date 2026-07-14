import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Registry, newBrainRecord } from './registry.js';
import { generateBrainName } from './names.js';
import { BRAINSTEM_NAME, buildBrainstemServer } from './brainstem.js';
import { FlujoClient, type FlujoFlow } from './flujo.js';
import { provisionBrain, deprovisionBrain, rebuildBrain } from './provision.js';
import { dockerAvailable, removeFlujoContainer } from './docker.js';
import { ensureDefaultFlujo } from './spawnFlujo.js';
import type { CreateBrainRequest, ModelSpec } from './types.js';

const PORT = Number(process.env.PORT ?? 8090);
const FLUJO_DEFAULT_URL = process.env.FLUJO_DEFAULT_URL ?? 'http://localhost:4200';
/** The default FLUJO as the user's BROWSER reaches it (FLUJO_DEFAULT_URL is
 *  container-internal in Docker; compose publishes it on 127.0.0.1:4200). */
const FLUJO_DEFAULT_PUBLIC_URL = process.env.FLUJO_DEFAULT_PUBLIC_URL ?? FLUJO_DEFAULT_URL;
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

const normUrl = (u: string) => u.replace(/\/+$/, '');

/** The brain that already lives in a FLUJO instance, if any. */
const brainAt = (url: string) => registry.list().find((b) => b.flujoUrl && normUrl(b.flujoUrl) === normUrl(url));

api.get('/health', (_req, res) => res.json({ ok: true }));

api.get('/brains', async (_req, res) => {
  res.json({
    brains: registry.list().map(publicBrain),
    docker: await dockerAvailable(),
    defaultFlujo: FLUJO_DEFAULT_URL,
    defaultFlujoEditor: FLUJO_DEFAULT_PUBLIC_URL,
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
  if (!body?.lifeGoal?.trim() || !body?.model) {
    return res.status(400).json({ error: 'lifeGoal and model are required' });
  }
  // Without Docker only adopted brains are possible. Refuse up front instead
  // of birthing a brain whose provisioning is doomed (the lobby's wizard
  // forces adopt mode in this case; this guards any other client).
  if (!body.adoptUrl && !(await dockerAvailable())) {
    return res.status(400).json({ error: 'Docker is not available — this brain must adopt an existing FLUJO instance (set adoptUrl).' });
  }
  // The name is just a handle — auto-generated unless the caller insists.
  const taken = new Set(registry.list().map((b) => b.name));
  const name = body.name?.trim() || generateBrainName(taken);
  if (taken.has(name)) {
    return res.status(409).json({ error: 'a brain with that name already exists' });
  }
  // 'default' = adopt the stack's default FLUJO without the browser needing
  // to know its internal URL.
  const adoptsDefault = body.adoptUrl === 'default';
  if (adoptsDefault) body.adoptUrl = FLUJO_DEFAULT_URL;
  // One FLUJO instance hosts at most one brain — a second adoption would just
  // alias the first mind (shared brain-stem flow and tool belt).
  if (body.adoptUrl) {
    const owner = brainAt(body.adoptUrl);
    if (owner) {
      return res.status(409).json({ error: `that FLUJO already hosts the brain "${owner.name}" — open it from the lobby instead` });
    }
  }
  const brain = newBrainRecord(name, body.lifeGoal.trim());
  // Adopted instances: the editor link is the URL as the browser knows it.
  if (body.adoptUrl) {
    brain.editorUrl = (adoptsDefault ? FLUJO_DEFAULT_PUBLIC_URL : body.adoptUrl).replace(/\/+$/, '');
  }
  await registry.put(brain);
  void provisionBrain(registry, brain, body); // runs in background; lobby polls status
  res.status(202).json(publicBrain(brain));
});

/**
 * Connect a FLUJO instance elsewhere in the network. If it already carries a
 * brain-stem (a brain grown elsewhere), it joins the lobby as-is — name and
 * life goal are recovered from the stem flow and its tool belt is re-pointed
 * at this manager. An empty instance is registered too; the viewer's grow
 * card puts a brain-stem into it.
 */
api.post('/connect', async (req, res) => {
  const raw = (req.body as { url?: string })?.url?.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) {
    return res.status(400).json({ error: 'url must start with http:// or https://' });
  }
  const url = normUrl(raw);
  const owner = brainAt(url);
  if (owner) {
    return res.status(409).json({ error: `already connected — that FLUJO hosts the brain "${owner.name}"` });
  }

  const flujo = new FlujoClient(url);
  let flows: FlujoFlow[];
  try {
    flows = await flujo.listFlows();
    if (!Array.isArray(flows)) throw new Error('unexpected answer');
  } catch (err) {
    return res.status(502).json({ error: `no FLUJO reachable at ${url}: ${(err as Error).message}` });
  }

  const stem = flows.find((f) => f.name === BRAINSTEM_NAME);
  const taken = new Set(registry.list().map((b) => b.name));
  const parsed = (stem?.description ?? '').match(/^Root of the "(.+?)" brain\. Life goal: (.*)$/s);
  const name = parsed && !taken.has(parsed[1]) ? parsed[1] : generateBrainName(taken);
  const brain = newBrainRecord(name, parsed?.[2] ?? '');
  brain.kind = 'external';
  brain.flujoUrl = url;
  brain.editorUrl = url;
  brain.status = 'ready';

  if (stem) {
    brain.brainstemFlowId = stem.id;
    // Model shown on the card: whatever the stem's process node thinks with.
    try {
      const proc = stem.nodes?.find((n) => (n.data?.type ?? n.type) === 'process');
      const boundModel = proc?.data?.properties?.boundModel as string | undefined;
      const model = boundModel ? (await flujo.listModels()).find((m) => m.id === boundModel) : undefined;
      if (model) {
        brain.modelId = model.id;
        brain.modelName = model.displayName ?? model.name;
      }
    } catch {
      // Cosmetic only.
    }
    // Re-point the tool belt at THIS manager (heals brains whose original
    // manager is gone). Best-effort: the flow keeps working without it.
    const managerBase = process.env.MANAGER_INTERNAL_URL ?? `http://${req.get('host')}`;
    await flujo
      .updateMcpServer(BRAINSTEM_NAME, {
        name: BRAINSTEM_NAME,
        transport: 'streamable',
        serverUrl: `${managerBase}/brains/${brain.id}/mcp/${brain.token}`,
        disabled: false,
      })
      .catch(() => undefined);
  }

  await registry.put(brain);
  res.status(201).json({ ...publicBrain(brain), hasStem: Boolean(stem) });
});

/**
 * Grow a brain-stem into an already-registered (adopted) instance — used by
 * the viewer's grow card when it looks at a brain through the per-brain proxy.
 */
api.post('/brains/:id/grow', async (req, res) => {
  const brain = registry.get(req.params.id);
  if (!brain) return res.status(404).json({ error: 'no such brain' });
  if (brain.status === 'provisioning') return res.status(409).json({ error: 'already provisioning' });
  const body = req.body as { lifeGoal?: string; model?: ModelSpec; heartbeat?: boolean; heartbeatCron?: string };
  if (!body?.lifeGoal?.trim() || !body?.model) {
    return res.status(400).json({ error: 'lifeGoal and model are required' });
  }
  brain.lifeGoal = body.lifeGoal.trim();
  brain.status = 'provisioning';
  brain.statusDetail = undefined;
  await registry.put(brain);
  void provisionBrain(registry, brain, {
    lifeGoal: brain.lifeGoal,
    model: body.model,
    adoptUrl: brain.flujoUrl,
    heartbeat: body.heartbeat,
    heartbeatCron: body.heartbeatCron,
  });
  res.status(202).json(publicBrain(brain));
});

/**
 * Recreate a managed brain's container from the current FLUJO_IMAGE, keeping
 * its volumes — the in-place upgrade path when the image gained new powers
 * (e.g. the baked-in browser).
 */
api.post('/brains/:id/rebuild', async (req, res) => {
  const brain = registry.get(req.params.id);
  if (!brain) return res.status(404).json({ error: 'no such brain' });
  if (brain.kind !== 'managed' || !brain.containerId) {
    return res.status(400).json({ error: 'only managed (Docker) brains can be rebuilt' });
  }
  if (brain.status === 'provisioning') return res.status(409).json({ error: 'already provisioning' });
  brain.status = 'provisioning';
  brain.statusDetail = 'rebuilding from the current image…';
  await registry.put(brain);
  void rebuildBrain(registry, brain);
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
  // Users often paste the OpenAI-compat URL FLUJO shows (…:11434/v1); the
  // native API lives at the root, so strip a trailing /v1 before /api/tags.
  const base =
    typeof req.query.url === 'string' && req.query.url
      ? req.query.url.replace(/\/+$/, '').replace(/\/v1$/, '')
      : OLLAMA_URL;
  if (!base) return res.status(503).json({ error: 'OLLAMA_URL not configured' });
  if (!/^https?:\/\//.test(base)) return res.status(400).json({ error: 'url must start with http:// or https://' });
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// ---------- live model catalogs (wizard hitlist) ----------

interface CatalogModel {
  id: string;
  name?: string;
}

async function catalogJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

/** OpenAI-compatible /models listing ({data: [{id, name?}]}). */
async function openaiStyleCatalog(url: string, key: string): Promise<CatalogModel[]> {
  const raw = (await catalogJson(url, { Authorization: `Bearer ${key}` })) as { data?: Array<{ id?: string; name?: string }> };
  return (raw.data ?? []).flatMap((m) => (m.id ? [{ id: m.id, name: m.name }] : []));
}

/** OpenAI's own list mixes in embeddings/audio/image models — hide those. */
const OPENAI_NON_CHAT = /embed|whisper|tts|dall-e|moderation|babbage|davinci|audio|realtime|transcribe|image/;

/**
 * One fetcher per wizard provider, each hitting the provider's official
 * model-list endpoint. OpenRouter needs no key; everyone else expects the
 * key the user just typed into the wizard.
 */
const MODEL_CATALOGS: Record<string, (key: string) => Promise<CatalogModel[]>> = {
  openrouter: async () => {
    const raw = (await catalogJson('https://openrouter.ai/api/v1/models')) as { data?: Array<{ id?: string; name?: string }> };
    return (raw.data ?? []).flatMap((m) => (m.id ? [{ id: m.id, name: m.name }] : []));
  },
  requesty: (key) => openaiStyleCatalog('https://router.requesty.ai/v1/models', key),
  openai: async (key) =>
    (await openaiStyleCatalog('https://api.openai.com/v1/models', key)).filter((m) => !OPENAI_NON_CHAT.test(m.id)),
  anthropic: async (key) => {
    const raw = (await catalogJson('https://api.anthropic.com/v1/models?limit=1000', {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    })) as { data?: Array<{ id?: string; display_name?: string }> };
    return (raw.data ?? []).flatMap((m) => (m.id ? [{ id: m.id, name: m.display_name }] : []));
  },
  gemini: async (key) => {
    const raw = (await catalogJson(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`,
    )) as { models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    return (raw.models ?? [])
      .filter((m) => m.name && (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => ({ id: m.name!.replace(/^models\//, ''), name: m.displayName }));
  },
  mistral: (key) => openaiStyleCatalog('https://api.mistral.ai/v1/models', key),
  xai: (key) => openaiStyleCatalog('https://api.x.ai/v1/models', key),
};

/** The provider's live model catalog, for the wizard's searchable hitlist.
 *  POST so the API key travels in the body, never in a URL or access log;
 *  it is relayed only to that provider. */
api.post('/provider-models', async (req, res) => {
  const { provider, apiKey } = req.body as { provider?: string; apiKey?: string };
  const source = provider && MODEL_CATALOGS[provider];
  if (!source) return res.status(400).json({ error: `unknown provider: ${provider}` });
  if (provider !== 'openrouter' && !apiKey) return res.status(400).json({ error: 'apiKey required' });
  try {
    res.json({ models: await source(apiKey ?? '') });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/** Search the Ollama library (models available to pull). There is no official
 *  API for this — we scan ollama.com/search result links, and the wizard
 *  falls back to free typing when the markup drifts. */
api.get('/ollama/library', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ models: [] });
  try {
    const r = await fetch(`https://ollama.com/search?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (brain-manager)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`ollama.com answered ${r.status}`);
    const html = await r.text();
    const seen = new Set<string>();
    for (const m of html.matchAll(/href="\/library\/([^"?#]+)"/g)) {
      const slug = decodeURIComponent(m[1]);
      if (!seen.has(slug)) seen.add(slug);
      if (seen.size >= 12) break;
    }
    res.json({ models: [...seen].map((id) => ({ id })) });
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

/**
 * Front door for bare `/`: multi-brain installs (registered brains, or Docker
 * available to create them) land in the lobby. A bare machine with a FLUJO
 * already running on the default URL goes straight to the single-brain
 * viewer instead — no lobby detour when there is nothing to manage.
 * Unreachable FLUJO without Docker still means lobby (adopt mode).
 */
let frontDoor: { at: number; lobby: boolean } | null = null;
async function lobbyIsFrontDoor(): Promise<boolean> {
  if (frontDoor && Date.now() - frontDoor.at < 10_000) return frontDoor.lobby;
  let lobby = true;
  if (registry.list().length === 0 && !(await dockerAvailable())) {
    try {
      const r = await fetch(`${FLUJO_DEFAULT_URL}/api/flow`, { signal: AbortSignal.timeout(1500) });
      lobby = !r.ok;
    } catch {
      lobby = true;
    }
  }
  frontDoor = { at: Date.now(), lobby };
  return lobby;
}

if (fs.existsSync(UI_DIR)) {
  // Viewer links keep working because they carry a query
  // (`/?flujo=/brains/<id>/flujo` from the lobby's open buttons).
  app.get('/', async (req, res, next) => {
    if (Object.keys(req.query).length > 0) return next();
    if (await lobbyIsFrontDoor()) return res.redirect('/lobby.html');
    // Single-brain mode: viewer on the default FLUJO via the same-origin proxy.
    res.redirect(`/?flujo=${encodeURIComponent('/flujo')}`);
  });
  app.use(express.static(UI_DIR));
  app.get(/^\/(?!api|brains|flujo).*/, (_req, res) => res.sendFile(path.join(UI_DIR, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`brain-manager listening on http://localhost:${PORT}`);
  console.log(`  default FLUJO: ${FLUJO_DEFAULT_URL}`);
  console.log(`  ui dir: ${fs.existsSync(UI_DIR) ? UI_DIR : '(none — API/proxy only)'}`);
  // Standalone launcher only (FLUJO_AUTOSTART=1): if nothing answers on the
  // default URL and it is local, spawn a FLUJO from the npm package so a bare
  // machine still gets a working single-brain setup. Fire-and-forget — the
  // front door keeps answering (lobby) until the instance is up.
  if (process.env.FLUJO_AUTOSTART === '1') void ensureDefaultFlujo(FLUJO_DEFAULT_URL);
});

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Registry, newBrainRecord } from './registry.js';
import { generateBrainName } from './names.js';
import { buildBrainstemServer } from './brainstem.js';
import { FlujoClient } from './flujo.js';
import { provisionBrain, deprovisionBrain } from './provision.js';
import { dockerAvailable, removeFlujoContainer } from './docker.js';
import type { CreateBrainRequest } from './types.js';

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
  const brain = newBrainRecord(name, body.lifeGoal.trim());
  // Adopted instances: the editor link is the URL as the browser knows it.
  if (body.adoptUrl) {
    brain.editorUrl = (adoptsDefault ? FLUJO_DEFAULT_PUBLIC_URL : body.adoptUrl).replace(/\/+$/, '');
  }
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
  console.log(`brain-manager listening on :${PORT}`);
  console.log(`  default FLUJO: ${FLUJO_DEFAULT_URL}`);
  console.log(`  ui dir: ${fs.existsSync(UI_DIR) ? UI_DIR : '(none — API/proxy only)'}`);
});

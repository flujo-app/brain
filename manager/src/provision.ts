import crypto from 'node:crypto';
import { FlujoClient, type FlujoModel } from './flujo.js';
import { createFlujoContainer, flujoImageAvailable, removeFlujoContainer } from './docker.js';
import { BRAINSTEM_NAME, brainstemFlow, WAKE_PROMPT } from './brainstem.js';
import type { Registry } from './registry.js';
import type { BrainRecord, CreateBrainRequest, ModelSpec } from './types.js';

const OLLAMA_URL = process.env.OLLAMA_URL; // e.g. http://ollama:11434
/** How FLUJO reaches this manager's MCP endpoints (container-internal in Docker). */
const MANAGER_INTERNAL_URL = process.env.MANAGER_INTERNAL_URL ?? `http://localhost:${process.env.PORT ?? 8090}`;

/** Default base URLs for bring-your-own-key providers. */
const BYOK_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  requesty: 'https://router.requesty.ai/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
};

async function waitForFlujo(flujo: FlujoClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await flujo.ping();
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`FLUJO at ${flujo.base} not reachable within ${timeoutMs / 1000}s`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
}

/** Pull an Ollama tag (streams until done) and register it as a FLUJO model.
 *  spec.baseUrl points at an Ollama elsewhere in the network; default is the stack's own. */
async function setupOllamaModel(flujo: FlujoClient, spec: Extract<ModelSpec, { mode: 'ollama' }>): Promise<FlujoModel> {
  // Accept FLUJO-style …/v1 URLs too — /api/pull is on the native root, and
  // /v1 is re-appended below when the model is registered in FLUJO.
  const base = (spec.baseUrl ?? OLLAMA_URL)?.replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!base) throw new Error('OLLAMA_URL is not configured — cannot pull local models.');
  let res: Response;
  try {
    res = await fetch(`${base}/api/pull`, {
      method: 'POST',
      body: JSON.stringify({ name: spec.tag }),
    });
  } catch (err) {
    // A bare 'fetch failed' helps nobody — say who was unreachable.
    throw new Error(
      `Ollama at ${base} is unreachable (${(err as Error).cause instanceof Error ? (err as Error & { cause: Error }).cause.message : (err as Error).message}) — ` +
        `is Ollama running? (Docker stack: docker compose up -d · standalone: install and start Ollama from ollama.com)`,
    );
  }
  if (!res.ok || !res.body) throw new Error(`ollama pull ${spec.tag} failed: ${res.status} ${await res.text()}`);
  // Drain the progress stream; the pull is done when the stream ends.
  for await (const _ of res.body) {
    // Progress lines — could be forwarded to the lobby later.
  }
  return flujo.createModel({
    id: crypto.randomUUID(),
    name: spec.tag,
    displayName: `${spec.tag} (ollama)`,
    provider: 'ollama',
    baseUrl: `${base}/v1`,
    ApiKey: '',
  });
}

/** BYO-key: FLUJO stores the key encrypted at rest — brain never persists it. */
async function setupByokModel(flujo: FlujoClient, spec: Extract<ModelSpec, { mode: 'byok' }>): Promise<FlujoModel> {
  const baseUrl = spec.baseUrl ?? BYOK_BASE_URLS[spec.provider];
  if (!baseUrl) throw new Error(`Unknown provider "${spec.provider}" — pass an explicit baseUrl.`);
  return flujo.createModel({
    id: crypto.randomUUID(),
    name: spec.model,
    displayName: `${spec.model} (${spec.provider})`,
    provider: spec.provider,
    baseUrl,
    ApiKey: spec.apiKey,
  });
}

/** Register the baked-in headless Chromium as the "browser" skill (idempotent). */
async function ensureBrowserSkill(flujo: FlujoClient): Promise<void> {
  const servers = await flujo.listMcpServers();
  if (servers.some((s) => s.name === 'browser')) return;
  await flujo.createMcpServer({
    name: 'browser',
    transport: 'stdio',
    command: 'playwright-mcp',
    // --isolated: fresh profile per session, so parallel behaviours never
    // fight over a profile lock. System Chromium, no sandbox (the container
    // is the sandbox), headless.
    args: ['--headless', '--no-sandbox', '--isolated', '--executable-path', '/usr/bin/chromium'],
    disabled: false,
    autoApprove: [],
    env: {},
    rootPath: '',
  });
}

/**
 * The full birth of a brain: instance → model → tool belt → brain-stem →
 * heartbeat → (optionally) first wake. Runs in the background; progress is
 * written to the registry so the lobby can poll it.
 */
export async function provisionBrain(registry: Registry, brain: BrainRecord, req: CreateBrainRequest): Promise<void> {
  const step = async (detail: string) => {
    brain.statusDetail = detail;
    await registry.put(brain);
  };

  try {
    // 1. The instance.
    if (req.adoptUrl) {
      brain.kind = 'external';
      brain.flujoUrl = req.adoptUrl.replace(/\/+$/, '');
      await step('connecting to adopted FLUJO…');
    } else {
      brain.kind = 'managed';
      await step('creating FLUJO container…');
      // Candidate editor ports: 4201 upwards, skipping ones the registry
      // already handed out (the host may still hold others — docker.ts retries).
      const used = new Set(registry.list().map((b) => b.editorPort).filter(Boolean));
      const candidates: number[] = [];
      for (let p = 4201; p <= 4299 && candidates.length < 20; p++) if (!used.has(p)) candidates.push(p);
      const c = await createFlujoContainer(brain.id, candidates);
      brain.containerId = c.containerId;
      brain.flujoUrl = c.flujoUrl;
      brain.editorPort = c.editorPort;
      brain.editorUrl = `http://127.0.0.1:${c.editorPort}`;
      await registry.put(brain);
    }
    const flujo = new FlujoClient(brain.flujoUrl);
    await waitForFlujo(flujo, req.adoptUrl ? 10_000 : 240_000);

    // 2. The model.
    await step('setting up the model…');
    let model: FlujoModel;
    if (req.model.mode === 'ollama') model = await setupOllamaModel(flujo, req.model);
    else if (req.model.mode === 'byok') model = await setupByokModel(flujo, req.model);
    else {
      const models = await flujo.listModels();
      const found = models.find((m) => m.id === (req.model as { id: string }).id);
      if (!found) throw new Error(`Model ${(req.model as { id: string }).id} not found in the FLUJO instance.`);
      model = found;
    }
    brain.modelId = model.id;
    brain.modelName = model.displayName ?? model.name;

    // 3. The tool belt: this manager, registered into FLUJO as a remote
    //    streamable MCP server. The token in the URL is the auth.
    await step('registering the brain-stem tool belt…');
    const serverUrl = `${MANAGER_INTERNAL_URL}/brains/${brain.id}/mcp/${brain.token}`;
    const existing = await flujo.listMcpServers();
    if (!existing.some((s) => s.name === BRAINSTEM_NAME)) {
      await flujo.createMcpServer({
        name: BRAINSTEM_NAME,
        transport: 'streamable',
        serverUrl,
        disabled: false,
        autoApprove: [],
        env: {},
        rootPath: '',
      });
    }

    // 3b. The browser skill — managed brains run the flujo-browser image
    //     (headless Chromium + Playwright MCP baked in), so offer it as a
    //     ready skill. Adopted instances are left alone: their host may lack
    //     a browser, and the brain can still learn one that fits.
    if (!req.adoptUrl) {
      await step('installing the browser skill…');
      try {
        await ensureBrowserSkill(flujo);
      } catch (err) {
        // Not fatal — the image may be a plain FLUJO without Chromium.
        brain.statusDetail = `browser skill skipped: ${(err as Error).message}`;
      }
    }

    // 4. The brain-stem flow (life goal + model + tools). Newer FLUJOs expose
    //    their whole API as the built-in "flujo" MCP server (also proxied at
    //    /mcp-proxy/flujo) — bind all of its tools so the brain-stem can drive
    //    FLUJO directly. Older instances just don't have it; skip silently.
    await step('growing the brain-stem…');
    const flujoTools = await flujo
      .listServerTools('flujo')
      .then((r) => (r.error ? [] : (r.tools ?? []).flatMap((t) => (t.name ? [t.name] : []))))
      .catch(() => [] as string[]);
    const flows = await flujo.listFlows().catch(() => []);
    const already = flows.find((f) => f.name === BRAINSTEM_NAME);
    if (already) {
      brain.brainstemFlowId = already.id;
    } else {
      const flow = brainstemFlow(brain, model.id, model.name, flujoTools) as { id: string };
      await flujo.createFlow(flow);
      brain.brainstemFlowId = flow.id;
    }

    // 5. The heartbeat: FLUJO's own scheduler wakes the mind.
    if (req.heartbeat !== false) {
      await step('starting the heartbeat…');
      try {
        await flujo.createPlannedExecution({
          name: `${brain.name} heartbeat`,
          enabled: true,
          flowId: brain.brainstemFlowId,
          prompt: WAKE_PROMPT,
          saveConversations: true,
          // 3-minute beat (croner 6-field, seconds first). Overlap is safe —
          // FLUJO's scheduler skips a fire while the previous run is still in
          // flight — the default is about keeping token spend sane.
          trigger: { type: 'schedule', cron: req.heartbeatCron ?? '0 */3 * * * *', catchUp: false },
        });
      } catch (err) {
        // Not fatal — the brain works, it just doesn't wake on its own.
        brain.statusDetail = `heartbeat failed: ${(err as Error).message}`;
      }
    }

    // 6. First wake (optional — spends tokens).
    if (req.wake) {
      await step('first wake…');
      flujo.runFlow(BRAINSTEM_NAME, WAKE_PROMPT).catch(() => undefined);
    }

    brain.status = 'ready';
    brain.statusDetail = undefined;
    await registry.put(brain);
  } catch (err) {
    brain.status = 'error';
    brain.statusDetail = (err as Error).message;
    await registry.put(brain);
  }
}

/**
 * Recreate a managed brain's container from the CURRENT image, keeping its
 * named volumes (db + mcp-servers) — flows, models, memories and the belt
 * registration all survive; only the image changes. Runs in the background
 * like provisioning; the lobby polls the status.
 */
export async function rebuildBrain(registry: Registry, brain: BrainRecord): Promise<void> {
  const step = async (detail: string) => {
    brain.statusDetail = detail;
    await registry.put(brain);
  };

  try {
    if (brain.kind !== 'managed' || !brain.containerId) {
      throw new Error('only managed (Docker) brains can be rebuilt');
    }
    // Never strand a brain: make sure the target image exists BEFORE the old
    // container is torn down.
    if (!(await flujoImageAvailable())) {
      throw new Error('the FLUJO image is not available locally — run `docker compose build flujo` (or pull it) first');
    }

    await step('removing the old container (memories are kept)…');
    await removeFlujoContainer(brain.containerId, brain.id, false);

    await step('creating the new container…');
    const used = new Set(
      registry
        .list()
        .filter((b) => b.id !== brain.id)
        .map((b) => b.editorPort)
        .filter(Boolean),
    );
    // Prefer the brain's old editor port so bookmarks keep working.
    const candidates: number[] = brain.editorPort ? [brain.editorPort] : [];
    for (let p = 4201; p <= 4299 && candidates.length < 20; p++) {
      if (!used.has(p) && !candidates.includes(p)) candidates.push(p);
    }
    const c = await createFlujoContainer(brain.id, candidates);
    brain.containerId = c.containerId;
    brain.flujoUrl = c.flujoUrl;
    brain.editorPort = c.editorPort;
    brain.editorUrl = `http://127.0.0.1:${c.editorPort}`;
    await registry.put(brain);

    await step('waiting for FLUJO to wake…');
    const flujo = new FlujoClient(brain.flujoUrl);
    await waitForFlujo(flujo, 240_000);

    // The volumes carried everything user-made; only image-level extras can
    // be new. Today that is the browser skill.
    await step('installing the browser skill…');
    try {
      await ensureBrowserSkill(flujo);
    } catch (err) {
      brain.statusDetail = `browser skill skipped: ${(err as Error).message}`;
    }

    brain.status = 'ready';
    brain.statusDetail = undefined;
    await registry.put(brain);
  } catch (err) {
    brain.status = 'error';
    brain.statusDetail = `rebuild failed: ${(err as Error).message}`;
    await registry.put(brain);
  }
}

/** Tear down what provisioning created (best-effort, per part). */
export async function deprovisionBrain(brain: BrainRecord): Promise<string[]> {
  const notes: string[] = [];
  const flujo = new FlujoClient(brain.flujoUrl);
  try {
    if (brain.brainstemFlowId) await flujo.deleteFlow(brain.brainstemFlowId);
    notes.push('brain-stem flow removed');
  } catch (err) {
    notes.push(`flow: ${(err as Error).message}`);
  }
  try {
    await flujo.deleteMcpServer(BRAINSTEM_NAME);
    notes.push('tool belt unregistered');
  } catch (err) {
    notes.push(`mcp: ${(err as Error).message}`);
  }
  return notes;
}

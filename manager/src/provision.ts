import crypto from 'node:crypto';
import { FlujoClient, type FlujoModel } from './flujo.js';
import { createFlujoContainer } from './docker.js';
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
        `is the ollama service running? (docker compose up -d starts the whole stack)`,
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

    // 4. The brain-stem flow (life goal + model + tools).
    await step('growing the brain-stem…');
    const flows = await flujo.listFlows().catch(() => []);
    const already = flows.find((f) => f.name === BRAINSTEM_NAME);
    if (already) {
      brain.brainstemFlowId = already.id;
    } else {
      const flow = brainstemFlow(brain, model.id, model.name) as { id: string };
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
          // 30s beat (croner 6-field, seconds first). Safe because FLUJO's
          // scheduler skips a fire while the previous run is still in flight.
          trigger: { type: 'schedule', cron: req.heartbeatCron ?? '*/30 * * * * *', catchUp: false },
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

/** One brain = one FLUJO instance + a brain-stem flow driven by its own model. */
export interface BrainRecord {
  id: string;
  name: string;
  lifeGoal: string;
  /** FLUJO base URL reachable FROM THE MANAGER (container-internal in Docker). */
  flujoUrl: string;
  /** managed = Docker container we own; external = adopted running instance. */
  kind: 'managed' | 'external';
  containerId?: string;
  /** URL-path secret FLUJO uses to reach this brain's MCP endpoint. */
  token: string;
  /** Host loopback port publishing a managed brain's FLUJO editor. */
  editorPort?: number;
  /** FLUJO editor URL reachable from the user's browser (host perspective). */
  editorUrl?: string;
  modelId?: string;
  modelName?: string;
  brainstemFlowId?: string;
  status: 'provisioning' | 'ready' | 'error';
  statusDetail?: string;
  createdAt: string;
}

/** How the brain's model is provided (chosen by the user at creation). */
export type ModelSpec =
  /** Pull a tag into an Ollama and register it in FLUJO. baseUrl overrides
   *  the stack's own Ollama with one elsewhere in the user's network. */
  | { mode: 'ollama'; tag: string; baseUrl?: string }
  /** Bring-your-own key; FLUJO stores the key encrypted at rest. */
  | { mode: 'byok'; provider: string; model: string; apiKey: string; baseUrl?: string }
  /** Reuse a model that already exists in the FLUJO instance (adopted brains). */
  | { mode: 'existing'; id: string };

export interface CreateBrainRequest {
  /** Optional — the manager auto-generates a friendly name when absent. */
  name?: string;
  lifeGoal: string;
  model: ModelSpec;
  /** Adopt a running FLUJO instead of provisioning a container (dev mode). */
  adoptUrl?: string;
  /** Create the planned-execution heartbeat that wakes the brain-stem. */
  heartbeat?: boolean;
  /** Cron for the heartbeat (croner syntax). Default: every 3 minutes. */
  heartbeatCron?: string;
  /** Kick a first brain-stem run right after provisioning (spends tokens). */
  wake?: boolean;
}

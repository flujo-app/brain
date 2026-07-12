/**
 * Thin client for one FLUJO instance's REST API. FLUJO has no auth (it's
 * only reachable on internal networks); every brain gets its own client.
 */

export interface FlujoFlow {
  id: string;
  name: string;
  description?: string;
  nodes: Array<{ id: string; type?: string; data: { type?: string; properties?: Record<string, unknown> } }>;
  edges: unknown[];
}

export interface FlujoModel {
  id: string;
  name: string;
  displayName?: string;
  provider?: string;
  baseUrl?: string;
  ApiKey?: string;
}

export interface McpServerConfig {
  name: string;
  transport: string;
  disabled?: boolean;
  serverUrl?: string;
  [key: string]: unknown;
}

export class FlujoClient {
  constructor(readonly base: string) {}

  private async req<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 15_000);
    try {
      const res = await fetch(`${this.base}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`FLUJO ${init?.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      return (text ? JSON.parse(text) : undefined) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  ping(): Promise<unknown> {
    return this.req('/api/cwd', { timeoutMs: 4000 });
  }

  // ---- flows ----
  listFlows(): Promise<FlujoFlow[]> {
    return this.req('/api/flow');
  }

  createFlow(flow: unknown): Promise<unknown> {
    return this.req('/api/flow', { method: 'POST', body: JSON.stringify(flow) });
  }

  deleteFlow(id: string): Promise<unknown> {
    return this.req(`/api/flow/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** LLM-generates a DRAFT flow (unsaved — persist via createFlow). */
  generateFlow(description: string, modelId: string): Promise<{ flow?: unknown; validation?: unknown; attempts?: number }> {
    return this.req('/api/flow/generate', {
      method: 'POST',
      body: JSON.stringify({ description, modelId }),
      timeoutMs: 300_000,
    });
  }

  // ---- models ----
  listModels(): Promise<FlujoModel[]> {
    return this.req('/api/model');
  }

  createModel(model: FlujoModel): Promise<FlujoModel> {
    return this.req('/api/model', { method: 'POST', body: JSON.stringify(model) });
  }

  // ---- MCP servers ----
  listMcpServers(): Promise<McpServerConfig[]> {
    return this.req('/api/mcp/servers');
  }

  createMcpServer(config: McpServerConfig): Promise<unknown> {
    return this.req('/api/mcp/servers', { method: 'POST', body: JSON.stringify(config), timeoutMs: 60_000 });
  }

  deleteMcpServer(name: string): Promise<unknown> {
    return this.req(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  mcpRegistry(): Promise<unknown> {
    return this.req('/api/mcp-registry', { timeoutMs: 30_000 });
  }

  /** Tools of one MCP server (e.g. FLUJO's built-in "flujo" API server). */
  listServerTools(name: string): Promise<{ tools?: Array<{ name?: string }>; error?: string }> {
    return this.req(`/api/mcp/servers/${encodeURIComponent(name)}/tools`, { timeoutMs: 30_000 });
  }

  // ---- execution ----
  /** Run a flow to completion via the OpenAI-compatible endpoint. */
  async runFlow(flowName: string, input: string, timeoutMs = 600_000): Promise<string> {
    const res = await this.req<{ choices?: Array<{ message?: { content?: string } }> }>('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: `flow-${flowName}`, messages: [{ role: 'user', content: input }] }),
      timeoutMs,
    });
    return res?.choices?.[0]?.message?.content ?? '(no output)';
  }

  createPlannedExecution(pe: unknown): Promise<unknown> {
    return this.req('/api/planned-executions', { method: 'POST', body: JSON.stringify(pe) });
  }
}

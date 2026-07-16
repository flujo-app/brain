import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FlujoClient, FlujoFlow } from './flujo.js';
import type { BrainRecord } from './types.js';

/** The protected root flow and the MCP server name it binds. */
export const BRAINSTEM_NAME = 'brain-stem';

export const BRAINSTEM_TOOLS = [
  'list_behaviours',
  'learn_behaviour',
  'perform_behaviour',
  'forget_behaviour',
  'list_skills',
  'use_skill',
  'learn_skill',
  'forget_skill',
] as const;

/** Max concurrent ephemeral behaviour runs per brain. Doubles as the recursion
 *  depth cap: a behaviour that binds the brain-stem and performs another
 *  behaviour holds its slot while awaiting the child, so nesting deeper than
 *  this refuses instead of recursing forever. */
const MAX_CONCURRENT_PERFORMS = 4;
const performCounts = new Map<string, number>();

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/**
 * The brain-stem's tool belt: seven friendly verbs over FLUJO's own REST API.
 * This is the single choke point where self-modification policy lives —
 * FLUJO itself has no guardrails.
 */
export function buildBrainstemServer(brain: BrainRecord, flujo: FlujoClient): McpServer {
  const server = new McpServer({ name: BRAINSTEM_NAME, version: '0.1.0' });

  server.tool(
    'list_behaviours',
    'List every behaviour (flow) this brain currently knows, with descriptions.',
    {},
    async () => {
      const flows = await flujo.listFlows();
      const lines = flows.map((f) => {
        const self = f.name === BRAINSTEM_NAME ? ' [this is you — protected]' : '';
        return `- ${f.name}${self}: ${f.description || '(no description)'} (${f.nodes?.length ?? 0} nodes)`;
      });
      return text(lines.join('\n') || 'No behaviours yet.');
    },
  );

  server.tool(
    'learn_behaviour',
    'Learn a NEW behaviour: describe what it should do and a flow is designed with your own model, then saved. Growth verb — use it when no existing behaviour fits.',
    { description: z.string().describe('What the new behaviour should do, in detail — inputs, steps, tools it may need, outputs.') },
    async ({ description }) => {
      if (!brain.modelId) return text('ERROR: this brain has no model configured for learning.');
      const result = await flujo.generateFlow(description, brain.modelId);
      const flow = result.flow as (FlujoFlow & { id?: string }) | undefined;
      if (!flow) return text(`Learning failed: ${JSON.stringify(result).slice(0, 500)}`);
      if (flow.name === BRAINSTEM_NAME) flow.name = `${BRAINSTEM_NAME}-child`;
      flow.id = crypto.randomUUID();
      await flujo.createFlow(flow);
      return text(`Learned behaviour "${flow.name}" (${flow.nodes?.length ?? 0} nodes). Validation: ${JSON.stringify(result.validation ?? 'ok').slice(0, 400)}`);
    },
  );

  server.tool(
    'perform_behaviour',
    `Perform one of your behaviours now (ephemeral run) and get its result. Not for the brain-stem itself. Behaviours may perform behaviours in turn — at most ${MAX_CONCURRENT_PERFORMS} run/nest at once.`,
    {
      name: z.string().describe('Exact behaviour name from list_behaviours.'),
      input: z.string().describe('The task or message to give the behaviour.'),
    },
    async ({ name, input }) => {
      if (name === BRAINSTEM_NAME) return text('REFUSED: the brain-stem cannot perform itself (recursion).');
      const flows = await flujo.listFlows();
      const flow = flows.find((f) => f.name === name);
      if (!flow) return text(`No behaviour named "${name}". Use list_behaviours first.`);
      const running = performCounts.get(brain.id) ?? 0;
      if (running >= MAX_CONCURRENT_PERFORMS) return text(`REFUSED: already ${running} behaviours running or nested — wait for them to finish.`);
      performCounts.set(brain.id, running + 1);
      try {
        const out = await flujo.runFlow(name, input);
        return text(out.slice(0, 8000));
      } finally {
        performCounts.set(brain.id, (performCounts.get(brain.id) ?? 1) - 1);
      }
    },
  );

  server.tool(
    'forget_behaviour',
    'Permanently forget a behaviour you no longer need. Irreversible.',
    { name: z.string().describe('Exact behaviour name to forget.') },
    async ({ name }) => {
      if (name === BRAINSTEM_NAME) return text('REFUSED: you cannot forget yourself.');
      const flows = await flujo.listFlows();
      const flow = flows.find((f) => f.name === name);
      if (!flow) return text(`No behaviour named "${name}".`);
      await flujo.deleteFlow(flow.id);
      return text(`Forgot behaviour "${name}".`);
    },
  );

  server.tool(
    'list_skills',
    'List your skills (MCP servers): what is installed and connected. Pass name to see one skill\'s tools (needed before use_skill). Pass search to also browse the public registry for NEW skills to learn.',
    {
      search: z.string().optional().describe('Optional: search the MCP registry for installable skills.'),
      name: z.string().optional().describe('Optional: an installed skill name — lists its tools.'),
    },
    async ({ search, name }) => {
      const servers = await flujo.listMcpServers();
      const installed = servers
        .map((s) => `- ${s.name}${s.name === BRAINSTEM_NAME ? ' [this is your own tool belt — protected]' : ''}${s.disabled ? ' (disabled)' : ''}`)
        .join('\n');
      let toolList = '';
      if (name) {
        try {
          const res = await flujo.listServerTools(name);
          const lines = (res.tools ?? []).map((t) => `- ${t.name}: ${(t.description ?? '').slice(0, 120)}`);
          toolList = `\n\nTools of "${name}":\n${lines.join('\n') || `(none${res.error ? ` — ${res.error}` : ''})`}`;
        } catch (err) {
          toolList = `\n\n(Could not list tools of "${name}": ${(err as Error).message})`;
        }
      }
      let found = '';
      if (search) {
        try {
          const reg = (await flujo.mcpRegistry()) as { servers?: Array<{ name?: string; description?: string }> } | Array<{ name?: string; description?: string }>;
          const entries = Array.isArray(reg) ? reg : reg?.servers ?? [];
          const q = search.toLowerCase();
          const hits = entries
            .filter((e) => `${e?.name} ${e?.description}`.toLowerCase().includes(q))
            .slice(0, 8)
            .map((e) => `- ${e.name}: ${(e.description ?? '').slice(0, 140)}`);
          found = `\n\nRegistry matches for "${search}":\n${hits.join('\n') || '(none)'}`;
        } catch (err) {
          found = `\n\n(Registry search failed: ${(err as Error).message})`;
        }
      }
      return text(`Installed skills:\n${installed || '(none)'}${toolList}${found}`);
    },
  );

  server.tool(
    'use_skill',
    'Use an installed skill directly: call one of its MCP tools and get the result. Run list_skills with name first to see the tools and their arguments.',
    {
      skill: z.string().describe('Installed skill (MCP server) name from list_skills.'),
      tool: z.string().describe('Exact tool name on that skill.'),
      args: z.record(z.unknown()).optional().describe('Arguments for the tool, as a JSON object.'),
    },
    async ({ skill, tool, args }) => {
      if (skill === BRAINSTEM_NAME) return text('REFUSED: use your tool belt directly, not through use_skill (recursion).');
      try {
        const out = await flujo.callTool(skill, tool, args ?? {});
        const s = typeof out === 'string' ? out : JSON.stringify(out);
        return text(s.slice(0, 8000) || '(empty result)');
      } catch (err) {
        return text(`Skill call failed: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    'learn_skill',
    'Learn a new skill by installing an MCP server. Provide either a remote serverUrl (streamable HTTP) or a local command to run.',
    {
      name: z.string().describe('Short name for the skill (letters, digits, dashes).'),
      serverUrl: z.string().optional().describe('Remote MCP server URL (Streamable HTTP).'),
      command: z.string().optional().describe('Local command (e.g. "npx").'),
      args: z.array(z.string()).optional().describe('Arguments for the command (e.g. ["-y", "@modelcontextprotocol/server-memory"]).'),
    },
    async ({ name, serverUrl, command, args }) => {
      if (name === BRAINSTEM_NAME) return text('REFUSED: that name is reserved.');
      if (!serverUrl && !command) return text('Provide serverUrl (remote) or command (local).');
      const config = serverUrl
        ? { name, transport: 'streamable', serverUrl, disabled: false, autoApprove: [], env: {}, rootPath: '' }
        : { name, transport: 'stdio', command: command!, args: args ?? [], disabled: false, autoApprove: [], env: {}, rootPath: '' };
      await flujo.createMcpServer(config);
      return text(`Learned skill "${name}". Check list_skills to confirm it connected, then bind it in behaviours that need it.`);
    },
  );

  server.tool(
    'forget_skill',
    'Forget (uninstall) a skill you no longer need.',
    { name: z.string().describe('Exact skill name to forget.') },
    async ({ name }) => {
      if (name === BRAINSTEM_NAME) return text('REFUSED: you cannot forget your own tool belt.');
      await flujo.deleteMcpServer(name);
      return text(`Forgot skill "${name}".`);
    },
  );

  return server;
}

/** System prompt for the brain-stem's process node.
 *  Deliberately minimal: the tool descriptions carry the semantics, and persona
 *  prose gets parroted verbatim by weak models ("I am the brain-stem…").
 *  Wake-specific instructions live in WAKE_PROMPT, not here. */
const BRAINSTEM_PROMPT = `Act through your tools. Take stock with list_behaviours and list_skills before acting.
Prefer performing an existing behaviour; learn a new one only when none fits. Forget what proved useless.`;

/** Build the brain-stem flow JSON (FLUJO's exact node/edge shapes).
 *  Only the eight tool-belt verbs are bound. FLUJO's own API (the built-in
 *  "flujo" MCP server, where present) stays reachable through
 *  list_skills/use_skill without bloating the bound schema. */
export function brainstemFlow(brain: BrainRecord, modelId: string, modelName: string): unknown {
  const startId = crypto.randomUUID();
  const processId = crypto.randomUUID();
  const mcpId = crypto.randomUUID();
  const finishId = crypto.randomUUID();
  const tools = [...BRAINSTEM_TOOLS];

  const edge = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({
    id: `${source}-${target}`,
    type: 'custom',
    animated: true,
    style: { stroke: '#7F8C8D', strokeWidth: 2 },
    markerEnd: { type: 'arrowclosed', width: 20, height: 20, color: '#7F8C8D' },
    source,
    sourceHandle,
    target,
    targetHandle,
    data: { edgeType: 'standard' },
  });

  const mcpEdge = (source: string, target: string) => ({
    id: `${source}-${target}`,
    type: 'mcpEdge',
    animated: false,
    style: { stroke: '#1976d2', strokeWidth: 2 },
    markerEnd: { type: 'arrowclosed', width: 20, height: 20, color: '#1976d2' },
    markerStart: { type: 'arrowclosed', width: 20, height: 20, color: '#1976d2' },
    source,
    sourceHandle: 'process-right-mcp',
    target,
    targetHandle: 'mcp-left',
    data: { edgeType: 'mcp' },
  });

  return {
    id: crypto.randomUUID(),
    name: BRAINSTEM_NAME,
    description: `Root of the "${brain.name}" brain. Life goal: ${brain.lifeGoal.slice(0, 140)}`,
    nodes: [
      {
        id: startId,
        type: 'start',
        position: { x: 250, y: 100 },
        data: {
          label: 'Life Goal',
          type: 'start',
          properties: { promptTemplate: `LIFE GOAL:\n${brain.lifeGoal}` },
        },
      },
      {
        id: processId,
        type: 'process',
        position: { x: 250, y: 260 },
        data: {
          id: processId,
          label: BRAINSTEM_NAME,
          type: 'process',
          properties: {
            boundModel: modelId,
            modelName,
            promptTemplate: BRAINSTEM_PROMPT,
            excludeModelPrompt: false,
            excludeStartNodePrompt: false,
            mcpNodes: [
              { id: mcpId, properties: { boundServer: BRAINSTEM_NAME, enabledTools: tools } },
            ],
          },
        },
      },
      {
        id: mcpId,
        type: 'mcp',
        position: { x: 540, y: 260 },
        data: {
          label: 'MCP Node',
          type: 'mcp',
          properties: { boundServer: BRAINSTEM_NAME, enabledTools: tools },
        },
      },
      {
        id: finishId,
        type: 'finish',
        position: { x: 250, y: 430 },
        data: { label: 'Rest', type: 'finish', properties: {} },
      },
    ],
    edges: [
      edge(startId, 'start-bottom', processId, 'process-top'),
      edge(processId, 'process-bottom', finishId, 'finish-top'),
      mcpEdge(processId, mcpId),
    ],
  };
}

/** Prompt used by the heartbeat planned execution. */
export const WAKE_PROMPT =
  'Wake up. Review your life goal and your current behaviours and skills. ' +
  'Decide the single most useful action or improvement, carry it out with your tools, ' +
  'then summarize what changed.';

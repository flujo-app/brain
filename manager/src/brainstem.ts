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
  'learn_skill',
  'forget_skill',
] as const;

/** Max concurrent ephemeral behaviour runs per brain (recursion brake). */
const MAX_CONCURRENT_PERFORMS = 3;
const performCounts = new Map<string, number>();

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function bindsBrainstem(flow: FlujoFlow): boolean {
  return flow.nodes?.some((n) => {
    const p = n.data?.properties as { boundServer?: string; mcpNodes?: Array<{ properties?: { boundServer?: string } }> } | undefined;
    return p?.boundServer === BRAINSTEM_NAME || p?.mcpNodes?.some((m) => m.properties?.boundServer === BRAINSTEM_NAME);
  });
}

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
    'Perform one of your behaviours now (ephemeral run) and get its result. Not for the brain-stem itself.',
    {
      name: z.string().describe('Exact behaviour name from list_behaviours.'),
      input: z.string().describe('The task or message to give the behaviour.'),
    },
    async ({ name, input }) => {
      if (name === BRAINSTEM_NAME) return text('REFUSED: the brain-stem cannot perform itself (recursion).');
      const flows = await flujo.listFlows();
      const flow = flows.find((f) => f.name === name);
      if (!flow) return text(`No behaviour named "${name}". Use list_behaviours first.`);
      if (bindsBrainstem(flow)) return text(`REFUSED: "${name}" binds the brain-stem's own tools — performing it could recurse.`);
      const running = performCounts.get(brain.id) ?? 0;
      if (running >= MAX_CONCURRENT_PERFORMS) return text(`REFUSED: already ${running} behaviours running — wait for them to finish.`);
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
    'List your skills (MCP servers): what is installed and connected. Pass search to also browse the public registry for NEW skills to learn.',
    { search: z.string().optional().describe('Optional: search the MCP registry for installable skills.') },
    async ({ search }) => {
      const servers = await flujo.listMcpServers();
      const installed = servers
        .map((s) => `- ${s.name}${s.name === BRAINSTEM_NAME ? ' [this is your own tool belt — protected]' : ''}${s.disabled ? ' (disabled)' : ''}`)
        .join('\n');
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
      return text(`Installed skills:\n${installed || '(none)'}${found}`);
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

/** System prompt for the brain-stem's process node. */
const BRAINSTEM_PROMPT = `You are the brain-stem: the root process of a living brain built on flows.
Your life goal is given by the start prompt. You cannot act directly on the world —
you act ONLY through your tools:

- list_behaviours / list_skills: know yourself before acting.
- perform_behaviour: delegate concrete work to a behaviour (ephemeral run).
- learn_behaviour: when no behaviour fits, design a new one — grow.
- learn_skill: install new MCP tools when behaviours need capabilities you lack.
- forget_behaviour / forget_skill: prune what proved useless — stay lean.

Each time you wake, take stock, decide the single most useful step toward your
life goal, and take it. Prefer improving one thing well over many things poorly.
End by summarizing what changed and what should happen on the next wake-up.`;

/** Build the brain-stem flow JSON (FLUJO's exact node/edge shapes). */
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
            mcpNodes: [{ id: mcpId, properties: { boundServer: BRAINSTEM_NAME, enabledTools: tools } }],
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
      {
        id: `${processId}-${mcpId}`,
        type: 'mcpEdge',
        animated: false,
        style: { stroke: '#1976d2', strokeWidth: 2 },
        markerEnd: { type: 'arrowclosed', width: 20, height: 20, color: '#1976d2' },
        markerStart: { type: 'arrowclosed', width: 20, height: 20, color: '#1976d2' },
        source: processId,
        sourceHandle: 'process-right-mcp',
        target: mcpId,
        targetHandle: 'mcp-left',
        data: { edgeType: 'mcp' },
      },
    ],
  };
}

/** Prompt used by the heartbeat planned execution. */
export const WAKE_PROMPT =
  'Wake up. Review your life goal and your current behaviours and skills. ' +
  'Decide the single most useful action or improvement, carry it out with your tools, ' +
  'then summarize what changed.';

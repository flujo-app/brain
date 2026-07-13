/**
 * Stored-conversation access for the history view: the list of FLUJO
 * conversations and lazily fetched transcripts, distilled to what the
 * constellation rendering needs. The chat dock (ui/aichat.ts) keeps its own
 * richer fetch because it also replays tool calls into its transcript UI.
 */

export interface StoredConversation {
  id: string;
  title: string;
  flowId: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

/** One transcript step, reduced to a visualizable point. */
export interface TranscriptStep {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  nodeId?: string;
  timestamp?: number;
}

interface RawListItem {
  id?: string;
  title?: string;
  flowId?: string | null;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface RawMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string } }>;
  processNodeId?: string;
  timestamp?: number;
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? (p as { text?: string }).text ?? '' : ''))
      .join('');
  }
  return '';
}

export async function listConversations(base: string): Promise<StoredConversation[]> {
  const res = await fetch(`${base}/v1/chat/conversations`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const raw = (await res.json()) as RawListItem[];
  return (Array.isArray(raw) ? raw : [])
    .filter((c): c is RawListItem & { id: string } => !!c?.id)
    .map((c) => ({
      id: c.id,
      title: c.title || 'untitled',
      flowId: c.flowId ?? null,
      status: c.status ?? '',
      createdAt: c.createdAt ?? 0,
      updatedAt: c.updatedAt ?? 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * A conversation's displayed transcript as steps. Assistant turns that only
 * carried tool calls become `tool` steps named after the tools, so the
 * thread still shows the work happening between spoken messages.
 */
export async function fetchTranscript(base: string, id: string): Promise<TranscriptStep[]> {
  const res = await fetch(`${base}/v1/chat/conversations/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const conv = (await res.json()) as { messages?: RawMessage[] };
  const steps: TranscriptStep[] = [];
  for (const m of Array.isArray(conv.messages) ? conv.messages : []) {
    const role = m.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    const text = flatten(m.content).trim();
    const meta = { ...(m.processNodeId ? { nodeId: m.processNodeId } : {}), ...(m.timestamp ? { timestamp: m.timestamp } : {}) };
    if (role === 'assistant') {
      const tools = (m.tool_calls ?? []).map((tc) => tc.function?.name).filter(Boolean) as string[];
      if (text) steps.push({ role: 'assistant', text, ...meta });
      if (!text && tools.length) steps.push({ role: 'tool', text: `⚙ ${tools.join(' · ')}`, ...meta });
    } else if (role === 'tool') {
      // Tool RESULTS are noise at constellation scale; the ⚙ step above
      // already marks the action. Skip.
      continue;
    } else if (text) {
      steps.push({ role: 'user', text, ...meta });
    }
  }
  return steps;
}

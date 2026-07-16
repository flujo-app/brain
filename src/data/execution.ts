import { flujoBase } from './loader';

/**
 * Live execution awareness: watches the FLUJO instance for running
 * conversations and subscribes to their SSE event streams, so the brain can
 * see itself think (which behaviour runs, which node is active, subflow
 * hand-offs, tool calls).
 *
 * FLUJO forwards a subflow child's events onto the PARENT conversation's
 * channel with depth+1, so we keep a per-conversation stack of flow ids
 * indexed by depth to attribute node events to the right behaviour.
 */

export interface NodeRef {
  nodeId: string;
  nodeName?: string;
  nodeType?: string;
}

export interface BrainActivityEvent {
  kind:
    | 'run-start'
    | 'node-enter'
    | 'node-exit'
    | 'subflow-start'
    | 'subflow-done'
    | 'tool-call'
    | 'tool-result'
    | 'resource-read'
    | 'resource-write'
    | 'message'
    | 'run-done';
  conversationId: string;
  /** The behaviour (flow id) the event belongs to, resolved via the depth stack. */
  flowId: string | null;
  node?: NodeRef;
  /** subflow-start / subflow-done: the called behaviour. */
  subflowId?: string;
  /** tool-call / tool-result: the tool's name ("<server>__<tool>" on the agent-SDK path, "-_-_-"-joined legacy). */
  toolName?: string;
  /** tool-result: the tool call failed (drives the red return flash). */
  isError?: boolean;
  /** resource-read / resource-write: the artifact's identity ("memory"). */
  server?: string;
  uri?: string;
  /** resource events: the artifact's stable name (run artifacts match by it). */
  resourceName?: string;
  /** message: the assistant's chat output text. */
  text?: string;
}

interface ConversationListItem {
  id: string;
  flowId?: string | null;
  status?: string;
  updatedAt?: number;
}

interface RawEvent {
  type: string;
  conversationId: string;
  seq: number;
  depth?: number;
  flowId?: string;
  node?: NodeRef;
  subflowId?: string;
  subflowName?: string;
  name?: string;
  status?: string;
  /** tool:result: the tool call failed. */
  isError?: boolean;
  /** resource:read / resource:write (Tier 3): the artifact's identity. */
  server?: string;
  uri?: string;
  /** tool:call: the model-issued tool call id (also on the persisted message). */
  toolCallId?: string;
  /** message: a FlujoChatMessage (OpenAI message + id/timestamp/processNodeId). */
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
    timestamp?: number;
    tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
  };
}

/** Flatten OpenAI-style message content (string or text-part array) to plain text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? (p as { text?: string }).text ?? '' : ''))
      .join('')
      .trim();
  }
  return '';
}

export class ExecutionWatcher {
  private subs = new Map<string, EventSource>();
  /** conversation -> flow id per subflow depth (index 0 = top-level run). */
  private stacks = new Map<string, Array<string | null>>();
  /** Last seen event seq per conversation, for ?fromSeq resume without replay. */
  private seenSeq = new Map<string, number>();
  /**
   * Message ids already surfaced per conversation. FLUJO emits a live copy
   * mid-loop AND the persisted copy at end-of-run under the same id — the
   * stream itself does not dedupe, consumers must. Kept across transport
   * drops (a ?fromSeq resume replays events) and cleared only on run:done.
   * NOTE: never judge freshness by comparing message timestamps to
   * Date.now() here — they come from the FLUJO server's clock, and skew
   * (Docker VMs, other machines) silently swallows every bubble.
   */
  private seenMsgs = new Map<string, Set<string>>();
  /**
   * Tool-call ids already surfaced per conversation. Tool calls arrive on TWO
   * channels: live `tool:call` events (the OpenAI-loop model path) and
   * `message` events whose assistant message carries `tool_calls` — the ONLY
   * channel on the agent-SDK (Claude subscription) path, whose tool loop runs
   * inside the adapter and never emits `tool:call`. The OpenAI path emits
   * both (live, then the persisted message at node end) under the SAME id, so
   * this set keeps each call from flashing twice.
   */
  private seenTools = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    private onEvent: (e: BrainActivityEvent) => void,
    private pollMs = 4000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const es of this.subs.values()) es.close();
    this.subs.clear();
  }

  private async tick(): Promise<void> {
    if (this.inFlight || document.hidden) return;
    const base = flujoBase();
    if (!base) return;
    this.inFlight = true;
    try {
      const res = await fetch(`${base}/v1/chat/conversations`);
      if (!res.ok) return;
      const list = (await res.json()) as ConversationListItem[];
      if (!Array.isArray(list)) return;
      for (const c of list) {
        if (c?.id && c.status === 'running' && !this.subs.has(c.id)) this.subscribe(base, c);
      }
    } catch {
      // FLUJO temporarily unreachable — next tick retries.
    } finally {
      this.inFlight = false;
    }
  }

  private subscribe(base: string, conv: ConversationListItem): void {
    const id = conv.id;
    // Seed depth 0 from the listing so mid-run attachment attributes correctly
    // even before (or without) a replayed run:start.
    this.stacks.set(id, [conv.flowId ?? null]);

    // fromSeq is inclusive server-side — resume just past the last seen event.
    const from = this.seenSeq.get(id);
    const url = `${base}/v1/chat/conversations/${encodeURIComponent(id)}/events${from !== undefined ? `?fromSeq=${from + 1}` : ''}`;
    const es = new EventSource(url);
    this.subs.set(id, es);

    es.onmessage = (msg) => {
      let ev: RawEvent;
      try {
        ev = JSON.parse(msg.data as string) as RawEvent;
      } catch {
        return;
      }
      if (typeof ev.seq === 'number') this.seenSeq.set(id, Math.max(ev.seq, this.seenSeq.get(id) ?? 0));
      this.dispatch(id, ev);
      if (ev.type === 'run:done') this.drop(id, true);
    };
    es.onerror = () => {
      // EventSource reconnects on its own; only clean up once it gave up.
      if (es.readyState === EventSource.CLOSED) this.drop(id);
    };
  }

  /** `terminal` = the run finished; transport drops keep the message dedupe
   *  set so a later resubscribe's replay can't re-bubble old messages. */
  private drop(id: string, terminal = false): void {
    this.subs.get(id)?.close();
    this.subs.delete(id);
    this.stacks.delete(id);
    if (terminal) {
      this.seenMsgs.delete(id);
      this.seenTools.delete(id);
    }
  }

  /** Mark a tool-call id as surfaced; false if it already was. */
  private freshTool(id: string, callId: string): boolean {
    let seen = this.seenTools.get(id);
    if (!seen) this.seenTools.set(id, (seen = new Set()));
    if (seen.has(callId)) return false;
    seen.add(callId);
    return true;
  }

  /** Per-uri throttle for resource events: a prompt with several pills emits a
   *  burst of reads — one flash per artifact per window is enough. */
  private lastResourceFlash = new Map<string, number>();
  private throttledResource(key: string, windowMs = 300): boolean {
    const now = Date.now();
    const last = this.lastResourceFlash.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    this.lastResourceFlash.set(key, now);
    return true;
  }

  private dispatch(id: string, ev: RawEvent): void {
    const stack = this.stacks.get(id) ?? [];
    const depth = ev.depth ?? 0;
    const flowAt = (d: number): string | null => stack[Math.min(d, stack.length - 1)] ?? null;

    switch (ev.type) {
      case 'run:start':
        stack.length = 0;
        stack[0] = ev.flowId ?? null;
        this.stacks.set(id, stack);
        this.onEvent({ kind: 'run-start', conversationId: id, flowId: ev.flowId ?? null });
        break;
      case 'subflow:start':
        stack[depth + 1] = ev.subflowId ?? null;
        stack.length = depth + 2;
        this.onEvent({
          kind: 'subflow-start',
          conversationId: id,
          flowId: flowAt(depth),
          subflowId: ev.subflowId,
          node: ev.node,
        });
        break;
      case 'subflow:done': {
        const child = stack[depth + 1] ?? ev.subflowId ?? null;
        stack.length = depth + 1;
        this.onEvent({
          kind: 'subflow-done',
          conversationId: id,
          flowId: flowAt(depth),
          subflowId: child ?? undefined,
        });
        break;
      }
      case 'node:enter':
        this.onEvent({ kind: 'node-enter', conversationId: id, flowId: flowAt(depth), node: ev.node });
        break;
      case 'node:exit':
        this.onEvent({ kind: 'node-exit', conversationId: id, flowId: flowAt(depth), node: ev.node });
        break;
      case 'tool:call':
        if (ev.toolCallId && !this.freshTool(id, ev.toolCallId)) break;
        this.onEvent({ kind: 'tool-call', conversationId: id, flowId: flowAt(depth), node: ev.node, toolName: ev.name });
        break;
      case 'tool:result':
        // The tool's reply travelling back to the behaviour. Fires once per
        // call (no dedupe needed); isError drives the red return flash.
        this.onEvent({
          kind: 'tool-result',
          conversationId: id,
          flowId: flowAt(depth),
          node: ev.node,
          toolName: ev.name,
          isError: ev.isError,
        });
        break;
      case 'resource:read':
      case 'resource:write': {
        // A data artifact ("memory") being read or written (Tier 3).
        const kind = ev.type === 'resource:read' ? 'resource-read' as const : 'resource-write' as const;
        if (!this.throttledResource(`${kind}:${ev.uri ?? ev.name ?? ''}`)) break;
        this.onEvent({
          kind,
          conversationId: id,
          flowId: flowAt(depth),
          node: ev.node,
          server: ev.server,
          uri: ev.uri,
          resourceName: ev.name,
        });
        break;
      }
      case 'message': {
        // Assistant activity only — user turns and tool results stay
        // invisible. Spoken text becomes a bubble; tool_calls on the message
        // become tool-call events (the agent-SDK model path streams its tool
        // loop this way and never emits `tool:call`), deduped against the
        // live channel by call id.
        const m = ev.message;
        if (m?.role !== 'assistant') break;
        for (const [i, tc] of (m.tool_calls ?? []).entries()) {
          const name = tc.function?.name;
          if (!name || !this.freshTool(id, tc.id ?? `${m.id ?? ev.seq}:${i}`)) continue;
          this.onEvent({ kind: 'tool-call', conversationId: id, flowId: flowAt(depth), node: ev.node, toolName: name });
        }
        const text = textOf(m.content);
        if (!text) break;
        const mid = m.id ?? `${id}:${ev.seq}`;
        let seen = this.seenMsgs.get(id);
        if (!seen) this.seenMsgs.set(id, (seen = new Set()));
        if (seen.has(mid)) break;
        seen.add(mid);
        this.onEvent({ kind: 'message', conversationId: id, flowId: flowAt(depth), node: ev.node, text });
        break;
      }
      case 'run:done':
        this.onEvent({ kind: 'run-done', conversationId: id, flowId: flowAt(0) });
        break;
      default:
        // model:delta, usage… — not visualized (yet).
        break;
    }
  }
}

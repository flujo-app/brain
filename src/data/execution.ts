import { flujoBase } from './loader';

/**
 * Live execution awareness: watches the FLUJO instance so the brain can see
 * itself think (which behaviour runs, which node is active, subflow hand-offs,
 * tool calls).
 *
 * Transport: a SINGLE connection to the global firehose (/v1/chat/events),
 * which streams execution events for EVERY conversation at once. This replaces
 * the old one-EventSource-per-conversation model, which hit the browser's
 * ~6-per-origin connection cap the moment several subflows ran in parallel —
 * starving (and never delivering) the deeper workers' tool calls. Every frame
 * carries its own conversationId, so all per-conversation state below is keyed
 * by it exactly as before.
 *
 * Attribution: events arrive two ways depending on a subflow node's output
 * mode. In 'steps' mode a child's events are forwarded onto the PARENT
 * conversation with depth+1 (hence the per-conversation depth stack). In
 * 'final-only' / separate-conversation mode each child runs as its OWN
 * conversation with its own run:start/flowId — the firehose delivers those
 * directly, which is why a single connection now sees them at all.
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

/**
 * FLUJO's edge-routing "tools": the model picks its next node by calling
 * handoff / handoff_to_<target>. Pure control flow inside a behaviour — never
 * an ability call, so the neuron view doesn't surface them. (A handoff onto a
 * subflow node still shows up: the child run emits subflow:start itself.)
 */
function isHandoffTool(name: string): boolean {
  return name === 'handoff' || name.startsWith('handoff_to_');
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
  /** The single firehose connection to /v1/chat/events (all conversations). */
  private es: EventSource | null = null;
  /** conversation -> flow id per subflow depth (index 0 = top-level run). */
  private stacks = new Map<string, Array<string | null>>();
  /**
   * conversationId -> flow id, from the light conversations poll. Used to seed
   * the depth stack of a conversation that was ALREADY running when we
   * connected — its run:start won't replay on the live firehose, so without
   * this its events would attribute to no behaviour.
   */
  private flowIdOf = new Map<string, string>();
  /** Highest firehose globalSeq seen, for ?fromSeq resume on manual reconnect. */
  private lastGlobalSeq = -1;
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
  /**
   * Subflow-node ids (per conversation) whose child run was VISIBLE on the
   * stream (a subflow:start arrived). After the child finishes, the parent
   * folds the child's final text into its own transcript as an assistant
   * message attributed to that node — a duplicate of the final message the
   * child already emitted (shown on the subagent neuron), so it's suppressed.
   * In final-only output mode no subflow:start is forwarded, the node is never
   * marked, and the folded copy stays visible — it's the run's only trace.
   */
  private subflowNodes = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    private onEvent: (e: BrainActivityEvent) => void,
    private pollMs = 4000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.connect();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.es?.close();
    this.es = null;
  }

  /**
   * Light poll of the conversations list — ONLY to keep the conversationId ->
   * flowId cache warm for seeding (see `flowIdOf`). No per-conversation SSE is
   * opened here anymore; the firehose is the single event source. Also (re)opens
   * the firehose if it isn't connected yet (e.g. FLUJO wasn't reachable at start).
   */
  private async tick(): Promise<void> {
    if (this.inFlight || document.hidden) return;
    const base = flujoBase();
    if (!base) return;
    if (!this.es) this.connect();
    this.inFlight = true;
    try {
      const res = await fetch(`${base}/v1/chat/conversations`);
      if (!res.ok) return;
      const list = (await res.json()) as ConversationListItem[];
      if (!Array.isArray(list)) return;
      for (const c of list) {
        if (c?.id && c.flowId) this.flowIdOf.set(c.id, c.flowId);
      }
    } catch {
      // FLUJO temporarily unreachable — next tick retries.
    } finally {
      this.inFlight = false;
    }
  }

  /** Open (or reopen) the single firehose connection. No-op if FLUJO isn't
   *  reachable yet (a later tick retries) or a connection already exists. */
  private connect(): void {
    const base = flujoBase();
    if (!base || this.es) return;

    // fromSeq is inclusive server-side — resume just past the last seen event.
    // Absent on the very first connect, so the stream just goes live.
    const from = this.lastGlobalSeq;
    const url = `${base}/v1/chat/events${from >= 0 ? `?fromSeq=${from + 1}` : ''}`;
    const es = new EventSource(url);
    this.es = es;

    es.onmessage = (msg) => {
      let ev: RawEvent;
      try {
        ev = JSON.parse(msg.data as string) as RawEvent;
      } catch {
        return;
      }
      const id = ev.conversationId;
      if (!id) return;
      // The SSE `id` is the firehose globalSeq (the browser also echoes it as
      // Last-Event-ID on auto-reconnect); track it for manual reconnect too.
      const gid = msg.lastEventId ? parseInt(msg.lastEventId, 10) : NaN;
      if (!Number.isNaN(gid)) this.lastGlobalSeq = Math.max(gid, this.lastGlobalSeq);
      // Seed depth 0 for a conversation first seen mid-run (no replayed
      // run:start): prefer the event's own flowId, else the polled cache.
      if (!this.stacks.has(id)) this.stacks.set(id, [ev.flowId ?? this.flowIdOf.get(id) ?? null]);
      this.dispatch(id, ev);
      if (ev.type === 'run:done') this.drop(id);
    };
    es.onerror = () => {
      // EventSource auto-reconnects (resuming via Last-Event-ID). Only recreate
      // manually once it has fully given up, resuming from lastGlobalSeq.
      if (es.readyState === EventSource.CLOSED) {
        this.es = null;
        this.connect();
      }
    };
  }

  /** A conversation's run finished — clear its per-conversation state. Resume
   *  is by monotonic globalSeq, so cleared state can never be re-bubbled by a
   *  reconnect replay (it only ever delivers events newer than lastGlobalSeq). */
  private drop(id: string): void {
    this.stacks.delete(id);
    this.seenMsgs.delete(id);
    this.seenTools.delete(id);
    this.subflowNodes.delete(id);
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
        // The child run is visible — its folded final message (attributed to
        // this subflow node) will be a duplicate; remember to suppress it.
        if (ev.node?.nodeId) {
          if (!this.subflowNodes.has(id)) this.subflowNodes.set(id, new Set());
          this.subflowNodes.get(id)!.add(ev.node.nodeId);
        }
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
        if (ev.name && isHandoffTool(ev.name)) break;
        if (ev.toolCallId && !this.freshTool(id, ev.toolCallId)) break;
        this.onEvent({ kind: 'tool-call', conversationId: id, flowId: flowAt(depth), node: ev.node, toolName: ev.name });
        break;
      case 'tool:result':
        if (ev.name && isHandoffTool(ev.name)) break;
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
          if (!name || isHandoffTool(name) || !this.freshTool(id, tc.id ?? `${m.id ?? ev.seq}:${i}`)) continue;
          this.onEvent({ kind: 'tool-call', conversationId: id, flowId: flowAt(depth), node: ev.node, toolName: name });
        }
        // The parent's folded copy of a visible child run's final message —
        // the child already surfaced it on the subagent neuron.
        if (ev.node?.nodeId && this.subflowNodes.get(id)?.has(ev.node.nodeId)) break;
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

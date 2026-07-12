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
  kind: 'run-start' | 'node-enter' | 'node-exit' | 'subflow-start' | 'subflow-done' | 'tool-call' | 'run-done';
  conversationId: string;
  /** The behaviour (flow id) the event belongs to, resolved via the depth stack. */
  flowId: string | null;
  node?: NodeRef;
  /** subflow-start / subflow-done: the called behaviour. */
  subflowId?: string;
  /** tool-call: the tool's name (typically "<server>_<tool>" or "-_-_-"-joined). */
  toolName?: string;
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
}

export class ExecutionWatcher {
  private subs = new Map<string, EventSource>();
  /** conversation -> flow id per subflow depth (index 0 = top-level run). */
  private stacks = new Map<string, Array<string | null>>();
  /** Last seen event seq per conversation, for ?fromSeq resume without replay. */
  private seenSeq = new Map<string, number>();
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

    const from = this.seenSeq.get(id);
    const url = `${base}/v1/chat/conversations/${encodeURIComponent(id)}/events${from ? `?fromSeq=${from}` : ''}`;
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
      if (ev.type === 'run:done') this.drop(id);
    };
    es.onerror = () => {
      // EventSource reconnects on its own; only clean up once it gave up.
      if (es.readyState === EventSource.CLOSED) this.drop(id);
    };
  }

  private drop(id: string): void {
    this.subs.get(id)?.close();
    this.subs.delete(id);
    this.stacks.delete(id);
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
        this.onEvent({ kind: 'tool-call', conversationId: id, flowId: flowAt(depth), node: ev.node, toolName: ev.name });
        break;
      case 'run:done':
        this.onEvent({ kind: 'run-done', conversationId: id, flowId: flowAt(0) });
        break;
      default:
        // model:delta, usage, message… — not visualized (yet).
        break;
    }
  }
}

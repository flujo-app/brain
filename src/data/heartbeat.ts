import { flujoBase } from './loader';

/**
 * Watches the brain's heartbeat: FLUJO's planned executions drive the
 * autonomous wake-ups, and every fire (with saveConversations on) leaves a
 * conversation behind. This poller finds the most recent heartbeat run and
 * loads its transcript, so the HUD can show what the brain thought on its
 * last beat while nothing is focused.
 */

export interface HeartbeatMessage {
  role: string;
  text: string;
}

export interface HeartbeatInfo {
  /** The planned execution's name (e.g. "misty-fjord heartbeat"). */
  name: string;
  flowId: string | null;
  /** Conversation status: running / completed / error / … */
  status: string;
  /** When the beat fired (ISO timestamp). */
  firedAt: string;
  messages: HeartbeatMessage[];
  /** The planned execution behind the beat — target for the tempo slider. */
  executionId: string | null;
  /** Current schedule cron; null when the trigger is not schedule-based. */
  cron: string | null;
}

interface PlannedListEntry {
  execution?: { id?: string; name?: string; flowId?: string; trigger?: { type?: string; cron?: string } };
  lastRun?: { conversationId?: string; firedAt?: string };
}

interface ConversationState {
  status?: string;
  updatedAt?: number;
  flowId?: string | null;
  messages?: Array<{ role?: string; content?: unknown }>;
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

const MAX_MESSAGES = 8;

export class HeartbeatWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** Fingerprint of the last update pushed, to skip redundant DOM work. */
  private lastSig: string | null = null;

  constructor(
    private onUpdate: (h: HeartbeatInfo | null) => void,
    private pollMs = 10_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.inFlight || document.hidden) return;
    const base = flujoBase();
    if (!base) return;
    this.inFlight = true;
    try {
      const res = await fetch(`${base}/api/planned-executions`);
      if (!res.ok) return this.push(null);
      const { executions } = (await res.json()) as { executions?: PlannedListEntry[] };

      // The heartbeat: a scheduled execution with a saved conversation. Prefer
      // ones actually named like a heartbeat, then schedule-triggered ones,
      // then any autonomous wake-up (poll/watch triggers) — freshest fire wins.
      const fired = (executions ?? []).filter((e) => e.lastRun?.conversationId);
      const named = fired.filter((e) => /heartbeat/i.test(e.execution?.name ?? ''));
      const scheduled = fired.filter((e) => e.execution?.trigger?.type === 'schedule');
      const pool = named.length ? named : scheduled.length ? scheduled : fired;
      const beat = pool.sort((a, b) => (b.lastRun?.firedAt ?? '').localeCompare(a.lastRun?.firedAt ?? ''))[0];
      if (!beat) return this.push(null);

      const convId = beat.lastRun!.conversationId!;
      const convRes = await fetch(`${base}/v1/chat/conversations/${encodeURIComponent(convId)}`);
      if (!convRes.ok) return this.push(null);
      const conv = (await convRes.json()) as ConversationState;

      const messages = (conv.messages ?? [])
        .flatMap((m) => {
          if (m.role !== 'user' && m.role !== 'assistant') return [];
          const text = textOf(m.content);
          return text ? [{ role: m.role, text }] : [];
        })
        .slice(-MAX_MESSAGES);

      this.push({
        name: beat.execution?.name ?? 'heartbeat',
        flowId: conv.flowId ?? beat.execution?.flowId ?? null,
        status: conv.status ?? 'completed',
        firedAt: beat.lastRun!.firedAt ?? '',
        messages,
        executionId: beat.execution?.id ?? null,
        cron: beat.execution?.trigger?.type === 'schedule' ? beat.execution.trigger.cron ?? null : null,
      });
    } catch {
      // FLUJO temporarily unreachable — keep whatever is shown, retry next tick.
    } finally {
      this.inFlight = false;
    }
  }

  private push(h: HeartbeatInfo | null): void {
    const sig = h
      ? `${h.firedAt}|${h.status}|${h.cron}|${h.messages.length}|${h.messages[h.messages.length - 1]?.text ?? ''}`
      : 'null';
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.onUpdate(h);
  }
}

/** Re-arm the heartbeat's schedule with a new cron (the tempo slider). */
export async function setHeartbeatTempo(executionId: string, cron: string): Promise<void> {
  const base = flujoBase();
  if (!base) throw new Error('FLUJO is not reachable');
  const res = await fetch(`${base}/api/planned-executions/${encodeURIComponent(executionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trigger: { type: 'schedule', cron, catchUp: false } }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

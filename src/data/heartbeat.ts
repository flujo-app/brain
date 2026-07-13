import { flujoBase } from './loader';

/**
 * Watches the brain's heartbeat: FLUJO's planned executions drive the
 * autonomous wake-ups. This poller finds the freshest beat and reports a
 * compact status (name, running/completed, when, tempo) — the transcript
 * itself lives in FLUJO as a stored conversation and opens in the chat dock.
 *
 * Resilience rule: a transient fetch failure never blanks the HUD — only a
 * successful poll that finds no heartbeat does.
 */

export interface HeartbeatInfo {
  /** The planned execution's name (e.g. "misty-fjord heartbeat"). */
  name: string;
  flowId: string | null;
  /** Last run status: running / completed / error / skipped. */
  status: string;
  /** When the beat fired (ISO timestamp). */
  firedAt: string;
  /** The stored conversation of the last beat (openable in the chat dock). */
  conversationId: string | null;
  /** The planned execution behind the beat — target for the tempo slider. */
  executionId: string | null;
  /** Current schedule cron; null when the trigger is not schedule-based. */
  cron: string | null;
}

interface PlannedListEntry {
  execution?: { id?: string; name?: string; flowId?: string; trigger?: { type?: string; cron?: string } };
  lastRun?: { conversationId?: string; firedAt?: string; finishedAt?: string; status?: string };
}

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
      if (!res.ok) return; // transient — keep whatever is shown
      const { executions, paused } = (await res.json()) as { executions?: PlannedListEntry[]; paused?: boolean };
      if (!Array.isArray(executions)) return;

      // A paused brain has no heartbeat to show — the scheduler is frozen.
      if (paused) return this.push(null);

      // The heartbeat: prefer executions named like one, then schedule-driven
      // ones, then any that ever fired — freshest fire wins.
      const fired = executions.filter((e) => e.lastRun?.firedAt);
      const named = fired.filter((e) => /heartbeat/i.test(e.execution?.name ?? ''));
      const scheduled = fired.filter((e) => e.execution?.trigger?.type === 'schedule');
      const pool = named.length ? named : scheduled.length ? scheduled : fired;
      const beat = pool.sort((a, b) => (b.lastRun?.firedAt ?? '').localeCompare(a.lastRun?.firedAt ?? ''))[0];
      if (!beat) return this.push(null); // a real answer: no heartbeat exists

      const run = beat.lastRun!;
      this.push({
        name: beat.execution?.name ?? 'heartbeat',
        flowId: beat.execution?.flowId ?? null,
        status: run.status ?? (run.finishedAt ? 'completed' : 'running'),
        firedAt: run.firedAt ?? '',
        conversationId: run.conversationId ?? null,
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
    const sig = h ? `${h.firedAt}|${h.status}|${h.cron}|${h.conversationId}` : 'null';
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

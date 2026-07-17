import { flujoBase } from './loader';

/**
 * Watches the brain's heartbeats: FLUJO's planned executions drive the
 * autonomous wake-ups. FLUJO is the single source of truth — this poller
 * mirrors EVERY planned execution (fired or not, enabled or not) so the HUD
 * can show them all; the transcripts live in FLUJO as stored conversations
 * and open in the chat dock.
 *
 * Resilience rule: a transient fetch failure never blanks the HUD — only a
 * successful poll updates it.
 */

export interface HeartbeatInfo {
  /** The planned execution's id — target for tempo / beat-now calls. */
  executionId: string;
  /** The planned execution's name (e.g. "misty-fjord heartbeat"). */
  name: string;
  flowId: string | null;
  /** Armed to fire on its own (execution.enabled). */
  enabled: boolean;
  /** A beat is running right now. */
  running: boolean;
  /** Last run status: completed / error / skipped — null if it never fired. */
  lastStatus: string | null;
  /** When the last beat fired (ISO timestamp) — null if it never fired. */
  firedAt: string | null;
  /** The stored conversation of the last beat (openable in the chat dock). */
  conversationId: string | null;
  /** Current schedule cron; null when the trigger is not schedule-based. */
  cron: string | null;
  /** Trigger kind as FLUJO reports it (schedule / …). */
  triggerType: string | null;
  /** FLUJO's own "next fire" prediction (ISO), null when nothing is armed. */
  nextRun: string | null;
}

/** Everything the HUD needs: the global pause switch + every beat. */
export interface HeartbeatState {
  paused: boolean;
  beats: HeartbeatInfo[];
}

interface PlannedListEntry {
  execution?: {
    id?: string;
    name?: string;
    flowId?: string;
    enabled?: boolean;
    trigger?: { type?: string; cron?: string };
  };
  status?: { nextRun?: string | null; running?: boolean; runningSince?: string };
  lastRun?: { conversationId?: string; firedAt?: string; finishedAt?: string; status?: string };
}

/** Sort: running beats first, then armed ones by soonest next fire, then rest. */
function beatOrder(a: HeartbeatInfo, b: HeartbeatInfo): number {
  if (a.running !== b.running) return a.running ? -1 : 1;
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  if (a.nextRun && b.nextRun) return a.nextRun.localeCompare(b.nextRun);
  if (a.nextRun !== b.nextRun) return a.nextRun ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export class HeartbeatWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** Fingerprint of the last update pushed, to skip redundant DOM work. */
  private lastSig: string | null = null;

  constructor(
    private onUpdate: (state: HeartbeatState) => void,
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

      const beats = executions
        .filter((e) => e.execution?.id)
        .map((e): HeartbeatInfo => {
          const run = e.lastRun;
          return {
            executionId: e.execution!.id!,
            name: e.execution?.name ?? 'heartbeat',
            flowId: e.execution?.flowId ?? null,
            enabled: e.execution?.enabled !== false,
            running: Boolean(e.status?.running) || (Boolean(run?.firedAt) && !run?.finishedAt && run?.status === undefined),
            lastStatus: run?.status ?? (run?.firedAt ? (run.finishedAt ? 'completed' : 'running') : null),
            firedAt: run?.firedAt ?? null,
            conversationId: run?.conversationId || null,
            cron: e.execution?.trigger?.type === 'schedule' ? e.execution.trigger.cron ?? null : null,
            triggerType: e.execution?.trigger?.type ?? null,
            nextRun: e.status?.nextRun ?? null,
          };
        })
        .sort(beatOrder);

      this.push({ paused: Boolean(paused), beats });
    } catch {
      // FLUJO temporarily unreachable — keep whatever is shown, retry next tick.
    } finally {
      this.inFlight = false;
    }
  }

  private push(state: HeartbeatState): void {
    const sig =
      `${state.paused}|` +
      state.beats
        .map((b) => `${b.executionId}:${b.firedAt}:${b.running}:${b.cron}:${b.nextRun}:${b.enabled}:${b.conversationId}`)
        .join('|');
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.onUpdate(state);
  }
}

/** Re-arm a beat's schedule with a new cron (the tempo slider). FLUJO is the
 *  source of truth — this PATCHes the real planned execution, nothing else. */
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

/** Beat now: fire a planned execution immediately (works even while paused).
 *  FLUJO's endpoint waits for the run to finish — callers should not await
 *  this to unblock the UI; the watcher picks the run up on its next poll. */
export async function beatNow(executionId: string): Promise<void> {
  const base = flujoBase();
  if (!base) throw new Error('FLUJO is not reachable');
  const res = await fetch(`${base}/api/planned-executions/${encodeURIComponent(executionId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

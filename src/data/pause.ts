import type { BrainGraph } from '../types';
import { flujoBase } from './loader';

/**
 * Freezes the whole mind: the FLUJO scheduler (planned executions / the
 * heartbeat) via its global pause switch, and every currently running
 * conversation by arming breakpoints on all of its flow's nodes — the run
 * halts at the next node boundary with status `paused_debug` and can be
 * resumed later with the debug/continue endpoint. Runs started while paused
 * (e.g. by the AI input) are deliberately left alone.
 */

interface ConversationListItem {
  id: string;
  flowId?: string | null;
  status?: string;
}

async function call<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json().catch(() => ({}))) as T;
}

export class PauseController {
  /** Conversations we breakpointed, to un-pause on resume. */
  private frozen: string[] = [];
  paused = false;

  /**
   * Returns a list of human-readable notes about anything that could not be
   * paused (partial success is still a pause).
   */
  async pause(graph: BrainGraph | null): Promise<string[]> {
    const base = flujoBase();
    if (!base) throw new Error('FLUJO is not reachable');
    const notes: string[] = [];

    // 1. Global scheduler pause — no planned execution fires until resume.
    try {
      await call(`${base}/api/planned-executions`, { method: 'PATCH', body: JSON.stringify({ paused: true }) });
    } catch {
      notes.push('scheduler pause failed');
    }

    // 2. Break every running conversation at its next node.
    try {
      const list = await call<ConversationListItem[]>(`${base}/v1/chat/conversations`);
      const running = (Array.isArray(list) ? list : []).filter((c) => c?.id && c.status === 'running');
      const allNodeIds = (graph?.neurons ?? []).flatMap((n) => n.inner.nodes.map((node) => node.id));
      for (const conv of running) {
        const neuron = graph?.neurons.find((n) => n.id === conv.flowId);
        // Unknown flow (not in the graph yet): arm every node id we know as a superset.
        const breakpoints = neuron ? neuron.inner.nodes.map((n) => n.id) : allNodeIds;
        if (!breakpoints.length) continue;
        try {
          await call(`${base}/v1/chat/conversations/${encodeURIComponent(conv.id)}/breakpoints`, {
            method: 'PUT',
            body: JSON.stringify({ breakpoints }),
          });
          this.frozen.push(conv.id);
        } catch {
          notes.push(`could not pause a running flow (${conv.id.slice(0, 8)}…)`);
        }
      }
    } catch {
      notes.push('could not list running flows');
    }

    this.paused = true;
    return notes;
  }

  async resume(): Promise<void> {
    const base = flujoBase();
    if (!base) throw new Error('FLUJO is not reachable');

    await call(`${base}/api/planned-executions`, { method: 'PATCH', body: JSON.stringify({ paused: false }) }).catch(
      () => undefined,
    );

    const frozen = this.frozen;
    this.frozen = [];
    for (const id of frozen) {
      const conv = encodeURIComponent(id);
      await call(`${base}/v1/chat/conversations/${conv}/breakpoints`, {
        method: 'PUT',
        body: JSON.stringify({ breakpoints: [] }),
      }).catch(() => undefined);
      try {
        const state = await call<{ status?: string }>(`${base}/v1/chat/conversations/${conv}`);
        if (state?.status === 'paused_debug') {
          // Fire and forget: continue re-enters the flow loop and only returns
          // when the run finishes or pauses again — resume must not block on it.
          void fetch(`${base}/v1/chat/conversations/${conv}/debug/continue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }).catch(() => undefined);
        }
      } catch {
        // Conversation finished or vanished — nothing to resume.
      }
    }

    this.paused = false;
  }
}

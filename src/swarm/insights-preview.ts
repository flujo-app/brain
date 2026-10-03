import { machineKey, type Observatory } from './insights-model';

/** Explicit design data only. Never used after a failed live read. */
export function observatoryPreview(sources: Array<{ id: string; factoryId: string }>): Observatory {
  const now = new Date().toISOString(), earlier = new Date(Date.now() - 120000).toISOString();
  return { schemaVersion: 1, scope: 'factory-observatory', commands: false, observedAt: now,
    sources: sources.map((s, i) => {
      const flyKey = machineKey('fly', 'sample-account/sample-app', null, 'sample-machine');
      return { sourceId: s.id, factoryId: s.factoryId, observedAt: now, modalStatus: 'observed', flyStatus: 'observed',
        budget: { revision: 12, limitCents: 10000, heldCents: 4200, availableCents: 5800, meteredCents: null, incomplete: true, reservations: [{ id: 'sample-modal-hold', provider: 'modal', state: 'started', heldCents: 2500 }, { id: 'sample-fly-hold', provider: 'fly', state: 'started', heldCents: 1700 }] },
        machines: [
          { key: machineKey('modal', null, 'sample-run', 'sample-modal-app'), provider: 'modal', accountId: null, appId: null, cellId: null, evidenceDigest: null, resourceId: 'sample-modal-app', runId: 'sample-run', label: 'Model inference', kind: 'app', state: 'current state unknown', freshness: 'retained', observedAt: now, region: null, operations: [{ id: 'deploy', label: 'deploy', state: 'succeeded', observedAt: earlier }, { id: 'generation', label: 'flujo-generation', state: i === 2 ? 'unknown' : 'succeeded', observedAt: now }] },
          { key: flyKey, provider: 'fly', accountId: 'sample-account/sample-app', appId: null, cellId: null, evidenceDigest: null, resourceId: 'sample-machine', runId: null, label: 'Development worker', kind: 'machine', state: i === 1 ? 'stopped' : 'started', freshness: 'provider_observed', observedAt: now, region: 'iad', operations: [] },
        ],
        workers: [{ id: 'sample-worker', label: 'Implementation worker', cellId: null, machineKey: flyKey, availability: 'observed', observedAt: now, conversationStatus: 'observed',
          flows: [{ id: 'sample-flow', name: 'Plan → build → review', nodes: [{ id: 'start', label: 'Receive goal', type: 'start' }, { id: 'build', label: 'Implement change', type: 'process' }, { id: 'review', label: 'Review result', type: 'process' }, { id: 'finish', label: 'Deliver', type: 'finish' }], edges: [{ source: 'start', target: 'build' }, { source: 'build', target: 'review' }, { source: 'review', target: 'finish' }] }],
          conversations: [{ id: 'sample-conversation', title: 'Build the Observatory details', status: i === 1 ? 'completed' : 'running', flowId: 'sample-flow', currentNodeId: 'build', updatedAt: now, tokens: 18420, estimatedCostUsd: 0.82, totalMessages: 4, truncated: false,
            messages: [
              { id: 'm1', role: 'user', truncated: false, content: 'Show analytics, the timeline, worker nodes, conversations and both providers in one readable view.', at: earlier, nodeId: null, tools: [] },
              { id: 'm2', role: 'assistant', truncated: false, content: 'I’m checking the source contracts and the worker’s current flow before adding the detail views.', at: earlier, nodeId: 'build', tools: [{ id: 'tool1', name: 'Bash', arguments: '{"command":"npm run build"}' }] },
              { id: 'm3', role: 'tool', truncated: false, content: 'Build passed. The worker node and transcript stay scoped to this conversation.', at: now, nodeId: 'build', tools: [] },
              { id: 'm4', role: 'assistant', truncated: false, content: 'The new views are ready for visual verification. Modal receipts remain historical; the Fly machine has a separate provider observation.', at: now, nodeId: 'build', tools: [] },
            ] }],
        }],
      };
    }),
  };
}

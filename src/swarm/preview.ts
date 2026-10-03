import type { Swarm, Source, Cell } from './model';

/** Opt-in fixtures only; never used to replace a failed live read. */
export function swarmPreview(totalCells = 54): Swarm {
  const now = new Date().toISOString(), future = new Date(Date.now() + 5 * 60000).toISOString(), digest = 'a'.repeat(64);
  const labels = ['FACTORY', 'Independent review', 'Delivery watch'];
  const sources: Source[] = labels.map((label, sourceIndex) => {
    const count = Math.floor(totalCells / 3) + (sourceIndex < totalCells % 3 ? 1 : 0);
    const cells: Cell[] = Array.from({ length: Math.max(1, count) }, (_, index) => ({
      id: index === 0 ? 'root' : `cell-${index}`, parentId: index === 0 ? null : index <= 4 ? 'root' : `cell-${Math.floor((index - 1) / 4)}`,
      depth: index === 0 ? 0 : Math.floor(Math.log(index * 3 + 1) / Math.log(4)), role: index === 0 ? 'coordinator' : index % 5 === 0 ? 'verifier' : index % 7 === 0 ? 'watcher' : 'developer',
      status: index % 17 === 16 ? 'retired' : 'ready', heartbeat: now,
      purpose: index === 0 ? 'Coordinate the recorded local delegation.' : `Inspect the work assigned to ${label} cell ${index}.`,
      allocationCents: Math.floor(10000 / 4 ** (index === 0 ? 0 : Math.floor(Math.log(index * 3 + 1) / Math.log(4)))), budgetBasis: 'logical-allocation',
    }));
    const tasks = cells.length > 1 ? [{ id: 'implementation', projectId: 'flujo', branch: 'codex/sample', status: 'running' as const, owner: 'cell-1', attempt: 1, leaseExpiry: future, specDigest: digest, candidate: null, review: null },
      { id: 'retire-operation', projectId: 'flujo', branch: 'codex/sample-retire', status: 'completed' as const, owner: cells.length > 2 ? 'cell-2' : 'root', attempt: 1, leaseExpiry: null, specDigest: digest, candidate: null, review: null },
      { id: 'exploration', projectId: 'flujo', branch: 'codex/sample-history', status: 'cancelled' as const, owner: 'root', attempt: 2, leaseExpiry: null, specDigest: digest, candidate: { sha256: digest }, review: { accepted: false, reviewerId: 'root', evidenceDigest: digest, candidateDigest: digest, specDigest: digest, attempt: 2 } }] : [];
    return { id: `source-${sourceIndex + 1}`, label, factoryId: `design-authority-${sourceIndex + 1}`, status: 'observed', events: [],
      snapshot: { schemaVersion: 1, factoryId: `design-authority-${sourceIndex + 1}`, scope: 'local-coordinator', revision: 42 + sourceIndex, cursor: 'NDI', observedAt: now, buildRevision: 'unknown', capabilities: { snapshot: true, events: true, commands: false },
        snapshot: { control: { status: sourceIndex === 1 ? 'paused' : 'active', epoch: 3, mission: 'Improve FLUJO, one accepted delivery at a time.' }, cells, tasks, effects: sourceIndex === 2 ? [{ key: 'pending-effect', kind: 'flow_call', state: 'unknown', owner: 'cell-1', taskId: 'implementation', scope: 'task', scopeId: 'implementation', ownerEpoch: 1, controlEpoch: 3, createdAt: now, updatedAt: now, requestDigest: digest }] : [], workerQuiescence: 'unverified' } } };
  });
  return { schemaVersion: 1, scope: 'operator-source-registry', observedAt: now, commands: false, sources, sample: true };
}

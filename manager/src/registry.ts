import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BrainRecord } from './types.js';

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'brains.json');

/** Persistent brain registry: one JSON file, small and human-readable. */
export class Registry {
  private brains = new Map<string, BrainRecord>();

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(FILE, 'utf8')) as BrainRecord[];
      for (const b of raw) this.brains.set(b.id, b);
    } catch {
      // First run — nothing persisted yet.
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify([...this.brains.values()], null, 2));
  }

  list(): BrainRecord[] {
    return [...this.brains.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): BrainRecord | undefined {
    return this.brains.get(id);
  }

  async put(brain: BrainRecord): Promise<void> {
    this.brains.set(brain.id, brain);
    await this.save();
  }

  async remove(id: string): Promise<void> {
    this.brains.delete(id);
    await this.save();
  }
}

export function newBrainRecord(name: string, lifeGoal: string): BrainRecord {
  return {
    id: crypto.randomUUID().slice(0, 8),
    name,
    lifeGoal,
    flujoUrl: '',
    kind: 'external',
    token: crypto.randomBytes(24).toString('hex'),
    status: 'provisioning',
    createdAt: new Date().toISOString(),
  };
}

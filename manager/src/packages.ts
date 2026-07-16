import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FlujoClient, FlujoModel, McpServerConfig } from './flujo.js';
import type { PackageSelection } from './types.js';

export type { PackageSelection };

/**
 * Starter packages: curated bundles of models, MCP servers (skills), flows
 * (behaviours) and planned executions that the wizard can pour into a fresh
 * brain. A package is a plain JSON manifest under manager/packages/ — the
 * same object shapes FLUJO's own storage (and backup zips) use, so a FLUJO
 * backup can be turned into a package by stripping its secrets.
 *
 * Secrets never live in a manifest. Anywhere a value is user-specific
 * (model API keys, MCP env tokens) the manifest writes a placeholder:
 *
 *   {{secret:github_token}}   — filled by the user during import
 *   {{brain.modelId}}         — the mind chosen in the wizard (also
 *                               .modelName, .name, .lifeGoal)
 *
 * and declares the secret under `secrets` so the wizard knows what to ask
 * for. Application is per-item upserts through FLUJO's REST API (idempotent,
 * skip-if-exists) — deliberately NOT FLUJO's /api/restore, which replaces
 * whole storage files.
 */

export interface PackageSecretDecl {
  /** Placeholder key — referenced in the manifest as {{secret:<key>}}. */
  key: string;
  /** Human label the wizard shows next to the input. */
  label: string;
  /** Where to get one (URL) or a short note. */
  hint?: string;
  /** Optional secrets substitute as '' when left blank instead of blocking. */
  optional?: boolean;
}

export interface PackagePlannedExecution {
  name: string;
  enabled: boolean;
  /** References a flow id from this manifest's `flows`. */
  flowId: string;
  prompt: string;
  saveConversations?: boolean;
  trigger: Record<string, unknown>;
}

export interface PackageManifest {
  id: string;
  name: string;
  description: string;
  version: number;
  secrets: PackageSecretDecl[];
  models: FlujoModel[];
  mcpServers: McpServerConfig[];
  flows: Array<{ id: string; name: string; [key: string]: unknown }>;
  plannedExecutions: PackagePlannedExecution[];
}

/** What the wizard sees — everything except the item bodies. */
export interface PackageSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  secrets: PackageSecretDecl[];
  counts: { models: number; mcpServers: number; flows: number; plannedExecutions: number };
}

const PACKAGES_DIR = process.env.PACKAGES_DIR ?? path.join(process.cwd(), 'packages');

export async function loadPackages(): Promise<PackageManifest[]> {
  let files: string[];
  try {
    files = (await fs.readdir(PACKAGES_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // No packages dir — the feature just stays invisible.
  }
  const packages: PackageManifest[] = [];
  for (const file of files.sort()) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(PACKAGES_DIR, file), 'utf8')) as Partial<PackageManifest>;
      if (!raw.id || !raw.name) continue;
      packages.push({
        description: '',
        version: 1,
        secrets: [],
        models: [],
        mcpServers: [],
        flows: [],
        plannedExecutions: [],
        ...raw,
      } as PackageManifest);
    } catch {
      // A malformed manifest hides itself instead of breaking the wizard.
    }
  }
  return packages;
}

export function summarizePackage(pkg: PackageManifest): PackageSummary {
  return {
    id: pkg.id,
    name: pkg.name,
    description: pkg.description,
    version: pkg.version,
    secrets: pkg.secrets,
    counts: {
      models: pkg.models.length,
      mcpServers: pkg.mcpServers.length,
      flows: pkg.flows.length,
      plannedExecutions: pkg.plannedExecutions.length,
    },
  };
}

/** Required secrets the user has not filled (non-empty) yet. */
export function missingSecrets(pkg: PackageManifest, provided: Record<string, string>): PackageSecretDecl[] {
  return pkg.secrets.filter((s) => !s.optional && !provided[s.key]?.trim());
}

/** Values the placeholders resolve against when a package is applied. */
export interface PackageContext {
  modelId?: string;
  modelName?: string;
  brainName: string;
  lifeGoal: string;
  /** Managed containers need PATH/HOME injected into stdio MCP envs. */
  managed: boolean;
}

const TOKEN = /\{\{\s*(secret:[\w.-]+|brain\.\w+)\s*\}\}/g;

/** Deep-copy `value`, replacing every {{…}} token inside strings. Throws on
 *  tokens that resolve to nothing — a package must never half-apply with
 *  literal placeholders left in FLUJO. */
function substitute<T>(value: T, resolve: (token: string) => string): T {
  if (typeof value === 'string') {
    return value.replace(TOKEN, (_, token: string) => resolve(token)) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, resolve)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, resolve)])) as unknown as T;
  }
  return value;
}

function makeResolver(pkg: PackageManifest, secrets: Record<string, string>, ctx: PackageContext) {
  return (token: string): string => {
    if (token.startsWith('secret:')) {
      const key = token.slice('secret:'.length);
      const decl = pkg.secrets.find((s) => s.key === key);
      if (!decl) throw new Error(`manifest references undeclared secret "${key}"`);
      const value = secrets[key]?.trim() ?? '';
      if (!value && !decl.optional) throw new Error(`secret "${key}" (${decl.label}) was not provided`);
      return value;
    }
    const brainValues: Record<string, string | undefined> = {
      'brain.modelId': ctx.modelId,
      'brain.modelName': ctx.modelName,
      'brain.name': ctx.brainName,
      'brain.lifeGoal': ctx.lifeGoal,
    };
    if (token in brainValues) {
      const v = brainValues[token];
      if (v === undefined) throw new Error(`placeholder {{${token}}} has no value for this brain`);
      return v;
    }
    throw new Error(`unknown placeholder {{${token}}}`);
  };
}

/** Same containerEnv rule as the standard skills (see provision.ts): a managed
 *  FLUJO passes the configured env VERBATIM to stdio transports, so a bare
 *  command dies with an empty PATH unless we inject one. */
const CONTAINER_ENV = {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/home/node',
};

/**
 * Pour one package into a FLUJO instance. Order matters: models first (flows
 * may bind them), then skills (flows may bind them), then flows, then the
 * planned executions that reference those flows. Every item is an upsert-skip:
 * applying the same package twice changes nothing.
 */
export async function applyPackage(
  flujo: FlujoClient,
  pkg: PackageManifest,
  secrets: Record<string, string>,
  ctx: PackageContext,
): Promise<string[]> {
  const missing = missingSecrets(pkg, secrets);
  if (missing.length) {
    throw new Error(`missing secrets: ${missing.map((s) => s.label).join(', ')}`);
  }
  const resolve = makeResolver(pkg, secrets, ctx);
  const notes: string[] = [];

  // Models — skip ids/names already present (an id collision would be the
  // same package re-applied; a name collision the user's own model).
  if (pkg.models.length) {
    const existing = await flujo.listModels();
    const byId = new Set(existing.map((m) => m.id));
    const byName = new Set(existing.map((m) => m.name));
    for (const raw of pkg.models) {
      const model = substitute(raw, resolve);
      if (byId.has(model.id) || byName.has(model.name)) {
        notes.push(`model "${model.name}" already exists — kept`);
        continue;
      }
      await flujo.createModel(model);
      notes.push(`model "${model.name}" added`);
    }
  }

  // MCP servers (skills) — keyed by name, like the standard skills.
  if (pkg.mcpServers.length) {
    const existing = new Set((await flujo.listMcpServers()).map((s) => s.name));
    for (const raw of pkg.mcpServers) {
      const server = substitute(raw, resolve);
      if (existing.has(server.name)) {
        notes.push(`skill "${server.name}" already exists — kept`);
        continue;
      }
      if (ctx.managed && server.transport === 'stdio') {
        server.env = { ...CONTAINER_ENV, ...(server.env as Record<string, string> | undefined) };
        if (!server.rootPath) server.rootPath = '/app';
      }
      await flujo.createMcpServer(server);
      notes.push(`skill "${server.name}" installed`);
    }
  }

  // Flows (behaviours) — manifest ids are stable so planned executions can
  // reference them and re-imports are recognizable.
  if (pkg.flows.length) {
    const existing = await flujo.listFlows();
    const byId = new Set(existing.map((f) => f.id));
    const byName = new Set(existing.map((f) => f.name));
    for (const raw of pkg.flows) {
      const flow = substitute(raw, resolve);
      if (byId.has(flow.id) || byName.has(flow.name)) {
        notes.push(`behaviour "${flow.name}" already exists — kept`);
        continue;
      }
      await flujo.createFlow(flow);
      notes.push(`behaviour "${flow.name}" added`);
    }
  }

  // Planned executions — keyed by name (FLUJO assigns ids on create).
  if (pkg.plannedExecutions.length) {
    const existing = await flujo.listPlannedExecutions().catch(() => ({ executions: [] }));
    const byName = new Set((existing.executions ?? []).map((e) => e.execution?.name).filter(Boolean));
    for (const raw of pkg.plannedExecutions) {
      const pe = substitute(raw, resolve);
      if (byName.has(pe.name)) {
        notes.push(`planned execution "${pe.name}" already exists — kept`);
        continue;
      }
      await flujo.createPlannedExecution(pe);
      notes.push(`planned execution "${pe.name}" created${pe.enabled ? '' : ' (disabled)'}`);
    }
  }

  return notes;
}

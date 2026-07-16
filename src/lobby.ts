import './style.css';
import { LANGS, applyI18n, getLang, onLangChange, setLang, t, type Lang } from './i18n';

interface Brain {
  id: string;
  name: string;
  lifeGoal: string;
  /** FLUJO base URL as the manager reaches it (for the one-brain-per-instance check). */
  flujoUrl?: string;
  status: 'provisioning' | 'ready' | 'error';
  statusDetail?: string;
  modelName?: string;
  kind: 'managed' | 'external';
  createdAt: string;
  /** This brain's FLUJO editor, reachable from the user's browser. */
  editorUrl?: string;
}

interface BrainsResponse {
  brains: Brain[];
  docker: boolean;
  ollama: boolean;
  /** The default FLUJO as the manager reaches it (adopt mode's target). */
  defaultFlujo?: string;
  /** The default FLUJO as the browser reaches it (adopt mode's home). */
  defaultFlujoEditor?: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Provider catalog — everything the wizard needs to stay non-technical:
// friendly names, brand marks, where to get a key, and curated model choices
// with plain-language tiers.
// ---------------------------------------------------------------------------

/** Matrix coordinate: 1 = cheap/simple … 3 = pricey/smart. */
type Axis = 1 | 2 | 3;

interface ModelChoice {
  id: string;
  label: string;
  /** Cost axis — for local models this reads as hardware weight (light → heavy). */
  cost: Axis;
  /** Capability axis (simple → smart). */
  smart: Axis;
  recommended?: boolean;
}

interface Provider {
  id: string;
  name: string;
  /** Short brand mark rendered inside the big button (emoji or monogram). */
  mark: string;
  color: string;
  /** Console URL where the user creates an API key (remote only). */
  keyUrl?: string;
  models: ModelChoice[];
}

const OLLAMA: Provider = {
  id: 'ollama',
  name: 'Ollama',
  mark: '🦙',
  color: '#a78bfa',
  models: [
    { id: 'llama3.2:3b', label: 'Llama 3.2 · 3B', cost: 1, smart: 1 },
    { id: 'qwen3:8b', label: 'Qwen 3 · 8B', cost: 2, smart: 2, recommended: true },
    { id: 'gemma3:12b', label: 'Gemma 3 · 12B', cost: 2, smart: 3 },
    { id: 'qwen3:30b', label: 'Qwen 3 · 30B', cost: 3, smart: 3 },
  ],
};

const REMOTE_PROVIDERS: Provider[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    mark: 'OR',
    color: '#8b5cf6',
    keyUrl: 'https://openrouter.ai/settings/keys',
    models: [
      { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', cost: 1, smart: 1 },
      { id: 'x-ai/grok-4.3', label: 'Grok 4.3', cost: 1, smart: 2 },
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', cost: 2, smart: 2, recommended: true },
      { id: 'openai/gpt-5.5', label: 'GPT-5.5', cost: 2, smart: 3 },
      { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', cost: 3, smart: 3 },
    ],
  },
  {
    id: 'requesty',
    name: 'Requesty',
    mark: 'RQ',
    color: '#0ea5e9',
    keyUrl: 'https://app.requesty.ai/api-keys',
    models: [
      { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', cost: 1, smart: 1 },
      { id: 'xai/grok-4.3', label: 'Grok 4.3', cost: 1, smart: 2 },
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', cost: 2, smart: 2, recommended: true },
      { id: 'openai/gpt-5.5', label: 'GPT-5.5', cost: 2, smart: 3 },
      { id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', cost: 3, smart: 3 },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    mark: 'AI',
    color: '#10a37f',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', cost: 1, smart: 1 },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', cost: 2, smart: 2, recommended: true },
      { id: 'gpt-5.5', label: 'GPT-5.5', cost: 2, smart: 3 },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', cost: 3, smart: 3 },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    mark: 'A\\',
    color: '#d97757',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', cost: 1, smart: 1 },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', cost: 2, smart: 2, recommended: true },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', cost: 3, smart: 3 },
      { id: 'claude-fable-5', label: 'Claude Fable 5', cost: 3, smart: 3 },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    mark: 'G',
    color: '#4285f4',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', cost: 1, smart: 1 },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', cost: 2, smart: 2, recommended: true },
      { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', cost: 3, smart: 3 },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    mark: 'M',
    color: '#fa520f',
    keyUrl: 'https://console.mistral.ai/api-keys',
    models: [
      { id: 'ministral-8b-latest', label: 'Ministral 8B', cost: 1, smart: 1 },
      { id: 'mistral-small-latest', label: 'Mistral Small 4', cost: 1, smart: 2, recommended: true },
      { id: 'mistral-medium-latest', label: 'Mistral Medium 3.5', cost: 2, smart: 3 },
      { id: 'mistral-large-latest', label: 'Mistral Large 3', cost: 3, smart: 3 },
    ],
  },
  {
    id: 'xai',
    name: 'xAI',
    mark: 'X',
    color: '#e2e8f0',
    keyUrl: 'https://console.x.ai',
    models: [
      { id: 'grok-4.1-fast', label: 'Grok 4.1 Fast', cost: 1, smart: 2 },
      { id: 'grok-4.3', label: 'Grok 4.3', cost: 2, smart: 3, recommended: true },
    ],
  },
];

const providerById = (id: string): Provider =>
  id === OLLAMA.id ? OLLAMA : REMOTE_PROVIDERS.find((p) => p.id === id) ?? OLLAMA;

// ---------------------------------------------------------------------------
// Orbit — existing brains circle a pulsing "+" core (FLUJO-landing style).
// ---------------------------------------------------------------------------

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const orbit = {
  wrap: $('orbit-wrap'),
  ring1: $('orbit-ring1'),
  ring2: $('orbit-ring2'),
  center: $('orbit-center'),
  centerLabel: $('orbit-center-label'),
  card: $('orbit-card'),
  cardBody: $('orbit-card-body'),
  hint: $('orbit-hint'),
};

let brains: Brain[] = [];
let nodeEls: HTMLElement[] = [];
let rotation = 0;
let targetRotation: number | null = null;
let autoRotate = !reducedMotion;
let activeBrainId: string | null = null;
let radius = 220;

const STATUS_ICON = { provisioning: '◌', ready: '●', error: '✕' } as const;

function layoutSizes(): void {
  const w = orbit.wrap.clientWidth;
  const h = orbit.wrap.clientHeight;
  radius = Math.max(115, Math.min(230, Math.min(w / 2 - 85, h / 2 - 70)));
  orbit.ring1.style.width = orbit.ring1.style.height = `${radius * 2}px`;
  orbit.ring2.style.width = orbit.ring2.style.height = `${radius * 2 + 64}px`;
}

function nodeAngle(i: number): number {
  return (i / Math.max(brains.length, 1)) * 360 + rotation;
}

function shortestDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function positionNodes(): void {
  for (let i = 0; i < nodeEls.length; i++) {
    const rad = (nodeAngle(i) * Math.PI) / 180;
    const x = radius * Math.cos(rad);
    const y = radius * Math.sin(rad);
    const el = nodeEls[i];
    const depth = (1 + Math.sin(rad)) / 2; // 0 top .. 1 bottom
    const scale = 0.85 + depth * 0.25;
    const isActive = activeBrainId === brains[i]?.id;
    el.style.transform = `translate(${x}px,${y}px) scale(${isActive ? 1.05 : scale})`;
    el.style.zIndex = String(isActive ? 200 : Math.round(50 + depth * 50));
    el.style.opacity = isActive ? '1' : (0.55 + depth * 0.45).toFixed(2);
  }
  if (activeBrainId !== null) positionCard();
}

function positionCard(): void {
  const cx = orbit.wrap.clientWidth / 2;
  const cy = orbit.wrap.clientHeight / 2;
  orbit.card.style.left = `${cx - orbit.card.offsetWidth / 2}px`;
  orbit.card.style.top = `${cy - radius + 56}px`;
}

/**
 * "awake" vs "idle" for a ready brain: idle when its scheduler is paused or
 * nothing is armed to wake it — it only acts when spoken to.
 */
async function isIdle(b: Brain): Promise<boolean> {
  try {
    const res = await fetch(`/brains/${encodeURIComponent(b.id)}/flujo/api/planned-executions`);
    if (!res.ok) return false;
    const data = (await res.json()) as { paused?: boolean; executions?: Array<{ execution?: { enabled?: boolean } }> };
    if (data.paused) return true;
    return !(data.executions ?? []).some((e) => e.execution?.enabled);
  } catch {
    return false; // unknowable — keep "awake"
  }
}

function renderCard(b: Brain): void {
  const open =
    b.status === 'ready'
      ? `<a class="open" href="./?flujo=${encodeURIComponent(`/brains/${b.id}/flujo`)}">${esc(t('card.open'))}</a>`
      : '';
  const editor =
    b.status === 'ready' && b.editorUrl
      ? `<a class="open editor" href="${esc(b.editorUrl)}" target="_blank" rel="noopener">${esc(t('card.editor'))}</a>`
      : '';
  // Any statusDetail is worth showing: error causes, provisioning steps, and
  // "born with warnings" notes (e.g. a starter package that half-applied).
  const detail = b.statusDetail ? `<p class="detail">${esc(b.statusDetail)}</p>` : '';
  const born = t('card.born', { date: new Date(b.createdAt).toLocaleDateString(getLang()) });
  orbit.cardBody.innerHTML = `
    <header><h3>${esc(b.name)}</h3>
      <span class="status ${b.status}">${STATUS_ICON[b.status]} ${esc(t(`status.${b.status}`))}</span></header>
    <p class="goal">${esc(b.lifeGoal)}</p>
    ${detail}
    <p class="meta">${esc(b.modelName ?? t('card.noModel'))} · ${esc(t(`card.kind.${b.kind}`))} · ${esc(born)}</p>
    <footer>${open}${editor}${
      b.kind === 'managed' && b.status !== 'provisioning'
        ? `<button class="rebuild" type="button" title="${esc(t('card.rebuildConfirm', { name: b.name }))}">${esc(t('card.rebuild'))}</button>`
        : ''
    }<button class="forget" type="button">${esc(t('card.forget'))}</button></footer>`;
  orbit.cardBody.querySelector<HTMLButtonElement>('.forget')!.addEventListener('click', async () => {
    if (!confirm(t('card.forgetConfirm', { name: b.name }))) return;
    await api(`/brains/${b.id}`, { method: 'DELETE' });
    deselect();
    void refresh();
  });
  orbit.cardBody.querySelector<HTMLButtonElement>('.rebuild')?.addEventListener('click', async () => {
    if (!confirm(t('card.rebuildConfirm', { name: b.name }))) return;
    try {
      await api(`/brains/${b.id}/rebuild`, { method: 'POST' });
    } catch (err) {
      alert((err as Error).message);
    }
    void refresh();
  });

  // A ready brain may still be idle (paused / nothing wakes it) — refine async.
  if (b.status === 'ready') {
    void isIdle(b).then((idle) => {
      const chip = orbit.cardBody.querySelector<HTMLElement>('.status.ready');
      if (idle && chip && activeBrainId === b.id) {
        chip.classList.remove('ready');
        chip.classList.add('idle');
        chip.textContent = `◦ ${t('status.idle')}`;
      }
    });
  }
}

function selectBrain(id: string): void {
  if (activeBrainId === id) {
    deselect();
    return;
  }
  const idx = brains.findIndex((b) => b.id === id);
  if (idx === -1) return;
  activeBrainId = id;
  autoRotate = false;
  const base = (idx / brains.length) * 360;
  if (reducedMotion) {
    rotation = (((270 - base) % 360) + 360) % 360;
    targetRotation = null;
  } else {
    targetRotation = rotation + shortestDelta(rotation + base, 270);
  }
  renderCard(brains[idx]);
  orbit.card.classList.add('show');
  nodeEls.forEach((el, i) => el.classList.toggle('active', brains[i]?.id === id));
  positionNodes();
}

function deselect(): void {
  activeBrainId = null;
  targetRotation = null;
  autoRotate = !reducedMotion;
  orbit.card.classList.remove('show');
  nodeEls.forEach((el) => el.classList.remove('active'));
  positionNodes();
}

function rebuildNodes(): void {
  nodeEls.forEach((el) => el.remove());
  nodeEls = brains.map((b) => {
    const el = document.createElement('div');
    el.className = `orbit-node ${b.status}`;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', b.name);
    el.innerHTML = `<div class="bubble">🧠</div><div class="nlabel">${esc(b.name)}</div>`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectBrain(b.id);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectBrain(b.id);
      }
    });
    orbit.wrap.appendChild(el);
    return el;
  });

  orbit.center.classList.toggle('lonely', brains.length === 0);
  orbit.hint.dataset.i18n = brains.length === 0 ? 'orbit.empty' : 'orbit.hint';
  orbit.hint.textContent = t(orbit.hint.dataset.i18n);

  if (activeBrainId) {
    const active = brains.find((b) => b.id === activeBrainId);
    if (active) renderCard(active);
    else deselect();
  }
  positionNodes();
}

let lastT: number | null = null;
function orbitLoop(now: number): void {
  if (lastT === null) lastT = now;
  const dt = Math.min(now - lastT, 100);
  lastT = now;
  if (targetRotation !== null) {
    const diff = targetRotation - rotation;
    if (Math.abs(diff) < 0.05) rotation = targetRotation;
    else rotation += diff * Math.min(1, dt / 220);
  } else if (autoRotate) {
    rotation = (rotation + dt * 0.005) % 360;
  }
  positionNodes();
  requestAnimationFrame(orbitLoop);
}

window.addEventListener('resize', () => {
  layoutSizes();
  positionNodes();
});
orbit.wrap.addEventListener('click', (e) => {
  if (e.target === orbit.wrap || e.target === orbit.ring1 || e.target === orbit.ring2) deselect();
});
orbit.card.addEventListener('click', (e) => e.stopPropagation());
orbit.center.addEventListener('click', (e) => {
  e.stopPropagation();
  openWizard();
});

// ---------------------------------------------------------------------------
// Data refresh
// ---------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let lastSnapshot = '';
let ollamaAvailable = false;
/** Optimistic until the first /brains answer — the wizard opens only after it. */
let dockerAvailable = true;
let defaultFlujoEditor = '';

/** No Docker → brains can only adopt the default FLUJO; say so up front. */
function renderAdoptBanner(): void {
  const banner = $('adopt-mode');
  banner.classList.toggle('hidden', dockerAvailable);
  if (!dockerAvailable) {
    banner.textContent = t('lobby.adoptMode', { url: defaultFlujoEditor || 'http://localhost:4200' });
  }
}

/** In adopt-only mode the "+" works exactly once: one FLUJO, one brain. */
function syncPlusButton(data: BrainsResponse): void {
  const norm = (u: string) => u.replace(/\/+$/, '');
  const taken =
    !data.docker &&
    Boolean(data.defaultFlujo) &&
    data.brains.some((b) => b.flujoUrl && norm(b.flujoUrl) === norm(data.defaultFlujo!));
  const center = $('orbit-center') as HTMLButtonElement;
  center.disabled = taken;
  center.title = taken ? t('orbit.taken') : '';
  $('orbit-center-label').textContent = taken ? t('orbit.taken') : t('orbit.new');
}

async function refresh(): Promise<void> {
  try {
    const data = await api<BrainsResponse>('/brains');
    ollamaAvailable = data.ollama;
    dockerAvailable = data.docker;
    defaultFlujoEditor = data.defaultFlujoEditor ?? '';
    renderAdoptBanner();
    syncPlusButton(data);
    $('manager-offline').classList.add('hidden');
    const snapshot = JSON.stringify(data.brains.map((b) => [b.id, b.name, b.status, b.statusDetail, b.modelName]));
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      brains = data.brains;
      rebuildNodes();
    }
    if (pollTimer) clearTimeout(pollTimer);
    if (data.brains.some((b) => b.status === 'provisioning')) pollTimer = setTimeout(() => void refresh(), 2500);
  } catch {
    $('manager-offline').classList.remove('hidden');
    if (brains.length) {
      brains = [];
      lastSnapshot = '';
      rebuildNodes();
    }
  }
}

// ---------------------------------------------------------------------------
// Connect to a FLUJO elsewhere in the network — a brain grown elsewhere joins
// the lobby as it is; an empty instance is registered and can grow one.
// ---------------------------------------------------------------------------

const connectOverlay = $('connect-overlay');

/** `M`, `192.168.1.50`, `http://M:4200/` → canonical FLUJO base URL
 *  (scheme defaults to http, port to FLUJO's 4200). */
function normalizeFlujoAddress(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
  const port = url.port || (url.protocol === 'https:' ? '' : '4200');
  return `${url.protocol}//${url.hostname}${port ? `:${port}` : ''}`;
}

function openConnect(): void {
  const status = $('connect-status');
  status.classList.add('hidden');
  status.textContent = '';
  connectOverlay.classList.remove('hidden');
  connectOverlay.querySelector<HTMLInputElement>('#connect-url')!.focus();
}

function closeConnect(): void {
  connectOverlay.classList.add('hidden');
}

async function submitConnect(): Promise<void> {
  const input = connectOverlay.querySelector<HTMLInputElement>('#connect-url')!;
  const go = connectOverlay.querySelector<HTMLButtonElement>('#connect-go')!;
  const status = $('connect-status');
  const url = normalizeFlujoAddress(input.value);
  if (!url) return;
  go.disabled = true;
  status.classList.remove('hidden');
  status.textContent = t('wiz.net.checking');
  try {
    const brain = await api<Brain & { hasStem?: boolean }>('/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    await refresh();
    if (brain.hasStem === false) {
      // Keep the dialog open so the note is read — the brain is selected behind it.
      status.textContent = t('connect.noStem');
    } else {
      closeConnect();
    }
    selectBrain(brain.id);
  } catch (err) {
    status.textContent = `⚠ ${(err as Error).message}`;
  } finally {
    go.disabled = false;
  }
}

$('connect-flujo').addEventListener('click', openConnect);
$('connect-close').addEventListener('click', closeConnect);
$('connect-go').addEventListener('click', () => void submitConnect());
connectOverlay.addEventListener('click', (e) => {
  if (e.target === connectOverlay) closeConnect();
});
connectOverlay.querySelector<HTMLInputElement>('#connect-url')!.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void submitConnect();
});

// ---------------------------------------------------------------------------
// Wizard — big buttons, few words. where → provider → (key) → model → soul.
// ---------------------------------------------------------------------------

type StepId = 'where' | 'provider' | 'network' | 'key' | 'model' | 'soul';

interface WizState {
  where: 'local' | 'network' | 'remote' | null;
  provider: string | null;
  networkUrl: string;
  apiKey: string;
  model: string | null;
  customModel: boolean;
  goal: string;
  adopt: boolean;
  existingId: string;
  heartbeat: boolean;
  cron: string;
  wake: boolean;
  /** Selected starter package ids (Advanced). */
  packages: string[];
  /** Secret values for selected packages, keyed `<pkgId>/<secretKey>`. */
  pkgSecrets: Record<string, string>;
  busy: boolean;
  error: string | null;
}

const freshWiz = (): WizState => ({
  where: null,
  provider: null,
  networkUrl: '',
  apiKey: '',
  model: null,
  customModel: false,
  goal: '',
  adopt: false,
  existingId: '',
  heartbeat: true,
  cron: '0 */3 * * * *',
  wake: false,
  packages: [],
  pkgSecrets: {},
  busy: false,
  error: null,
});

let wiz = freshWiz();
let wizStep: StepId = 'where';
let wizOpen = false;
let ollamaTags: string[] | null = null;
let existingModels: Array<{ id: string; name: string; displayName?: string }> | null = null;

// Starter packages (curated bundles of models/skills/behaviours/schedules the
// manager offers). Loaded once; the soul step's Advanced section renders them.
interface PackageSecretDecl {
  key: string;
  label: string;
  hint?: string;
  optional?: boolean;
}
interface PackageSummary {
  id: string;
  name: string;
  description: string;
  secrets: PackageSecretDecl[];
  counts: { models: number; mcpServers: number; flows: number; plannedExecutions: number };
}
let packageCatalog: PackageSummary[] | null = null;

function loadPackageCatalog(): void {
  if (packageCatalog !== null) return;
  void api<{ packages: PackageSummary[] }>('/packages')
    .then((r) => {
      packageCatalog = r.packages;
      if (wizOpen && wizStep === 'soul') renderWizard();
    })
    .catch(() => {
      packageCatalog = [];
    });
}

/** Required secrets of the selected packages the user hasn't filled yet. */
function pkgSecretsMissing(): boolean {
  return wiz.packages.some((id) => {
    const pkg = packageCatalog?.find((p) => p.id === id);
    return pkg?.secrets.some((s) => !s.optional && !wiz.pkgSecrets[`${id}/${s.key}`]?.trim());
  });
}

// Model search: the provider's official catalog, fetched live via the manager.
interface CatalogModel {
  id: string;
  name?: string;
}
let modelQuery = '';
/** Which provider+key the fetched catalog belongs to (remote providers). */
let catalogFor: string | null = null;
let catalogModels: CatalogModel[] | 'loading' | 'error' = 'loading';
/** Ollama library search results (debounced, seq guards stale responses). */
let libraryHits: CatalogModel[] | 'loading' | 'error' | null = null;
let librarySeq = 0;

/** Fetch the provider's full model list once per provider+key; search filters it locally. */
function ensureCatalog(): void {
  if (wiz.where !== 'remote' || !wiz.provider) return;
  const want = `${wiz.provider}:${wiz.apiKey}`;
  if (catalogFor === want) return;
  catalogFor = want;
  catalogModels = 'loading';
  void api<{ models: CatalogModel[] }>('/provider-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: wiz.provider, apiKey: wiz.apiKey }),
  })
    .then((r) => {
      if (catalogFor !== want) return;
      catalogModels = r.models;
      refreshModelLists();
    })
    .catch(() => {
      if (catalogFor !== want) return;
      catalogModels = 'error';
      refreshModelLists();
    });
}

/** Debounced search of the Ollama library (models available to pull). */
function searchLibrary(q: string): void {
  const seq = ++librarySeq;
  if (!q) {
    libraryHits = null;
    return;
  }
  libraryHits = 'loading';
  window.setTimeout(() => {
    if (seq !== librarySeq) return;
    void api<{ models: CatalogModel[] }>(`/ollama/library?q=${encodeURIComponent(q)}`)
      .then((r) => {
        if (seq !== librarySeq) return;
        libraryHits = r.models;
        refreshModelLists();
      })
      .catch(() => {
        if (seq !== librarySeq) return;
        libraryHits = 'error';
        refreshModelLists();
      });
  }, 300);
}

/** Case-insensitive match: every word of the query must appear in id or
 *  display name ("gemini flash" finds google/gemini-2.5-flash); models whose
 *  id/name starts with the query rank first. */
function rankHits(models: CatalogModel[], q: string): CatalogModel[] {
  const lq = q.toLowerCase();
  const words = lq.split(/\s+/).filter(Boolean);
  return models
    .flatMap((m) => {
      const id = m.id.toLowerCase();
      const name = (m.name ?? '').toLowerCase();
      const hay = `${id} ${name}`;
      if (!words.every((w) => hay.includes(w))) return [];
      return [{ m, score: id.startsWith(lq) || name.startsWith(lq) ? 0 : 1 }];
    })
    .sort((a, b) => a.score - b.score || a.m.id.localeCompare(b.m.id))
    .slice(0, 8)
    .map((x) => x.m);
}

const overlay = $('wizard-overlay');
const wizard = $('wizard');

function wizSteps(): StepId[] {
  // network = Ollama on another machine: no provider choice, ask for its address instead.
  const base: StepId[] = ['where', wiz.where === 'network' ? 'network' : 'provider'];
  if (wiz.where === 'remote') base.push('key');
  base.push('model', 'soul');
  return base;
}

/** Models already present in the default FLUJO (adopted brains can reuse one). */
function loadExistingModels(): void {
  if (existingModels !== null) return;
  void api<Array<{ id: string; name: string; displayName?: string }>>('/default-flujo/models')
    .then((models) => {
      existingModels = models;
      if (wizOpen && wizStep === 'soul') renderWizard();
    })
    .catch(() => {
      existingModels = [];
    });
}

function openWizard(): void {
  wiz = freshWiz();
  loadPackageCatalog();
  // No Docker → managed brains are impossible; every new brain adopts the
  // stack's default FLUJO instance.
  if (!dockerAvailable) {
    wiz.adopt = true;
    loadExistingModels();
  }
  wizStep = 'where';
  wizOpen = true;
  overlay.classList.remove('hidden');
  renderWizard();
}

function closeWizard(): void {
  wizOpen = false;
  overlay.classList.add('hidden');
}

function goTo(step: StepId): void {
  wizStep = step;
  wiz.error = null;
  renderWizard();
}

function goNext(): void {
  const steps = wizSteps();
  const i = steps.indexOf(wizStep);
  if (i < steps.length - 1) goTo(steps[i + 1]);
}

function goBack(): void {
  const steps = wizSteps();
  const i = steps.indexOf(wizStep);
  if (i > 0) goTo(steps[i - 1]);
}

/** Turn whatever the user typed — `M`, `192.168.1.50`, `M:11434`,
 *  `http://M:11434/v1` — into a canonical Ollama base URL. Scheme defaults to
 *  http, port to Ollama's 11434 (unless https, whose default port stays 443),
 *  and any path like /v1 is dropped. Returns null if it isn't an address. */
function normalizeOllamaAddress(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
  const port = url.port || (url.protocol === 'https:' ? '' : '11434');
  return `${url.protocol}//${url.hostname}${port ? `:${port}` : ''}`;
}

/** One big tappable choice tile. */
function choiceHtml(opts: { key: string; icon: string; color?: string; title: string; sub: string; badge?: string }): string {
  const mark =
    opts.icon.length <= 3 && !/\p{Emoji}/u.test(opts.icon)
      ? `<span class="mark" style="--mc:${opts.color ?? 'var(--model)'}">${esc(opts.icon)}</span>`
      : `<span class="mark emoji">${opts.icon}</span>`;
  const badge = opts.badge ? `<span class="badge">${esc(opts.badge)}</span>` : '';
  return `<button type="button" class="wiz-choice" data-key="${esc(opts.key)}">
    ${mark}
    <span class="txt"><b>${esc(opts.title)}${badge}</b><small>${esc(opts.sub)}</small></span>
    <span class="chev" aria-hidden="true">›</span>
  </button>`;
}

/** The model step below the search box: curated picks, or live hits while searching. */
function modelListsHtml(prov: Provider): string {
  const q = modelQuery.trim();
  if (q) return hitlistHtml(prov, q);

  const installed =
    prov.id === OLLAMA.id && ollamaTags?.length
      ? `<p class="wiz-group">${esc(t(wiz.where === 'network' ? 'wiz.model.installedNet' : 'wiz.model.installed'))}</p>
         <div class="wiz-choices">
           ${ollamaTags
             .slice(0, 6)
             .map((tag) => choiceHtml({ key: `m:${tag}`, icon: '💾', title: tag, sub: '' }))
             .join('')}
         </div>
         <p class="wiz-group"></p>`
      : '';
  const custom = wiz.customModel
    ? `<input id="wiz-custom-model" autocomplete="off" placeholder="${esc(t('wiz.model.customPh'))}" value="${esc(wiz.model ?? '')}" />`
    : choiceHtml({ key: 'custom', icon: '⌨️', title: t('wiz.model.custom'), sub: t('wiz.model.customPh') });
  return `${installed}
    ${matrixHtml(prov)}
    <div class="wiz-choices">${wiz.customModel ? '' : custom}</div>
    ${wiz.customModel ? custom : ''}`;
}

/** Curated picks laid out on a cheap↔pricey × simple↔smart grid. */
function matrixHtml(prov: Provider): string {
  const models = prov.models.filter((m) => !(prov.id === OLLAMA.id && ollamaTags?.includes(m.id)));
  if (!models.length) return '';
  // Row 0 is the top of the grid, so the smartest models sit up there.
  const cells: string[][] = Array.from({ length: 9 }, () => []);
  for (const m of models) {
    cells[(3 - m.smart) * 3 + (m.cost - 1)].push(
      `<button type="button" class="wiz-choice wiz-cell-pick" data-key="m:${esc(m.id)}">
        <b>${esc(m.label)}</b>
        ${m.recommended ? `<span class="badge">${esc(t('tier.recommended'))}</span>` : ''}
      </button>`,
    );
  }
  const local = prov.id === OLLAMA.id;
  return `<div class="wiz-matrix">
    <div class="wiz-axis-y" aria-hidden="true">
      <span>${esc(t('wiz.matrix.smart'))}</span><span>${esc(t('wiz.matrix.simple'))}</span>
    </div>
    <div class="wiz-matrix-grid">
      ${cells.map((c) => `<div class="wiz-cell${c.length ? '' : ' empty'}">${c.join('')}</div>`).join('')}
    </div>
    <div class="wiz-axis-x" aria-hidden="true">
      <span>${esc(t(local ? 'wiz.matrix.light' : 'wiz.matrix.cheap'))}</span>
      <span>${esc(t(local ? 'wiz.matrix.heavy' : 'wiz.matrix.pricey'))}</span>
    </div>
  </div>`;
}

/** Live search results: installed tags + Ollama library, or the provider catalog. */
function hitlistHtml(prov: Provider, q: string): string {
  let items = '';
  let note = '';
  if (prov.id === OLLAMA.id) {
    items = (ollamaTags ?? [])
      .filter((tag) => tag.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 4)
      .map((tag) => choiceHtml({ key: `m:${tag}`, icon: '💾', title: tag, sub: '' }))
      .join('');
    if (libraryHits === 'loading') note = t('wiz.model.loading');
    else if (libraryHits === 'error') note = t('wiz.model.liveFail');
    else
      items += (libraryHits ?? [])
        .map((m) => choiceHtml({ key: `m:${m.id}`, icon: '📦', title: m.id, sub: t('wiz.model.library') }))
        .join('');
  } else if (catalogModels === 'loading') {
    note = t('wiz.model.loading');
  } else if (catalogModels === 'error') {
    note = t('wiz.model.liveFail');
  } else {
    const hits = rankHits(catalogModels, q);
    items = hits
      .map((m) =>
        choiceHtml({
          key: `m:${m.id}`,
          icon: '✨',
          title: m.name && m.name !== m.id ? m.name : m.id,
          sub: m.name && m.name !== m.id ? m.id : '',
        }),
      )
      .join('');
    if (!hits.length) note = t('wiz.model.noHits');
  }
  // Whatever happens, the typed id itself stays selectable.
  const useTyped = choiceHtml({ key: `use:${q}`, icon: '⌨️', title: t('wiz.model.useTyped', { q }), sub: t('wiz.model.useTypedSub') });
  return `<div class="wiz-choices">${items}${useTyped}</div>${note ? `<p class="wiz-safe">${esc(note)}</p>` : ''}`;
}

/** Re-render only the model lists (keeps focus in the search box) and rewire. */
function refreshModelLists(): void {
  if (!wizOpen || wizStep !== 'model' || !wiz.provider) return;
  const div = wizard.querySelector<HTMLDivElement>('#wiz-model-lists');
  if (!div) return;
  div.innerHTML = modelListsHtml(providerById(wiz.provider));
  wireChoices(div);
  wireCustomModel();
}

function stepBodyHtml(): string {
  switch (wizStep) {
    case 'where':
      // Special hero layout: big centered question, three arrows fanning
      // down to three big cards side by side (stacked on narrow screens).
      return `<div class="wiz-where">
        <h3>${esc(t('wiz.where.title'))}</h3>
        <svg class="wiz-fan" viewBox="0 0 600 56" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <marker id="wiz-fan-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="currentColor" stroke="none"/>
            </marker>
          </defs>
          <path d="M300 4 C300 26 100 24 100 46" marker-end="url(#wiz-fan-arrow)"/>
          <path d="M300 4 L300 46" marker-end="url(#wiz-fan-arrow)"/>
          <path d="M300 4 C300 26 500 24 500 46" marker-end="url(#wiz-fan-arrow)"/>
        </svg>
        <div class="wiz-choices wiz-row">
          ${choiceHtml({ key: 'local', icon: '🖥️', title: t('wiz.where.local'), sub: t('wiz.where.localSub') })}
          ${choiceHtml({ key: 'network', icon: '🌐', title: t('wiz.where.network'), sub: t('wiz.where.networkSub') })}
          ${choiceHtml({ key: 'remote', icon: '☁️', title: t('wiz.where.remote'), sub: t('wiz.where.remoteSub') })}
        </div>
      </div>`;

    case 'provider': {
      if (wiz.where === 'local') {
        return `<h3>${esc(t('wiz.provider.titleLocal'))}</h3>
          <div class="wiz-choices">
            ${choiceHtml({ key: OLLAMA.id, icon: OLLAMA.mark, color: OLLAMA.color, title: OLLAMA.name, sub: t('prov.ollama.sub') })}
          </div>`;
      }
      return `<h3>${esc(t('wiz.provider.titleRemote'))}</h3>
        <div class="wiz-choices">
          ${REMOTE_PROVIDERS.map((p) =>
            choiceHtml({ key: p.id, icon: p.mark, color: p.color, title: p.name, sub: t(`prov.${p.id}.sub`) }),
          ).join('')}
        </div>`;
    }

    case 'network':
      return `<h3>${esc(t('wiz.net.title'))}</h3>
        <p class="wiz-desc">${esc(t('wiz.net.desc'))}</p>
        <input id="wiz-net-url" autocomplete="off" inputmode="url" spellcheck="false" placeholder="${esc(t('wiz.net.ph'))}" value="${esc(wiz.networkUrl)}" />
        ${wiz.error ? `<p class="error">${esc(wiz.error)}</p>` : ''}
        <p class="wiz-safe">${esc(t('wiz.net.hint'))}</p>`;

    case 'key': {
      const prov = providerById(wiz.provider!);
      return `<h3>${esc(t('wiz.key.title', { provider: prov.name }))}</h3>
        <p class="wiz-desc">${esc(t(`key.desc.${prov.id}`))}</p>
        <a class="wiz-keylink" href="${esc(prov.keyUrl!)}" target="_blank" rel="noopener">${esc(t('wiz.key.get'))}</a>
        <input id="wiz-key" type="password" autocomplete="off" placeholder="${esc(t('wiz.key.ph'))}" value="${esc(wiz.apiKey)}" />
        <p class="wiz-safe">${esc(t('wiz.key.safe'))}</p>`;
    }

    case 'model': {
      const prov = providerById(wiz.provider!);
      const searchPh =
        prov.id === OLLAMA.id ? t('wiz.model.searchPhOllama') : t('wiz.model.searchPh', { provider: prov.name });
      const note = prov.id === OLLAMA.id ? `<p class="wiz-safe">${esc(t('wiz.model.pullNote'))}</p>` : '';
      return `<h3>${esc(t('wiz.model.title'))}</h3>
        <input id="wiz-model-search" class="wiz-search" type="search" autocomplete="off" spellcheck="false"
          placeholder="${esc(searchPh)}" value="${esc(modelQuery)}" />
        <div id="wiz-model-lists">${modelListsHtml(prov)}</div>
        ${note}`;
    }

    case 'soul': {
      const existingOpts = existingModels
        ? `<option value="">${esc(t('wiz.adv.existingNew'))}</option>` +
          existingModels
            .map((m) => `<option value="${esc(m.id)}"${m.id === wiz.existingId ? ' selected' : ''}>${esc(m.displayName ?? m.name)}</option>`)
            .join('')
        : `<option value="">${esc(t('wiz.adv.existingNew'))}</option>`;
      // Without Docker the adopt choice is not a choice — show it as a fact
      // instead of a checkbox.
      const adoptRow = dockerAvailable
        ? `<label class="check"><input type="checkbox" id="wiz-adopt"${wiz.adopt ? ' checked' : ''} /> ${esc(t('wiz.adv.adopt'))}</label>`
        : '';
      const adoptNote = dockerAvailable ? '' : `<p class="wiz-adoptnote">🐳 ${esc(t('wiz.soul.adoptForced'))}</p>`;
      // Starter packages: one checkbox per bundle; picking one with secrets
      // unfolds the inputs for them right below it.
      const pkgRows = (packageCatalog ?? [])
        .map((pkg) => {
          const checked = wiz.packages.includes(pkg.id);
          const secretRows =
            checked && pkg.secrets.length
              ? pkg.secrets
                  .map((s) => {
                    const hint =
                      s.hint && /^https?:\/\//.test(s.hint)
                        ? ` <a class="wiz-pkg-hint" href="${esc(s.hint)}" target="_blank" rel="noopener">${esc(t('wiz.key.get'))}</a>`
                        : '';
                    return `<label class="check wiz-pkg-secret">${esc(s.label)}${hint}
                      <input type="password" autocomplete="off" placeholder="${esc(t('wiz.key.ph'))}"
                        data-pkg-secret="${esc(`${pkg.id}/${s.key}`)}" value="${esc(wiz.pkgSecrets[`${pkg.id}/${s.key}`] ?? '')}" />
                    </label>`;
                  })
                  .join('')
              : '';
          return `<label class="check wiz-pkg"><input type="checkbox" data-pkg="${esc(pkg.id)}"${checked ? ' checked' : ''} />
              <span class="wiz-pkg-txt"><b>${esc(pkg.name)}</b><small>${esc(pkg.description)}</small></span>
            </label>${secretRows}`;
        })
        .join('');
      const packagesGroup = pkgRows ? `<p class="wiz-group">${esc(t('wiz.adv.packages'))}</p>${pkgRows}` : '';
      return `<h3>${esc(t('wiz.soul.title'))}</h3>
        <label class="wiz-field">${esc(t('wiz.soul.goal'))}
          <textarea id="wiz-goal" rows="3" placeholder="${esc(t('wiz.soul.goalPh'))}">${esc(wiz.goal)}</textarea>
          <small>${esc(t('wiz.soul.goalHint'))}</small>
        </label>
        ${adoptNote}
        <details class="wiz-adv"${(dockerAvailable && wiz.adopt) || wiz.wake || !wiz.heartbeat || wiz.packages.length ? ' open' : ''}>
          <summary>${esc(t('wiz.adv'))}</summary>
          ${adoptRow}
          <label class="check wiz-existing${wiz.adopt ? '' : ' hidden'}">${esc(t('wiz.adv.existing'))}
            <select id="wiz-existing">${existingOpts}</select>
          </label>
          ${packagesGroup}
          <label class="check"><input type="checkbox" id="wiz-heartbeat"${wiz.heartbeat ? ' checked' : ''} /> ${esc(t('wiz.adv.heartbeat'))}</label>
          <label class="check cron${wiz.heartbeat ? '' : ' hidden'}">${esc(t('wiz.adv.cron'))}
            <input id="wiz-cron" value="${esc(wiz.cron)}" autocomplete="off" />
          </label>
          <label class="check"><input type="checkbox" id="wiz-wake"${wiz.wake ? ' checked' : ''} /> ${esc(t('wiz.adv.wake'))}</label>
        </details>
        ${wiz.error ? `<p class="error">${esc(wiz.error)}</p>` : ''}`;
    }
  }
}

function footerHtml(): string {
  const steps = wizSteps();
  const i = steps.indexOf(wizStep);
  const dots = steps
    .map((_, d) => `<span class="dot${d === i ? ' active' : ''}${d < i ? ' done' : ''}"></span>`)
    .join('');
  const back = i > 0 ? `<button type="button" class="wiz-back" id="wiz-back">← ${esc(t('wiz.back'))}</button>` : '<span></span>';
  let action = '';
  if (wizStep === 'key' || wizStep === 'network')
    action = `<button type="button" class="wiz-next" id="wiz-next" disabled>${esc(t('wiz.next'))} →</button>`;
  if (wizStep === 'model' && wiz.customModel)
    action = `<button type="button" class="wiz-next" id="wiz-next" disabled>${esc(t('wiz.next'))} →</button>`;
  if (wizStep === 'soul')
    action = `<button type="button" class="wiz-create" id="wiz-create" disabled>${esc(t('wiz.create'))}</button>`;
  return `${back}<div class="wiz-dots">${dots}</div>${action || '<span></span>'}`;
}

function renderWizard(): void {
  wizard.classList.toggle('wide', wizStep === 'where');
  wizard.innerHTML = `
    <header>
      <h2>${esc(t('wiz.title'))}</h2>
      <button type="button" class="wiz-close" id="wiz-close" aria-label="${esc(t('wiz.close'))}">×</button>
    </header>
    <div class="wiz-body">${stepBodyHtml()}</div>
    <footer class="wiz-footer">${footerHtml()}</footer>`;
  wireWizard();
}

function wireChoices(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>('.wiz-choice').forEach((btn) => {
    btn.addEventListener('click', () => handleChoice(btn.dataset.key!));
  });
}

function handleChoice(key: string): void {
  if (wizStep === 'where') {
    wiz.where = key as 'local' | 'network' | 'remote';
    wiz.provider = wiz.where === 'remote' ? null : OLLAMA.id;
    wiz.model = null;
    wiz.customModel = false;
    ollamaTags = null;
    modelQuery = '';
    libraryHits = null;
    librarySeq++;
    if (wiz.where === 'local' && ollamaAvailable) {
      // Prefetch installed tags so the model step can offer them.
      void api<{ models?: Array<{ name: string }> }>('/ollama/tags')
        .then((r) => {
          ollamaTags = (r.models ?? []).map((m) => m.name);
          if (wizOpen && wizStep === 'model') renderWizard();
        })
        .catch(() => {
          ollamaTags = null;
        });
    }
    goNext();
  } else if (wizStep === 'provider') {
    wiz.provider = key;
    wiz.model = null;
    wiz.customModel = false;
    modelQuery = '';
    goNext();
  } else if (wizStep === 'model') {
    if (key === 'custom') {
      wiz.customModel = true;
      renderWizard();
      wizard.querySelector<HTMLInputElement>('#wiz-custom-model')?.focus();
    } else if (key.startsWith('use:')) {
      wiz.model = key.slice(4);
      wiz.customModel = false;
      goNext();
    } else {
      wiz.model = key.slice(2);
      wiz.customModel = false;
      goNext();
    }
  }
}

/** Re-render the footer alone (e.g. the next button appearing/disappearing). */
function refreshFooter(): void {
  const footer = wizard.querySelector<HTMLElement>('.wiz-footer');
  if (!footer) return;
  footer.innerHTML = footerHtml();
  footer.querySelector('#wiz-back')?.addEventListener('click', goBack);
}

function wireCustomModel(): void {
  const customInput = wizard.querySelector<HTMLInputElement>('#wiz-custom-model');
  if (!customInput) return;
  const next = wizard.querySelector<HTMLButtonElement>('#wiz-next');
  if (!next) return;
  const sync = () => {
    wiz.model = customInput.value.trim() || null;
    next.disabled = !wiz.model;
  };
  customInput.addEventListener('input', sync);
  customInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && wiz.model) goNext();
  });
  sync();
  next.addEventListener('click', goNext);
}

function wireWizard(): void {
  wizard.querySelector('#wiz-close')?.addEventListener('click', closeWizard);
  wizard.querySelector('#wiz-back')?.addEventListener('click', goBack);

  wireChoices(wizard);

  const searchInput = wizard.querySelector<HTMLInputElement>('#wiz-model-search');
  if (searchInput) {
    ensureCatalog();
    searchInput.addEventListener('input', () => {
      modelQuery = searchInput.value;
      if (wiz.customModel) {
        // Searching replaces the free-text path; the footer loses its next button.
        wiz.customModel = false;
        refreshFooter();
      }
      if (wiz.provider === OLLAMA.id) searchLibrary(modelQuery.trim());
      refreshModelLists();
    });
  }

  const netInput = wizard.querySelector<HTMLInputElement>('#wiz-net-url');
  if (netInput) {
    const next = wizard.querySelector<HTMLButtonElement>('#wiz-next')!;
    const sync = () => {
      wiz.networkUrl = netInput.value;
      next.disabled = wiz.busy || !normalizeOllamaAddress(netInput.value);
    };
    // Reach the server through the manager (no CORS) and grab its installed
    // models on the way — the model step offers them like local tags.
    const advance = async () => {
      const base = normalizeOllamaAddress(netInput.value);
      if (wiz.busy || !base) return;
      wiz.networkUrl = base;
      wiz.busy = true;
      wiz.error = null;
      next.disabled = true;
      next.textContent = t('wiz.net.checking');
      try {
        const r = await api<{ models?: Array<{ name: string }> }>(`/ollama/tags?url=${encodeURIComponent(wiz.networkUrl)}`);
        ollamaTags = (r.models ?? []).map((m) => m.name);
        wiz.busy = false;
        goNext();
      } catch {
        wiz.busy = false;
        wiz.error = t('wiz.net.fail');
        renderWizard();
      }
    };
    netInput.addEventListener('input', sync);
    netInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void advance();
    });
    sync();
    netInput.focus();
    next.addEventListener('click', () => void advance());
  }

  const keyInput = wizard.querySelector<HTMLInputElement>('#wiz-key');
  if (keyInput) {
    const next = wizard.querySelector<HTMLButtonElement>('#wiz-next')!;
    const sync = () => {
      wiz.apiKey = keyInput.value.trim();
      next.disabled = !wiz.apiKey;
    };
    keyInput.addEventListener('input', sync);
    keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && wiz.apiKey) goNext();
    });
    sync();
    keyInput.focus();
    next.addEventListener('click', goNext);
  }

  wireCustomModel();

  const goalInput = wizard.querySelector<HTMLTextAreaElement>('#wiz-goal');
  if (goalInput) {
    const createBtn = wizard.querySelector<HTMLButtonElement>('#wiz-create')!;
    // Absent when Docker is unavailable (adopt is forced, not a checkbox).
    const adopt = wizard.querySelector<HTMLInputElement>('#wiz-adopt');
    const heartbeat = wizard.querySelector<HTMLInputElement>('#wiz-heartbeat')!;
    const sync = () => {
      wiz.goal = goalInput.value.trim();
      createBtn.disabled = !wiz.goal || wiz.busy || pkgSecretsMissing();
    };
    goalInput.addEventListener('input', sync);
    // Starter packages: toggling re-renders (secret inputs fold in and out);
    // typing a secret only updates state, so focus stays in the field.
    wizard.querySelectorAll<HTMLInputElement>('input[data-pkg]').forEach((box) => {
      box.addEventListener('change', () => {
        const id = box.dataset.pkg!;
        wiz.packages = box.checked ? [...wiz.packages, id] : wiz.packages.filter((p) => p !== id);
        renderWizard();
      });
    });
    wizard.querySelectorAll<HTMLInputElement>('input[data-pkg-secret]').forEach((input) => {
      input.addEventListener('input', () => {
        wiz.pkgSecrets[input.dataset.pkgSecret!] = input.value;
        sync();
      });
    });
    adopt?.addEventListener('change', () => {
      wiz.adopt = adopt.checked;
      wizard.querySelector('.wiz-existing')?.classList.toggle('hidden', !wiz.adopt);
      if (wiz.adopt) loadExistingModels();
    });
    wizard.querySelector<HTMLSelectElement>('#wiz-existing')?.addEventListener('change', (e) => {
      wiz.existingId = (e.target as HTMLSelectElement).value;
    });
    heartbeat.addEventListener('change', () => {
      wiz.heartbeat = heartbeat.checked;
      wizard.querySelector('.cron')?.classList.toggle('hidden', !wiz.heartbeat);
    });
    wizard.querySelector<HTMLInputElement>('#wiz-cron')?.addEventListener('input', (e) => {
      wiz.cron = (e.target as HTMLInputElement).value.trim();
    });
    wizard.querySelector<HTMLInputElement>('#wiz-wake')?.addEventListener('change', (e) => {
      wiz.wake = (e.target as HTMLInputElement).checked;
    });
    createBtn.addEventListener('click', () => void createBrain());
    sync();
    goalInput.focus();
  }
}

async function createBrain(): Promise<void> {
  const model =
    wiz.adopt && wiz.existingId
      ? { mode: 'existing' as const, id: wiz.existingId }
      : wiz.where === 'remote'
        ? { mode: 'byok' as const, provider: wiz.provider!, model: wiz.model!, apiKey: wiz.apiKey }
        : { mode: 'ollama' as const, tag: wiz.model!, baseUrl: wiz.where === 'network' ? wiz.networkUrl : undefined };

  // Selected starter packages, each with just its own declared secrets.
  const packages = wiz.packages.length
    ? wiz.packages.map((id) => {
        const decls = packageCatalog?.find((p) => p.id === id)?.secrets ?? [];
        const secrets = Object.fromEntries(
          decls
            .map((s) => [s.key, wiz.pkgSecrets[`${id}/${s.key}`]?.trim() ?? ''] as const)
            .filter(([, v]) => v),
        );
        return { id, secrets };
      })
    : undefined;

  const body = {
    // No name — the manager generates a friendly one.
    lifeGoal: wiz.goal,
    model,
    adoptUrl: wiz.adopt ? 'default' : undefined,
    heartbeat: wiz.heartbeat,
    heartbeatCron: wiz.cron || undefined,
    wake: wiz.wake,
    packages,
  };

  wiz.busy = true;
  wiz.error = null;
  const createBtn = wizard.querySelector<HTMLButtonElement>('#wiz-create');
  if (createBtn) {
    createBtn.disabled = true;
    createBtn.textContent = t('wiz.creating');
  }
  try {
    await api('/brains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    closeWizard();
    void refresh();
  } catch (err) {
    wiz.busy = false;
    wiz.error = (err as Error).message;
    renderWizard();
  }
}

overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeWizard();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && wizOpen) closeWizard();
});

// ---------------------------------------------------------------------------
// Language picker
// ---------------------------------------------------------------------------

const langSelect = $<HTMLSelectElement>('lang-select');
langSelect.innerHTML = LANGS.map((l) => `<option value="${l.id}"${l.id === getLang() ? ' selected' : ''}>${l.label}</option>`).join('');
langSelect.addEventListener('change', () => setLang(langSelect.value as Lang));

onLangChange(() => {
  applyI18n(document);
  renderAdoptBanner();
  const active = brains.find((b) => b.id === activeBrainId);
  if (active) renderCard(active);
  if (wizOpen) renderWizard();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.documentElement.lang = getLang();
applyI18n(document);
layoutSizes();
if (reducedMotion) positionNodes();
else requestAnimationFrame(orbitLoop);
void refresh();
setInterval(() => void refresh(), 10_000);

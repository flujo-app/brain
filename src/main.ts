import './style.css';
import { fetchBrain, flujoBase, watchBrain } from './data/loader';
import { ExecutionWatcher, type BrainActivityEvent } from './data/execution';
import { Brain } from './scene/brain';
import { Brain2D } from './scene2d/brain2d';
import { Hud, type ViewMode } from './ui/hud';
import { AiDock } from './ui/aichat';
import type { BrainGraph } from './types';

const VIEW_KEY = 'brain-view';

function setBadge(text: string, connected: boolean) {
  const badge = document.getElementById('source-badge');
  if (!badge) return;
  badge.textContent = text;
  badge.classList.toggle('snapshot', !connected);
}

/**
 * The FLUJO editor as the BROWSER reaches it, for the badge link: a direct
 * base (adopted/override) is its own editor; proxy bases are translated by
 * the manager (per-brain editor port, or the default instance's public URL).
 */
async function editorUrl(base: string | null): Promise<string | null> {
  if (!base) return null;
  if (/^https?:\/\//i.test(base)) return base;
  try {
    const perBrain = base.match(/^\/brains\/([^/]+)\/flujo\/?$/);
    if (perBrain) {
      const r = await fetch(`/api/brains/${perBrain[1]}`);
      return r.ok ? ((await r.json()) as { editorUrl?: string }).editorUrl ?? null : null;
    }
    if (base === '/flujo') {
      const r = await fetch('/api/brains');
      if (r.ok) return ((await r.json()) as { defaultFlujoEditor?: string }).defaultFlujoEditor ?? null;
      return 'http://localhost:4200'; // vite dev proxy without a manager
    }
  } catch {
    // No manager to ask — leave the badge unlinked.
  }
  return null;
}

/** Once connected, make the badge a link to the instance's own editor. */
let editorLinked = false;
function linkBadgeToEditor(): void {
  if (editorLinked) return;
  editorLinked = true;
  void editorUrl(flujoBase()).then((url) => {
    const badge = document.getElementById('source-badge') as HTMLAnchorElement | null;
    if (!badge || !url) return;
    badge.href = url;
    badge.target = '_blank';
    badge.rel = 'noopener';
    badge.title = 'open the FLUJO editor';
  });
}

function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas');
    return !!(probe.getContext('webgl2') ?? probe.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Saved choice wins; otherwise weak/GL-less hardware starts in the 2D view. */
function initialMode(): ViewMode {
  const saved = localStorage.getItem(VIEW_KEY);
  if (saved === '2d' || saved === '3d') return saved;
  if (!webglAvailable()) return '2d';
  if ((navigator.hardwareConcurrency ?? 8) <= 4) return '2d';
  return '3d';
}

/**
 * A canvas that has held a WebGL context can never hand out a 2D one (and
 * vice versa), so every renderer switch starts from a fresh element.
 */
function freshCanvas(): HTMLCanvasElement {
  const old = document.getElementById('scene') as HTMLCanvasElement;
  const next = document.createElement('canvas');
  next.id = 'scene';
  old.replaceWith(next);
  return next;
}

async function boot() {
  const hud = new Hud();
  const aiDock = new AiDock();
  let mode = initialMode();
  let brain: Brain | Brain2D | null = null;
  let graph: BrainGraph | null = null;
  let hash: string | null = null;

  hud.setViewMode(mode);

  const createRenderer = () => {
    if (!graph) return;
    brain?.dispose();
    const canvas = freshCanvas();
    brain = mode === '2d' ? new Brain2D(canvas, graph, hud) : new Brain(canvas, graph, hud);
  };

  // The view toggle swaps whole renderers: real WebGL vs. real Canvas 2D.
  // (Renderers wire the rest of the HUD themselves; this callback is ours.)
  hud.onViewMode = (m) => {
    if (m === mode) return;
    mode = m;
    localStorage.setItem(VIEW_KEY, m);
    createRenderer();
  };

  const apply = (data: { graph: BrainGraph; hash: string }) => {
    hash = data.hash;
    graph = data.graph;
    if (graph.neurons.length) {
      if (brain) brain.setGraph(graph);
      else createRenderer();
      setBadge('● live from FLUJO', true);
    } else {
      // Reachable but empty (fresh instance) — distinct from unreachable.
      setBadge('● FLUJO connected — no flows yet', true);
    }
    linkBadgeToEditor();
    aiDock.setGraph(graph);
  };

  const first = await fetchBrain();
  if (first) apply(first);
  else setBadge('○ waiting for FLUJO…', false);

  // Keep polling: first contact boots the brain, later changes rebuild it.
  // Everything lives in memory only — a reload starts from scratch.
  watchBrain(
    () => hash,
    (data) => apply(data),
  );

  // Live execution: watch running conversations and feed events to the scene.
  new ExecutionWatcher((e) => brain?.handleExecution(e)).start();

  // If a brain-manager is serving us, offer the lobby.
  fetch('/api/health')
    .then((r) => {
      if (r.ok) document.getElementById('lobby-link')?.classList.remove('hidden');
    })
    .catch(() => undefined);

  // Dev hook: simulate execution events from the console without spending
  // real model tokens, e.g. __brainSim({kind:'run-start', conversationId:'x', flowId:'<id>'}).
  (window as unknown as { __brainSim?: (e: BrainActivityEvent) => void }).__brainSim = (e) =>
    brain?.handleExecution(e);
}

boot();

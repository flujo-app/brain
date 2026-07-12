/**
 * Chat bubbles: the brain's spoken output, floating over the neuron that said
 * it. Each bubble fades in, drifts gently upward while it lingers (longer for
 * longer texts), then fades away. Both renderers drive the layer once per
 * frame with a projection callback, so bubbles stay glued to their behaviour
 * while the camera moves.
 */

const FADE_IN_MS = 250;
const FADE_OUT_MS = 1400;
const MAX_BUBBLES = 8;
const MAX_CHARS = 220;

export interface BubbleAnchor {
  x: number;
  y: number;
}

interface Bubble {
  el: HTMLDivElement;
  flowId: string | null;
  born: number;
  ttl: number;
}

export class ChatBubbleLayer {
  private container: HTMLDivElement;
  private bubbles: Bubble[] = [];

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'bubble-layer';
    document.body.appendChild(this.container);
  }

  /** Show a new bubble above the given behaviour (null = no known neuron). */
  push(flowId: string | null, flowName: string, text: string): void {
    const short = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS - 1).trimEnd() + '…' : text;

    const el = document.createElement('div');
    el.className = 'chat-bubble';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = flowName;
    const body = document.createElement('div');
    body.className = 'text';
    body.textContent = short;
    el.append(who, body);
    this.container.appendChild(el);

    // Reading time scales with length; the fade-out rides on top.
    const ttl = Math.min(14_000, 3_500 + short.length * 45) + FADE_OUT_MS;
    this.bubbles.push({ el, flowId, born: performance.now(), ttl });

    while (this.bubbles.length > MAX_BUBBLES) this.bubbles.shift()!.el.remove();
  }

  /**
   * Reposition and age all bubbles. `project` maps a behaviour to its screen
   * anchor (null = unknown or behind the camera). Bubbles on the same
   * behaviour stack upward, newest closest to the neuron.
   */
  update(project: (flowId: string) => BubbleAnchor | null): void {
    const now = performance.now();
    const stack = new Map<string, number>();

    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      const age = now - b.born;
      if (age > b.ttl) {
        b.el.remove();
        this.bubbles.splice(i, 1);
        continue;
      }

      // Behaviours the graph doesn't know anchor above the activity strip.
      const anchor = b.flowId
        ? project(b.flowId)
        : { x: window.innerWidth / 2, y: window.innerHeight * 0.82 };
      if (!anchor) {
        b.el.style.opacity = '0';
        continue;
      }

      const key = b.flowId ?? '·';
      const offset = stack.get(key) ?? 0;
      stack.set(key, offset + b.el.offsetHeight + 8);

      const fadeIn = Math.min(1, age / FADE_IN_MS);
      const fadeOut = Math.min(1, (b.ttl - age) / FADE_OUT_MS);
      const drift = (age / 1000) * 4; // the slow float upward as it fades
      b.el.style.opacity = String(Math.min(fadeIn, fadeOut));
      b.el.style.transform =
        `translate(-50%, -100%) translate(${anchor.x}px, ${anchor.y - 14 - offset - drift}px)`;
    }
  }

  dispose(): void {
    this.container.remove();
    this.bubbles = [];
  }
}

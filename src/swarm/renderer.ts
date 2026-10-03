import { BufferGeometry, Color, Float32BufferAttribute, LineBasicMaterial, LineSegments, PerspectiveCamera, Points, Scene, ShaderMaterial, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Node, Point } from './model';

const hues = ['#7fd1de', '#9bb8e8', '#c2a7e8', '#e8a7b8', '#e8c98a', '#8fd9b6'];
const sourceHue = (id: string) => hues[[...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0) % hues.length]!;
const tint = (node: Node): string => node.source.status !== 'observed' ? '#7d8798' : node.activity === 'uncertain' ? '#e0a85c' : node.cell?.status === 'retired' ? '#7d8798' : sourceHue(node.source.id);
const vertexShader = `attribute float aSize; attribute float aActive; attribute float aFill; varying vec3 vColor; varying float vActive; varying float vFill; uniform float uTime;
void main(){vColor=color; vActive=aActive; vFill=aFill; vec4 p=modelViewMatrix*vec4(position,1.); float pulse=1.+aActive*.08*sin(uTime*2.); gl_PointSize=clamp(aSize*pulse*180./max(1.,-p.z),7.,56.); gl_Position=projectionMatrix*p;}`;
const fragmentShader = `varying vec3 vColor; varying float vActive; varying float vFill;
void main(){float d=length(gl_PointCoord-.5)*2.; if(d>1.)discard; float ring=smoothstep(.7,.8,d)*(1.-smoothstep(.86,1.,d)); float core=(1.-smoothstep(.2,.54,d))*vFill; float glow=exp(-d*d*5.)*.12*vFill; gl_FragColor=vec4(mix(vColor,vec3(.92,.98,1.),core*.6),ring*.8+core*.7+glow);}`;

/** Two semantic draw batches, bounded labels, no postprocessing or idle orbit.
 * Rendering is demand-driven; evidenced activity pulses at no more than 30fps. */
export class SwarmRenderer {
  private gl: WebGLRenderer | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private scene = new Scene();
  private camera = new PerspectiveCamera(50, 1, .1, 20000);
  private controls: OrbitControls | null = null;
  private points: Points<BufferGeometry, ShaderMaterial> | null = null;
  private lines: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;
  private nodes: Node[] = [];
  private selected: string | null = null;
  private frameId = 0;
  private active = false;
  private lastFrame = 0;
  private width = 1;
  private height = 1;
  private zoom = 1;
  private pan = { x: 0, y: 0 };
  private projected = new Map<string, { x: number; y: number; size: number }>();
  private drag: { x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;
  private observer: ResizeObserver;
  private disposeInput: () => void;
  private disposed = false;
  private labelElements: HTMLSpanElement[] = [];
  private submissions = 0;
  private lastSubmissionMs = 0;
  private flight: { start: number; fromPosition: Vector3; fromTarget: Vector3; toPosition: Vector3; toTarget: Vector3 } | null = null;
  readonly mode: '3d' | '2d';
  onPick: (node: Node) => void = () => undefined;
  onStats: (stats: { mode: string; visible: number; labels: number; draws: number; submissions: number; cpuMs: number }) => void = () => undefined;

  constructor(private canvas: HTMLCanvasElement, private labels: HTMLElement, requested: '3d' | '2d') {
    if (requested === '3d') {
      try {
        this.gl = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power', alpha: true });
        this.gl.setPixelRatio(Math.min(devicePixelRatio || 1, 1.25));
        this.gl.setClearColor(0x081216, 0);
        this.camera.position.set(40, 120, 180);
        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = false;
        this.controls.enablePan = true;
        this.controls.minDistance = 8;
        this.controls.maxDistance = 10000;
        this.controls.addEventListener('change', this.request);
        canvas.addEventListener('webglcontextlost', this.contextLost);
      } catch { this.gl = null; }
    }
    if (!this.gl) {
      // A failed GL creation may still bind its context; replace the canvas.
      const replacement = canvas.cloneNode(false) as HTMLCanvasElement;
      canvas.replaceWith(replacement); this.canvas = replacement;
      this.ctx = replacement.getContext('2d');
      if (!this.ctx) throw new Error('No canvas renderer is available.');
    }
    this.mode = this.gl ? '3d' : '2d';
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(this.canvas.parentElement!);
    document.addEventListener('visibilitychange', this.visibility);
    this.disposeInput = this.wireInput();
    this.resize();
  }
  private contextLost = (event: Event) => { event.preventDefault(); this.active = false; this.canvas.dispatchEvent(new CustomEvent('swarm-renderer-lost', { bubbles: true })); };
  private visibility = () => { if (document.hidden) { cancelAnimationFrame(this.frameId); this.frameId = 0; } else this.request(); };
  private resize = () => {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.width = Math.max(1, rect.width); this.height = Math.max(1, rect.height);
    if (this.gl) { this.gl.setSize(this.width, this.height, false); this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix(); }
    else { const ratio = Math.min(devicePixelRatio || 1, 1.25); this.canvas.width = this.width * ratio; this.canvas.height = this.height * ratio; this.ctx!.setTransform(ratio, 0, 0, ratio, 0, 0); }
    this.request();
  };
  setNodes(nodes: Node[], selected: string | null): void {
    this.nodes = nodes; this.selected = selected;
    this.active = !matchMedia('(prefers-reduced-motion: reduce)').matches && nodes.some(node => node.activity === 'recent');
    if (this.gl) {
      const pos: number[] = [], colors: number[] = [], sizes: number[] = [], active: number[] = [], fill: number[] = [], linkPos: number[] = [], linkColors: number[] = [];
      const byKey = new Map(nodes.map(node => [node.key, node]));
      // Static engraved source plates share the delegation line batch. They
      // are reference rings, not edges or activity. No cross-authority lines.
      for (const source of nodes.filter(node => !node.cell)) {
        const color = new Color(sourceHue(source.source.id));
        for (const radius of [26, 49, 72]) for (let i = 0; i < 64; i++) for (const t of [i / 64, (i + 1) / 64]) {
          const angle = t * Math.PI * 2;
          linkPos.push(source.point.x + Math.cos(angle) * radius, 0, source.point.z + Math.sin(angle) * radius);
          linkColors.push(color.r * .07, color.g * .07, color.b * .07);
        }
      }
      for (const node of nodes) {
        pos.push(node.point.x, node.point.y, node.point.z);
        const color = new Color(node.key === selected ? '#e1fff5' : tint(node)); colors.push(color.r, color.g, color.b);
        sizes.push(!node.cell ? 18 : node.key === selected ? 17 : node.cell.role === 'coordinator' ? 13 : 9); active.push(node.activity === 'recent' ? 1 : 0);
        fill.push(node.source.status === 'observed' && node.cell?.status !== 'retired' && node.cell?.status !== 'reserved' && node.activity !== 'uncertain' ? 1 : 0);
        const parent = node.parent ? byKey.get(node.parent) : undefined;
        if (parent?.cell && node.cell?.parentId) {
          // Short curved delegation links, one shared line batch.
          for (let i = 0; i < 8; i++) {
            for (const t of [i / 8, (i + 1) / 8]) {
              linkPos.push(parent.point.x + (node.point.x - parent.point.x) * t, parent.point.y + (node.point.y - parent.point.y) * t + Math.sin(t * Math.PI) * 3, parent.point.z + (node.point.z - parent.point.z) * t);
              const intensity = node.key === selected || parent.key === selected ? .65 : .2; linkColors.push(color.r * intensity, color.g * intensity, color.b * intensity);
            }
          }
        }
      }
      const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(pos, 3)); geometry.setAttribute('color', new Float32BufferAttribute(colors, 3)); geometry.setAttribute('aSize', new Float32BufferAttribute(sizes, 1)); geometry.setAttribute('aActive', new Float32BufferAttribute(active, 1)); geometry.setAttribute('aFill', new Float32BufferAttribute(fill, 1));
      if (this.points) { this.points.geometry.dispose(); this.points.geometry = geometry; }
      else { this.points = new Points(geometry, new ShaderMaterial({ vertexShader, fragmentShader, vertexColors: true, transparent: true, depthWrite: false, uniforms: { uTime: { value: 0 } } })); this.scene.add(this.points); }
      const links = new BufferGeometry(); links.setAttribute('position', new Float32BufferAttribute(linkPos, 3)); links.setAttribute('color', new Float32BufferAttribute(linkColors, 3));
      if (this.lines) { this.lines.geometry.dispose(); this.lines.geometry = links; }
      else { this.lines = new LineSegments(links, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .9, depthWrite: false })); this.scene.add(this.lines); }
    }
    const priority = nodes.filter(node => node.key === selected).concat(nodes.filter(node => !node.cell || node.cell.role === 'coordinator'), nodes.filter(node => node.cell && node.cell.role !== 'coordinator').sort((a, b) => a.cell!.depth - b.cell!.depth));
    const labelled = [...new Map(priority.map(node => [node.key, node])).values()].slice(0, 24);
    this.labels.replaceChildren(); this.labelElements = [];
    for (const node of labelled) { const span = document.createElement('span'); span.className = `swarm-label${!node.cell ? ' source-label' : ''}${node.key === selected ? ' selected' : ''}`; span.textContent = node.label.length > 24 ? `${node.label.slice(0, 22)}…` : node.label; span.title = `${node.source.factoryId} / ${node.label}`; span.dataset.key = node.key; this.labels.append(span); this.labelElements.push(span); }
    this.request();
  }
  frame(point?: Point, sourceId?: string): void {
    const nodes = sourceId ? this.nodes.filter(node => node.source.id === sourceId) : this.nodes;
    const center = point ?? nodes.reduce((sum, node) => ({ x: sum.x + node.point.x / Math.max(1, nodes.length), y: sum.y + node.point.y / Math.max(1, nodes.length), z: sum.z + node.point.z / Math.max(1, nodes.length) }), { x: 0, y: 0, z: 0 });
    const radius = point ? 35 : Math.max(sourceId ? 78 : 40, ...nodes.map(node => Math.hypot(node.point.x - center.x, node.point.z - center.z)));
    if (this.gl) {
      const distance = radius * (this.width < this.height ? 3.8 : sourceId ? 2.5 : 1.8);
      const target = new Vector3(center.x, center.y, center.z), position = new Vector3(center.x + distance * .16, center.y + distance * .65, center.z + distance);
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.controls!.target.copy(target); this.camera.position.copy(position); this.controls!.update(); }
      else this.flight = { start: performance.now(), fromPosition: this.camera.position.clone(), fromTarget: this.controls!.target.clone(), toPosition: position, toTarget: target };
    } else { this.zoom = Math.min(this.width, this.height) / (radius * 2.8); this.pan = { x: -center.x * this.zoom, y: -center.z * this.zoom }; }
    this.request();
  }
  request = (): void => { if (!this.disposed && !document.hidden && !this.frameId) this.frameId = requestAnimationFrame(this.draw); };
  private project = (point: Point): { x: number; y: number; size: number } => {
    if (!this.gl) return { x: this.width / 2 + point.x * this.zoom + this.pan.x, y: this.height / 2 + point.z * this.zoom + this.pan.y, size: 10 };
    const vector = new Vector3(point.x, point.y, point.z).project(this.camera);
    return { x: (vector.x + 1) * this.width / 2, y: (1 - vector.y) * this.height / 2, size: vector.z >= 1 || vector.z < -1 ? 0 : 12 };
  };
  private draw = (time: number): void => {
    this.frameId = 0;
    if (this.disposed || document.hidden) return;
    if ((this.active || this.flight) && time - this.lastFrame < 33) { this.request(); return; }
    this.lastFrame = time; const start = performance.now(); this.projected.clear();
    if (this.flight) {
      const progress = Math.min(1, (time - this.flight.start) / 620), eased = 1 - (1 - progress) ** 3;
      this.camera.position.lerpVectors(this.flight.fromPosition, this.flight.toPosition, eased); this.controls!.target.lerpVectors(this.flight.fromTarget, this.flight.toTarget, eased); this.controls!.update();
      if (progress >= 1) this.flight = null;
    }
    for (const node of this.nodes) this.projected.set(node.key, this.project(node.point));
    if (this.gl) { if (this.points) this.points.material.uniforms.uTime!.value = time / 1000; this.gl.render(this.scene, this.camera); }
    else {
      const context = this.ctx!; context.clearRect(0, 0, this.width, this.height);
      for (const source of this.nodes.filter(node => !node.cell)) { const point = this.projected.get(source.key)!; context.strokeStyle = `${sourceHue(source.source.id)}18`; context.lineWidth = 1; for (const radius of [26, 49, 72]) { context.beginPath(); context.arc(point.x, point.y, radius * this.zoom, 0, Math.PI * 2); context.stroke(); } }
      for (const node of this.nodes) {
        const parent = node.parent && this.projected.get(node.parent), point = this.projected.get(node.key)!;
        if (!parent || !node.cell?.parentId) continue;
        context.beginPath(); context.moveTo(parent.x, parent.y); context.quadraticCurveTo((parent.x + point.x) / 2 + 7, (parent.y + point.y) / 2 - 12, point.x, point.y); context.strokeStyle = node.key === this.selected ? '#7cdcbda0' : '#739c9e36'; context.lineWidth = 1; context.stroke();
      }
      for (const node of this.nodes) {
        const point = this.projected.get(node.key)!, radius = !node.cell ? 13 : node.key === this.selected ? 10 : node.cell.role === 'coordinator' ? 9 : 5;
        const gradient = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius * 3); gradient.addColorStop(0, `${tint(node)}d0`); gradient.addColorStop(.3, `${tint(node)}60`); gradient.addColorStop(1, `${tint(node)}00`);
        context.fillStyle = gradient; context.beginPath(); context.arc(point.x, point.y, radius * 3, 0, Math.PI * 2); context.fill();
        context.strokeStyle = tint(node); context.beginPath(); context.arc(point.x, point.y, radius * .75, 0, Math.PI * 2); context.stroke();
        if (node.source.status === 'observed' && node.cell?.status !== 'retired' && node.activity !== 'uncertain') { context.fillStyle = tint(node); context.beginPath(); context.arc(point.x, point.y, radius * .35, 0, Math.PI * 2); context.fill(); }
        if (node.key === this.selected) { context.strokeStyle = '#c6ffec'; context.beginPath(); context.arc(point.x, point.y, radius + 4, 0, Math.PI * 2); context.stroke(); }
      }
    }
    const occupied = new Set<string>();
    for (const label of this.labelElements) {
      const point = this.projected.get(label.dataset.key!); label.hidden = !point?.size || point.x < 0 || point.x > this.width || point.y < 0 || point.y > this.height;
      if (point && point.y > this.height - 145) label.hidden = true;
      if (point && !label.hidden) { const slot = `${Math.floor(point.x / 110)}:${Math.floor(point.y / 26)}`; if (occupied.has(slot)) label.hidden = true; else occupied.add(slot); }
      if (point) label.style.transform = `translate(${point.x}px,${point.y + 17}px) translateX(-50%)`;
    }
    this.submissions++; this.lastSubmissionMs = performance.now() - start;
    this.onStats({ mode: this.mode, visible: this.nodes.length, labels: this.labelElements.length, draws: this.gl?.info.render.calls ?? 0, submissions: this.submissions, cpuMs: this.lastSubmissionMs });
    if (this.active || this.flight) this.request();
  };
  private wireInput(): () => void {
    const down = (event: PointerEvent) => { this.flight = null; this.drag = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false }; if (!this.gl) this.canvas.setPointerCapture(event.pointerId); };
    const move = (event: PointerEvent) => {
      if (!this.drag) return; if (Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY) > 5) this.drag.moved = true;
      if (!this.gl) { this.pan.x += event.clientX - this.drag.x; this.pan.y += event.clientY - this.drag.y; this.request(); }
      this.drag.x = event.clientX; this.drag.y = event.clientY;
    };
    const up = (event: PointerEvent) => {
      if (this.drag && !this.drag.moved) {
        const rect = this.canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
        let best: Node | null = null, distance = 20;
        for (const node of this.nodes) { const point = this.projected.get(node.key); if (!point?.size) continue; const next = Math.hypot(point.x - x, point.y - y); if (next < distance) { distance = next; best = node; } }
        if (best) this.onPick(best);
      }
      this.drag = null;
    };
    const wheel = (event: WheelEvent) => { if (this.gl) return; event.preventDefault(); const multiplier = Math.exp(-event.deltaY * .001); this.zoom = Math.max(.01, Math.min(30, this.zoom * multiplier)); this.pan.x *= multiplier; this.pan.y *= multiplier; this.request(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Home') { event.preventDefault(); this.frame(); } };
    this.canvas.addEventListener('pointerdown', down); this.canvas.addEventListener('pointermove', move); window.addEventListener('pointerup', up); this.canvas.addEventListener('wheel', wheel, { passive: false }); this.canvas.addEventListener('keydown', key);
    return () => { this.canvas.removeEventListener('pointerdown', down); this.canvas.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); this.canvas.removeEventListener('wheel', wheel); this.canvas.removeEventListener('keydown', key); };
  }
  dispose(): void {
    this.disposed = true; cancelAnimationFrame(this.frameId); this.observer.disconnect(); this.disposeInput(); document.removeEventListener('visibilitychange', this.visibility);
    this.canvas.removeEventListener('webglcontextlost', this.contextLost); this.controls?.removeEventListener('change', this.request); this.controls?.dispose();
    this.points?.geometry.dispose(); this.points?.material.dispose(); this.lines?.geometry.dispose(); this.lines?.material.dispose(); this.gl?.dispose(); this.labels.replaceChildren();
  }
}

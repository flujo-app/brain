import { BufferGeometry, Color, Float32BufferAttribute, LineBasicMaterial, LineSegments, PerspectiveCamera, Points, Scene, ShaderMaterial, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Node, Point } from './model';

/** Deterministic authority palette. The navigation indicators read the same
 * function, so a plate in the field and its index entry cannot disagree. */
const hues = ['#7fd1de', '#9bb8e8', '#c2a7e8', '#e8a7b8', '#e8c98a', '#8fd9b6'];
export const sourceHue = (id: string) => hues[[...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0) % hues.length]!;
/** Shared with the atlas rail; identical input gives an identical colour. */
export const sourceColor = sourceHue;
export const uncertainHue = '#e0a85c';
export const retiredHue = '#7d8798';
const tint = (node: Node): string => node.source.status !== 'observed' ? retiredHue : node.activity === 'uncertain' ? uncertainHue : node.cell?.status === 'retired' ? retiredHue : sourceHue(node.source.id);

/** One batched point program: engraved plates, cell rings, cores and haloes.
 * Depth attenuation keeps a deep field legible without a second pass. */
const vertexShader = `attribute float aSize; attribute float aActive; attribute float aFill; attribute float aPlate; attribute float aSelected;
varying vec3 vColor; varying float vActive; varying float vFill; varying float vPlate; varying float vSelected; varying float vFade; uniform float uTime;
void main(){
  vColor=color; vActive=aActive; vFill=aFill; vPlate=aPlate; vSelected=aSelected;
  vec4 p=modelViewMatrix*vec4(position,1.);
  float depth=max(1.,-p.z);
  vFade=clamp(1.25-depth/5200.,.34,1.);
  float breath=1.+aActive*.09*sin(uTime*2.+position.x*.12);
  gl_PointSize=clamp(aSize*breath*(1.+aSelected*.26)*200./depth,7.,78.);
  gl_Position=projectionMatrix*p;
}`;
const fragmentShader = `varying vec3 vColor; varying float vActive; varying float vFill; varying float vPlate; varying float vSelected; varying float vFade;
void main(){
  vec2 uv=gl_PointCoord-.5; float d=length(uv)*2.;
  if(d>1.)discard;
  float core=(1.-smoothstep(.0,.40,d))*vFill;
  float ring=smoothstep(.49,.58,d)*(1.-smoothstep(.70,.80,d));
  float plate=vPlate*smoothstep(.86,.91,d)*(1.-smoothstep(.97,1.,d));
  float halo=exp(-d*d*3.6)*(.10+.12*vFill);
  vec2 q=abs(uv)*2.;
  float spike=vSelected*max(exp(-q.x*22.),exp(-q.y*22.))*(1.-smoothstep(.2,1.,d))*.55;
  float select=vSelected*smoothstep(.80,.88,d)*(1.-smoothstep(.95,1.,d));
  vec3 lit=mix(vColor,vec3(.93,.99,1.),clamp(core*.55+spike*.7+select*.8,0.,1.));
  float alpha=(ring*.9+core*.85+halo+plate*.55+spike*.6+select*.95)*vFade;
  gl_FragColor=vec4(lit,clamp(alpha,0.,1.));
}`;

/** Two semantic draw batches, bounded labels, no postprocessing or idle orbit.
 * Rendering is demand-driven; evidenced activity pulses at no more than 30fps. */
export class SwarmRenderer {
  private gl: WebGLRenderer | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private scene = new Scene();
  private camera = new PerspectiveCamera(46, 1, .1, 20000);
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
  private motion = matchMedia('(prefers-reduced-motion: reduce)');
  private labelElements: HTMLSpanElement[] = [];
  private labelSizes = new Map<HTMLSpanElement, { width: number; height: number }>();
  private submissions = 0;
  private lastSubmissionMs = 0;
  private flight: { start: number; fromPosition: Vector3; fromTarget: Vector3; toPosition: Vector3; toTarget: Vector3 } | null = null;
  private lastFit: { point?: Point; sourceId?: string } | null = null;
  readonly mode: '3d' | '2d';
  onPick: (node: Node) => void = () => undefined;
  onStats: (stats: { mode: string; visible: number; labels: number; draws: number; submissions: number; cpuMs: number }) => void = () => undefined;

  constructor(private canvas: HTMLCanvasElement, private labels: HTMLElement, requested: '3d' | '2d') {
    if (requested === '3d') {
      try {
        this.gl = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power', alpha: true });
        this.gl.setPixelRatio(Math.min(devicePixelRatio || 1, 1.25));
        this.gl.setClearColor(0x05070c, 0);
        this.camera.position.set(52, 128, 196);
        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = false;
        this.controls.enablePan = true;
        this.controls.minDistance = 8;
        this.controls.maxDistance = 10000;
        this.controls.maxPolarAngle = Math.PI * .92;
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
    this.motion.addEventListener('change', this.motionChanged);
    this.disposeInput = this.wireInput();
    this.resize();
  }
  private contextLost = (event: Event) => { event.preventDefault(); this.active = false; this.canvas.dispatchEvent(new CustomEvent('swarm-renderer-lost', { bubbles: true })); };
  private visibility = () => { if (document.hidden) { cancelAnimationFrame(this.frameId); this.frameId = 0; } else this.request(); };
  private motionChanged = () => {
    if (this.motion.matches) {
      this.flight = null;
      cancelAnimationFrame(this.frameId); this.frameId = 0;
    }
    this.setNodes(this.nodes, this.selected);
  };
  private resize = () => {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.width = Math.max(1, rect.width); this.height = Math.max(1, rect.height);
    if (this.gl) { this.gl.setSize(this.width, this.height, false); this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix(); }
    else { const ratio = Math.min(devicePixelRatio || 1, 1.25); this.canvas.width = this.width * ratio; this.canvas.height = this.height * ratio; this.ctx!.setTransform(ratio, 0, 0, ratio, 0, 0); }
    this.viewport();
    if (this.lastFit) this.frame(this.lastFit.point, this.lastFit.sourceId);
    this.request();
  };
  /** Fit observations into the area left by visible instruments. The backdrop
   * remains full bleed, while atlas/evidence/caption plates do not hide focus. */
  private viewport(): { x: number; y: number; width: number; height: number } {
    const stage = this.canvas.parentElement!.getBoundingClientRect();
    let left = 20, right = this.width - 20, top = 24, bottom = this.height - 24;
    const overlaps = (rect: DOMRect) => rect.width > 0 && rect.height > 0 && rect.top < stage.bottom && rect.bottom > stage.top;
    const atlas = document.querySelector('.swarm-navigation')?.getBoundingClientRect();
    if (atlas && overlaps(atlas) && atlas.left < stage.left + this.width / 2) left = Math.max(left, atlas.right - stage.left + 20);
    const evidence = document.querySelector('.swarm-inspector')?.getBoundingClientRect();
    if (evidence && overlaps(evidence) && evidence.right > stage.left + this.width / 2) right = Math.min(right, evidence.left - stage.left - 20);
    const toolbar = document.querySelector('.space-toolbar')?.getBoundingClientRect();
    if (toolbar && overlaps(toolbar)) top = Math.max(top, toolbar.bottom - stage.top + 20);
    const caption = document.querySelector('.space-caption')?.getBoundingClientRect();
    if (caption && overlaps(caption)) bottom = Math.min(bottom, caption.top - stage.top - 20);
    const width = Math.max(120, right - left), height = Math.max(120, bottom - top);
    const x = left + width / 2, y = top + height / 2;
    if (this.gl) this.camera.setViewOffset(this.width, this.height, this.width / 2 - x, this.height / 2 - y, this.width, this.height);
    return { x, y, width, height };
  }
  setNodes(nodes: Node[], selected: string | null): void {
    this.nodes = nodes; this.selected = selected;
    this.viewport();
    // The plan view has no animated shader; it only needs observation/input redraws.
    this.active = !!this.gl && !this.motion.matches && nodes.some(node => node.activity === 'recent');
    if (this.gl) {
      const pos: number[] = [], colors: number[] = [], sizes: number[] = [], active: number[] = [], fill: number[] = [], plate: number[] = [], chosen: number[] = [];
      const linkPos: number[] = [], linkColors: number[] = [];
      const byKey = new Map(nodes.map(node => [node.key, node]));
      // Static engraved source plates share the delegation line batch. They are
      // decorative reference rings, not edges, authority or activity, and no
      // cross-authority line is ever emitted.
      for (const source of nodes.filter(node => !node.cell)) {
        const color = new Color(sourceHue(source.source.id)), base = source.point.y;
        const faint = source.source.status !== 'observed' ? .035 : .085;
        for (const [ri, radius] of [30, 56, 84].entries()) {
          const segments = 80, weight = faint * (ri === 1 ? 1.35 : 1);
          for (let i = 0; i < segments; i++) for (const t of [i / segments, (i + 1) / segments]) {
            const angle = t * Math.PI * 2;
            linkPos.push(source.point.x + Math.cos(angle) * radius, base, source.point.z + Math.sin(angle) * radius);
            linkColors.push(color.r * weight, color.g * weight, color.b * weight);
          }
        }
        // Graduated ticks on the outer ring read as an instrument bezel.
        for (let i = 0; i < 24; i++) {
          const angle = i / 24 * Math.PI * 2, inner = i % 6 === 0 ? 78 : 81.5, weight = faint * 1.9;
          linkPos.push(source.point.x + Math.cos(angle) * inner, base, source.point.z + Math.sin(angle) * inner);
          linkColors.push(color.r * weight, color.g * weight, color.b * weight);
          linkPos.push(source.point.x + Math.cos(angle) * 88, base, source.point.z + Math.sin(angle) * 88);
          linkColors.push(color.r * weight * .25, color.g * weight * .25, color.b * weight * .25);
        }
      }
      for (const node of nodes) {
        pos.push(node.point.x, node.point.y, node.point.z);
        const own = new Color(tint(node)), color = new Color(node.key === selected ? '#e6fff8' : tint(node));
        colors.push(color.r, color.g, color.b);
        sizes.push(!node.cell ? 21 : node.key === selected ? 17 : node.cell.role === 'coordinator' ? 13.5 : node.cell.role === 'verifier' ? 10 : 8.5);
        active.push(!this.motion.matches && node.activity === 'recent' ? 1 : 0);
        fill.push(node.source.status === 'observed' && node.cell?.status !== 'retired' && node.cell?.status !== 'reserved' && node.activity !== 'uncertain' ? 1 : 0);
        plate.push(node.cell ? 0 : 1); chosen.push(node.key === selected ? 1 : 0);
        const parent = node.parent ? byKey.get(node.parent) : undefined;
        if (parent?.cell && node.cell?.parentId) {
          // Lifted delegation ribbons fading parent to child, one line batch.
          const from = new Color(tint(parent)), lit = node.key === selected || parent.key === selected;
          for (let i = 0; i < 10; i++) for (const t of [i / 10, (i + 1) / 10]) {
            const arc = Math.sin(t * Math.PI), intensity = (lit ? .72 : .19) * (.45 + .55 * arc);
            linkPos.push(parent.point.x + (node.point.x - parent.point.x) * t, parent.point.y + (node.point.y - parent.point.y) * t + arc * 3.4, parent.point.z + (node.point.z - parent.point.z) * t);
            linkColors.push((from.r + (own.r - from.r) * t) * intensity, (from.g + (own.g - from.g) * t) * intensity, (from.b + (own.b - from.b) * t) * intensity);
          }
        }
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(pos, 3)); geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
      geometry.setAttribute('aSize', new Float32BufferAttribute(sizes, 1)); geometry.setAttribute('aActive', new Float32BufferAttribute(active, 1));
      geometry.setAttribute('aFill', new Float32BufferAttribute(fill, 1)); geometry.setAttribute('aPlate', new Float32BufferAttribute(plate, 1));
      geometry.setAttribute('aSelected', new Float32BufferAttribute(chosen, 1));
      if (this.points) { this.points.geometry.dispose(); this.points.geometry = geometry; }
      else { this.points = new Points(geometry, new ShaderMaterial({ vertexShader, fragmentShader, vertexColors: true, transparent: true, depthWrite: false, uniforms: { uTime: { value: 0 } } })); this.scene.add(this.points); }
      const links = new BufferGeometry(); links.setAttribute('position', new Float32BufferAttribute(linkPos, 3)); links.setAttribute('color', new Float32BufferAttribute(linkColors, 3));
      if (this.lines) { this.lines.geometry.dispose(); this.lines.geometry = links; }
      else { this.lines = new LineSegments(links, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .92, depthWrite: false })); this.scene.add(this.lines); }
    }
    const priority = nodes.filter(node => node.key === selected).concat(nodes.filter(node => !node.cell || node.cell.role === 'coordinator'), nodes.filter(node => node.cell && node.activity === 'recent'), nodes.filter(node => node.cell && node.cell.role !== 'coordinator').sort((a, b) => a.cell!.depth - b.cell!.depth));
    const labelled = [...new Map(priority.map(node => [node.key, node])).values()].slice(0, 24);
    this.labels.replaceChildren(); this.labelElements = [];
    for (const node of labelled) {
      const span = document.createElement('span');
      span.className = `swarm-label${!node.cell ? ' source-label' : ''}${node.key === selected ? ' selected' : ''}${node.activity === 'recent' ? ' active' : ''}`;
      span.textContent = node.label.length > 24 ? `${node.label.slice(0, 22)}…` : node.label;
      span.title = `${node.source.factoryId} / ${node.label}`;
      span.dataset.key = node.key;
      span.style.setProperty('--accent', sourceHue(node.source.id));
      if (!node.cell) { const kicker = document.createElement('i'); kicker.textContent = node.source.status === 'observed' ? 'authority' : node.source.status; span.append(kicker); }
      this.labels.append(span); this.labelElements.push(span);
    }
    // Measure once per observation, rather than reading layout on every frame.
    this.labelSizes = new Map(this.labelElements.map(label => {
      const rect = label.getBoundingClientRect();
      return [label, { width: rect.width, height: rect.height }];
    }));
    this.request();
  }
  frame(point?: Point, sourceId?: string): void {
    this.lastFit = { point, sourceId };
    const viewport = this.viewport();
    const nodes = sourceId ? this.nodes.filter(node => node.source.id === sourceId) : this.nodes;
    const center = point ?? nodes.reduce((sum, node) => ({ x: sum.x + node.point.x / Math.max(1, nodes.length), y: sum.y + node.point.y / Math.max(1, nodes.length), z: sum.z + node.point.z / Math.max(1, nodes.length) }), { x: 0, y: 0, z: 0 });
    const radius = point ? 35 : Math.max(sourceId ? 92 : 48, ...nodes.map(node => Math.hypot(node.point.x - center.x, node.point.z - center.z)));
    if (this.gl) {
      const distance = radius * Math.max((point ? 2.7 : sourceId ? 1.45 : 1.1) * this.height / viewport.height, 2.4 * this.height / viewport.width);
      const target = new Vector3(center.x, center.y + (point ? 0 : 6), center.z);
      const position = new Vector3(center.x + distance * .34, center.y + distance * (point ? .42 : .52), center.z + distance * .86);
      if (this.motion.matches) { this.controls!.target.copy(target); this.camera.position.copy(position); this.controls!.update(); }
      else this.flight = { start: performance.now(), fromPosition: this.camera.position.clone(), fromTarget: this.controls!.target.clone(), toPosition: position, toTarget: target };
    } else { this.zoom = Math.min(viewport.width, viewport.height) / (radius * 2.8); this.pan = { x: viewport.x - this.width / 2 - center.x * this.zoom, y: viewport.y - this.height / 2 - center.z * this.zoom }; }
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
    if ((this.active || this.flight) && time - this.lastFrame < 1000 / 30) { this.request(); return; }
    this.lastFrame = time; const start = performance.now(); this.projected.clear();
    if (this.flight) {
      const progress = Math.min(1, (time - this.flight.start) / 760), eased = 1 - (1 - progress) ** 3;
      this.camera.position.lerpVectors(this.flight.fromPosition, this.flight.toPosition, eased); this.controls!.target.lerpVectors(this.flight.fromTarget, this.flight.toTarget, eased); this.controls!.update();
      if (progress >= 1) this.flight = null;
    }
    for (const node of this.nodes) this.projected.set(node.key, this.project(node.point));
    if (this.gl) { if (this.points) this.points.material.uniforms.uTime!.value = time / 1000; this.gl.render(this.scene, this.camera); }
    else this.paint2d();
    const occupied: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    for (const label of this.labelElements) {
      const point = this.projected.get(label.dataset.key!); label.hidden = !point?.size || point.x < 0 || point.x > this.width || point.y < 0 || point.y > this.height;
      if (point && point.y > this.height - 145) label.hidden = true;
      if (point && !label.hidden) {
        const size = this.labelSizes.get(label)!;
        const rect = { left: point.x - size.width / 2 - 4, right: point.x + size.width / 2 + 4, top: point.y + 16, bottom: point.y + 20 + size.height };
        if (occupied.some(other => rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top)) label.hidden = true;
        else occupied.push(rect);
      }
      if (point) label.style.transform = `translate(${point.x}px,${point.y + 18}px) translateX(-50%)`;
    }
    this.submissions++; this.lastSubmissionMs = performance.now() - start;
    this.onStats({ mode: this.mode, visible: this.nodes.length, labels: this.labelElements.length, draws: this.gl?.info.render.calls ?? 0, submissions: this.submissions, cpuMs: this.lastSubmissionMs });
    if (this.active || this.flight) this.request();
  };
  /** 2D fallback: the same index, the same deterministic colours, plan view. */
  private paint2d(): void {
    const context = this.ctx!;
    context.clearRect(0, 0, this.width, this.height);
    for (const source of this.nodes.filter(node => !node.cell)) {
      const point = this.projected.get(source.key)!, hue = sourceHue(source.source.id);
      context.lineWidth = 1;
      for (const radius of [30, 56, 84]) { context.strokeStyle = `${hue}${radius === 56 ? '22' : '16'}`; context.beginPath(); context.arc(point.x, point.y, radius * this.zoom, 0, Math.PI * 2); context.stroke(); }
      context.strokeStyle = `${hue}2c`;
      for (let i = 0; i < 24; i++) {
        const angle = i / 24 * Math.PI * 2, inner = (i % 6 === 0 ? 78 : 81.5) * this.zoom, outer = 88 * this.zoom;
        context.beginPath(); context.moveTo(point.x + Math.cos(angle) * inner, point.y + Math.sin(angle) * inner); context.lineTo(point.x + Math.cos(angle) * outer, point.y + Math.sin(angle) * outer); context.stroke();
      }
    }
    for (const node of this.nodes) {
      const parent = node.parent && this.projected.get(node.parent), point = this.projected.get(node.key)!;
      if (!parent || !node.cell?.parentId) continue;
      const lit = node.key === this.selected || node.parent === this.selected;
      context.beginPath(); context.moveTo(parent.x, parent.y);
      context.quadraticCurveTo((parent.x + point.x) / 2 + 7, (parent.y + point.y) / 2 - 13, point.x, point.y);
      context.strokeStyle = lit ? `${tint(node)}c0` : `${tint(node)}30`; context.lineWidth = lit ? 1.4 : 1; context.stroke();
    }
    for (const node of this.nodes) {
      const point = this.projected.get(node.key)!, hue = tint(node);
      const radius = !node.cell ? 14 : node.key === this.selected ? 10 : node.cell.role === 'coordinator' ? 9 : node.cell.role === 'verifier' ? 6 : 5;
      const gradient = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius * 3.2);
      gradient.addColorStop(0, `${hue}cc`); gradient.addColorStop(.32, `${hue}55`); gradient.addColorStop(1, `${hue}00`);
      context.fillStyle = gradient; context.beginPath(); context.arc(point.x, point.y, radius * 3.2, 0, Math.PI * 2); context.fill();
      context.strokeStyle = hue; context.lineWidth = node.cell ? 1 : 1.4; context.beginPath(); context.arc(point.x, point.y, radius * .78, 0, Math.PI * 2); context.stroke();
      if (!node.cell) { context.strokeStyle = `${hue}66`; context.beginPath(); context.arc(point.x, point.y, radius * 1.5, 0, Math.PI * 2); context.stroke(); }
      if (node.source.status === 'observed' && node.cell?.status !== 'retired' && node.cell?.status !== 'reserved' && node.activity !== 'uncertain') { context.fillStyle = hue; context.beginPath(); context.arc(point.x, point.y, radius * .34, 0, Math.PI * 2); context.fill(); }
      if (node.key === this.selected) {
        context.strokeStyle = '#d2fff0'; context.lineWidth = 1.2;
        context.beginPath(); context.arc(point.x, point.y, radius + 5, 0, Math.PI * 2); context.stroke();
        context.beginPath(); context.moveTo(point.x - radius - 11, point.y); context.lineTo(point.x - radius - 3, point.y); context.moveTo(point.x + radius + 3, point.y); context.lineTo(point.x + radius + 11, point.y); context.stroke();
      }
    }
  }
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
    this.motion.removeEventListener('change', this.motionChanged);
    this.canvas.removeEventListener('webglcontextlost', this.contextLost); this.controls?.removeEventListener('change', this.request); this.controls?.dispose();
    this.points?.geometry.dispose(); this.points?.material.dispose(); this.lines?.geometry.dispose(); this.lines?.material.dispose(); this.gl?.dispose(); this.labels.replaceChildren(); this.labelSizes.clear();
  }
}

import type { Analysis } from '../model/drawing';
import type { Axis, Drawing } from '../model/types';
import type { Preview, Selection, ViewBox } from '../render/renderer';
import { contentBounds, paperOf, renderDrawing } from '../render/renderer';
import { axisFromScreenDelta, lengthAlongAxis } from '../model/iso';
import { contentCss } from '../render/style';

export interface CanvasCallbacks {
  onSelect(selection: Selection): void;
  onRoute(fromId: string, axis: Axis, length: number): void;
  onStart(): void;
  onPreview(preview: Preview | null): void;
  onHover(message: string | null): void;
}

interface DragState {
  kind: 'pan' | 'route';
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startView: ViewBox;
  fromId?: string;
  moved: boolean;
}

const MIN_VIEW = 8;
const MAX_VIEW = 400_000;

export class Canvas {
  private svg: SVGSVGElement;
  private cb: CanvasCallbacks;
  private drawing: Drawing | null = null;
  private analysis: Analysis | null = null;
  private selection: Selection = null;
  private preview: Preview | null = null;
  private drag: DragState | null = null;
  private pinch: { d: number; view: ViewBox } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();

  view: ViewBox = { x: -400, y: -300, w: 800, h: 600 };

  constructor(svg: SVGSVGElement, callbacks: CanvasCallbacks) {
    this.svg = svg;
    this.cb = callbacks;

    svg.addEventListener('pointerdown', this.onPointerDown);
    svg.addEventListener('pointermove', this.onPointerMove);
    svg.addEventListener('pointerup', this.onPointerUp);
    svg.addEventListener('pointercancel', this.onPointerUp);
    svg.addEventListener('wheel', this.onWheel, { passive: false });
    svg.addEventListener('contextmenu', (e) => e.preventDefault());

    new ResizeObserver(() => this.syncAspect()).observe(svg);
  }

  /** Keeps the viewBox aspect ratio matched to the element so nothing distorts. */
  private syncAspect(): void {
    const rect = this.svg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const target = rect.height / rect.width;
    const centreY = this.view.y + this.view.h / 2;
    this.view.h = this.view.w * target;
    this.view.y = centreY - this.view.h / 2;
    this.render();
  }

  setState(drawing: Drawing, analysis: Analysis, selection: Selection, preview: Preview | null): void {
    this.drawing = drawing;
    this.analysis = analysis;
    this.selection = selection;
    this.preview = preview;
    this.render();
  }

  /** Paper units per screen pixel, inverted — used to keep line weights constant. */
  private get k(): number {
    const rect = this.svg.getBoundingClientRect();
    return rect.width > 0 ? rect.width / this.view.w : 1;
  }

  render(): void {
    if (!this.drawing || !this.analysis) return;
    const { x, y, w, h } = this.view;
    this.svg.setAttribute('viewBox', `${x.toFixed(3)} ${y.toFixed(3)} ${w.toFixed(3)} ${h.toFixed(3)}`);
    const body = renderDrawing({
      drawing: this.drawing,
      analysis: this.analysis,
      view: this.view,
      selection: this.selection,
      preview: this.preview,
      symbolSize: 11 / this.k,
    });
    this.svg.innerHTML = `<style>${contentCss({ k: this.k, u: 1 })}</style>${body}`;
  }

  fit(): void {
    if (!this.drawing || !this.analysis) return;
    const rect = this.svg.getBoundingClientRect();
    const aspect = rect.height > 0 && rect.width > 0 ? rect.height / rect.width : 0.75;
    if (this.drawing.nodes.length === 0) {
      this.view = { x: -400, y: -400 * aspect, w: 800, h: 800 * aspect };
      this.render();
      return;
    }
    const b = contentBounds(this.drawing, this.analysis);
    const pad = 60;
    const cw = Math.max(b.maxX - b.minX, 1) + pad * 2;
    const ch = Math.max(b.maxY - b.minY, 1) + pad * 2;
    const w = Math.max(cw, ch / aspect);
    const h = w * aspect;
    this.view = {
      x: (b.minX + b.maxX) / 2 - w / 2,
      y: (b.minY + b.maxY) / 2 - h / 2,
      w,
      h,
    };
    this.render();
  }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    const rect = this.svg.getBoundingClientRect();
    const px = cx ?? rect.left + rect.width / 2;
    const py = cy ?? rect.top + rect.height / 2;
    const before = this.toPaper(px, py);
    const w = Math.min(MAX_VIEW, Math.max(MIN_VIEW, this.view.w / factor));
    const scale = w / this.view.w;
    this.view.w = w;
    this.view.h *= scale;
    const after = this.toPaper(px, py);
    this.view.x += before.x - after.x;
    this.view.y += before.y - after.y;
    this.render();
  }

  private toPaper(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: this.view.x + ((clientX - rect.left) / Math.max(rect.width, 1)) * this.view.w,
      y: this.view.y + ((clientY - rect.top) / Math.max(rect.height, 1)) * this.view.h,
    };
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.drawing) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2) {
      this.drag = null;
      this.cb.onPreview(null);
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), view: { ...this.view } };
      return;
    }

    const target = event.target as Element | null;
    const nodeEl = target?.closest('[data-node]');
    const runEl = target?.closest('[data-run]');
    const compEl = target?.closest('[data-component]');

    const startView = { ...this.view };
    const panRequested = event.button === 1 || event.button === 2 || event.shiftKey;

    if (!panRequested && compEl) {
      this.cb.onSelect({ kind: 'component', id: compEl.getAttribute('data-component')! });
      return;
    }

    if (!panRequested && nodeEl) {
      const id = nodeEl.getAttribute('data-node')!;
      this.svg.setPointerCapture(event.pointerId);
      this.drag = {
        kind: 'route',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startView,
        fromId: id,
        moved: false,
      };
      this.cb.onSelect({ kind: 'node', id });
      return;
    }

    if (!panRequested && runEl) {
      this.cb.onSelect({ kind: 'run', id: runEl.getAttribute('data-run')! });
      return;
    }

    if (this.drawing.nodes.length === 0 && !panRequested) {
      this.cb.onStart();
      return;
    }

    this.svg.setPointerCapture(event.pointerId);
    this.svg.classList.add('panning');
    this.drag = {
      kind: 'pan',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startView,
      moved: false,
    };
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch.d > 4) {
        const rect = this.svg.getBoundingClientRect();
        const factor = d / this.pinch.d;
        const w = Math.min(MAX_VIEW, Math.max(MIN_VIEW, this.pinch.view.w / factor));
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const relX = (midX - rect.left) / Math.max(rect.width, 1);
        const relY = (midY - rect.top) / Math.max(rect.height, 1);
        const anchorX = this.pinch.view.x + relX * this.pinch.view.w;
        const anchorY = this.pinch.view.y + relY * this.pinch.view.h;
        const h = w * (this.pinch.view.h / this.pinch.view.w);
        this.view = { x: anchorX - relX * w, y: anchorY - relY * h, w, h };
        this.render();
      }
      return;
    }

    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId || !this.drawing || !this.analysis) return;

    const dxScreen = event.clientX - drag.startClientX;
    const dyScreen = event.clientY - drag.startClientY;
    if (Math.abs(dxScreen) > 2 || Math.abs(dyScreen) > 2) drag.moved = true;

    if (drag.kind === 'pan') {
      const rect = this.svg.getBoundingClientRect();
      this.view.x = drag.startView.x - (dxScreen / Math.max(rect.width, 1)) * drag.startView.w;
      this.view.y = drag.startView.y - (dyScreen / Math.max(rect.height, 1)) * drag.startView.h;
      this.render();
      return;
    }

    // Routing: work out which isometric direction the drag follows, then how
    // far along it the pointer has reached.
    const from = paperOf(this.analysis, this.drawing, drag.fromId!);
    if (!from) return;
    const here = this.toPaper(event.clientX, event.clientY);
    const dx = here.x - from.x;
    const dy = here.y - from.y;
    const rotation = this.drawing.options.northRotation;
    const axis = axisFromScreenDelta(dx, dy, rotation, 6 / this.k);
    if (!axis) {
      this.cb.onPreview(null);
      this.cb.onHover(null);
      return;
    }
    const raw = lengthAlongAxis(dx, dy, axis, this.drawing.options.scale, rotation);
    const snap = Math.max(1, this.drawing.options.snap);
    const length = Math.max(snap, Math.round(raw / snap) * snap);
    this.cb.onPreview({ fromId: drag.fromId!, axis, length });
    this.cb.onHover(`${axis} ${Math.round(length).toLocaleString('en-GB')} mm`);
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinch = null;

    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = null;
    this.svg.classList.remove('panning');
    if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);

    if (drag.kind === 'route' && this.preview && drag.moved) {
      this.cb.onRoute(this.preview.fromId, this.preview.axis, this.preview.length);
    }
    this.cb.onPreview(null);
    this.cb.onHover(null);
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0016);
    this.zoomBy(factor, event.clientX, event.clientY);
  };
}

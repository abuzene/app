import type { Analysis } from '../model/drawing';
import type { Axis, Drawing } from '../model/types';
import type { Preview, Selection, ViewBox } from '../render/renderer';
import { contentBounds, paperOf, renderDrawing, symbolSizeFor } from '../render/renderer';
import { axisFromScreenDelta, lengthAlongAxis } from '../model/iso';
import { contentCss } from '../render/style';

export interface CanvasCallbacks {
  onSelect(selection: Selection): void;
  onRoute(fromId: string, axis: Axis, length: number): void;
  onStart(): void;
  onPreview(preview: Preview | null): void;
  onHover(message: string | null): void;
  /** Slides a component along the run it sits in. */
  onSlideComponent(componentId: string, paper: { x: number; y: number }, commit: boolean): void;
  /** Slides a branch point along the line it sits in. */
  onSlideNode(nodeId: string, paper: { x: number; y: number }, commit: boolean): void;
  /** A dimension figure was tapped, to be typed over. */
  onEditDimension(runId: string, index: number, clientX: number, clientY: number): void;
  /** A weld number was tapped, to be typed over. */
  onEditWeld(key: string, clientX: number, clientY: number): void;
  /** A support's name was tapped, to be typed over. */
  onEditSupport(componentId: string, clientX: number, clientY: number): void;
  /** Drags one end of a run along the run's own line. */
  onStretchRun(runId: string, end: 'from' | 'to', paper: { x: number; y: number }, commit: boolean): void;
  /** Moves a weld number tag; the offset is from the weld, in paper units. */
  onSlideTag(key: string, offset: { dx: number; dy: number }, commit: boolean): void;
}

interface DragState {
  kind: 'pan' | 'route' | 'slide-component' | 'slide-node' | 'stretch' | 'slide-tag';
  /** Which end of the run a stretch moves. */
  end?: 'from' | 'to';
  /** Where a dragged tag's weld is, in paper units. */
  anchor?: { x: number; y: number };
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startView: ViewBox;
  fromId?: string;
  /** What is being slid, for the slide drags. */
  targetId?: string;
  moved: boolean;
  /** What a finger tap should select, if the finger never really moved. */
  tapSelect?: Selection;
  /** A dimension a finger landed on, opened for typing if it was a tap. */
  tapDim?: string;
  /** The editor was opened on the touch itself, so the lift has nothing to do. */
  opened?: boolean;
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
  /**
   * The point the next run will leave from. Routing is a continuous tool: the
   * first touch puts a point down, and every touch after that adds a run and
   * carries on from its end, the way a polyline is drawn in any CAD program.
   * Dragging from a point still works and is sometimes quicker; both leave the
   * anchor on the new end so the route keeps going either way.
   */
  private anchor: string | null = null;
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
    // A touch that ends somewhere else — over a box that opened under it, or
    // off the page — must still be forgotten, or the next touch would read as
    // a second finger and every tap after that as a pinch.
    window.addEventListener('pointerup', this.onPointerGone, true);
    window.addEventListener('pointercancel', this.onPointerGone, true);
    svg.addEventListener('dblclick', this.onDoubleClick);
    svg.addEventListener('wheel', this.onWheel, { passive: false });
    svg.addEventListener('contextmenu', (e) => e.preventDefault());

    new ResizeObserver(() => this.syncAspect()).observe(svg);
  }

  /** Keeps the rest of this touch coming to the drawing, wherever it goes. */
  private capture(pointerId: number): void {
    try {
      this.svg.setPointerCapture(pointerId);
    } catch {
      // A pointer that is already gone cannot be held; nothing is lost.
    }
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

  /** Sets, moves or clears the point the next run leaves from. */
  setAnchor(nodeId: string | null): void {
    this.anchor = nodeId;
  }

  get drawingFrom(): string | null {
    return this.anchor;
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
      hitSize: 14 / this.k,
    });
    this.svg.innerHTML = `<style>${contentCss({ k: this.k, u: 1, symbol: symbolSizeFor(this.drawing, this.analysis) })}</style>${body}`;
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
    // A finger never draws. On a tablet the pen is the pencil and the fingers
    // are for moving the sheet around, so a stray palm or a scrolling hand
    // cannot lay pipe. A finger tap still selects, on the way back up.
    const fingers = event.pointerType === 'touch';
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
    const weldEl = target?.closest('[data-weld]');
    const tagEl = target?.closest('[data-weld-tag]');
    const balloonEl = target?.closest('[data-balloon]');
    const dimEl = target?.closest('[data-dim]');
    const handleEl = target?.closest('[data-run-end]');

    const startView = { ...this.view };
    const panRequested = fingers || event.button === 1 || event.button === 2 || event.shiftKey;

    // A finger drag moves the sheet; a finger tap selects whatever is under it.
    if (fingers) {
      if (dimEl || weldEl) event.preventDefault();
      this.capture(event.pointerId);
      this.svg.classList.add('panning');
      this.drag = {
        kind: 'pan',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startView,
        moved: false,
        tapDim: dimEl?.getAttribute('data-dim') ?? undefined,
        tapSelect: weldEl
          ? { kind: 'weld', key: weldEl.getAttribute('data-weld')! }
          : compEl
          ? { kind: 'component', id: compEl.getAttribute('data-component')! }
          : nodeEl
            ? { kind: 'node', id: nodeEl.getAttribute('data-node')! }
            : runEl
              ? { kind: 'run', id: runEl.getAttribute('data-run')! }
              : null,
      };
      return;
    }

    // A dimension figure is tapped to be typed over. The box opens on the
    // touch itself, which is when a tablet lets a keyboard come up; the mouse
    // events that would follow and take focus back are not let through.
    if (!panRequested && dimEl) {
      event.preventDefault();
      // The box opens under the pointer, so the lift is kept coming here.
      this.capture(event.pointerId);
      this.drag = {
        kind: 'pan',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startView,
        moved: false,
        opened: true,
      };
      const [runId, index] = dimEl.getAttribute('data-dim')!.split(':');
      this.cb.onEditDimension(runId, Number(index), event.clientX, event.clientY);
      return;
    }

    // A weld number tag is dragged to where it reads best, its leader staying
    // on the weld; tapped, it opens to be typed over.
    if (!panRequested && tagEl) {
      event.preventDefault();
      this.capture(event.pointerId);
      const key = tagEl.getAttribute('data-weld')!;
      this.cb.onSelect({ kind: 'weld', key });
      this.drag = {
        kind: 'slide-tag',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startView,
        targetId: key,
        anchor: { x: Number(tagEl.getAttribute('data-ax')), y: Number(tagEl.getAttribute('data-ay')) },
        moved: false,
      };
      return;
    }

    // An item balloon or a support's name is dragged to where it reads best,
    // its leader staying put. A support's name is opened to be typed over on
    // the touch itself, as a weld number is; a balloon has nothing to type.
    if (!panRequested && balloonEl) {
      event.preventDefault();
      this.capture(event.pointerId);
      this.drag = {
        kind: 'slide-tag',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startView,
        targetId: `item:${balloonEl.getAttribute('data-balloon')!}`,
        anchor: { x: Number(balloonEl.getAttribute('data-ax')), y: Number(balloonEl.getAttribute('data-ay')) },
        moved: false,
      };
      const key = balloonEl.getAttribute('data-balloon')!;
      if (key.startsWith('sup:')) {
        this.capture(event.pointerId);
        this.drag.opened = true;
        this.cb.onEditSupport(key.slice(4), event.clientX, event.clientY);
      }
      return;
    }

    // The weld mark itself: picked, and opened to be typed over, on the touch
    // itself as a dimension is.
    if (!panRequested && weldEl) {
      event.preventDefault();
      this.capture(event.pointerId);
      const key = weldEl.getAttribute('data-weld')!;
      this.cb.onSelect({ kind: 'weld', key });
      this.drag = {
        kind: 'slide-tag',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startView,
        targetId: key,
        moved: false,
        opened: true,
      };
      this.cb.onEditWeld(key, event.clientX, event.clientY);
      return;
    }

    // A handle on the end of a picked run: dragged along the run's line to
    // make it longer or shorter, never to turn it.
    if (!panRequested && handleEl) {
      const [runId, end] = handleEl.getAttribute('data-run-end')!.split(':');
      this.capture(event.pointerId);
      this.drag = {
        kind: 'stretch',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startView,
        targetId: runId,
        end: end as 'from' | 'to',
        moved: false,
      };
      return;
    }

    if (!panRequested && compEl) {
      const id = compEl.getAttribute('data-component')!;
      this.cb.onSelect({ kind: 'component', id });
      // Dragging slides it along the pipe: dropping something in the middle of
      // a run and leaving it there is never where it actually goes.
      this.capture(event.pointerId);
      this.drag = {
        kind: 'slide-component',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startView,
        targetId: id,
        moved: false,
      };
      return;
    }

    if (!panRequested && nodeEl) {
      const id = nodeEl.getAttribute('data-node')!;
      this.capture(event.pointerId);
      // A branch or a joint sitting along a line slides along it, and so does
      // an end: dragging it makes the pipe longer or shorter, never turns it.
      // Drawing on is done by tapping. A corner has nothing to slide along, so
      // dragging routes from it.
      const endOf = this.freeEndOf(id);
      if (this.slidesAlongLine(id) || endOf) {
        this.drag = endOf
          ? {
              kind: 'stretch',
              pointerId: event.pointerId,
              startClientX: event.clientX,
              startClientY: event.clientY,
              startView,
              targetId: endOf.runId,
              end: endOf.end,
              moved: false,
            }
          : {
              kind: 'slide-node',
              pointerId: event.pointerId,
              startClientX: event.clientX,
              startClientY: event.clientY,
              startView,
              targetId: id,
              moved: false,
            };
        // Touching a point while drawing moves the route there.
        if (this.anchor) this.anchor = id;
        this.cb.onSelect({ kind: 'node', id });
        return;
      }
      this.drag = {
        kind: 'route',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startView,
        fromId: id,
        moved: false,
      };
      // Touching a point while drawing moves the route there. Touching one
      // when not drawing only selects it — looking at a point should never
      // start laying pipe from it. Double click to pick the route back up.
      if (this.anchor) this.anchor = id;
      this.cb.onSelect({ kind: 'node', id });
      return;
    }

    // A tap on a line picks it — unless drawing, when the pencil draws to
    // that point instead (the line is split there, never doubled).
    if (!panRequested && runEl && !this.anchor) {
      this.cb.onSelect({ kind: 'run', id: runEl.getAttribute('data-run')! });
      return;
    }

    if (this.drawing.nodes.length === 0 && !panRequested) {
      this.cb.onStart();
      return;
    }

    // With a point armed, touching open canvas draws the run to there. A pencil
    // has no hover, so the run is worked out on contact rather than relying on
    // a preview built up beforehand: touch and lift places it, and dragging
    // before lifting adjusts it first.
    if (this.anchor && !panRequested) {
      this.capture(event.pointerId);
      this.drag = {
        kind: 'route',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startView,
        fromId: this.anchor,
        moved: false,
      };
      this.previewFrom(this.anchor, event.clientX, event.clientY);
      return;
    }

    this.capture(event.pointerId);
    this.svg.classList.add('panning');
    this.drag = {
      kind: 'pan',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startView,
      moved: false,
      // Lifted without moving, this was a tap on open sheet: clear the selection.
      tapSelect: panRequested ? undefined : null,
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
    if (!drag) {
      // Not dragging: if a point is armed, show what the next touch would draw.
      if (this.anchor) this.previewFrom(this.anchor, event.clientX, event.clientY);
      return;
    }
    if (drag.pointerId !== event.pointerId || !this.drawing || !this.analysis) return;

    const dxScreen = event.clientX - drag.startClientX;
    const dyScreen = event.clientY - drag.startClientY;
    if (Math.abs(dxScreen) > 2 || Math.abs(dyScreen) > 2) drag.moved = true;

    if (drag.kind === 'slide-component' || drag.kind === 'slide-node' || drag.kind === 'stretch' || drag.kind === 'slide-tag') {
      if (!drag.moved) return;
      const here = this.toPaper(event.clientX, event.clientY);
      if (drag.kind === 'slide-component') this.cb.onSlideComponent(drag.targetId!, here, false);
      else if (drag.kind === 'slide-node') this.cb.onSlideNode(drag.targetId!, here, false);
      else if (drag.kind === 'stretch') this.cb.onStretchRun(drag.targetId!, drag.end!, here, false);
      else if (drag.anchor) this.cb.onSlideTag(drag.targetId!, { dx: here.x - drag.anchor.x, dy: here.y - drag.anchor.y }, false);
      return;
    }

    if (drag.kind === 'pan') {
      const rect = this.svg.getBoundingClientRect();
      this.view.x = drag.startView.x - (dxScreen / Math.max(rect.width, 1)) * drag.startView.w;
      this.view.y = drag.startView.y - (dyScreen / Math.max(rect.height, 1)) * drag.startView.h;
      this.render();
      return;
    }

    // Routing: work out which isometric direction the drag follows, then how
    // far along it the pointer has reached.
    this.previewFrom(drag.fromId!, event.clientX, event.clientY);
  };

  /**
   * Whether a point has a line running straight through it — a tee, an olet or
   * a plain joint — in which case dragging should slide it along that line.
   */
  private slidesAlongLine(nodeId: string): boolean {
    if (!this.analysis) return false;
    const info = this.analysis.nodeInfo.get(nodeId);
    if (!info || info.legs.length < 2) return false;
    for (let i = 0; i < info.legs.length; i += 1) {
      for (let j = i + 1; j < info.legs.length; j += 1) {
        const a = info.legs[i];
        const b = info.legs[j];
        const dot = a.e * b.e + a.n * b.n + a.u * b.u;
        if (dot < -0.999) return true;
      }
    }
    return false;
  }

  /** The one run a free end belongs to, and which end of it this is. */
  private freeEndOf(nodeId: string): { runId: string; end: 'from' | 'to' } | null {
    const info = this.analysis?.nodeInfo.get(nodeId);
    if (!info || info.runs.length !== 1) return null;
    const run = info.runs[0];
    return { runId: run.id, end: run.from === nodeId ? 'from' : 'to' };
  }

  /** Offers the run that would be drawn from `fromId` to the pointer. */
  private previewFrom(fromId: string, clientX: number, clientY: number): boolean {
    if (!this.drawing || !this.analysis) return false;
    const from = paperOf(this.analysis, this.drawing, fromId);
    if (!from) return false;
    const here = this.toPaper(clientX, clientY);
    const dx = here.x - from.x;
    const dy = here.y - from.y;
    const rotation = this.drawing.options.northRotation;
    const axis = axisFromScreenDelta(dx, dy, rotation, 6 / this.k);
    if (!axis) {
      this.cb.onPreview(null);
      this.cb.onHover(null);
      return false;
    }
    const raw = lengthAlongAxis(dx, dy, axis, this.drawing.options.scale, rotation);
    const snap = Math.max(1, this.drawing.options.snap);
    const length = Math.max(snap, Math.round(raw / snap) * snap);
    this.cb.onPreview({ fromId, axis, length });
    this.cb.onHover(`${axis} ${Math.round(length)} mm — click to place`);
    return true;
  }

  private onPointerGone = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.drag && this.drag.pointerId === event.pointerId && event.target !== this.svg && !this.svg.contains(event.target as Node)) {
      this.drag = null;
      this.svg.classList.remove('panning');
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinch = null;

    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = null;
    this.svg.classList.remove('panning');
    if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);

    if ((drag.kind === 'slide-component' || drag.kind === 'slide-node' || drag.kind === 'stretch' || drag.kind === 'slide-tag') && drag.moved) {
      const here = this.toPaper(event.clientX, event.clientY);
      if (drag.kind === 'slide-component') this.cb.onSlideComponent(drag.targetId!, here, true);
      else if (drag.kind === 'slide-node') this.cb.onSlideNode(drag.targetId!, here, true);
      else if (drag.kind === 'stretch') this.cb.onStretchRun(drag.targetId!, drag.end!, here, true);
      else if (drag.anchor) this.cb.onSlideTag(drag.targetId!, { dx: here.x - drag.anchor.x, dy: here.y - drag.anchor.y }, true);
      this.cb.onHover(null);
      return;
    }
    // A weld number tapped, not dragged: open it to be typed over.
    if (drag.kind === 'slide-tag' && !drag.moved) {
      if (!drag.opened && !drag.targetId!.startsWith('item:')) this.cb.onEditWeld(drag.targetId!, event.clientX, event.clientY);
      return;
    }
    if (drag.opened) return;

    // A tap selects rather than pans; a tap on nothing puts the pencil down,
    // which is how drawing is stopped without a keyboard.
    if (drag.kind === 'pan' && !drag.moved && drag.tapDim) {
      const [runId, index] = drag.tapDim.split(':');
      this.cb.onEditDimension(runId, Number(index), event.clientX, event.clientY);
      return;
    }
    if (drag.kind === 'pan' && !drag.moved && drag.tapSelect?.kind === 'weld') {
      this.cb.onSelect(drag.tapSelect);
      this.cb.onEditWeld(drag.tapSelect.key, event.clientX, event.clientY);
      return;
    }
    if (drag.kind === 'pan' && !drag.moved && drag.tapSelect !== undefined) {
      if (drag.tapSelect === null) {
        this.anchor = null;
        this.cb.onPreview(null);
        this.cb.onHover(null);
      }
      this.cb.onSelect(drag.tapSelect);
      return;
    }

    if (drag.kind === 'route' && this.preview) {
      // Drawn from a point that was armed, a touch places the run whether or
      // not the pointer moved; started on a point itself, it has to be a drag.
      const fromArmed = drag.fromId === this.anchor;
      if (fromArmed || drag.moved) {
        this.cb.onRoute(this.preview.fromId, this.preview.axis, this.preview.length);
        return;
      }
    }
    if (drag.kind === 'route' || !this.anchor) {
      this.cb.onPreview(null);
      this.cb.onHover(null);
    }
  };

  /** Double clicking a point picks the route back up from there. */
  private onDoubleClick = (event: MouseEvent): void => {
    const nodeEl = (event.target as Element | null)?.closest('[data-node]');
    if (!nodeEl) return;
    event.preventDefault();
    const id = nodeEl.getAttribute('data-node')!;
    this.anchor = id;
    this.cb.onSelect({ kind: 'node', id });
    this.cb.onHover('drawing again from here');
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0016);
    this.zoomBy(factor, event.clientX, event.clientY);
  };
}

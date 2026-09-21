import type { Analysis } from '../model/drawing';
import type { Axis, Drawing, Run, Vec3 } from '../model/types';
import { COMPONENT_LABEL, TERMINAL_LABEL, dimensionStops, fittingLabel, isMark, isSupport, isValve, oletLegs, resolveEnds } from '../model/drawing';
import { componentTakeout, sizeLabel, valveFlangeKind } from '../model/pipe-data';
import { AXIS_VECTOR, axisBetween, axisScreenDir, project, scale3, add } from '../model/iso';
import { componentSymbol, flangeHub, flangeSymbol, frameFor, gasketLine, groundSymbol, isFlange, jointMark, oletSymbol, supportCallout, supportSymbol, terminalSymbol, transitionSymbol, type Facing, type Frame } from './symbols';

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Selection =
  | { kind: 'run'; id: string }
  | { kind: 'node'; id: string }
  | { kind: 'component'; id: string }
  | { kind: 'weld'; key: string }
  | null;

/**
 * Symbols, balloons and lettering are part of the drawing: they keep their
 * size against the pipe whatever the zoom. Their size is fixed on the printed
 * sheet — a flange plate is always about the same few millimetres tall — and
 * worked back from there into paper units through the scale the sheet would
 * print this drawing at. A big drawing prints small, so its symbols are small
 * against it; a small drawing is never blown up to fill the page.
 */
const SYMBOL_MM = 2.4;
/** The drawing area of an A3 sheet, in mm, that the symbol size is judged against. */
const SHEET_AREA = { w: 270, h: 265 };
/** Sheet mm per paper unit at most: a small drawing sits at this scale rather than filling the page. */
export const SHEET_SCALE_MAX = 1.4;

/** The scale a drawing of this size prints at, in sheet mm per paper unit. */
export function sheetScale(contentW: number, contentH: number, areaW: number, areaH: number, pad = 14): number {
  const fit = Math.min((areaW - pad * 2) / Math.max(contentW, 1), (areaH - pad * 2) / Math.max(contentH, 1));
  return Math.min(fit, SHEET_SCALE_MAX);
}

/**
 * Sheet millimetres per paper unit at the drawing's chosen scale (1:R), or
 * fitted to an A3 sheet when the drawing is set to fit.
 */
export function drawingScale(drawing: Drawing, analysis: Analysis): number {
  const R = drawing.options.sheetScale ?? 15;
  if (R > 0) return 1 / drawing.options.scale / R;
  const b = contentBounds(drawing, analysis);
  return sheetScale(b.maxX - b.minX, b.maxY - b.minY, SHEET_AREA.w, SHEET_AREA.h);
}

/** Symbol half-size in paper units for this drawing. */
export function symbolSizeFor(drawing: Drawing, analysis: Analysis): number {
  return SYMBOL_MM / drawingScale(drawing, analysis);
}

/** Half the gap between two bolted flange faces, as a share of the symbol size. */
const FLANGE_GAP = 0.25;

export interface Preview {
  fromId: string;
  axis: Axis;
  length: number;
}

export interface RenderState {
  drawing: Drawing;
  analysis: Analysis;
  view: ViewBox;
  selection: Selection;
  preview?: Preview | null;
  /** Radius of the invisible touch targets, in paper units: kept constant on screen. */
  hitSize?: number;
}

export interface Pt {
  x: number;
  y: number;
}

/**
 * The two isometric axes a symbol on this run is drawn in: across the pipe and
 * up. A horizontal run takes the other horizontal axis across it and true up;
 * a riser is drawn in a vertical plane instead, since "up" along it means
 * nothing. This is what makes a valve read as an object on the pipe rather
 * than a badge stuck to the screen.
 */
function symbolPlane(drawing: Drawing, a: Vec3, b: Vec3): { across: Pt; up: Pt } | null {
  const axis = axisBetween(a, b);
  if (!axis) return null;
  const rotation = drawing.options.northRotation;
  if (axis === 'U' || axis === 'D') {
    return { across: axisScreenDir('E', rotation), up: axisScreenDir('N', rotation) };
  }
  const across = axis === 'N' || axis === 'S' ? 'E' : 'N';
  return { across: axisScreenDir(across, rotation), up: axisScreenDir('U', rotation) };
}

export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Converts a plant coordinate to paper units, honouring the sheet orientation. */
export function toPaper(pos: Vec3, drawing: Drawing): Pt {
  const p = project(pos, drawing.options.northRotation);
  return { x: p.x * drawing.options.scale, y: p.y * drawing.options.scale };
}

function displayPos(analysis: Analysis, nodeId: string): Vec3 | null {
  return analysis.display.get(nodeId) ?? null;
}

export function paperOf(analysis: Analysis, drawing: Drawing, nodeId: string): Pt | null {
  const pos = displayPos(analysis, nodeId);
  return pos ? toPaper(pos, drawing) : null;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function contentBounds(drawing: Drawing, analysis: Analysis): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of drawing.nodes) {
    const p = paperOf(analysis, drawing, node.id);
    if (!p) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}

/** A piece of a straight pipe, between two fractions of its length. */
function pipeLine(a: Pt, b: Pt, t0: number, t1: number, cls: string): string {
  const x1 = a.x + (b.x - a.x) * t0;
  const y1 = a.y + (b.y - a.y) * t0;
  const x2 = a.x + (b.x - a.x) * t1;
  const y2 = a.y + (b.y - a.y) * t1;
  return `<line class="${cls}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
}

/** Where two segments cross, as a fraction along each, or null if they do not. */
function crossing(a: Pt, b: Pt, c: Pt, d: Pt): { t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  const inside = (v: number) => v > 0.03 && v < 0.97;
  return inside(t) && inside(u) ? { t, u } : null;
}

/** Dimensions are written plainly: 1750, not 1,750. */
function formatMm(value: number): string {
  return String(Math.round(value));
}

/** Background isometric grid, generated across the visible area only. */
function renderGrid(drawing: Drawing, view: ViewBox): string {
  const { scale, snap, northRotation } = drawing.options;
  // Choose a grid step that stays readable at the current zoom.
  let step = Math.max(snap, 100);
  while (step * scale * Math.cos(Math.PI / 6) < view.w / 60) step *= 2;

  const families: Axis[] = ['N', 'E', 'U'];
  const corners: Pt[] = [
    { x: view.x, y: view.y },
    { x: view.x + view.w, y: view.y },
    { x: view.x, y: view.y + view.h },
    { x: view.x + view.w, y: view.y + view.h },
  ];

  let out = '';
  for (const axis of families) {
    const dir = axisScreenDir(axis, northRotation);
    const perp = { x: -dir.y, y: dir.x };

    // Perpendicular spacing is the same for every family in an isometric, but
    // derive it so that a rotated sheet stays correct.
    let spacing = Infinity;
    for (const other of families) {
      if (other === axis) continue;
      const v = project(scale3(AXIS_VECTOR[other], step), northRotation);
      const d = Math.abs(v.x * scale * perp.x + v.y * scale * perp.y);
      if (d > 0.01) spacing = Math.min(spacing, d);
    }
    if (!Number.isFinite(spacing) || spacing < 1) continue;

    const offsets = corners.map((c) => c.x * perp.x + c.y * perp.y);
    const kMin = Math.floor(Math.min(...offsets) / spacing);
    const kMax = Math.ceil(Math.max(...offsets) / spacing);
    if (kMax - kMin > 400) continue;

    const spans = corners.map((c) => c.x * dir.x + c.y * dir.y);
    const tMin = Math.min(...spans);
    const tMax = Math.max(...spans);

    for (let k = kMin; k <= kMax; k += 1) {
      const o = k * spacing;
      const x1 = perp.x * o + dir.x * tMin;
      const y1 = perp.y * o + dir.y * tMin;
      const x2 = perp.x * o + dir.x * tMax;
      const y2 = perp.y * o + dir.y * tMax;
      out += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }
  }
  return `<g class="grid">${out}</g>`;
}

/** Dimension line for one run, offset clear of the pipe. */
function renderDimension(
  a: Pt,
  b: Pt,
  centroid: Pt,
  text: string,
  size: number,
  id: string,
  hitR: number,
): { svg: string; hit: string; at: Pt } {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return { svg: '', hit: '', at: a };
  const dx = (b.x - a.x) / len;
  const dy = (b.y - a.y) / len;
  let nx = -dy;
  let ny = dx;

  // Push the dimension away from the middle of the drawing.
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  if ((midX - centroid.x) * nx + (midY - centroid.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }

  const off = size * 2.6;
  const gap = size * 0.5;
  const ax = a.x + nx * off;
  const ay = a.y + ny * off;
  const bx = b.x + nx * off;
  const by = b.y + ny * off;

  const tick = size * 0.5;
  const ext = (p: Pt, q: Pt) =>
    `<line class="dim-ext" x1="${(p.x + nx * gap).toFixed(2)}" y1="${(p.y + ny * gap).toFixed(2)}" x2="${q.x.toFixed(2)}" y2="${q.y.toFixed(2)}"/>`;

  const slash = (x: number, y: number) =>
    `<line class="dim-tick" x1="${(x - (dx + nx) * tick).toFixed(2)}" y1="${(y - (dy + ny) * tick).toFixed(2)}" x2="${(x + (dx + nx) * tick).toFixed(2)}" y2="${(y + (dy + ny) * tick).toFixed(2)}"/>`;

  // Keep the text upright rather than letting it read upside down.
  let angle = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
  if (angle > 90 || angle < -90) angle += 180;
  const tx = (ax + bx) / 2;
  const ty = (ay + by) / 2;

  // The figure sits a little off the line; that is also where it is tapped
  // to be typed over.
  const lift = size * 0.75;
  const rad = (angle * Math.PI) / 180;
  const textX = tx + Math.sin(rad) * lift;
  const textY = ty - Math.cos(rad) * lift;
  return {
    at: { x: textX, y: textY },
    svg:
      `<g class="dim">` +
      ext(a, { x: ax, y: ay }) +
      ext(b, { x: bx, y: by }) +
      `<line class="dim-line" x1="${ax.toFixed(2)}" y1="${ay.toFixed(2)}" x2="${bx.toFixed(2)}" y2="${by.toFixed(2)}"/>` +
      slash(ax, ay) +
      slash(bx, by) +
      // Clear of the dimension line, never sitting across it.
      `<text class="dim-text" x="${tx.toFixed(2)}" y="${(ty - lift).toFixed(2)}" transform="rotate(${angle.toFixed(1)} ${tx.toFixed(2)} ${ty.toFixed(2)})">${escapeText(text)}</text>` +
      `</g>`,
    hit: `<circle class="hit-dot" data-dim="${id}" cx="${textX.toFixed(2)}" cy="${textY.toFixed(2)}" r="${Math.max(size * 1.2, hitR * 0.6).toFixed(2)}"/>`,
  };
}

export function renderDrawing(state: RenderState): string {
  const { drawing, analysis, view, selection } = state;
  const size = symbolSizeFor(drawing, analysis);
  const hitR = state.hitSize ?? size * 1.2;
  const sel = selection;

  const bounds = contentBounds(drawing, analysis);
  const centroid: Pt = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };

  const paper = (id: string) => paperOf(analysis, drawing, id);

  let grid = '';
  if (drawing.options.showGrid) grid = renderGrid(drawing, view);

  let pipes = '';
  let hits = '';
  let dims = '';
  let dimHits = '';
  let handles = '';
  let comps = '';
  const straights: { run: Run; pa: Pt; pb: Pt; selected: boolean; gaps: number[] }[] = [];
  /** Where dimension figures sit: tags and balloons keep clear of them. */
  const figures: Pt[] = [];

  const BENDS = ['ELBOW_90', 'ELBOW_45', 'BEND'];
  /**
   * How far, in paper units, the straight pipe stops short of a point: at an
   * elbow the run ends where the elbow starts, and the corner is drawn round.
   */
  // Fittings are drawn a set size, the same on every sheet, whatever their
  // true take-out: an elbow's sweep, and where its welds sit, is a symbol.
  const FITTING_REACH = size * 1.4;
  const trimAt = (nodeId: string): number => {
    const info = analysis.nodeInfo.get(nodeId);
    if (!info || info.degree !== 2 || !BENDS.includes(info.fitting)) return 0;
    return FITTING_REACH;
  };
  /**
   * How far an in-line item reaches from its centre to its face, in paper
   * units: its true half length to scale, a set size not to scale, and never
   * so short that the symbol collapses.
   */
  // A valve is a set size like every other symbol, however long it really
  // is: drawn to scale a big valve stretched right across the sheet.
  const faceReach = (trueHalf: number, paperPerMm: number): number =>
    drawing.options.schematic ? size * 1.2 : Math.min(size * 1.2, Math.max(trueHalf * paperPerMm, size * 0.8));
  const towards = (from: Pt, to: Pt, by: number): Pt => {
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: from.x + ((to.x - from.x) / len) * Math.min(by, len / 2), y: from.y + ((to.y - from.y) / len) * Math.min(by, len / 2) };
  };

  // Supports are numbered along the line, in the order they were placed,
  // unless they are named: "SUPPORT 1", "SUPPORT 2", or "SUPPORT A".
  const supportNo = new Map<string, number>();
  for (const run of drawing.runs) {
    for (const comp of run.inline) if (isSupport(comp.kind)) supportNo.set(comp.id, supportNo.size + 1);
  }
  let callouts = '';
  let calloutHits = '';

  for (const run of drawing.runs) {
    const a = paper(run.from);
    const b = paper(run.to);
    if (!a || !b) continue;
    const selected = sel?.kind === 'run' && sel.id === run.id;

    const lengths = analysis.runLengths.get(run.id);
    const total = lengths?.centre ?? 0;
    // Paper units per millimetre along this run, which is what places things
    // at their true distance whether or not the sheet is to scale.
    const paperPerMm = total > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / total : 0;

    // The straight pipe, stopping where an elbow takes over at either end.
    const pa = towards(a, b, trimAt(run.from));
    const pb = towards(b, a, trimAt(run.to));
    straights.push({ run, pa, pb, selected, gaps: [] });
    if (selected) {
      // A picked run shows a handle at each end, dragged to make it longer or
      // shorter along its own line.
      for (const [p, which] of [[a, 'from'], [b, 'to']] as const) {
        handles +=
          `<circle class="run-handle" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${(hitR * 0.55).toFixed(2)}"/>` +
          `<circle class="hit-dot" data-run-end="${run.id}:${which}" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${(hitR * 1.3).toFixed(2)}"/>`;
      }
    }
    hits += `<line class="hit" data-run="${run.id}" x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}"/>`;
    const along = (mm: number): Pt => {
      const t = total > 0 ? Math.max(0, Math.min(1, mm / total)) : 0.5;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    };

    // A valve is dimensioned to its faces, not through: the pipe either side
    // of it is its own piece, so the run's dimension breaks at each face and
    // the valve's face-to-face stands on its own between them.
    if (drawing.options.showDimensions && lengths && !run.noDim) {
      const stops = dimensionStops(drawing, run);
      // A dimension to a valve face ends where the face is drawn, which is
      // the symbol's face rather than the true one when the two differ.
      const facePaper = new Map<number, Pt>();
      for (const comp of run.inline) {
        if (!isValve(comp.kind)) continue;
        const half = componentTakeout(comp.kind, comp.dn ?? run.dn, false);
        const centre = along(comp.offset);
        const reach = faceReach(half, paperPerMm);
        const ux = total > 0 ? (b.x - a.x) / Math.hypot(b.x - a.x, b.y - a.y) : 0;
        const uy = total > 0 ? (b.y - a.y) / Math.hypot(b.x - a.x, b.y - a.y) : 0;
        facePaper.set(Math.round(comp.offset - half), { x: centre.x - ux * reach, y: centre.y - uy * reach });
        facePaper.set(Math.round(comp.offset + half), { x: centre.x + ux * reach, y: centre.y + uy * reach });
      }
      const at = (mm: number): Pt => facePaper.get(Math.round(mm)) ?? along(mm);
      for (let i = 0; i + 1 < stops.length; i += 1) {
        const span = stops[i + 1] - stops[i];
        if (span < 0.5) continue;
        const dim = renderDimension(at(stops[i]), at(stops[i + 1]), centroid, formatMm(span), size, `${run.id}:${i}`, hitR);
        dims += dim.svg;
        dimHits += dim.hit;
        figures.push(dim.at);
      }
    }

    // Inline components, positioned by their true offset along the run.
    const fromPos = analysis.nodeById.get(run.from)!.pos;
    const toPos = analysis.nodeById.get(run.to)!.pos;
    const plane = symbolPlane(drawing, fromPos, toPos);
    // The AG/UG mark's above-ground side: up a riser, else on towards the
    // end of the run, unless it has been turned round.
    const groundSide = (flip?: boolean): Facing => {
      const side: Facing = toPos.u - fromPos.u < 0 ? -1 : 1;
      return flip ? ((-side) as Facing) : side;
    };
    for (const comp of run.inline) {
      const t = total > 0 ? Math.max(0, Math.min(1, comp.offset / total)) : 0.5;
      const f = frameFor(a.x, a.y, b.x, b.y, t, size, plane?.across, plane?.up);
      const selectedComp = sel?.kind === 'component' && sel.id === comp.id;
      const dn = comp.dn ?? run.dn;
      comps += `<g class="component${selectedComp ? ' selected' : ''}" data-component="${comp.id}">`;
      // The body reaches its real faces, so what bolts or welds to it sits
      // against it rather than floating off along the pipe.
      const faceHalf = isValve(comp.kind) ? faceReach(componentTakeout(comp.kind, dn, false), paperPerMm) : undefined;
      comps +=
        comp.kind === 'TRANSITION'
          ? transitionSymbol(f, comp.flip ? -1 : 1)
          : comp.kind === 'GROUND'
            ? groundSymbol(f, groundSide(comp.flip))
            : isSupport(comp.kind)
              ? supportSymbol(f, comp.kind as 'SUPPORT' | 'SUPPORT_L')
              : componentSymbol(comp.kind, f, faceHalf);
      if (isSupport(comp.kind)) {
        // The support's name, on a leader to it; dragged wherever it reads
        // best, like a balloon, and kept there with the drawing.
        const { anchor, label } = supportCallout(f, comp.kind as 'SUPPORT' | 'SUPPORT_L');
        const placed = drawing.itemOverrides?.[`sup:${comp.id}`];
        const lx = placed ? anchor[0] + placed.dx : label[0];
        const ly = placed ? anchor[1] + placed.dy : label[1];
        // "SUPPORT 2 L50": the number (or a name), then what the support is,
        // which is typed over on the drawing — the angle size, or anything.
        const detail = comp.note ?? (comp.kind === 'SUPPORT_L' ? 'L50' : '');
        const name = `SUPPORT ${comp.tag || supportNo.get(comp.id) || ''} ${detail}`.replace(/\s+/g, ' ').trim();
        const textAnchor = lx < anchor[0] ? 'end' : 'start';
        const gap = size * 0.3 * (lx < anchor[0] ? 1 : -1);
        callouts +=
          `<g class="callout">` +
          `<line class="balloon-leader" x1="${anchor[0].toFixed(2)}" y1="${anchor[1].toFixed(2)}" x2="${(lx + gap).toFixed(2)}" y2="${ly.toFixed(2)}"/>` +
          `<text class="sym-text callout-text" x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" text-anchor="${textAnchor}" dominant-baseline="middle" font-size="${(size * 0.85).toFixed(2)}">${escapeText(name)}</text>` +
          `</g>`;
        calloutHits += `<circle class="hit-dot" data-balloon="sup:${comp.id}" data-ax="${anchor[0].toFixed(2)}" data-ay="${anchor[1].toFixed(2)}" cx="${(lx + (textAnchor === 'end' ? -1 : 1) * size * 2).toFixed(2)}" cy="${ly.toFixed(2)}" r="${Math.max(size * 1.4, hitR * 0.6).toFixed(2)}"/>`;
      }

      // A flanged component is drawn with the flanges it bolts between, each
      // facing in towards it, which is how it is actually built.
      const ends = resolveEnds(comp.kind, dn, comp.ends, drawing.options.joint ?? 'BW');
      if (ends === 'FLG' && !isFlange(comp.kind) && faceHalf !== undefined) {
        const shifted = (by: number): Frame => ({ ...f, cx: f.cx + f.dx * by, cy: f.cy + f.dy * by });
        // Weld neck flanges on a butt welded line; socket weld or threaded on those.
        const flange = valveFlangeKind(drawing.options.joint ?? 'BW');
        comps += gasketLine(f, -faceHalf) + flangeSymbol(shifted(-faceHalf), flange, 1);
        comps += gasketLine(f, faceHalf) + flangeSymbol(shifted(faceHalf), flange, -1);
      }
      // A support's name is part of its symbol; a mark has no tag of its own.
      const label = isMark(comp.kind) ? '' : (comp.tag ?? '');
      if (label) {
        comps += `<text class="tag" x="${(f.cx + f.nx * size * 2.2).toFixed(2)}" y="${(f.cy + f.ny * size * 2.2).toFixed(2)}">${escapeText(label)}</text>`;
      }
      comps += `<circle class="hit-dot" data-component="${comp.id}" cx="${f.cx.toFixed(2)}" cy="${f.cy.toFixed(2)}" r="${hitR.toFixed(2)}"/>`;
      comps += `</g>`;
    }
  }

  // Where two lines cross on the paper without meeting, the one further from
  // the eye is broken either side of the crossing, so the nearer one reads as
  // passing in front. Nearness is along the isometric line of sight.
  const depthAt = (run: Run, t: number): number => {
    const pa3 = analysis.display.get(run.from);
    const pb3 = analysis.display.get(run.to);
    if (!pa3 || !pb3) return 0;
    const p = { e: pa3.e + (pb3.e - pa3.e) * t, n: pa3.n + (pb3.n - pa3.n) * t, u: pa3.u + (pb3.u - pa3.u) * t };
    const rot = project({ e: p.e, n: p.n, u: 0 }, drawing.options.northRotation);
    // Screen-down is towards the eye on the ground; up is towards it too.
    return rot.y + p.u * 2;
  };
  for (let i = 0; i < straights.length; i += 1) {
    for (let j = i + 1; j < straights.length; j += 1) {
      const A = straights[i];
      const B = straights[j];
      if (A.run.from === B.run.from || A.run.from === B.run.to || A.run.to === B.run.from || A.run.to === B.run.to) continue;
      const hit = crossing(A.pa, A.pb, B.pa, B.pb);
      if (!hit) continue;
      const rear = depthAt(A.run, hit.t) < depthAt(B.run, hit.u) ? A : B;
      rear.gaps.push(rear === A ? hit.t : hit.u);
    }
  }
  for (const piece of straights) {
    const cls = `pipe${piece.selected ? ' selected' : ''}`;
    const len = Math.hypot(piece.pb.x - piece.pa.x, piece.pb.y - piece.pa.y);
    const half = len > 0 ? (size * 0.7) / len : 0;
    let t0 = 0;
    for (const g of piece.gaps.sort((x, y) => x - y)) {
      const t1 = Math.max(t0, g - half);
      if (t1 > t0) pipes += pipeLine(piece.pa, piece.pb, t0, t1, cls);
      t0 = Math.min(1, g + half);
    }
    if (t0 < 1) pipes += pipeLine(piece.pa, piece.pb, t0, 1, cls);
  }

  // Elbows are drawn round, sweeping from where one pipe stops to where the
  // next starts — which is exactly where their weld marks sit.
  for (const [nodeId, info] of analysis.nodeInfo) {
    if (info.degree !== 2 || !BENDS.includes(info.fitting)) continue;
    const c = paper(nodeId);
    if (!c) continue;
    const ends: Pt[] = [];
    for (const run of info.runs) {
      const otherId = run.from === nodeId ? run.to : run.from;
      const q = paper(otherId);
      const other = analysis.nodeById.get(otherId);
      if (!q || !other) continue;
      ends.push(towards(c, q, FITTING_REACH));
    }
    if (ends.length !== 2) continue;
    pipes += `<path class="pipe" d="M ${ends[0].x.toFixed(2)} ${ends[0].y.toFixed(2)} Q ${c.x.toFixed(2)} ${c.y.toFixed(2)} ${ends[1].x.toFixed(2)} ${ends[1].y.toFixed(2)}"/>`;
  }

  // Nodes: fitting corners, terminals and labels.
  let nodes = '';
  for (const node of drawing.nodes) {
    const p = paper(node.id);
    if (!p) continue;
    const info = analysis.nodeInfo.get(node.id);
    const selected = sel?.kind === 'node' && sel.id === node.id;

    nodes += `<g class="node${selected ? ' selected' : ''}" data-node="${node.id}">`;

    if (info && info.fitting === 'NONE' && node.flange && info.degree === 2) {
      // A flanged joint: a flange on each run, faces together at this point,
      // each hub running back to its own weld.
      let first = true;
      for (const run of info.runs) {
        const otherId = run.from === node.id ? run.to : run.from;
        const q = paper(otherId);
        const other = analysis.nodeById.get(otherId);
        if (!q || !other) continue;
        const plane = symbolPlane(drawing, node.pos, other.pos);
        const f = frameFor(p.x, p.y, q.x, q.y, 0, size, plane?.across, plane?.up);
        const gap = size * FLANGE_GAP;
        if (first) nodes += gasketLine(f, 0);
        first = false;
        nodes += flangeSymbol({ ...f, cx: f.cx + f.dx * gap, cy: f.cy + f.dy * gap }, node.flange, -1);
      }
    }

    if (info && info.degree === 1 && node.terminal && node.terminal.kind !== 'OPEN') {
      // Orient the end symbol along the single run leaving this node.
      const run = info.runs[0];
      const otherId = run.from === node.id ? run.to : run.from;
      const q = paper(otherId);
      if (q) {
        // Frame runs from the pipe outwards, so the symbol faces off the end.
        const other = analysis.nodeById.get(otherId);
        const endPlane = other ? symbolPlane(drawing, other.pos, node.pos) : null;
        const f = frameFor(q.x, q.y, p.x, p.y, 1, size, endPlane?.across, endPlane?.up);
        nodes += terminalSymbol(node.terminal.kind, f, node.joint ?? drawing.options.joint ?? 'BW');
        if (node.terminal.note) {
          nodes += `<text class="note" x="${(p.x + f.dx * size * 2.4).toFixed(2)}" y="${(p.y + f.dy * size * 2.4).toFixed(2)}">${escapeText(node.terminal.note)}</text>`;
        }
      }
    }

    if (drawing.options.showNodeLabels && node.label) {
      nodes += `<text class="node-label" x="${(p.x + size * 1.2).toFixed(2)}" y="${(p.y - size * 1.2).toFixed(2)}">${escapeText(node.label)}</text>`;
    }

    nodes += `<circle class="hit-dot" data-node="${node.id}" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${hitR.toFixed(2)}"/>`;
    if (selected) nodes += `<circle class="node-mark" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${(size * 0.8).toFixed(2)}"/>`;
    nodes += `</g>`;
  }

  // Joint marks sit on the run they belong to, positioned by true distance.
  // They are part of the fitting symbol, so they are always drawn; only the
  // weld numbers follow the Welds toggle.
  let welds = '';
  // Weld marks and tags sit on top of everything, so their touch targets do too.
  let weldHits = calloutHits;
  const jointPoints = new Map<string, Pt>();
  const weldLabels: { x: number; y: number; text: string; fromX: number; fromY: number; key: string; placed: boolean }[] = [];

  analysis.joints.forEach((joint, index) => {
    const place = weldPlacement(drawing, analysis, joint.pos);
    if (!place) return;
    let f = frameFor(place.a.x, place.a.y, place.b.x, place.b.y, place.t, size, place.plane?.across, place.plane?.up);
    // The mark is part of the symbol it belongs to: it sits on the symbol's
    // end, a set distance out from the point or the item, whatever the true
    // take-out — so it never drifts off the fitting as lengths change.
    if (joint.anchor && joint.reach) {
      const at = weldPlacement(drawing, analysis, joint.anchor);
      if (at) {
        const from = frameFor(at.a.x, at.a.y, at.b.x, at.b.y, at.t, size, at.plane?.across, at.plane?.up);
        const dx = f.cx - from.cx;
        const dy = f.cy - from.cy;
        const len = Math.hypot(dx, dy) || 1;
        const r = joint.reach;
        const out =
          r.kind === 'fitting'
            ? FITTING_REACH
            : r.kind === 'olet'
              ? size * 0.9
              : r.kind === 'reducer'
                ? size * 0.9
                : r.kind === 'transition'
                  ? 0
                : r.kind === 'flange'
                  ? flangeHub(r.flange, size) + (r.paired ? size * FLANGE_GAP : 0)
                  : faceReach(r.trueHalf, at.perMm) + (r.flange ? flangeHub(r.flange, size) : 0);
        f = { ...f, cx: from.cx + (dx / len) * out, cy: from.cy + (dy / len) * out };
      }
    }
    jointPoints.set(joint.key, { x: f.cx, y: f.cy });
    const selectedWeld = sel?.kind === 'weld' && sel.key === joint.key;
    welds += `<g class="weld${selectedWeld ? ' selected' : ''}">${jointMark(f, joint.joint, joint.facing)}</g>`;
    // The mark is a touch target unless it sits on a point, whose own target
    // it would otherwise cover; the number tag is always one.
    const onPoint = [...analysis.nodeById.keys()].some((id) => {
      const q = paper(id);
      return q && Math.hypot(q.x - f.cx, q.y - f.cy) < size * 0.6;
    });
    if (joint.number && !onPoint) {
      weldHits += `<circle class="hit-dot" data-weld="${joint.key}" cx="${f.cx.toFixed(2)}" cy="${f.cy.toFixed(2)}" r="${Math.max(size * 0.9, hitR * 0.4).toFixed(2)}"/>`;
    }
    if (drawing.options.showWelds && joint.number) {
      // Joints cluster around fittings, so stagger the tags either side of the
      // pipe rather than stacking them all on the same one.
      const side = index % 2 === 0 ? 1 : -1;
      const placed = drawing.weldOverrides[joint.key]?.tag;
      weldLabels.push({
        x: placed ? f.cx + placed.dx : f.cx + f.nx * size * 3.4 * side,
        y: placed ? f.cy + placed.dy : f.cy + f.ny * size * 3.4 * side,
        text: joint.number,
        fromX: f.cx,
        fromY: f.cy,
        key: joint.key,
        placed: !!placed,
      });
    }
  });

  // A tag that was dragged somewhere stays there; the rest spread out around it.
  const placedTags = weldLabels.filter((l) => l.placed);
  const spreadTags = spreadLabels(weldLabels.filter((l) => !l.placed), size * 2.1, [...figures, ...placedTags]);
  for (const label of [...placedTags, ...spreadTags]) {
    const selectedWeld = sel?.kind === 'weld' && sel.key === label.key;
    // The number sits in a rounded box on a leader to its weld — the weld's
    // own kind of balloon, told from an item balloon by its shape.
    const boxW = Math.max(size * 1.6, label.text.length * size * 0.46 + size * 0.7);
    const boxH = size * 1.15;
    const ddx = label.x - label.fromX;
    const ddy = label.y - label.fromY;
    const stopAt = Math.max(Math.abs(ddx) / (boxW / 2), Math.abs(ddy) / (boxH / 2), 1e-6);
    const ex = label.x - ddx / stopAt;
    const ey = label.y - ddy / stopAt;
    welds +=
      `<g class="weld${selectedWeld ? ' selected' : ''}">` +
      `<line class="weld-leader" x1="${label.fromX.toFixed(2)}" y1="${label.fromY.toFixed(2)}" x2="${ex.toFixed(2)}" y2="${ey.toFixed(2)}"/>` +
      `<rect class="weld-box" x="${(label.x - boxW / 2).toFixed(2)}" y="${(label.y - boxH / 2).toFixed(2)}" width="${boxW.toFixed(2)}" height="${boxH.toFixed(2)}" rx="${(size * 0.3).toFixed(2)}"/>` +
      `<text class="weld-no" x="${label.x.toFixed(2)}" y="${(label.y + size * 0.27).toFixed(2)}" text-anchor="middle">${escapeText(label.text)}</text></g>`;

    // The tag itself is a touch target too: it is what is read, so it is what gets tapped.
    // The target is the box itself, so a small box on a small drawing does not
    // reach out and take taps meant for the figures beside it.
    const tagR = Math.max(boxH * 0.8, hitR * 0.55);
    weldHits += `<circle class="hit-dot" data-weld="${label.key}" data-weld-tag="1" data-ax="${label.fromX.toFixed(2)}" data-ay="${label.fromY.toFixed(2)}" cx="${label.x.toFixed(2)}" cy="${label.y.toFixed(2)}" r="${tagR.toFixed(2)}"/>`;
  }

  // Item balloons: every pipe run, fitting, flange and valve carries the number
  // of its line in the material list, on a leader out to a circle clear of the
  // drawing. This is how a fabrication isometric says what things are.
  let balloons = '';
  if (drawing.options.showItems !== false) {
    const marks = analysis.items
      .map((item) => {
        const place = weldPlacement(drawing, analysis, item.pos);
        if (!place) return null;
        const f = frameFor(place.a.x, place.a.y, place.b.x, place.b.y, place.t, size);
        // Dimensions are placed away from the middle of the drawing, so the
        // balloons go the other way and the two never fight for the same space.
        const inward = (centroid.x - f.cx) * f.nx + (centroid.y - f.cy) * f.ny >= 0 ? 1 : -1;
        const reach = size * 4.6;
        // A balloon that was dragged somewhere stays there.
        const placed = drawing.itemOverrides?.[item.key];
        return {
          key: item.key,
          number: item.number,
          fromX: f.cx,
          fromY: f.cy,
          x: placed ? f.cx + placed.dx : f.cx + f.nx * reach * inward,
          y: placed ? f.cy + placed.dy : f.cy + f.ny * reach * inward,
          placed: !!placed,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    const r = size * 1.05;
    const placedMarks = marks.filter((m) => m.placed);
    const spreadMarks = spreadLabels(marks.filter((m) => !m.placed), r * 2.9, [...figures, ...weldLabels, ...placedMarks]);
    for (const mark of [...placedMarks, ...spreadMarks]) {
      // The leader stops at the balloon's edge rather than running into it.
      const dx = mark.x - mark.fromX;
      const dy = mark.y - mark.fromY;
      const len = Math.hypot(dx, dy) || 1;
      const ex = mark.x - (dx / len) * r;
      const ey = mark.y - (dy / len) * r;
      balloons +=
        `<g class="balloon">` +
        `<line class="balloon-leader" x1="${mark.fromX.toFixed(2)}" y1="${mark.fromY.toFixed(2)}" x2="${ex.toFixed(2)}" y2="${ey.toFixed(2)}"/>` +
        `<circle class="balloon-ring" cx="${mark.x.toFixed(2)}" cy="${mark.y.toFixed(2)}" r="${r.toFixed(2)}"/>` +
        `<text class="balloon-no" x="${mark.x.toFixed(2)}" y="${(mark.y + size * 0.27).toFixed(2)}" text-anchor="middle">${mark.number}</text>` +
        `</g>`;
      // The balloon is dragged to where it reads best, like a weld tag; its
      // leader stays on the item.
      weldHits += `<circle class="hit-dot" data-balloon="${mark.key}" data-ax="${mark.fromX.toFixed(2)}" data-ay="${mark.fromY.toFixed(2)}" cx="${mark.x.toFixed(2)}" cy="${mark.y.toFixed(2)}" r="${Math.max(r * 1.2, hitR * 0.55).toFixed(2)}"/>`;
    }
  }

  // An olet is drawn as the saddle on the header where the branch leaves it.
  let olets = '';
  for (const [nodeId, info] of analysis.nodeInfo) {
    if (info.fitting !== 'OLET') continue;
    const legs = oletLegs(info);
    if (!legs) continue;
    const here = paper(nodeId);
    const branchOther = legs.branch.from === nodeId ? legs.branch.to : legs.branch.from;
    const out = paper(branchOther);
    if (!here || !out) continue;
    const otherNode = analysis.nodeById.get(branchOther);
    const branchPlane = otherNode ? symbolPlane(drawing, info.node.pos, otherNode.pos) : null;
    const f = frameFor(here.x, here.y, out.x, out.y, 0, size, branchPlane?.across, branchPlane?.up);
    olets += `<g class="olet">${oletSymbol(f)}</g>`;
  }

  // A branch of a different size is called out in words beside it — "6\"X2\" NS"
  // — rather than drawn as a special shape, which is how these sheets read.
  let tees = '';
  for (const [nodeId, info] of analysis.nodeInfo) {
    const isReducingTee = info.fitting === 'TEE_REDUCING';
    const isOlet = info.fitting === 'OLET';
    if (!isReducingTee && !isOlet) continue;
    const header = isOlet ? oletLegs(info)?.header[0] : info.runs[0];
    const branch = isOlet
      ? oletLegs(info)?.branch
      : info.runs.find((r) => r.dn !== info.runs[0].dn);
    if (!header || !branch || header.dn === branch.dn) continue;
    const at = paper(nodeId);
    if (!at) continue;
    tees += `<text class="branch-note" x="${(at.x + size * 1.4).toFixed(2)}" y="${(at.y - size * 1.4).toFixed(2)}">${escapeText(
      `${sizeLabel(header.dn)}X${sizeLabel(branch.dn)} NS`,
    )}</text>`;
  }

  welds = olets + tees + welds + balloons + callouts;

  // Drag preview.
  let preview = '';
  if (state.preview) {
    const from = paper(state.preview.fromId);
    const fromPos = displayPos(analysis, state.preview.fromId);
    if (from && fromPos) {
      const target = add(fromPos, scale3(AXIS_VECTOR[state.preview.axis], state.preview.length));
      const to = toPaper(target, drawing);
      preview =
        `<line class="preview" x1="${from.x.toFixed(2)}" y1="${from.y.toFixed(2)}" x2="${to.x.toFixed(2)}" y2="${to.y.toFixed(2)}"/>` +
        `<text class="preview-text" x="${((from.x + to.x) / 2).toFixed(2)}" y="${((from.y + to.y) / 2 - size).toFixed(2)}">${formatMm(state.preview.length)}</text>`;
    }
  }

  // Hit targets for runs go under the node and component handles so that a
  // drag starting on a point is never swallowed by the run beneath it.
  // Dimension targets sit under the things on the pipe, so a figure close to
  // a valve never takes the tap meant for the valve.
  return grid + dims + pipes + `<g class="hits">${dimHits}${hits}</g>` + comps + nodes + welds + handles + `<g class="hits">${weldHits}</g>` + preview;
}

/**
 * Nudges labels apart so none sits on top of another.
 *
 * Welds cluster tightly around a fitting and their numbers would otherwise
 * stack into an unreadable smudge. A few relaxation passes push overlapping
 * labels away from each other, which is enough for the handful that ever
 * collide and leaves everything else exactly where it was placed.
 */
/**
 * Pushes labels apart until none sit on top of each other, and clear of the
 * `fixed` points — things already on the sheet that do not move, such as
 * dimension figures and tags that were placed by hand.
 */
function spreadLabels<T extends { x: number; y: number }>(labels: T[], minGap: number, fixed: Pt[] = []): T[] {
  for (let pass = 0; pass < 40; pass += 1) {
    let moved = false;
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        const dx = labels[j].x - labels[i].x;
        const dy = labels[j].y - labels[i].y;
        const d = Math.hypot(dx, dy);
        if (d >= minGap) continue;
        // Coincident labels need a direction to separate along.
        const ux = d > 0.01 ? dx / d : 1;
        const uy = d > 0.01 ? dy / d : 0;
        const push = (minGap - d) / 2;
        labels[i].x -= ux * push;
        labels[i].y -= uy * push;
        labels[j].x += ux * push;
        labels[j].y += uy * push;
        moved = true;
      }
      for (const f of fixed) {
        const dx = labels[i].x - f.x;
        const dy = labels[i].y - f.y;
        const d = Math.hypot(dx, dy);
        if (d >= minGap) continue;
        const ux = d > 0.01 ? dx / d : 0;
        const uy = d > 0.01 ? dy / d : -1;
        labels[i].x += ux * (minGap - d);
        labels[i].y += uy * (minGap - d);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return labels;
}

/** Finds which run a weld sits on so it can be drawn in the run's frame. */
function weldPlacement(
  drawing: Drawing,
  analysis: Analysis,
  pos: Vec3,
): { a: Pt; b: Pt; t: number; perMm: number; plane: { across: Pt; up: Pt } | null } | null {
  let best: { a: Pt; b: Pt; t: number; d: number; perMm: number; plane: { across: Pt; up: Pt } | null } | null = null;
  for (const run of drawing.runs) {
    const fa = analysis.nodeById.get(run.from);
    const fb = analysis.nodeById.get(run.to);
    if (!fa || !fb) continue;
    const vx = fb.pos.e - fa.pos.e;
    const vy = fb.pos.n - fa.pos.n;
    const vz = fb.pos.u - fa.pos.u;
    const lenSq = vx * vx + vy * vy + vz * vz;
    if (lenSq < 1) continue;
    const t = Math.max(
      0,
      Math.min(1, ((pos.e - fa.pos.e) * vx + (pos.n - fa.pos.n) * vy + (pos.u - fa.pos.u) * vz) / lenSq),
    );
    const cx = fa.pos.e + vx * t;
    const cy = fa.pos.n + vy * t;
    const cz = fa.pos.u + vz * t;
    const d = Math.hypot(pos.e - cx, pos.n - cy, pos.u - cz);
    if (!best || d < best.d) {
      const a = paperOf(analysis, drawing, run.from);
      const b = paperOf(analysis, drawing, run.to);
      if (a && b) best = { a, b, t, d, perMm: Math.hypot(b.x - a.x, b.y - a.y) / Math.sqrt(lenSq), plane: symbolPlane(drawing, fa.pos, fb.pos) };
    }
  }
  return best ? { a: best.a, b: best.b, t: best.t, perMm: best.perMm, plane: best.plane } : null;
}

/** Small compass drawn as a screen-fixed overlay rather than part of the sheet. */
export function northArrow(drawing: Drawing, size = 58): string {
  const dir = axisScreenDir('N', drawing.options.northRotation);
  const c = size / 2;
  const ring = size * 0.3;
  const tip = { x: c + dir.x * ring * 0.86, y: c + dir.y * ring * 0.86 };
  const tail = { x: c - dir.x * ring * 0.7, y: c - dir.y * ring * 0.7 };
  const wing = { x: -dir.y * ring * 0.42, y: dir.x * ring * 0.42 };
  const label = { x: c + dir.x * ring * 1.62, y: c + dir.y * ring * 1.62 };
  const points = [
    `${tip.x.toFixed(1)},${tip.y.toFixed(1)}`,
    `${(tail.x + wing.x).toFixed(1)},${(tail.y + wing.y).toFixed(1)}`,
    `${c.toFixed(1)},${c.toFixed(1)}`,
    `${(tail.x - wing.x).toFixed(1)},${(tail.y - wing.y).toFixed(1)}`,
  ].join(' ');
  return (
    `<svg class="compass" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-label="North arrow">` +
    `<circle class="compass-ring" cx="${c}" cy="${c}" r="${ring.toFixed(1)}"/>` +
    `<polygon class="compass-needle" points="${points}"/>` +
    `<text x="${label.x.toFixed(1)}" y="${(label.y + 4).toFixed(1)}">N</text>` +
    `</svg>`
  );
}

export { COMPONENT_LABEL, TERMINAL_LABEL, fittingLabel };

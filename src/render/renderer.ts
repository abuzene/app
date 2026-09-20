import type { Analysis } from '../model/drawing';
import type { Axis, Drawing, Vec3 } from '../model/types';
import { COMPONENT_LABEL, TERMINAL_LABEL, fittingLabel } from '../model/drawing';
import { AXIS_VECTOR, axisScreenDir, project, scale3, add } from '../model/iso';
import { componentSymbol, frameFor, terminalSymbol, weldSymbol } from './symbols';

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
  | null;

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
  /** Symbol half-size in paper units. */
  symbolSize?: number;
}

export interface Pt {
  x: number;
  y: number;
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

function formatMm(value: number): string {
  const rounded = Math.round(value);
  return rounded.toLocaleString('en-GB');
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
): string {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return '';
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

  return (
    `<g class="dim">` +
    ext(a, { x: ax, y: ay }) +
    ext(b, { x: bx, y: by }) +
    `<line class="dim-line" x1="${ax.toFixed(2)}" y1="${ay.toFixed(2)}" x2="${bx.toFixed(2)}" y2="${by.toFixed(2)}"/>` +
    slash(ax, ay) +
    slash(bx, by) +
    `<text class="dim-text" x="${tx.toFixed(2)}" y="${(ty - size * 0.45).toFixed(2)}" transform="rotate(${angle.toFixed(1)} ${tx.toFixed(2)} ${ty.toFixed(2)})">${escapeText(text)}</text>` +
    `</g>`
  );
}

export function renderDrawing(state: RenderState): string {
  const { drawing, analysis, view, selection } = state;
  const size = state.symbolSize ?? 11;
  const sel = selection;

  const bounds = contentBounds(drawing, analysis);
  const centroid: Pt = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };

  const paper = (id: string) => paperOf(analysis, drawing, id);

  let grid = '';
  if (drawing.options.showGrid) grid = renderGrid(drawing, view);

  let pipes = '';
  let hits = '';
  let dims = '';
  let comps = '';

  for (const run of drawing.runs) {
    const a = paper(run.from);
    const b = paper(run.to);
    if (!a || !b) continue;
    const selected = sel?.kind === 'run' && sel.id === run.id;
    pipes += `<line class="pipe${selected ? ' selected' : ''}" x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}"/>`;
    hits += `<line class="hit" data-run="${run.id}" x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}"/>`;

    const lengths = analysis.runLengths.get(run.id);
    if (drawing.options.showDimensions && lengths && !run.noDim) {
      dims += renderDimension(a, b, centroid, formatMm(lengths.centre), size);
    }

    // Inline components, positioned by their true offset along the run.
    const total = lengths?.centre ?? 0;
    for (const comp of run.inline) {
      const t = total > 0 ? Math.max(0, Math.min(1, comp.offset / total)) : 0.5;
      const f = frameFor(a.x, a.y, b.x, b.y, t, size);
      const selectedComp = sel?.kind === 'component' && sel.id === comp.id;
      comps += `<g class="component${selectedComp ? ' selected' : ''}" data-component="${comp.id}">`;
      comps += componentSymbol(comp.kind, f);
      const label = comp.tag ?? '';
      if (label) {
        comps += `<text class="tag" x="${(f.cx + f.nx * size * 2.2).toFixed(2)}" y="${(f.cy + f.ny * size * 2.2).toFixed(2)}">${escapeText(label)}</text>`;
      }
      comps += `<circle class="hit-dot" data-component="${comp.id}" cx="${f.cx.toFixed(2)}" cy="${f.cy.toFixed(2)}" r="${(size * 1.3).toFixed(2)}"/>`;
      comps += `</g>`;
    }
  }

  // Nodes: fitting corners, terminals and labels.
  let nodes = '';
  for (const node of drawing.nodes) {
    const p = paper(node.id);
    if (!p) continue;
    const info = analysis.nodeInfo.get(node.id);
    const selected = sel?.kind === 'node' && sel.id === node.id;

    nodes += `<g class="node${selected ? ' selected' : ''}" data-node="${node.id}">`;

    if (info && info.degree === 1 && node.terminal && node.terminal.kind !== 'OPEN') {
      // Orient the end symbol along the single run leaving this node.
      const run = info.runs[0];
      const otherId = run.from === node.id ? run.to : run.from;
      const q = paper(otherId);
      if (q) {
        const f = frameFor(p.x, p.y, q.x, q.y, 0, size);
        nodes += terminalSymbol(node.terminal.kind, f);
        if (node.terminal.note) {
          nodes += `<text class="note" x="${(p.x - f.dx * size * 2).toFixed(2)}" y="${(p.y - f.dy * size * 2).toFixed(2)}">${escapeText(node.terminal.note)}</text>`;
        }
      }
    }

    if (drawing.options.showNodeLabels && node.label) {
      nodes += `<text class="node-label" x="${(p.x + size * 1.2).toFixed(2)}" y="${(p.y - size * 1.2).toFixed(2)}">${escapeText(node.label)}</text>`;
    }

    nodes += `<circle class="hit-dot" data-node="${node.id}" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${(size * 1.1).toFixed(2)}"/>`;
    if (selected) nodes += `<circle class="node-mark" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${(size * 0.8).toFixed(2)}"/>`;
    nodes += `</g>`;
  }

  // Welds sit on the run they belong to, positioned by true distance.
  let welds = '';
  if (drawing.options.showWelds) {
    analysis.welds.forEach((weld, index) => {
      const place = weldPlacement(drawing, analysis, weld.pos);
      if (!place) return;
      const f = frameFor(place.a.x, place.a.y, place.b.x, place.b.y, place.t, size);
      // Welds cluster around fittings, so stagger the tags either side of the
      // pipe rather than stacking them all on the same one.
      const side = index % 2 === 0 ? 1 : -1;
      const lx = f.cx + f.nx * size * 1.7 * side;
      const ly = f.cy + f.ny * size * 1.7 * side;
      welds += `<g class="weld">`;
      welds += weldSymbol(f, weld.type === 'FIELD');
      welds += `<text class="weld-no" x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" text-anchor="middle">${escapeText(weld.number)}</text>`;
      welds += `</g>`;
    });
  }

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
  return grid + dims + pipes + `<g class="hits">${hits}</g>` + comps + nodes + welds + preview;
}

/** Finds which run a weld sits on so it can be drawn in the run's frame. */
function weldPlacement(
  drawing: Drawing,
  analysis: Analysis,
  pos: Vec3,
): { a: Pt; b: Pt; t: number } | null {
  let best: { a: Pt; b: Pt; t: number; d: number } | null = null;
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
      if (a && b) best = { a, b, t, d };
    }
  }
  return best ? { a: best.a, b: best.b, t: best.t } : null;
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

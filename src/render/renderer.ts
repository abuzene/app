import type { Analysis } from '../model/drawing';
import type { Axis, Drawing, Vec3 } from '../model/types';
import { COMPONENT_LABEL, TERMINAL_LABEL, fittingLabel, oletLegs, resolveEnds } from '../model/drawing';
import { sizeLabel } from '../model/pipe-data';
import { AXIS_VECTOR, axisBetween, axisScreenDir, project, scale3, add } from '../model/iso';
import { componentSymbol, flangeSymbol, frameFor, isFlange, jointMark, oletSymbol, terminalSymbol } from './symbols';

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
    // Clear of the dimension line, never sitting across it.
    `<text class="dim-text" x="${tx.toFixed(2)}" y="${(ty - size * 0.75).toFixed(2)}" transform="rotate(${angle.toFixed(1)} ${tx.toFixed(2)} ${ty.toFixed(2)})">${escapeText(text)}</text>` +
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
    const plane = symbolPlane(drawing, analysis.nodeById.get(run.from)!.pos, analysis.nodeById.get(run.to)!.pos);
    for (const comp of run.inline) {
      const t = total > 0 ? Math.max(0, Math.min(1, comp.offset / total)) : 0.5;
      const f = frameFor(a.x, a.y, b.x, b.y, t, size, plane?.across, plane?.up);
      const selectedComp = sel?.kind === 'component' && sel.id === comp.id;
      comps += `<g class="component${selectedComp ? ' selected' : ''}" data-component="${comp.id}">`;
      comps += componentSymbol(comp.kind, f);

      // A flanged component is drawn with the flanges it bolts between, each
      // facing in towards it, which is how it is actually built.
      const ends = resolveEnds(comp.kind, comp.dn ?? run.dn, comp.ends, drawing.options.joint ?? 'BW');
      if (ends === 'FLG' && !isFlange(comp.kind)) {
        const gap = size * 2.6;
        comps += flangeSymbol({ ...f, cx: f.cx - f.dx * gap, cy: f.cy - f.dy * gap }, 'FLG_WN', 1);
        comps += flangeSymbol({ ...f, cx: f.cx + f.dx * gap, cy: f.cy + f.dy * gap }, 'FLG_WN', -1);
      }
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

    nodes += `<circle class="hit-dot" data-node="${node.id}" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${(size * 1.1).toFixed(2)}"/>`;
    if (selected) nodes += `<circle class="node-mark" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${(size * 0.8).toFixed(2)}"/>`;
    nodes += `</g>`;
  }

  // Joint marks sit on the run they belong to, positioned by true distance.
  // They are part of the fitting symbol, so they are always drawn; only the
  // weld numbers follow the Welds toggle.
  let welds = '';
  const jointPoints = new Map<string, Pt>();
  const weldLabels: { x: number; y: number; text: string; fromX: number; fromY: number }[] = [];

  analysis.joints.forEach((joint, index) => {
    const place = weldPlacement(drawing, analysis, joint.pos);
    if (!place) return;
    const f = frameFor(
      place.a.x,
      place.a.y,
      place.b.x,
      place.b.y,
      place.t,
      size,
      place.plane?.across,
      place.plane?.up,
    );
    jointPoints.set(joint.key, { x: f.cx, y: f.cy });
    welds += `<g class="weld">${jointMark(f, joint.joint, joint.facing)}</g>`;
    if (drawing.options.showWelds && joint.number) {
      // Joints cluster around fittings, so stagger the tags either side of the
      // pipe rather than stacking them all on the same one.
      const side = index % 2 === 0 ? 1 : -1;
      weldLabels.push({
        x: f.cx + f.nx * size * 3 * side,
        y: f.cy + f.ny * size * 3 * side,
        text: joint.number,
        fromX: f.cx,
        fromY: f.cy,
      });
    }
  });

  for (const label of spreadLabels(weldLabels, size * 2.1)) {
    // A tag pushed clear of its neighbours gets a leader back to its weld, so
    // it is never ambiguous which joint it belongs to.
    const reach = Math.hypot(label.x - label.fromX, label.y - label.fromY);
    const leader =
      reach > size * 3.6
        ? `<line class="weld-leader" x1="${label.fromX.toFixed(2)}" y1="${label.fromY.toFixed(2)}" x2="${label.x.toFixed(2)}" y2="${label.y.toFixed(2)}"/>`
        : '';
    welds += `<g class="weld">${leader}<text class="weld-no" x="${label.x.toFixed(2)}" y="${(label.y + size * 0.3).toFixed(2)}" text-anchor="middle">${escapeText(label.text)}</text></g>`;
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
        return {
          number: item.number,
          fromX: f.cx,
          fromY: f.cy,
          x: f.cx + f.nx * reach * inward,
          y: f.cy + f.ny * reach * inward,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    const r = size * 1.3;
    for (const mark of spreadLabels(marks, r * 2.9)) {
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
        `<text class="balloon-no" x="${mark.x.toFixed(2)}" y="${(mark.y + size * 0.42).toFixed(2)}" text-anchor="middle">${mark.number}</text>` +
        `</g>`;
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

  welds = olets + tees + welds + balloons;

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

/**
 * Nudges labels apart so none sits on top of another.
 *
 * Welds cluster tightly around a fitting and their numbers would otherwise
 * stack into an unreadable smudge. A few relaxation passes push overlapping
 * labels away from each other, which is enough for the handful that ever
 * collide and leaves everything else exactly where it was placed.
 */
function spreadLabels<T extends { x: number; y: number }>(labels: T[], minGap: number): T[] {
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
): { a: Pt; b: Pt; t: number; plane: { across: Pt; up: Pt } | null } | null {
  let best: { a: Pt; b: Pt; t: number; d: number; plane: { across: Pt; up: Pt } | null } | null = null;
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
      if (a && b) best = { a, b, t, d, plane: symbolPlane(drawing, fa.pos, fb.pos) };
    }
  }
  return best ? { a: best.a, b: best.b, t: best.t, plane: best.plane } : null;
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

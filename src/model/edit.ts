import type { Axis, ComponentKind, Drawing, EndType, Equipment, FlangeKind, InlineComponent, IsoNode, Run, TerminalKind, Vec3 } from './types';
import { add, axisBetween, direction, equals3, length3, scale3, step, sub } from './iso';
import { dimensionStops, fittingsTouchLength, isValve, itemAtEnd, terminalTakeoutOf, uid, type Analysis } from './drawing';
import { componentTakeout } from './pipe-data';

/** Finds an existing node at a position, so that routes join rather than overlap. */
export function findNodeAt(drawing: Drawing, pos: Vec3, tol = 0.5): string | null {
  for (const node of drawing.nodes) {
    if (equals3(node.pos, pos, tol)) return node.id;
  }
  return null;
}

export function ensureNode(drawing: Drawing, pos: Vec3): string {
  const existing = findNodeAt(drawing, pos);
  if (existing) return existing;
  const id = uid('n');
  drawing.nodes.push({ id, pos: { ...pos } });
  return id;
}

export function runBetween(drawing: Drawing, a: string, b: string): Run | undefined {
  return drawing.runs.find(
    (r) => (r.from === a && r.to === b) || (r.from === b && r.to === a),
  );
}

export function addRun(
  drawing: Drawing,
  from: string,
  to: string,
  dn: string,
  schedule: string,
): Run | null {
  if (from === to) return null;
  const existing = runBetween(drawing, from, to);
  if (existing) return existing;
  const run: Run = { id: uid('r'), from, to, dn, schedule, inline: [] };
  drawing.runs.push(run);
  return run;
}

export interface RouteResult {
  run: Run | null;
  nodeId: string;
  /** Set when nothing was drawn, saying why. */
  refused?: string;
}

/**
 * Routes `length` mm along `axis` from a node, creating or joining the far node.
 *
 * If a run already leaves the node along that same axis the two would lie on top
 * of one another, which is never what is meant. Instead the existing run is
 * reused: a shorter route splits it, a longer one carries on from its far end.
 */
export function route(
  drawing: Drawing,
  fromId: string,
  axis: Axis,
  length: number,
  dn: string,
  schedule: string,
  depth = 0,
  /** How long to draw the run when the sheet is not to scale: where the pencil put it. */
  visual?: number,
): RouteResult | null {
  const from = drawing.nodes.find((n) => n.id === fromId);
  if (!from || length <= 0) return null;

  // A flange bolts to the flange facing it, so past a flanged end the line
  // can only carry straight on. A bend there needs a piece of pipe first.
  if (from.terminal && isFlangeKind(from.terminal.kind)) {
    const only = drawing.runs.find((r) => r.from === fromId || r.to === fromId);
    const other = only ? drawing.nodes.find((n) => n.id === (only.from === fromId ? only.to : only.from)) : undefined;
    const arrive = only && other ? axisBetween(other.pos, from.pos) : null;
    const back = only && other ? axisBetween(from.pos, other.pos) : null;
    if (arrive && axis !== arrive && axis !== back) {
      return { run: null, nodeId: fromId, refused: 'A flange continues straight on — add a length of pipe before turning.' };
    }
  }

  if (depth < 64) {
    const overlapping = findRunAlong(drawing, fromId, axis);
    if (overlapping) {
      const { run, farId, farLength } = overlapping;
      if (Math.abs(farLength - length) < 0.5) return { run, nodeId: farId };
      if (length < farLength) {
        // The new point falls inside the existing run, so break it there.
        const distance = run.from === fromId ? length : farLength - length;
        const midId = splitRun(drawing, run.id, distance);
        return midId ? { run: drawing.runs.find((r) => r.id === run.id) ?? run, nodeId: midId } : null;
      }
      return route(drawing, farId, axis, length - farLength, dn, schedule, depth + 1, visual === undefined ? undefined : Math.max(1, visual - farLength));
    }
  }

  const target = step(from.pos, axis, length);
  if (overlapsExisting(drawing, from.pos, target)) {
    return { run: null, nodeId: fromId, refused: 'That would lie on top of a line already drawn.' };
  }
  const toId = ensureNode(drawing, target);
  const fresh = !runBetween(drawing, fromId, toId);
  const run = addRun(drawing, fromId, toId, dn, schedule);
  // Drawn not to scale, the run still ends where the pencil put it. Typed
  // runs carry no drawn length and take the sheet's even spacing.
  if (run && fresh && visual !== undefined) run.visual = visual;
  if (run) settleEnds(drawing, [fromId, toId]);
  return { run, nodeId: toId };
}

/**
 * Whether a segment would lie along an existing run: same line, sharing more
 * than a point. Two lines on top of each other cannot be read, so it is never
 * allowed to happen.
 */
export function overlapsExisting(drawing: Drawing, a: Vec3, b: Vec3, ignoreRunId?: string): boolean {
  const ab = sub(b, a);
  const len = length3(ab);
  if (len < 0.01) return false;
  const unit = { e: ab.e / len, n: ab.n / len, u: ab.u / len };
  for (const run of drawing.runs) {
    if (run.id === ignoreRunId) continue;
    const p = drawing.nodes.find((n) => n.id === run.from);
    const q = drawing.nodes.find((n) => n.id === run.to);
    if (!p || !q) continue;
    // Collinear: both ends of the run sit on the new segment's line.
    const off = (v: Vec3) => {
      const d = sub(v, a);
      const t = d.e * unit.e + d.n * unit.n + d.u * unit.u;
      const away = sub(d, { e: unit.e * t, n: unit.n * t, u: unit.u * t });
      return { t, away: length3(away) };
    };
    const P = off(p.pos);
    const Q = off(q.pos);
    if (P.away > 0.5 || Q.away > 0.5) continue;
    const lo = Math.min(P.t, Q.t);
    const hi = Math.max(P.t, Q.t);
    if (Math.min(hi, len) - Math.max(lo, 0) > 0.5) return true;
  }
  return false;
}

/**
 * Keeps what sits on a point true to how many runs meet there.
 *
 * A flange is a break in the line, so the line can only carry on past one by
 * bolting another flange against it: an end flange that the route continues
 * through becomes a flanged joint, and a flanged joint left with one run
 * becomes an end flange again. A cap or a blind is simply gone once the line
 * carries on, and a plain end mark stops applying.
 */
export function settleEnds(drawing: Drawing, ids: string[]): void {
  for (const id of ids) {
    const node = drawing.nodes.find((n) => n.id === id);
    if (!node) continue;
    const touching = drawing.runs.filter((r) => r.from === id || r.to === id).length;
    if (node.terminal && touching > 1) {
      const kind = node.terminal.kind;
      node.terminal = undefined;
      if (isFlangeKind(kind) && kind !== 'FLG_BLIND') node.flange = kind;
    }
    if (node.flange && touching <= 1) {
      node.terminal = { kind: node.flange };
      node.flange = undefined;
    }
  }
}

function isFlangeKind(kind: string): kind is FlangeKind {
  return ['FLG_WN', 'FLG_SO', 'FLG_SW', 'FLG_THD', 'FLG_LAP', 'FLG_BLIND'].includes(kind);
}

/**
 * Puts a flanged joint on a run: the run is broken at that distance and the
 * two halves bolted together there. Returns the point the joint sits on.
 */
export function addFlangeJoint(drawing: Drawing, runId: string, distance: number, kind: FlangeKind): string | null {
  const run = drawing.runs.find((r) => r.id === runId);
  if (!run) return null;
  const total = runLength(drawing, run);
  const snapped = Math.max(1, Math.min(total - 1, distance));
  const nodeId = splitRun(drawing, run.id, snapped);
  if (!nodeId) return null;
  const node = drawing.nodes.find((n) => n.id === nodeId);
  if (node) node.flange = kind;
  return nodeId;
}

/**
 * Where along a run a point sits, as a distance from its start. Used to place
 * and then slide the things that sit in the line.
 */
export function offsetAlongRun(drawing: Drawing, run: Run, pos: Vec3): number {
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  if (!a || !b) return 0;
  const v = sub(b.pos, a.pos);
  const len = length3(v);
  if (len < 0.01) return 0;
  const d = sub(pos, a.pos);
  const t = (d.e * v.e + d.n * v.n + d.u * v.u) / (len * len);
  return Math.max(0, Math.min(len, t * len));
}

/** The run leaving `nodeId` along `axis`, if there is one. */
function findRunAlong(
  drawing: Drawing,
  nodeId: string,
  axis: Axis,
): { run: Run; farId: string; farLength: number } | null {
  const node = drawing.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  for (const run of drawing.runs) {
    const farId = run.from === nodeId ? run.to : run.to === nodeId ? run.from : null;
    if (!farId) continue;
    const far = drawing.nodes.find((n) => n.id === farId);
    if (!far) continue;
    if (axisBetween(node.pos, far.pos) !== axis) continue;
    return { run, farId, farLength: length3(sub(far.pos, node.pos)) };
  }
  return null;
}

/** Removes nodes that no longer carry any run. */
export function pruneNodes(drawing: Drawing): void {
  const used = new Set<string>();
  for (const run of drawing.runs) {
    used.add(run.from);
    used.add(run.to);
  }
  drawing.nodes = drawing.nodes.filter((n) => used.has(n.id));
}

export function deleteRun(drawing: Drawing, runId: string): void {
  const run = drawing.runs.find((r) => r.id === runId);
  drawing.runs = drawing.runs.filter((r) => r.id !== runId);
  pruneNodes(drawing);
  if (run) settleEnds(drawing, [run.from, run.to]);
}

export function deleteNode(drawing: Drawing, nodeId: string): void {
  const touched = drawing.runs
    .filter((r) => r.from === nodeId || r.to === nodeId)
    .map((r) => (r.from === nodeId ? r.to : r.from));
  drawing.runs = drawing.runs.filter((r) => r.from !== nodeId && r.to !== nodeId);
  drawing.nodes = drawing.nodes.filter((n) => n.id !== nodeId);
  pruneNodes(drawing);
  settleEnds(drawing, touched);
}

export function runLength(drawing: Drawing, run: Run): number {
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  if (!a || !b) return 0;
  return length3(sub(b.pos, a.pos));
}

export function addComponent(
  drawing: Drawing,
  runId: string,
  kind: ComponentKind,
  offset?: number,
  ends?: EndType,
): InlineComponent | null {
  const run = drawing.runs.find((r) => r.id === runId);
  if (!run) return null;
  const total = runLength(drawing, run);
  const at = offset === undefined ? total / 2 : Math.max(0, Math.min(total, offset));
  // Leaving `ends` unset lets the component follow the drawing's joint type.
  const comp: InlineComponent = { id: uid('c'), kind, offset: at, ends };
  run.inline.push(comp);
  run.inline.sort((a, b) => a.offset - b.offset);
  return comp;
}

export function removeComponent(drawing: Drawing, compId: string): void {
  for (const run of drawing.runs) {
    run.inline = run.inline.filter((c) => c.id !== compId);
  }
}

/**
 * Moves a node, dragging its connected runs with it. Other nodes stay put, so
 * the runs either side change length — which is what a user expects when they
 * nudge a corner of the route.
 */
export function moveNode(drawing: Drawing, nodeId: string, pos: Vec3): void {
  const node = drawing.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const existing = findNodeAt(drawing, pos);
  node.pos = { ...pos };
  if (existing && existing !== nodeId) mergeNodes(drawing, existing, nodeId);
}

/** Merges `loser` into `keeper`, rewiring runs and dropping any that collapse. */
export function mergeNodes(drawing: Drawing, keeper: string, loser: string): void {
  for (const run of drawing.runs) {
    if (run.from === loser) run.from = keeper;
    if (run.to === loser) run.to = keeper;
  }
  drawing.runs = drawing.runs.filter((r) => r.from !== r.to);
  const seen = new Set<string>();
  drawing.runs = drawing.runs.filter((r) => {
    const key = [r.from, r.to].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  drawing.nodes = drawing.nodes.filter((n) => n.id !== loser);
}

/** Splits a run at a distance from its start, returning the new middle node. */
export function splitRun(drawing: Drawing, runId: string, distance: number): string | null {
  const run = drawing.runs.find((r) => r.id === runId);
  if (!run) return null;
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  if (!a || !b) return null;
  const total = length3(sub(b.pos, a.pos));
  if (distance <= 0 || distance >= total) return null;
  const t = distance / total;
  const pos: Vec3 = {
    e: a.pos.e + (b.pos.e - a.pos.e) * t,
    n: a.pos.n + (b.pos.n - a.pos.n) * t,
    u: a.pos.u + (b.pos.u - a.pos.u) * t,
  };
  const midId = ensureNode(drawing, pos);
  const tail: Run = {
    id: uid('r'),
    from: midId,
    to: run.to,
    dn: run.dn,
    schedule: run.schedule,
    inline: run.inline.filter((c) => c.offset > distance).map((c) => ({ ...c, offset: c.offset - distance })),
  };
  run.inline = run.inline.filter((c) => c.offset <= distance);
  run.to = midId;
  // The two halves share the drawn length the way they share the true one.
  if (run.visual !== undefined) {
    tail.visual = run.visual * (1 - t);
    run.visual = run.visual * t;
  }
  drawing.runs.splice(drawing.runs.indexOf(run) + 1, 0, tail);
  return midId;
}

/**
 * Changes a run's length by moving its far node, taking everything downstream
 * of that node with it — which is how a route behaves when a dimension is
 * corrected. If the far side loops back to the near side the branch cannot move
 * independently, so only the node itself is moved and the loop re-closes.
 */
/**
 * Joins the fittings at a run's two ends to each other directly, with no
 * pipe between — an elbow welded straight to an olet, say. The run stays,
 * as the fittings' centre-to-centre distance, and is pulled in to exactly
 * that: the sum of the two take-outs. Off again, the run is a pipe as before.
 */
export function setRunDirect(drawing: Drawing, analysis: Analysis, runId: string, direct: boolean): void {
  const run = drawing.runs.find((r) => r.id === runId);
  if (!run) return;
  run.direct = direct || undefined;
  if (!direct) return;
  const touch = fittingsTouchLength(drawing, analysis, run);
  if (touch > 0 && Math.abs(runLength(drawing, run) - touch) > 0.5) stretchRun(drawing, runId, touch, 'to');
}

export function setRunLength(drawing: Drawing, runId: string, length: number): boolean {
  return stretchRun(drawing, runId, length, 'to');
}

/**
 * Sets a run's length by moving one of its ends along its own line — never
 * turning it. `end` says which end moves; the other stays put.
 */
export function stretchRun(drawing: Drawing, runId: string, length: number, end: 'from' | 'to'): boolean {
  const run = drawing.runs.find((r) => r.id === runId);
  if (!run || length <= 0) return false;
  const start = drawing.nodes.find((n) => n.id === run.from);
  const finish = drawing.nodes.find((n) => n.id === run.to);
  if (!start || !finish) return false;
  // Seen from the end that stays: `from` is fixed, `to` moves.
  const from = end === 'to' ? start : finish;
  const to = end === 'to' ? finish : start;

  const current = length3(sub(to.pos, from.pos));
  if (current < 0.01) return false;
  const unit = {
    e: (to.pos.e - from.pos.e) / current,
    n: (to.pos.n - from.pos.n) / current,
    u: (to.pos.u - from.pos.u) / current,
  };
  const delta = {
    e: unit.e * (length - current),
    n: unit.n * (length - current),
    u: unit.u * (length - current),
  };
  if (Math.abs(delta.e) < 1e-6 && Math.abs(delta.n) < 1e-6 && Math.abs(delta.u) < 1e-6) return false;
  const startBefore = { ...start.pos };
  // Whatever sits along the run keeps its place in space; once the start has
  // moved, its distance from the start has changed by as much.
  const settleInline = () => {
    const shift = length3(sub(start.pos, startBefore)) > 1e-6 ? length - current : 0;
    for (const comp of run.inline) comp.offset = Math.max(0, Math.min(length, comp.offset + shift));
  };

  // A point the line runs straight through — a tee, a flange, a plain joint —
  // is placed by the lengths either side of it. Changing one side slides the
  // point and the other side takes up the difference; nothing else moves.
  const beyond = (nodeId: string, awayFrom: Vec3): Run | undefined =>
    drawing.runs.find((other) => {
      if (other.id === run.id || (other.from !== nodeId && other.to !== nodeId)) return false;
      const farId = other.from === nodeId ? other.to : other.from;
      const far = drawing.nodes.find((n) => n.id === farId);
      const here = drawing.nodes.find((n) => n.id === nodeId);
      if (!far || !here) return false;
      const d = sub(far.pos, here.pos);
      const l = length3(d);
      if (l < 0.01) return false;
      const dot = (d.e * unit.e + d.n * unit.n + d.u * unit.u) / l;
      const wantDot = awayFrom === from.pos ? 1 : -1;
      return dot * wantDot > 0.999;
    });
  const slideThrough = (node: IsoNode, next: Run, shift: Vec3): boolean => {
    const farId = next.from === node.id ? next.to : next.from;
    const far = drawing.nodes.find((n) => n.id === farId);
    if (!far) return false;
    const moved = add(node.pos, shift);
    const remaining = sub(far.pos, moved);
    const still = sub(far.pos, node.pos);
    // The other side has to keep some pipe in it, on the same side of the point.
    if (length3(remaining) < 1) return false;
    if (remaining.e * still.e + remaining.n * still.n + remaining.u * still.u <= 0) return false;
    node.pos = moved;
    // What sits along the other side stays where it is in space.
    const total = length3(remaining);
    const along = length3(still) - total;
    for (const comp of next.inline) {
      const fromMoved = next.from === node.id ? comp.offset - along : comp.offset;
      comp.offset = Math.max(0, Math.min(total, fromMoved));
    }
    return true;
  };
  const onward = beyond(to.id, from.pos);
  if (onward && slideThrough(to, onward, delta)) {
    settleInline();
    return true;
  }
  const backward = beyond(from.id, to.pos);
  if (backward && slideThrough(from, backward, scale3(delta, -1))) {
    settleInline();
    return true;
  }

  // Collect the nodes reachable from `to` without passing back through the run.
  const adjacency = new Map<string, string[]>();
  for (const node of drawing.nodes) adjacency.set(node.id, []);
  for (const other of drawing.runs) {
    if (other.id === run.id) continue;
    adjacency.get(other.from)?.push(other.to);
    adjacency.get(other.to)?.push(other.from);
  }

  const moving = new Set<string>([to.id]);
  const queue = [to.id];
  let loops = false;
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of adjacency.get(id) ?? []) {
      if (next === from.id) {
        loops = true;
        continue;
      }
      if (moving.has(next)) continue;
      moving.add(next);
      queue.push(next);
    }
  }

  const ids = loops ? [to.id] : [...moving];
  for (const id of ids) {
    const node = drawing.nodes.find((n) => n.id === id);
    if (node) node.pos = add(node.pos, delta);
  }
  settleInline();
  return true;
}

/**
 * Sets one dimension of a run to a value. The piece before a valve moves the
 * valve; the last piece changes the run's length; a valve's own face-to-face
 * is what it is. Returns why nothing could be done, or null when it was.
 */
export function applyDimension(drawing: Drawing, runId: string, index: number, value: number): string | null {
  const run = drawing.runs.find((r) => r.id === runId);
  if (!run || !(value > 0)) return 'A dimension has to be more than nothing.';
  const stops = dimensionStops(drawing, run);
  if (index < 0 || index + 1 >= stops.length) return 'No such dimension.';
  const total = stops[stops.length - 1];
  const from = stops[index];
  const to = stops[index + 1];
  const valveAt = (mm: number, side: -1 | 1) =>
    run.inline.find((c) => {
      if (!isValve(c.kind)) return false;
      const half = componentTakeout(c.kind, c.dn ?? run.dn, false);
      return Math.abs(c.offset + side * half - mm) < 0.5;
    });
  const lower = valveAt(to, -1);
  if (lower) {
    // Up to a valve face: the valve slides so this piece is the value.
    const half = componentTakeout(lower.kind, lower.dn ?? run.dn, false);
    const offset = from + value + half;
    if (offset + half > total - 0.5) return 'That would push the valve off the end of the run.';
    lower.offset = offset;
    run.inline.sort((x, y) => x.offset - y.offset);
    return null;
  }
  if (valveAt(from, -1) && valveAt(to, 1)) return 'That is the valve itself, face to face.';
  if (to >= total - 0.5) {
    return setRunLength(drawing, run.id, from + value) ? null : 'The line cannot be made that length here.';
  }
  return 'That dimension cannot be set directly.';
}

/**
 * Takes a pair of bolted flanges out of a line and joins the pipe straight
 * through where they were: the two runs either side become one, with what
 * sat along them kept in place. On a point that is not a flanged joint, or
 * where the line turns, only the flanges go and the point stays as a joint.
 */
export function removeFlangeJoint(drawing: Drawing, nodeId: string): boolean {
  const node = drawing.nodes.find((n) => n.id === nodeId);
  if (!node) return false;
  node.flange = undefined;
  joinThrough(drawing, nodeId);
  return true;
}

/**
 * Joins the two runs meeting at a point into one, when they lie on a line:
 * the point goes and the pipe runs straight through, with what sat along
 * either run kept in place. Nothing happens at a corner, a branch or an end.
 */
export function joinThrough(drawing: Drawing, nodeId: string): boolean {
  const node = drawing.nodes.find((n) => n.id === nodeId);
  if (!node) return false;
  const runs = drawing.runs.filter((r) => r.from === nodeId || r.to === nodeId);
  if (runs.length !== 2) return false;
  const [a, b] = runs;
  const farA = drawing.nodes.find((n) => n.id === (a.from === nodeId ? a.to : a.from));
  const farB = drawing.nodes.find((n) => n.id === (b.from === nodeId ? b.to : b.from));
  if (!farA || !farB) return false;
  const inA = axisBetween(farA.pos, node.pos);
  const outB = axisBetween(node.pos, farB.pos);
  if (!inA || inA !== outB) return false;
  // Turn each run so that a ends on the point and b starts from it.
  const turn = (run: Run) => {
    const len = runLength(drawing, run);
    [run.from, run.to] = [run.to, run.from];
    for (const comp of run.inline) comp.offset = len - comp.offset;
    run.inline.sort((x, y) => x.offset - y.offset);
  };
  if (a.to !== nodeId) turn(a);
  if (b.from !== nodeId) turn(b);
  const lenA = runLength(drawing, a);
  a.to = b.to;
  a.inline.push(...b.inline.map((c) => ({ ...c, offset: c.offset + lenA })));
  a.inline.sort((x, y) => x.offset - y.offset);
  if (a.visual !== undefined || b.visual !== undefined) {
    a.visual = (a.visual ?? drawing.options.schematicLength) + (b.visual ?? drawing.options.schematicLength);
  }
  a.direct = undefined;
  drawing.runs = drawing.runs.filter((r) => r.id !== b.id);
  drawing.nodes = drawing.nodes.filter((n) => n.id !== nodeId);
  if (drawing.dimOverrides) delete drawing.dimOverrides[a.id + ':0'];
  return true;
}

/**
 * Whether a point is only a point: the pipe runs straight through it with
 * no fitting, flange, olet or end there, so deleting it can leave the line
 * whole rather than take its runs away.
 */
export function isPlainPoint(drawing: Drawing, nodeId: string): boolean {
  const node = drawing.nodes.find((n) => n.id === nodeId);
  if (!node || node.flange || node.olet || (node.fittingOverride && node.fittingOverride !== 'NONE')) return false;
  const runs = drawing.runs.filter((r) => r.from === nodeId || r.to === nodeId);
  if (runs.length !== 2) return false;
  const far = (run: Run) => drawing.nodes.find((n) => n.id === (run.from === nodeId ? run.to : run.from));
  const a = far(runs[0]);
  const b = far(runs[1]);
  if (!a || !b) return false;
  const inA = axisBetween(a.pos, node.pos);
  const outB = axisBetween(node.pos, b.pos);
  return !!inA && inA === outB;
}

/**
 * Deletes a point. A plain point along a line (a weld put in, a face a
 * reducer was drawn from) just goes, and the pipe runs straight through —
 * as a pair of flanges comes out. A corner, branch or end takes its runs
 * with it, since there is nothing to join.
 */
export function deletePoint(drawing: Drawing, nodeId: string): 'joined' | 'deleted' {
  if (isPlainPoint(drawing, nodeId) && joinThrough(drawing, nodeId)) return 'joined';
  deleteNode(drawing, nodeId);
  return 'deleted';
}

/**
 * Takes an olet off the line. With its branch gone (or never drawn) the two
 * header runs are joined back into one, so no joint is left where it sat.
 */
export function removeOlet(drawing: Drawing, nodeId: string): void {
  const node = drawing.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  node.olet = undefined;
  if (node.fittingOverride === 'OLET') node.fittingOverride = undefined;
  node.joint = undefined;
  if (drawing.runs.filter((r) => r.from === nodeId || r.to === nodeId).length === 2) removeFlangeJoint(drawing, nodeId);
}

/** Puts an equipment box on a point, reaching away from the line that ends there. */
export function addEquipment(drawing: Drawing, nodeId: string, name: string): Equipment | null {
  const node = drawing.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const run = drawing.runs.find((r) => r.from === nodeId || r.to === nodeId);
  const other = run ? drawing.nodes.find((n) => n.id === (run.from === nodeId ? run.to : run.from)) : undefined;
  // Away from the pipe: on along the line's last leg; east when there is none.
  const axis: Axis = other ? axisBetween(other.pos, node.pos) ?? 'E' : 'E';
  const across: Axis = axis === 'U' || axis === 'D' ? 'E' : axis === 'E' || axis === 'W' ? 'N' : 'E';
  const box: Equipment = { id: uid('q'), at: { ...node.pos }, axis, across, length: 1500, width: 1000, name };
  drawing.equipment = [...(drawing.equipment ?? []), box];
  return box;
}

export function removeEquipment(drawing: Drawing, id: string): void {
  drawing.equipment = (drawing.equipment ?? []).filter((q) => q.id !== id);
  if (drawing.itemOverrides) delete drawing.itemOverrides[`eq:${id}`];
}

/**
 * Sets a reducer's two sizes and which way round it sits, and makes the
 * pipe either side of it the size that side of it is: the run it sits in
 * takes the size on the side the rest of that run lies, and a run carrying
 * on from a face that sits on the run's end takes the other size.
 */
export function applyReducer(drawing: Drawing, compId: string, large: string, small: string, flip: boolean): void {
  const run = drawing.runs.find((r) => r.inline.some((c) => c.id === compId));
  const comp = run?.inline.find((c) => c.id === compId);
  if (!run || !comp) return;
  comp.dn = large;
  comp.dn2 = small;
  comp.flip = flip || undefined;
  const startSide = flip ? small : large;
  const endSide = flip ? large : small;
  const half = componentTakeout(comp.kind, large);
  const total = runLength(drawing, run);
  // A face on the run's end, or against the flange that ends the line there.
  const backStart = terminalTakeoutOf(drawing.nodes.find((n) => n.id === run.from)?.terminal?.kind, startSide);
  const backEnd = terminalTakeoutOf(drawing.nodes.find((n) => n.id === run.to)?.terminal?.kind, endSide);
  const atStart = Math.abs(comp.offset - half - backStart) < 0.5;
  const atEnd = Math.abs(comp.offset + half + backEnd - total) < 0.5;
  run.dn = atStart && !atEnd ? endSide : startSide;
  // The line beyond a face is that size on through its elbows and joints,
  // up to a branch point or another reducer, which have sizes of their own.
  const beyond = (nodeId: string, size: string) => {
    const seen = new Set<string>([run.id]);
    const queue = [nodeId];
    while (queue.length > 0) {
      const at = queue.shift()!;
      const touching = drawing.runs.filter((r) => r.from === at || r.to === at);
      if (touching.length > 2) continue;
      for (const other of touching) {
        if (seen.has(other.id)) continue;
        seen.add(other.id);
        other.dn = size;
        if (other.inline.some((c) => c.kind === 'RED_CONC' || c.kind === 'RED_ECC')) continue;
        queue.push(other.from === at ? other.to : other.from);
      }
    }
  };
  if (atEnd) beyond(run.to, endSide);
  if (atStart) beyond(run.from, startSide);
}

/**
 * Ends the line at a point with a flange, cap or transition — or takes it
 * off again. An item whose face sits on the point (a reducer placed there)
 * keeps its place against the new end piece: the point moves out by the
 * piece's length, so the flange is welded straight to the item, with no
 * pipe between; taken off, the point comes back in.
 */
export function setTerminal(drawing: Drawing, nodeId: string, kind: TerminalKind | undefined, note?: string): void {
  const node = drawing.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  const run = drawing.runs.find((r) => r.from === nodeId || r.to === nodeId);
  const other = run ? drawing.nodes.find((n) => n.id === (run.from === nodeId ? run.to : run.from)) : undefined;
  if (run && other) {
    const atStart = run.from === nodeId;
    const meets = itemAtEnd(drawing, run, atStart);
    if (meets) {
      const shift = terminalTakeoutOf(kind, meets.dn) - meets.face;
      const out = direction(other.pos, node.pos);
      if (Math.abs(shift) > 0.5 && out) {
        node.pos = add(node.pos, scale3(out, shift));
        if (atStart) for (const c of run.inline) c.offset += shift;
      }
    }
  }
  node.terminal = kind ? { kind, note: note ?? node.terminal?.note } : undefined;
}

/** Whether pipe already leads from one point to the other, however far round. */
export function samePiece(drawing: Drawing, a: string, b: string): boolean {
  const seen = new Set<string>([a]);
  const queue = [a];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === b) return true;
    for (const run of drawing.runs) {
      const next = run.from === id ? run.to : run.to === id ? run.from : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

export interface ConnectResult {
  /** The points the new pipe passes through, from the first to the second. */
  path: string[];
  /** Set when nothing was drawn, saying why. */
  refused?: string;
}

/**
 * Joins two points with pipe: one run when they lie on a line, otherwise
 * a run along each axis they differ in, turning at a corner between. This is
 * how a gap is closed again after a length or a fitting has been taken out:
 * the open end is drawn to the other open end, and the corner gets its elbow
 * from the turn, like any other. Of the ways round, the one with the fewest
 * turns is taken — straight on out of the first point where that helps, and
 * straight into the second — as long as it lies along no line already drawn.
 */
export function connectNodes(drawing: Drawing, fromId: string, toId: string, dn: string, schedule: string): ConnectResult {
  const from = drawing.nodes.find((n) => n.id === fromId);
  const to = drawing.nodes.find((n) => n.id === toId);
  if (!from || !to || fromId === toId) return { path: [], refused: 'Pick another point to join this one to.' };
  if (runBetween(drawing, fromId, toId)) return { path: [], refused: 'Those two points are joined already.' };

  const d = sub(to.pos, from.pos);
  const legs: { axis: Axis; length: number }[] = [];
  if (Math.abs(d.e) > 0.5) legs.push({ axis: d.e > 0 ? 'E' : 'W', length: Math.abs(d.e) });
  if (Math.abs(d.n) > 0.5) legs.push({ axis: d.n > 0 ? 'N' : 'S', length: Math.abs(d.n) });
  if (Math.abs(d.u) > 0.5) legs.push({ axis: d.u > 0 ? 'U' : 'D', length: Math.abs(d.u) });
  if (legs.length === 0) return { path: [], refused: 'Those two points are in the same place.' };

  // The way the line would carry straight on out of each point.
  const straightOut = (node: IsoNode): Axis | null => {
    const only = drawing.runs.filter((r) => r.from === node.id || r.to === node.id);
    if (only.length !== 1) return null;
    const other = drawing.nodes.find((n) => n.id === (only[0].from === node.id ? only[0].to : only[0].from));
    return other ? axisBetween(other.pos, node.pos) : null;
  };
  const outOfFrom = straightOut(from);
  const outOfTo = straightOut(to);
  const opposite: Record<Axis, Axis> = { N: 'S', S: 'N', E: 'W', W: 'E', U: 'D', D: 'U' };

  const orders: { axis: Axis; length: number }[][] = [];
  const permute = (rest: typeof legs, chosen: typeof legs) => {
    if (rest.length === 0) {
      orders.push(chosen);
      return;
    }
    rest.forEach((leg, i) => permute(rest.filter((_, k) => k !== i), [...chosen, leg]));
  };
  permute(legs, []);
  const turns = (order: typeof legs) =>
    (outOfFrom && order[0].axis !== outOfFrom ? 1 : 0) + (order.length - 1) + (outOfTo && opposite[order[order.length - 1].axis] !== outOfTo ? 1 : 0);
  orders.sort((a, b) => turns(a) - turns(b));

  for (const order of orders) {
    // Every leg has to lie clear of what is drawn already.
    let at = from.pos;
    let clear = true;
    for (const leg of order) {
      const next = step(at, leg.axis, leg.length);
      if (overlapsExisting(drawing, at, next)) {
        clear = false;
        break;
      }
      at = next;
    }
    if (!clear) continue;
    const trial = JSON.parse(JSON.stringify(drawing)) as Drawing;
    const path = [fromId];
    let here = fromId;
    let ok = true;
    for (const leg of order) {
      const result = route(trial, here, leg.axis, leg.length, dn, schedule);
      if (!result || !result.run || result.refused) {
        ok = false;
        break;
      }
      here = result.nodeId;
      path.push(here);
    }
    if (!ok || here !== toId) continue;
    Object.assign(drawing, trial);
    return { path };
  }
  return { path: [], refused: 'No way round from here to there clear of the lines already drawn.' };
}

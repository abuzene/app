import type { Axis, ComponentKind, Drawing, EndType, Equipment, FlangeKind, InlineComponent, IsoNode, Measure, Run, TerminalKind, Vec3 } from './types';
import { AXIS_VECTOR, add, axisBetween, direction, equals3, length3, scale3, step, sub } from './iso';
import { chainStops, dimensionStops, drawnLength, fittingsTouchLength, minDrawnLength, isMark, isValve, itemAtEnd, oletMarks, resolveEnds, runGroupIds, terminalTakeoutOf, uid, valveOpenSide, type Analysis } from './drawing';
import { componentTakeout, valveFlangeKind } from './pipe-data';

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
 * A flange put on a point an item's face sits on (a reducer in a run of its
 * own, in the middle of a line): the flange is welded straight to the item,
 * so the point — now the joint's gasket — moves out by the flange's length
 * at the item's end size into the pipe beyond it (which gets shorter), and
 * the item and everything else stay
 * (his ask, 2026-09-25: "a reducer straight on a flange"). False when no
 * item's face is on the point.
 */
export function flangeOnItemFace(drawing: Drawing, nodeId: string, kind: FlangeKind): boolean {
  const node = drawing.nodes.find((n) => n.id === nodeId);
  if (!node || node.terminal) return false;
  for (const run of drawing.runs.filter((r) => r.from === nodeId || r.to === nodeId)) {
    const atStart = run.from === nodeId;
    const meets = itemAtEnd(drawing, run, atStart);
    if (!meets || meets.face > 0.5) continue;
    const len = componentTakeout(kind, meets.dn);
    // The flange takes its length out of the pipe beyond the point, which
    // slides along; with no pipe to spare there, what lies beyond moves out.
    const grown = runLength(drawing, run) + len;
    const side = atStart ? 'from' : 'to';
    if (len > 0.5 && !stretchRun(drawing, run.id, grown, side) && !stretchRun(drawing, run.id, grown, side, true)) return false;
    node.flange = kind;
    return true;
  }
  return false;
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
  // The stub between an item's face and the line's end piece: the pipe goes,
  // the end piece stays put and the item comes up to it.
  const stub = run ? terminalStub(drawing, run) : null;
  if (run && stub) {
    joinTerminalStub(drawing, run, stub);
    return;
  }
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

/**
 * Not to scale: a pipe drawn at its own length again — the drawn lengths
 * set by hand or left by a stretch are cleared. A header through olets is
 * drawn at its whole length (capped as any run is) and shared among its
 * runs in proportion, so each olet stays where it is along it. (His
 * complaint, 2026-09-24: a header stretched by the old olet drag.)
 */
export function resetDrawnLength(drawing: Drawing, analysis: Analysis, runId: string): void {
  const ids = runGroupIds(analysis, runId);
  const runs = ids.map((id) => drawing.runs.find((r) => r.id === id)).filter((r): r is Run => !!r);
  if (runs.length === 1) {
    delete runs[0].visual;
    return;
  }
  const lengths = runs.map((r) => runLength(drawing, r));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total <= 0) return;
  const floor = minDrawnLength(drawing);
  const drawn = Math.min(total, drawing.options.schematicLength);
  runs.forEach((run, i) => {
    run.visual = Math.max(floor, (drawn * lengths[i]) / total);
  });
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
  const parentDrawn = run.visual !== undefined || drawing.options.schematic ? drawnLength(drawing, run, total) : undefined;
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
  // The two halves share the drawn length the way they share the true one,
  // so the line is drawn no longer for being split — an olet or a valve
  // put in a long header once drew it twice as long, each half capped on
  // its own (his complaint, 2026-09-24). Neither half is left under the
  // floor, where it would be drawn at its own length instead.
  if (parentDrawn !== undefined) {
    const drawn = parentDrawn;
    const floor = minDrawnLength(drawing);
    const head = drawn >= floor * 2 ? Math.max(floor, Math.min(drawn - floor, drawn * t)) : floor;
    run.visual = head;
    tail.visual = Math.max(floor, drawn - head);
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
/**
 * A short length of pipe between an item's face and the line's end piece —
 * the stub left beyond a reducer when a flange goes on the end of its run.
 * Joining the fittings directly here means the end piece goes straight on
 * the face, so the stub and its point go and the face wears the end piece.
 */
function terminalStub(drawing: Drawing, run: Run): { endNode: IsoNode; faceNode: IsoNode } | null {
  if (run.inline.length > 0) return null;
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  if (!a || !b) return null;
  const isEnd = (node: IsoNode) => {
    const kind = node.terminal?.kind;
    return !!kind && kind !== 'OPEN' && kind !== 'CONTINUATION' && kind !== 'EQUIPMENT' && drawing.runs.filter((r) => r.from === node.id || r.to === node.id).length === 1;
  };
  for (const [endNode, faceNode] of [[a, b], [b, a]] as const) {
    if (!isEnd(endNode) || !isPlainPoint(drawing, faceNode.id)) continue;
    const other = drawing.runs.find((r) => r.id !== run.id && (r.from === faceNode.id || r.to === faceNode.id));
    if (!other || !itemAtEnd(drawing, other, other.from === faceNode.id)) continue;
    return { endNode, faceNode };
  }
  return null;
}

/**
 * The stub goes and the end piece sits straight on the item's face. The end
 * piece stays where it is — a flange on an equipment nozzle is the datum —
 * and everything on the face's side slides up to it (his complaint,
 * 2026-09-23: "the flange must stay fixed and the reducer moves onto it").
 * Returns the point that now wears the end piece.
 */
function joinTerminalStub(drawing: Drawing, run: Run, stub: { endNode: IsoNode; faceNode: IsoNode }): string {
  const { endNode, faceNode } = stub;
  const terminal = endNode.terminal!;
  const kind = terminal.kind;
  drawing.runs = drawing.runs.filter((r) => r.id !== run.id);
  // Everything joined to the face, now the stub is gone: the piece to slide.
  const side = new Set<string>([faceNode.id]);
  const queue = [faceNode.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const r of drawing.runs) {
      const next = r.from === id ? r.to : r.to === id ? r.from : null;
      if (next && !side.has(next)) {
        side.add(next);
        queue.push(next);
      }
    }
  }
  // Where the face must end up so that, moved out by the end piece's length,
  // the point lands exactly where the end piece stood.
  const other = drawing.runs.find((r) => r.from === faceNode.id || r.to === faceNode.id);
  const meets = other ? itemAtEnd(drawing, other, other.from === faceNode.id) : null;
  const out = direction(faceNode.pos, endNode.pos);
  if (out) {
    const back = terminalTakeoutOf(kind, meets?.dn ?? other?.dn ?? '');
    const target = sub(endNode.pos, scale3(out, back));
    const delta = sub(target, faceNode.pos);
    for (const node of drawing.nodes) if (side.has(node.id)) node.pos = add(node.pos, delta);
  }
  drawing.nodes = drawing.nodes.filter((n) => n.id !== endNode.id);
  if (drawing.weldOverrides) {
    const was = drawing.weldOverrides[`n:${endNode.id}:term`];
    delete drawing.weldOverrides[`n:${endNode.id}:term`];
    if (was) drawing.weldOverrides[`n:${faceNode.id}:term`] = was;
  }
  if (drawing.dimOverrides) {
    for (const key of Object.keys(drawing.dimOverrides)) if (key.startsWith(`${run.id}:`)) delete drawing.dimOverrides[key];
  }
  setTerminal(drawing, faceNode.id, kind, terminal.note);
  return faceNode.id;
}

/**
 * Marks a run as fittings joined directly, and pulls it in to fit. Returns
 * the point that now wears the end piece when the run was a stub between an
 * item's face and the end piece: that run is gone, and the end piece sits on
 * the face (2026-09-23, "flange + reducer + flange, joined together").
 */
export function setRunDirect(drawing: Drawing, analysis: Analysis, runId: string, direct: boolean): string | null {
  const run = drawing.runs.find((r) => r.id === runId);
  if (!run) return null;
  run.direct = direct || undefined;
  if (!direct) return null;
  const stub = terminalStub(drawing, run);
  if (stub) return joinTerminalStub(drawing, run, stub);
  const touch = fittingsTouchLength(drawing, analysis, run);
  if (touch > 0 && Math.abs(runLength(drawing, run) - touch) > 0.5) stretchRun(drawing, runId, touch, 'to');
  return null;
}

/** What a run made dashed says beside it unless typed over. */
export const DASHED_NOTE = 'CONT. ON NEXT SHEET';

/**
 * Draws a run dashed — pipe continued on the next sheet — with a note beside
 * it that can be typed over; solid again, a note of its own is kept.
 */
export function setRunDashed(drawing: Drawing, runId: string, dashed: boolean): void {
  const run = drawing.runs.find((r) => r.id === runId);
  if (!run) return;
  run.dashed = dashed || undefined;
  if (dashed && !run.note) run.note = DASHED_NOTE;
  if (!dashed && run.note === DASHED_NOTE) run.note = undefined;
}

export function setRunLength(drawing: Drawing, runId: string, length: number): boolean {
  return stretchRun(drawing, runId, length, 'to');
}

/**
 * Sets a run's length by moving one of its ends along its own line — never
 * turning it. `end` says which end moves; the other stays put.
 */
export function stretchRun(drawing: Drawing, runId: string, length: number, end: 'from' | 'to', moveEnd = false): boolean {
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
  // Never shorter than the items on it reach from the end that stays: a
  // valve left across the end got a dimension to its centre and no pipe
  // beside it (his complaint, 2026-09-24).
  if (length < current) {
    for (const comp of run.inline) {
      if (isMark(comp.kind)) continue;
      const half = componentTakeout(comp.kind, comp.dn ?? run.dn, false, comp.ff);
      const fromFixed = end === 'to' ? comp.offset : current - comp.offset;
      if (fromFixed + half > length + 0.5) return false;
    }
  }
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
  // Unless the end itself is to move — a header's far end, whatever the
  // olets along it — a through point either side takes up the difference.
  const onward = moveEnd ? undefined : beyond(to.id, from.pos);
  if (onward && slideThrough(to, onward, delta)) {
    settleInline();
    return true;
  }
  const backward = moveEnd ? undefined : beyond(from.id, to.pos);
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
      const half = componentTakeout(c.kind, c.dn ?? run.dn, false, c.ff);
      return Math.abs(c.offset + side * half - mm) < 0.5;
    });
  const lower = valveAt(to, -1);
  if (lower) {
    // Up to a valve face: the valve slides so this piece is the value.
    const half = componentTakeout(lower.kind, lower.dn ?? run.dn, false, lower.ff);
    const offset = from + value + half;
    if (offset + half > total - 0.5) return 'That would push the valve off the end of the run.';
    lower.offset = offset;
    run.inline.sort((x, y) => x.offset - y.offset);
    return null;
  }
  // The valve's own face-to-face, typed over: the face on the run's start
  // side stays, the far one moves with it (his ask, 2026-09-24).
  const own = valveAt(from, -1);
  if (own && valveAt(to, 1) === own) return setValveFaceToFace(drawing, run, own, value, true);
  if (to >= total - 0.5) {
    return setRunLength(drawing, run.id, from + value) ? null : 'The line cannot be made that length here.';
  }
  return 'That dimension cannot be set directly.';
}

/**
 * Sets a valve's face-to-face (`comp.ff`), keeping the face on the run's
 * start side where it is (`keepStart`), else the one on its end side. The
 * valve, with its flanges, has to stay on its run and clear of the items
 * beside it.
 */
export function setValveFaceToFace(drawing: Drawing, run: Run, comp: InlineComponent, value: number, keepStart: boolean): string | null {
  if (!isValve(comp.kind)) return 'Only a valve\'s face to face can be typed.';
  if (!(value > 0)) return 'A dimension has to be more than nothing.';
  const total = runLength(drawing, run);
  const joint = drawing.options.joint ?? 'BW';
  // How far an item reaches either side of its centre: its face, and its
  // flange where it wears one there.
  const reach = (c: InlineComponent, side: 0 | 1): number => {
    const dn = c.dn ?? run.dn;
    const face = componentTakeout(c.kind, dn, false, c.ff);
    const flanged = resolveEnds(c.kind, dn, c.ends, joint) === 'FLG' && isValve(c.kind);
    if (!flanged || c.bare === side || (c.lastFlange && valveOpenSide(drawing, run, c) === side)) return face;
    return componentTakeout(c.kind, dn, valveFlangeKind(joint), c.ff);
  };
  const half = componentTakeout(comp.kind, comp.dn ?? run.dn, false, comp.ff);
  const fixed = keepStart ? comp.offset - half : comp.offset + half;
  const moved: InlineComponent = { ...comp, ff: value, offset: keepStart ? fixed + value / 2 : fixed - value / 2 };
  const lo = moved.offset - reach(moved, 0);
  const hi = moved.offset + reach(moved, 1);
  if (lo < -0.5 || hi > total + 0.5) return 'The valve would not fit on its run at that length.';
  for (const other of run.inline) {
    if (other.id === comp.id || isMark(other.kind)) continue;
    const olo = other.offset - reach(other, 0);
    const ohi = other.offset + reach(other, 1);
    if (olo < hi - 0.5 && ohi > lo + 0.5) return 'The valve would run into the item beside it.';
  }
  comp.ff = value;
  comp.offset = moved.offset;
  return null;
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
  if (!node || node.flange || oletMarks(node).length > 0 || (node.fittingOverride && node.fittingOverride !== 'NONE')) return false;
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
 * A plain point with an item lying across it — a valve put on an end back
 * when it sat centred there, and the line then drawn on — is moved out to
 * the item's face (flange included), taking everything beyond with it, so
 * the pipe drawn on from it keeps the length it had on the cut list, and
 * then joined through, so no dimension ends on the valve's centre (his complaint, 2026-09-24: a 310
 * to the middle of a valve; pipe A between two valves that could not be
 * picked). Returns whether anything changed.
 */
export function uncoverPoints(drawing: Drawing): boolean {
  let changed = false;
  const joint = drawing.options.joint ?? 'BW';
  for (const node of [...drawing.nodes]) {
    if (node.joint || node.terminal || !isPlainPoint(drawing, node.id)) continue;
    for (const run of drawing.runs.filter((r) => r.from === node.id || r.to === node.id)) {
      const len = runLength(drawing, run);
      const atEnd = run.to === node.id;
      let over = 0;
      for (const c of run.inline) {
        if (isMark(c.kind)) continue;
        const dn = c.dn ?? run.dn;
        const face = componentTakeout(c.kind, dn, false, c.ff);
        const side: 0 | 1 = atEnd ? 1 : 0;
        const flanged = isValve(c.kind) && resolveEnds(c.kind, dn, c.ends, joint) === 'FLG' && c.bare !== side && !c.lastFlange;
        const reach = flanged ? componentTakeout(c.kind, dn, valveFlangeKind(joint), c.ff) : face;
        // Only an item whose body crosses the point; one whose flange
        // alone reaches past it sits on it as meant.
        if (atEnd ? c.offset + face <= len + 0.5 : c.offset - face >= -0.5) continue;
        over = Math.max(over, atEnd ? c.offset + reach - len : reach - c.offset);
      }
      if (over > 0.5 && stretchRun(drawing, run.id, len + over, atEnd ? 'to' : 'from', true)) {
        // Then the point, with nothing at it now, goes: the pipe runs on
        // from the valve's face, dimensioned as one piece to what is next.
        if (joinThrough(drawing, node.id) && drawing.measures) {
          drawing.measures = drawing.measures.filter((m) => m.a !== node.id && m.b !== node.id);
        }
        changed = true;
        break;
      }
    }
  }
  return changed;
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
 * Sets a dimension on a header chain — one that runs through olets. The
 * end-to-end pieces work as a run's do: up to a valve face the valve slides,
 * on the last piece the far end moves with everything beyond it. An olet's
 * own dimension, from the chain's start, moves just the olet along the
 * header: the header keeps its length, and what sits along it stays put.
 */
/** Sets the length of the whole pipe a run belongs to: a header's far end moves, its olets stay. */
export function setGroupLength(drawing: Drawing, analysis: Analysis, runId: string, value: number): boolean {
  const chain = analysis.chainOfRun.get(runId);
  if (!chain || chain.runs.length < 2) return setRunLength(drawing, runId, value);
  const last = chain.runs[chain.runs.length - 1];
  const length = last.length + (value - chain.total);
  if (length <= 0.5) return false;
  return stretchRun(drawing, last.run.id, length, last.forward ? 'to' : 'from', true);
}

/**
 * What a flanged valve on the open end wears on its last face: its flange
 * (unset), none, or a blind bolted on the valve. With no flange the line
 * ends at the valve's face, so the end point comes in by the flange's
 * length, and goes back out when the flange is put back.
 */
export function setLastFlange(drawing: Drawing, compId: string, state: 'flange' | 'none' | 'blind'): boolean {
  const run = drawing.runs.find((r) => r.inline.some((c) => c.id === compId));
  const comp = run?.inline.find((c) => c.id === compId);
  if (!run || !comp) return false;
  const side = valveOpenSide(drawing, run, comp);
  if (side === null) return false;
  const joint = drawing.options.joint ?? 'BW';
  const dn = comp.dn ?? run.dn;
  const flangeLen = componentTakeout(comp.kind, dn, valveFlangeKind(joint), comp.ff) - componentTakeout(comp.kind, dn, false, comp.ff);
  const hadFlange = !comp.lastFlange;
  const hasFlange = state === 'flange';
  comp.lastFlange = hasFlange ? undefined : state;
  if (hadFlange === hasFlange) return true;
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  const dir = a && b ? direction(a.pos, b.pos) : null;
  if (!a || !b || !dir) return true;
  // In towards the valve when the flange comes off, out again when it returns.
  const shift = hasFlange ? flangeLen : -flangeLen;
  if (side === 1) b.pos = add(b.pos, scale3(dir, shift));
  else {
    a.pos = add(a.pos, scale3(dir, -shift));
    for (const c of run.inline) c.offset += shift;
  }
  return true;
}

/**
 * A flanged valve put on the end of a line bolts on to what is there, with
 * no pipe between (his ask, 2026-09-23: "fittings one after another").
 * On an end flange, that flange becomes the valve's own flange on that
 * side and the line grows by the valve; on a valve already on the open
 * end, the two bolt face to face with no flanges between. The new valve's
 * far face is left bare (`lastFlange: 'none'`): a flange there is put on
 * by hand. Returns the new valve's id, or null when the end holds neither
 * (the caller places it as before).
 */
export function boltValveOnEnd(drawing: Drawing, nodeId: string, kind: ComponentKind): string | null {
  const node = drawing.nodes.find((n) => n.id === nodeId);
  const touching = drawing.runs.filter((r) => r.from === nodeId || r.to === nodeId);
  if (!node || touching.length !== 1 || !isValve(kind)) return null;
  const run = touching[0];
  const joint = drawing.options.joint ?? 'BW';
  const dn = run.dn;
  if (resolveEnds(kind, dn, undefined, joint) !== 'FLG') return null;
  const half = componentTakeout(kind, dn, valveFlangeKind(joint));
  const faceHalf = componentTakeout(kind, dn, false);
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  const dir = a && b ? direction(a.pos, b.pos) : null;
  if (!a || !b || !dir) return null;
  const total = length3(sub(b.pos, a.pos));
  const atTo = run.to === nodeId;
  // Distances measured outward from the end point.
  const outward = (offset: number) => (atTo ? offset - total : -offset);
  let centre: number;
  let weldKey: string | null = null;
  let bareNew: 0 | 1 | undefined;
  const term = node.terminal?.kind;
  if (term && isFlangeKind(term) && term !== 'FLG_BLIND') {
    // The end flange is the valve's own: its weld stays where it is.
    centre = half - terminalTakeoutOf(term, dn);
    weldKey = `n:${nodeId}:term`;
    node.terminal = undefined;
  } else {
    const prev = run.inline.find((c) => valveOpenSide(drawing, run, c) === (atTo ? 1 : 0));
    if (!prev) return null;
    const prevFace = outward(prev.offset) + componentTakeout(prev.kind, prev.dn ?? dn, false, prev.ff);
    centre = prevFace + faceHalf;
    prev.bare = atTo ? 1 : 0;
    prev.lastFlange = undefined;
    bareNew = atTo ? 0 : 1;
  }
  // Only the valve goes on: nothing on its far face until something is put
  // there by hand — a flange, another valve, equipment (his ask, 2026-09-23).
  const reach = centre + faceHalf;
  if (atTo) b.pos = add(b.pos, scale3(dir, reach));
  else {
    a.pos = add(a.pos, scale3(dir, -reach));
    for (const c of run.inline) c.offset += reach;
  }
  const comp: InlineComponent = { id: uid('c'), kind, offset: atTo ? total + centre : reach - centre };
  if (bareNew !== undefined) comp.bare = bareNew;
  comp.lastFlange = 'none';
  run.inline.push(comp);
  run.inline.sort((x, y) => x.offset - y.offset);
  if (weldKey && drawing.weldOverrides?.[weldKey]) {
    drawing.weldOverrides[`c:${comp.id}:${atTo ? 0 : 1}`] = drawing.weldOverrides[weldKey];
    delete drawing.weldOverrides[weldKey];
  }
  return comp.id;
}

/** Deletes the whole pipe a run belongs to; an olet left with no header is no olet. */
export function deleteRunGroup(drawing: Drawing, analysis: Analysis, runId: string): void {
  const ids = runGroupIds(analysis, runId);
  const oletNodes = analysis.chainOfRun.get(runId)?.olets.map((o) => o.nodeId) ?? [];
  for (const id of ids) deleteRun(drawing, id);
  for (const nodeId of oletNodes) {
    const node = drawing.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    node.olets = undefined;
    node.olet = undefined;
    if (node.fittingOverride === 'OLET') node.fittingOverride = undefined;
  }
}

/**
 * A hand dimension from an olet to a point on its own header can be typed:
 * the olet slides along the header to that distance, the point stays. This
 * is how an olet is placed "from its base" once it is on the pipe.
 */
export function measureOnOlet(drawing: Drawing, analysis: Analysis, measureId: string): { oletId: string; otherAlong: number; sign: number } | null {
  const measure = (drawing.measures ?? []).find((m) => m.id === measureId);
  if (!measure) return null;
  for (const [oletId, otherId] of [[measure.a, measure.b], [measure.b, measure.a]]) {
    const chain = analysis.chains.find((c) => c.olets.some((o) => o.nodeId === oletId));
    if (!chain) continue;
    const start = drawing.nodes.find((n) => n.id === chain.from);
    const end = drawing.nodes.find((n) => n.id === chain.to);
    const other = drawing.nodes.find((n) => n.id === otherId);
    const dir = start && end ? direction(start.pos, end.pos) : null;
    if (!start || !other || !dir) continue;
    const rel = sub(other.pos, start.pos);
    const along = rel.e * dir.e + rel.n * dir.n + rel.u * dir.u;
    if (length3(sub(rel, scale3(dir, along))) > 0.5) continue;
    const oletAlong = chain.olets.find((o) => o.nodeId === oletId)!.along;
    return { oletId, otherAlong: along, sign: oletAlong >= along ? 1 : -1 };
  }
  return null;
}

/**
 * A hand dimension between two points on one straight line — flange to
 * flange, say — can be typed: the point tapped second moves along the
 * line with everything beyond it, by stretching the run that leads to it
 * from the first. Returns which run and end, or null when there is none.
 */
export function measureAlongLine(drawing: Drawing, measureId: string): { runId: string; end: 'from' | 'to'; length: number; current: number } | null {
  const measure = (drawing.measures ?? []).find((m) => m.id === measureId);
  if (!measure) return null;
  for (const [fixedId, movingId] of [[measure.a, measure.b], [measure.b, measure.a]]) {
    const fixed = drawing.nodes.find((n) => n.id === fixedId);
    const moving = drawing.nodes.find((n) => n.id === movingId);
    if (!fixed || !moving || !axisBetween(fixed.pos, moving.pos)) continue;
    const current = length3(sub(moving.pos, fixed.pos));
    const toward = direction(moving.pos, fixed.pos);
    if (!toward) continue;
    for (const run of drawing.runs.filter((r) => r.from === movingId || r.to === movingId)) {
      const other = drawing.nodes.find((n) => n.id === (run.from === movingId ? run.to : run.from));
      if (!other) continue;
      const leg = sub(other.pos, moving.pos);
      const along = leg.e * toward.e + leg.n * toward.n + leg.u * toward.u;
      // The run heads back along the line, no further than the fixed point.
      if (along <= 0.5 || along > current + 0.5 || length3(sub(leg, scale3(toward, along))) > 0.5) continue;
      return { runId: run.id, end: run.to === movingId ? 'to' : 'from', length: runLength(drawing, run), current };
    }
  }
  return null;
}

/** Whether a hand dimension can be typed over: from an olet, or along one straight line. */
export function measureTypeable(drawing: Drawing, analysis: Analysis, measureId: string): boolean {
  return !!measureOnOlet(drawing, analysis, measureId) || !!measureAlongLine(drawing, measureId);
}

export function applyMeasureToOlet(drawing: Drawing, analysis: Analysis, measureId: string, value: number): string | null {
  const on = measureOnOlet(drawing, analysis, measureId);
  if (on) return applyChainDimension(drawing, analysis, `olet:${on.oletId}`, on.otherAlong + on.sign * value);
  const line = measureAlongLine(drawing, measureId);
  if (!line) return 'A dimension between two points: move a point to change it.';
  const length = line.length + (value - line.current);
  if (length <= 0.5) return 'The line cannot be made that length here.';
  return stretchRun(drawing, line.runId, length, line.end, true) ? null : 'The line cannot be made that length here.';
}

export function applyChainDimension(drawing: Drawing, analysis: Analysis, key: string, value: number): string | null {
  if (!(value > 0)) return 'A dimension has to be more than nothing.';
  const olet = key.match(/^olet:(.+)$/);
  if (olet) {
    const nodeId = olet[1];
    const chain = analysis.chains.find((c) => c.olets.some((o) => o.nodeId === nodeId));
    const node = drawing.nodes.find((n) => n.id === nodeId);
    const start = chain ? drawing.nodes.find((n) => n.id === chain.from) : undefined;
    const end = chain ? drawing.nodes.find((n) => n.id === chain.to) : undefined;
    if (!chain || !node || !start || !end) return 'No such dimension.';
    const was0 = chain.olets.find((o) => o.nodeId === nodeId)!.along;
    const stops = chainStops(drawing, chain).filter((mm) => Math.abs(mm - was0) > 0.5);
    const others = chain.olets.filter((o) => o.nodeId !== nodeId).map((o) => o.along);
    const below = Math.max(...[...stops, ...others].filter((mm) => mm < value - 0.5 && mm < chain.total), 0);
    const above = Math.min(...[...stops, ...others].filter((mm) => mm > value + 0.5), chain.total);
    if (value <= below + 0.5 || value >= above - 0.5) return 'That would put the olet past the next thing on the header.';
    const dir = direction(start.pos, end.pos);
    if (!dir) return 'No such dimension.';
    const was = chain.olets.find((o) => o.nodeId === nodeId)!.along;
    const delta = value - was;
    node.pos = add(start.pos, scale3(dir, value));
    // What sits along the runs either side keeps its place on the header.
    const before = chain.runs.find((leg) => (leg.forward ? leg.run.to : leg.run.from) === nodeId);
    const after = chain.runs.find((leg) => (leg.forward ? leg.run.from : leg.run.to) === nodeId);
    if (before && !before.forward) for (const c of before.run.inline) c.offset += delta;
    if (after && after.forward) for (const c of after.run.inline) c.offset -= delta;
    return null;
  }
  const piece = key.match(/^(?:hdr|chain):(.+):(\d+|all)$/);
  if (!piece) return 'No such dimension.';
  const chain = analysis.chains.find((c) => c.id === piece[1]);
  if (!chain) return 'No such dimension.';
  const stops = chainStops(drawing, chain);
  const whole = piece[2] === 'all';
  const index = whole ? 0 : Number(piece[2]);
  if (!whole && (index < 0 || index + 1 >= stops.length)) return 'No such dimension.';
  const from = whole ? 0 : stops[index];
  const to = whole ? chain.total : stops[index + 1];
  // Up to an olet's centre: the olet moves, the next piece gives.
  const oletTo = whole ? undefined : chain.olets.find((o) => Math.abs(o.along - to) < 0.5);
  if (oletTo) return applyChainDimension(drawing, analysis, `olet:${oletTo.nodeId}`, from + value);
  // Up to a valve face: the valve slides so this piece is the value.
  for (const leg of chain.runs) {
    for (const comp of leg.run.inline) {
      if (!isValve(comp.kind)) continue;
      const half = componentTakeout(comp.kind, comp.dn ?? leg.run.dn, false, comp.ff);
      const nearFace = leg.forward ? leg.start + comp.offset - half : leg.start + leg.length - comp.offset + half;
      const farFace = leg.forward ? leg.start + comp.offset + half : leg.start + leg.length - comp.offset - half;
      const lower = Math.min(nearFace, farFace);
      if (Math.abs(lower - to) > 0.5) continue;
      const centre = from + value + half;
      const offset = leg.forward ? centre - leg.start : leg.start + leg.length - centre;
      const total = leg.length;
      if (offset - half < 0.5 || offset + half > total - 0.5) return 'That would push the valve off its run.';
      comp.offset = offset;
      leg.run.inline.sort((x, y) => x.offset - y.offset);
      return null;
    }
  }
  // A valve's own face-to-face: the face nearer the chain's start stays.
  for (const leg of chain.runs) {
    for (const comp of leg.run.inline) {
      if (!isValve(comp.kind)) continue;
      const half = componentTakeout(comp.kind, comp.dn ?? leg.run.dn, false, comp.ff);
      const centre = leg.forward ? leg.start + comp.offset : leg.start + leg.length - comp.offset;
      if (Math.abs(centre - half - from) > 0.5 || Math.abs(centre + half - to) > 0.5) continue;
      return setValveFaceToFace(drawing, leg.run, comp, value, leg.forward);
    }
  }
  if (to >= chain.total - 0.5) {
    // The last piece: the header's far end moves, with everything beyond.
    const last = chain.runs[chain.runs.length - 1];
    const length = last.length + (from + value - chain.total);
    if (length <= 0.5) return 'The line cannot be made that length here.';
    return stretchRun(drawing, last.run.id, length, last.forward ? 'to' : 'from', true) ? null : 'The line cannot be made that length here.';
  }
  return 'That dimension cannot be set directly.';
}

/**
 * Takes an olet off the line. With its branch gone (or never drawn) the two
 * header runs are joined back into one, so no joint is left where it sat.
 */
export function removeOlet(drawing: Drawing, nodeId: string): void {
  const node = drawing.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  node.olet = undefined;
  node.olets = undefined;
  if (node.fittingOverride === 'OLET') node.fittingOverride = undefined;
  node.joint = undefined;
  if (drawing.runs.filter((r) => r.from === nodeId || r.to === nodeId).length === 2) removeFlangeJoint(drawing, nodeId);
}

/** A dimension by hand between two points; the same pair is not measured twice. */
export function addMeasure(drawing: Drawing, a: string, b: string): Measure | null {
  if (a === b) return null;
  const twice = (drawing.measures ?? []).find((m) => (m.a === a && m.b === b) || (m.a === b && m.b === a));
  if (twice) return twice;
  const measure: Measure = { id: uid('m'), a, b };
  drawing.measures = [...(drawing.measures ?? []), measure];
  return measure;
}

export function removeMeasure(drawing: Drawing, id: string): void {
  drawing.measures = (drawing.measures ?? []).filter((m) => m.id !== id);
  if (drawing.dimOverrides) delete drawing.dimOverrides[`meas:${id}`];
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
  const box: Equipment = { id: uid('q'), at: { ...node.pos }, axis, across, length: 1500, width: 1000, name, stand: node.id, standPos: { ...node.pos } };
  drawing.equipment = [...(drawing.equipment ?? []), box];
  return box;
}

/** The middle of the box's far face: where a line leaves the equipment. */
export function equipmentFarSide(box: Equipment): Vec3 {
  return add(box.at, scale3(AXIS_VECTOR[box.axis], box.length));
}

/**
 * Puts a point on the far side of an equipment box for a new line to start
 * from: what goes in one side of a pump or a vessel comes out the other.
 */
export function startFromEquipment(drawing: Drawing, id: string): string | null {
  const box = (drawing.equipment ?? []).find((q) => q.id === id);
  if (!box) return null;
  const nodeId = ensureNode(drawing, equipmentFarSide(box));
  box.next = nodeId;
  return nodeId;
}

/** Every point joined to this one by pipe, itself included. */
function pieceOf(drawing: Drawing, nodeId: string): Set<string> {
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const run of drawing.runs) {
      const next = run.from === id ? run.to : run.to === id ? run.from : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * Keeps each equipment box with the point it stands on, and the line drawn
 * on from its far side with the box: the point moved (a dimension typed
 * upstream), the box goes with it; the box made shorter or longer or
 * turned, the line beyond it moves to its new far side (his complaint,
 * 2026-09-24: the line after the equipment stayed where the first, longer
 * box had put it, and could not be brought in). Run after every edit.
 */
export function syncEquipment(drawing: Drawing): void {
  for (const box of drawing.equipment ?? []) {
    // Boxes put down before this was kept: the point under them, and a line
    // starting on their own axis beyond them, are theirs.
    if (!box.stand) {
      const under = drawing.nodes.find((n) => length3(sub(n.pos, box.at)) < 0.5);
      if (under) {
        box.stand = under.id;
        box.standPos = { ...under.pos };
      }
    }
    const stand = box.stand ? drawing.nodes.find((n) => n.id === box.stand) : undefined;
    if (box.stand && !stand) {
      box.stand = undefined;
      box.standPos = undefined;
    }
    const own = stand ? pieceOf(drawing, stand.id) : new Set<string>();
    if (!box.next) {
      const axis = AXIS_VECTOR[box.axis];
      let best: { id: string; t: number } | null = null;
      for (const node of drawing.nodes) {
        if (own.has(node.id)) continue;
        const d = sub(node.pos, box.at);
        const t = d.e * axis.e + d.n * axis.n + d.u * axis.u;
        if (t <= 0.5 || length3(sub(d, scale3(axis, t))) > 0.5) continue;
        if (drawing.runs.filter((r) => r.from === node.id || r.to === node.id).length > 1) continue;
        if (!best || t < best.t) best = { id: node.id, t };
      }
      if (best) box.next = best.id;
    }
    // The box goes with its point.
    if (stand) {
      const moved = box.standPos ? sub(stand.pos, box.standPos) : { e: 0, n: 0, u: 0 };
      if (length3(moved) > 1e-6) box.at = add(box.at, moved);
      box.standPos = { ...stand.pos };
    }
    // The line beyond goes with the box, unless it has been joined back to
    // the line the box stands on.
    const next = box.next ? drawing.nodes.find((n) => n.id === box.next) : undefined;
    if (box.next && !next) box.next = undefined;
    if (next && !own.has(next.id)) {
      const shift = sub(equipmentFarSide(box), next.pos);
      if (length3(shift) > 1e-6) {
        const piece = pieceOf(drawing, next.id);
        for (const node of drawing.nodes) if (piece.has(node.id)) node.pos = add(node.pos, shift);
      }
    }
  }
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
  const half = componentTakeout(comp.kind, large, false, comp.ff);
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
/** An open end: one run, and nothing on it but a plain open end. */
function isOpenEnd(drawing: Drawing, node: IsoNode): boolean {
  const kind = node.terminal?.kind;
  return (!kind || kind === 'OPEN') && drawing.runs.filter((r) => r.from === node.id || r.to === node.id).length === 1;
}

/**
 * Where the lines of two open ends cross, when they do: each end carried
 * straight on out of its run (or back along it, never past its far end),
 * clear of what is drawn, meeting the other at a right angle.
 */
function crossingOfEnds(drawing: Drawing, a: IsoNode, b: IsoNode): Vec3 | null {
  if (!isOpenEnd(drawing, a) || !isOpenEnd(drawing, b)) return null;
  const out = (node: IsoNode): { axis: Axis; back: number } | null => {
    const run = drawing.runs.find((r) => r.from === node.id || r.to === node.id);
    const far = run && drawing.nodes.find((n) => n.id === (run.from === node.id ? run.to : run.from));
    const axis = far ? axisBetween(far.pos, node.pos) : null;
    return axis && far ? { axis, back: length3(sub(node.pos, far.pos)) } : null;
  };
  const oa = out(a);
  const ob = out(b);
  if (!oa || !ob) return null;
  const ua = AXIS_VECTOR[oa.axis];
  const ub = AXIS_VECTOR[ob.axis];
  if (Math.abs(ua.e * ub.e + ua.n * ub.n + ua.u * ub.u) > 0.5) return null;
  const d = sub(b.pos, a.pos);
  const along = (v: Vec3, u: Vec3) => v.e * u.e + v.n * u.n + v.u * u.u;
  const ta = along(d, ua);
  const tb = -along(d, ub);
  const meet = add(a.pos, scale3(ua, ta));
  if (length3(sub(meet, add(b.pos, scale3(ub, tb)))) > 0.5) return null;
  // Pulled back, an end keeps some of its pipe.
  if (ta <= -oa.back + 1 || tb <= -ob.back + 1) return null;
  if ((ta > 0.5 && overlapsExisting(drawing, a.pos, meet)) || (tb > 0.5 && overlapsExisting(drawing, b.pos, meet))) return null;
  return meet;
}

/** Moves an open end along its own line, its items keeping their place. */
function moveOpenEnd(drawing: Drawing, node: IsoNode, to: Vec3): void {
  const shift = length3(sub(to, node.pos));
  if (shift < 1e-6) return;
  const run = drawing.runs.find((r) => r.from === node.id || r.to === node.id);
  if (run) {
    const far = drawing.nodes.find((n) => n.id === (run.from === node.id ? run.to : run.from));
    const longer = far ? length3(sub(to, far.pos)) - length3(sub(node.pos, far.pos)) : 0;
    // Offsets run from the run's start: moved, the start takes them with it.
    if (run.from === node.id) for (const comp of run.inline) comp.offset += longer;
    if (run.visual !== undefined) run.visual = Math.max(0, run.visual + longer);
  }
  node.pos = { ...to };
}

export function connectNodes(drawing: Drawing, fromId: string, toId: string, dn: string, schedule: string): ConnectResult {
  const from = drawing.nodes.find((n) => n.id === fromId);
  const to = drawing.nodes.find((n) => n.id === toId);
  if (!from || !to || fromId === toId) return { path: [], refused: 'Pick another point to join this one to.' };
  if (runBetween(drawing, fromId, toId)) return { path: [], refused: 'Those two points are joined already.' };

  // Two open ends whose lines cross meet at the crossing: each is carried
  // on (or back) along its own line to the corner and the two become one
  // point there, an elbow, with no new pipe (his complaint, 2026-09-24:
  // a branch up 430 and a line at 440 ending 10 mm short "would not join").
  const corner = crossingOfEnds(drawing, from, to);
  if (corner) {
    moveOpenEnd(drawing, from, corner);
    moveOpenEnd(drawing, to, corner);
  }

  const d = sub(to.pos, from.pos);
  const legs: { axis: Axis; length: number }[] = [];
  if (Math.abs(d.e) > 0.5) legs.push({ axis: d.e > 0 ? 'E' : 'W', length: Math.abs(d.e) });
  if (Math.abs(d.n) > 0.5) legs.push({ axis: d.n > 0 ? 'N' : 'S', length: Math.abs(d.n) });
  if (Math.abs(d.u) > 0.5) legs.push({ axis: d.u > 0 ? 'U' : 'D', length: Math.abs(d.u) });
  // Two ends in the same place are one point: they meet there, as a corner
  // (its elbow from the turn) or straight through.
  if (legs.length === 0) {
    const openEnd = (id: string) => {
      const kind = drawing.nodes.find((n) => n.id === id)?.terminal?.kind;
      return (!kind || kind === 'OPEN') && drawing.runs.filter((r) => r.from === id || r.to === id).length === 1;
    };
    if (!openEnd(fromId) || !openEnd(toId)) return { path: [], refused: 'Those two points are in the same place.' };
    for (const run of drawing.runs) {
      if (run.from === toId) run.from = fromId;
      if (run.to === toId) run.to = fromId;
    }
    from.terminal = undefined;
    drawing.nodes = drawing.nodes.filter((n) => n.id !== toId);
    if (isPlainPoint(drawing, fromId)) joinThrough(drawing, fromId);
    return { path: drawing.nodes.some((n) => n.id === fromId) ? [fromId] : [] };
  }

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
    // Joined straight on to a line, the ends are no joints of their own: the
    // pipe runs through, with no point left where the gap was.
    for (const id of [fromId, toId]) if (isPlainPoint(drawing, id)) joinThrough(drawing, id);
    return { path: path.filter((id) => drawing.nodes.some((n) => n.id === id)) };
  }
  return { path: [], refused: 'No way round from here to there clear of the lines already drawn.' };
}

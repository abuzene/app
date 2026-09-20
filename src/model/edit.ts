import type { Axis, ComponentKind, Drawing, EndType, InlineComponent, Run, Vec3 } from './types';
import { add, axisBetween, equals3, length3, step, sub } from './iso';
import { uid } from './drawing';

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
): RouteResult | null {
  const from = drawing.nodes.find((n) => n.id === fromId);
  if (!from || length <= 0) return null;

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
      return route(drawing, farId, axis, length - farLength, dn, schedule, depth + 1);
    }
  }

  const target = step(from.pos, axis, length);
  const toId = ensureNode(drawing, target);
  return { run: addRun(drawing, fromId, toId, dn, schedule), nodeId: toId };
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
  drawing.runs = drawing.runs.filter((r) => r.id !== runId);
  pruneNodes(drawing);
}

export function deleteNode(drawing: Drawing, nodeId: string): void {
  drawing.runs = drawing.runs.filter((r) => r.from !== nodeId && r.to !== nodeId);
  drawing.nodes = drawing.nodes.filter((n) => n.id !== nodeId);
  pruneNodes(drawing);
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
  ends: EndType = 'BW',
): InlineComponent | null {
  const run = drawing.runs.find((r) => r.id === runId);
  if (!run) return null;
  const total = runLength(drawing, run);
  const at = offset === undefined ? total / 2 : Math.max(0, Math.min(total, offset));
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
  drawing.runs.splice(drawing.runs.indexOf(run) + 1, 0, tail);
  return midId;
}

/**
 * Changes a run's length by moving its far node, taking everything downstream
 * of that node with it — which is how a route behaves when a dimension is
 * corrected. If the far side loops back to the near side the branch cannot move
 * independently, so only the node itself is moved and the loop re-closes.
 */
export function setRunLength(drawing: Drawing, runId: string, length: number): boolean {
  const run = drawing.runs.find((r) => r.id === runId);
  if (!run || length <= 0) return false;
  const from = drawing.nodes.find((n) => n.id === run.from);
  const to = drawing.nodes.find((n) => n.id === run.to);
  if (!from || !to) return false;

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

  // Component offsets on this run are measured from its start, so clamp them.
  for (const comp of run.inline) comp.offset = Math.max(0, Math.min(length, comp.offset));
  return true;
}

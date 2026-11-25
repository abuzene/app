/**
 * Copy and paste part of a drawing, on this sheet or another (his ask,
 * 2026-11-25: "a rectangle like Move area that gives me copy, then paste,
 * even on another sheet"). A box drawn round points copies them with the
 * pipes between them, their items and the hand dimensions between them;
 * the copy is kept on this device (localStorage), so it pastes on any
 * sheet. Pasted with an open end picked, the copy's end that was cut from
 * the rest of the line goes onto it and the two are joined; otherwise it
 * goes beside the drawing, held in a box to be dragged into place.
 */
import type { Drawing, IsoNode, Measure, Run, Vec3 } from './types';
import type { SupportType } from './supports';
import { analyse, routeOrder, uid } from './drawing';
import { connectNodes, overlapsExisting } from './edit';

const KEY = 'iso-draw.clipboard.v1';

export interface Clip {
  version: 1;
  /** Points, positions as drawn on the sheet copied from (mm). */
  nodes: IsoNode[];
  runs: Run[];
  measures: Measure[];
  supportTypes: SupportType[];
  /** The point that goes onto a picked open end when pasted. */
  anchor: string;
  /** Where it came from, for the notice. */
  from: string;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ e: a.e - b.e, n: a.n - b.n, u: a.u - b.u });
const add = (a: Vec3, b: Vec3): Vec3 => ({ e: a.e + b.e, n: a.n + b.n, u: a.u + b.u });

/** The points in `held` with the pipes between them, or null when no pipe lies wholly in the box. */
export function copyArea(drawing: Drawing, held: Set<string>): Clip | null {
  const runs = drawing.runs.filter((r) => held.has(r.from) && held.has(r.to));
  if (runs.length === 0) return null;
  const used = new Set(runs.flatMap((r) => [r.from, r.to]));
  const degree = (id: string, list: Run[]) => list.filter((r) => r.from === id || r.to === id).length;
  const analysis = analyse(drawing);
  const nodes = drawing.nodes
    .filter((n) => used.has(n.id))
    .map((n) => {
      const copy = JSON.parse(JSON.stringify(n)) as IsoNode;
      // A point that lost a leg to the box's edge is no longer the
      // fitting it was there: what it becomes is worked out afresh.
      if (degree(n.id, runs) !== degree(n.id, drawing.runs)) {
        delete copy.fittingOverride;
        delete copy.olet;
        delete copy.olets;
        delete copy.halfCoupling;
        delete copy.union;
        delete copy.autoCoupling;
        delete copy.flange;
        delete copy.flangeStd;
        // Its joint as it was drawn there (an olet's branch, say).
        const joint = analysis.nodeJoint.get(n.id);
        if (joint && !copy.joint) copy.joint = joint;
      }
      return copy;
    });
  // The anchor: the point the copy was cut off the line at, the first
  // along the route; else an open end; else the first point.
  // A point's place along the route: the first run that reaches it, from
  // the end it is walked from.
  const route = routeOrder(drawing);
  const place = new Map<string, number>();
  for (const r of drawing.runs) {
    const k = route.rank.get(r.id);
    if (k === undefined) continue;
    const first = route.reversed.has(r.id) ? r.to : r.from;
    const last = route.reversed.has(r.id) ? r.from : r.to;
    place.set(first, Math.min(place.get(first) ?? Infinity, k * 2));
    place.set(last, Math.min(place.get(last) ?? Infinity, k * 2 + 1));
  }
  const rank = (id: string) => place.get(id) ?? Number.MAX_SAFE_INTEGER;
  const byRoute = [...nodes].sort((a, b) => rank(a.id) - rank(b.id));
  const cut = byRoute.find((n) => degree(n.id, runs) === 1 && degree(n.id, drawing.runs) > 1);
  const open = byRoute.find((n) => degree(n.id, runs) === 1);
  const anchor = (cut ?? open ?? byRoute[0]).id;
  const typeIds = new Set(runs.flatMap((r) => r.inline.map((c) => c.supportType)).filter((t): t is string => !!t));
  return {
    version: 1,
    nodes,
    runs: JSON.parse(JSON.stringify(runs)) as Run[],
    measures: (drawing.measures ?? []).filter((m) => used.has(m.a) && used.has(m.b)).map((m) => ({ ...m })),
    supportTypes: (drawing.supportTypes ?? []).filter((t) => typeIds.has(t.id)).map((t) => JSON.parse(JSON.stringify(t)) as SupportType),
    anchor,
    from: `${drawing.meta.project || 'drawing'}, sheet ${drawing.meta.sheet || '1 of 1'}`,
  };
}

export function saveClip(clip: Clip): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(clip));
    return true;
  } catch {
    return false;
  }
}

export function loadClip(): Clip | null {
  try {
    const clip = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Clip | null;
    return clip && clip.version === 1 && Array.isArray(clip.nodes) && Array.isArray(clip.runs) && clip.runs.length > 0 ? clip : null;
  } catch {
    return null;
  }
}

export interface PasteResult {
  /** The pasted points (the one joined to the picked end under its id). */
  ids: string[];
  refused?: string;
}

/**
 * Puts a copy of `clip` into the drawing: its anchor onto the open end
 * `onto` (joined to it), else beside what is drawn.
 */
export function pasteClip(drawing: Drawing, clip: Clip, onto: string | null): PasteResult {
  const anchor = clip.nodes.find((n) => n.id === clip.anchor) ?? clip.nodes[0];
  const target = onto ? drawing.nodes.find((n) => n.id === onto) : undefined;
  const openEnd = (id: string) => {
    const kind = drawing.nodes.find((n) => n.id === id)?.terminal?.kind;
    return (!kind || kind === 'OPEN') && drawing.runs.filter((r) => r.from === id || r.to === id).length === 1;
  };
  let shift: Vec3;
  let join = false;
  if (target && openEnd(target.id)) {
    shift = sub(target.pos, anchor.pos);
    join = clip.runs.filter((r) => r.from === anchor.id || r.to === anchor.id).length === 1 && !anchor.terminal;
  } else if (drawing.runs.length === 0) {
    // An empty sheet: the copy where it was, its anchor on the start point.
    const start = drawing.nodes[0];
    shift = start ? sub(start.pos, anchor.pos) : { e: 0, n: 0, u: 0 };
  } else {
    // Beside the drawing, clear of it to the east.
    const maxE = Math.max(...drawing.nodes.map((n) => n.pos.e));
    const minE = Math.min(...clip.nodes.map((n) => n.pos.e));
    const minN = Math.min(...drawing.nodes.map((n) => n.pos.n));
    const clipMinN = Math.min(...clip.nodes.map((n) => n.pos.n));
    shift = { e: maxE + 1500 - minE, n: minN - clipMinN, u: 0 };
  }

  // New ids throughout, so the copy is a thing of its own.
  const nodeId = new Map<string, string>();
  for (const n of clip.nodes) nodeId.set(n.id, uid('n'));
  const nodes: IsoNode[] = clip.nodes.map((n) => ({ ...(JSON.parse(JSON.stringify(n)) as IsoNode), id: nodeId.get(n.id)!, pos: add(n.pos, shift) }));
  const existingTypes = drawing.supportTypes ?? [];
  const newTypes: SupportType[] = [];
  for (const t of clip.supportTypes ?? []) {
    // The same type on this sheet already (copied within it): kept.
    if (existingTypes.some((x) => x.id === t.id)) continue;
    newTypes.push(JSON.parse(JSON.stringify(t)) as SupportType);
  }
  const runs: Run[] = clip.runs.map((r) => {
    const copy = JSON.parse(JSON.stringify(r)) as Run;
    copy.id = uid('r');
    copy.from = nodeId.get(r.from)!;
    copy.to = nodeId.get(r.to)!;
    for (const c of copy.inline) c.id = uid('c');
    return copy;
  });

  // Nothing pasted may lie along a line already drawn.
  const pos = new Map(nodes.map((n) => [n.id, n.pos]));
  for (const r of runs) {
    const a = pos.get(r.from)!;
    const b = pos.get(r.to)!;
    if (overlapsExisting(drawing, a, b)) {
      return { ids: [], refused: target ? 'The copy would lie along pipe already drawn from that end — pick another end, or paste with nothing picked and drag it into place.' : 'The copy would lie along pipe already drawn.' };
    }
  }

  drawing.nodes.push(...nodes);
  drawing.runs.push(...runs);
  if (newTypes.length) drawing.supportTypes = [...existingTypes, ...newTypes];
  const measures = (clip.measures ?? []).map((m) => ({ id: uid('m'), a: nodeId.get(m.a)!, b: nodeId.get(m.b)! }));
  if (measures.length) drawing.measures = [...(drawing.measures ?? []), ...measures];
  const ids = nodes.map((n) => n.id);
  if (join && target) {
    const first = runs.find((r) => r.from === nodeId.get(anchor.id) || r.to === nodeId.get(anchor.id));
    const joined = connectNodes(drawing, target.id, nodeId.get(anchor.id)!, first?.dn ?? '', first?.schedule ?? '');
    if (!joined.refused) return { ids: ids.filter((id) => drawing.nodes.some((n) => n.id === id)) };
  }
  return { ids };
}

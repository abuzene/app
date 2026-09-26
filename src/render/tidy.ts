import type { Pt } from './renderer';

/**
 * Tidy: lays out dimensions, weld tags, item balloons and pipe letters so
 * that none of them sits on another, on the pipe or on a symbol, each as
 * close to what it belongs to as it can be (his ask, 2026-09-23: "a button
 * that arranges dimension lines, weld numbers and item numbers so no line
 * or balloon clashes, neatly and as close to the drawing as possible").
 *
 * Everything is a capsule — a segment with a radius — so pipes, symbols,
 * dimension lines, figures, boxes and balloons are tested alike. The
 * renderer hands over what is on the drawing (`LayoutSpecs`); this works
 * out where each label goes and returns it in the drawing's own override
 * terms, so the result is saved like any drag and can be dragged after.
 */

export interface LayoutSpecs {
  size: number;
  centroid: Pt;
  /** The drawn pipe, as segments. */
  pipes: [Pt, Pt][];
  /** Symbols, points and weld marks: fixed round obstacles. */
  points: { p: Pt; r: number }[];
  /** Fixed lettering (equipment names, run notes): boxes to keep off. */
  texts: { p: Pt; w: number; h: number }[];
  dims: { key: string; a: Pt; b: Pt; text: string }[];
  tags: { key: string; at: Pt; n: Pt; text: string }[];
  /** `feet`: the pipe a pipe's balloon leads to, from its nearest point. */
  balloons: { key: string; line: string; at: Pt; n: Pt; feet?: [Pt, Pt][] }[];
  letters: { key: string; at: Pt; n: Pt; text: string; dflt: Pt; feet?: [Pt, Pt][] }[];
  /** Notes at a line's end ("CONT. FROM SH.1"): moved like a label, `dflt` where they sit anyway. */
  notes: { key: string; at: Pt; n: Pt; w: number; h: number; dflt: Pt }[];
}

export interface TidyResult {
  dims: Record<string, { offset: number; along: number }>;
  tags: Record<string, { dx: number; dy: number }>;
  balloons: Record<string, { dx: number; dy: number; line: string }>;
  letters: Record<string, { dx: number; dy: number }>;
  /** Moved line-end notes; one left out sits where it does anyway. */
  notes: Record<string, { dx: number; dy: number }>;
}

interface Capsule {
  a: Pt;
  b: Pt;
  r: number;
  /** Kept off by labels and leaders only, not by other dimensions. */
  labelsOnly?: boolean;
  /** What it is, for how badly a label or leader on it reads. */
  kind?: 'pipe' | 'point' | 'text' | 'dimline' | 'dimfull' | 'figure' | 'ext' | 'box' | 'leader';
}

function segDistance(p1: Pt, q1: Pt, p2: Pt, q2: Pt): number {
  // Closest distance between two segments (Ericson, Real-Time Collision Detection).
  const d1 = { x: q1.x - p1.x, y: q1.y - p1.y };
  const d2 = { x: q2.x - p2.x, y: q2.y - p2.y };
  const r = { x: p1.x - p2.x, y: p1.y - p2.y };
  const a = d1.x * d1.x + d1.y * d1.y;
  const e = d2.x * d2.x + d2.y * d2.y;
  const f = d2.x * r.x + d2.y * r.y;
  let s = 0;
  let t = 0;
  if (a <= 1e-9 && e <= 1e-9) return Math.hypot(r.x, r.y);
  if (a <= 1e-9) {
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1.x * r.x + d1.y * r.y;
    if (e <= 1e-9) {
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = d1.x * d2.x + d1.y * d2.y;
      const denom = a * e - b * b;
      s = denom > 1e-9 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  const c1 = { x: p1.x + d1.x * s, y: p1.y + d1.y * s };
  const c2 = { x: p2.x + d2.x * t, y: p2.y + d2.y * t };
  return Math.hypot(c1.x - c2.x, c1.y - c2.y);
}

function hits(c: Capsule, others: Capsule[], gap: number): number {
  let n = 0;
  for (const o of others) if (segDistance(c.a, c.b, o.a, o.b) < c.r + o.r + gap) n += 1;
  return n;
}

/** A box w × h centred on p, as a capsule along its long side. */
function boxCapsule(p: Pt, w: number, h: number): Capsule {
  const half = Math.max(0, (w - h) / 2);
  return { a: { x: p.x - half, y: p.y }, b: { x: p.x + half, y: p.y }, r: h / 2 };
}

/** Where renderDimension puts a dimension's line and figure, as capsules. */
function dimCapsules(a: Pt, b: Pt, n: Pt, off: number, along: number, text: string, s: number): Capsule[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const ax = a.x + n.x * off;
  const ay = a.y + n.y * off;
  const bx = b.x + n.x * off;
  const by = b.y + n.y * off;
  // The line, short of its ends, so the pieces of one run may meet.
  const trim = Math.min(s * 0.4, len * 0.2);
  const line: Capsule = { a: { x: ax + ux * trim, y: ay + uy * trim }, b: { x: bx - ux * trim, y: by - uy * trim }, r: s * 0.15, kind: 'dimline' };
  let angle = Math.atan2(by - ay, bx - ax);
  if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
  const tx = ax + (bx - ax) * along;
  const ty = ay + (by - ay) * along;
  const lift = s * 0.75;
  const cx = tx + Math.sin(angle) * lift;
  const cy = ty - Math.cos(angle) * lift;
  const w = Math.max(s * 1.2, text.length * s * 0.72);
  const h = s * 1.25;
  const half = Math.max(0, (w - h) / 2);
  const fx = Math.cos(angle);
  const fy = Math.sin(angle);
  const figure: Capsule = { a: { x: cx - fx * half, y: cy - fy * half }, b: { x: cx + fx * half, y: cy + fy * half }, r: h / 2, kind: 'figure' };
  // The extension lines, from just off the pipe out to the line: a leader
  // or a label across one reads as badly as across the line itself.
  const sign = off < 0 ? -1 : 1;
  const extFrom = (p: Pt): Capsule => ({ a: { x: p.x + n.x * s * 0.5 * sign, y: p.y + n.y * s * 0.5 * sign }, b: { x: p.x + n.x * off, y: p.y + n.y * off }, r: s * 0.05, labelsOnly: true, kind: 'ext' });
  // The whole line, end to end, for labels and leaders: trimmed, a leader
  // from a tee's weld crossed a branch's dimension right by its end.
  // Its end ticks reach half a symbol past the ends.
  const tick = s * 0.5;
  const full: Capsule = { a: { x: ax - ux * tick, y: ay - uy * tick }, b: { x: bx + ux * tick, y: by + uy * tick }, r: s * 0.1, labelsOnly: true, kind: 'dimfull' };
  return Math.abs(off) > s * 0.6 ? [line, figure, full, extFrom(a), extFrom(b)] : [line, figure, full];
}

/** How near its pipe a letter is drawn with no leader, in symbols. */
export const LETTER_BESIDE = 2.2;

/**
 * Spots beside a pipe, `off` from it on either side, along its length:
 * the nearest to `first` first. A letter may sit anywhere along its pipe.
 */
function besideAlong(feet: [Pt, Pt][], first: Pt, w: number, h: number, clear: number): Pt[] {
  const out: Pt[] = [];
  for (const [a, b] of feet) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    // The box's own reach across the pipe, then the clearance.
    const off = (w / 2) * Math.abs(nx) + (h / 2) * Math.abs(ny) + clear;
    for (const t of [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85]) {
      for (const side of [1, -1]) out.push({ x: a.x + (b.x - a.x) * t + nx * off * side, y: a.y + (b.y - a.y) * t + ny * off * side });
    }
  }
  return out.sort((p, q) => Math.hypot(p.x - first.x, p.y - first.y) - Math.hypot(q.x - first.x, q.y - first.y));
}

export function tidyLayout(specs: LayoutSpecs): TidyResult {
  const s = specs.size;
  const gap = s * 0.2;
  const fixed: Capsule[] = [
    ...specs.pipes.map(([a, b]) => ({ a, b, r: s * 0.3, kind: 'pipe' as const })),
    ...specs.points.map(({ p, r }) => ({ a: p, b: p, r, kind: 'point' as const })),
    ...specs.texts.map(({ p, w, h }) => ({ ...boxCapsule(p, w, h), kind: 'text' as const })),
  ];
  const placed: Capsule[] = [];
  const result: TidyResult = { dims: {}, tags: {}, balloons: {}, letters: {}, notes: {} };
  const forDims = (cs: Capsule[]) => cs.filter((c) => !c.labelsOnly);
  const clash = (cs: Capsule[]) => forDims(cs).reduce((n, c) => n + hits(c, fixed, gap) + hits(c, forDims(placed), gap), 0);

  // Dimensions first: they stand off their pipe in rows. Pieces along one
  // line (a run broken at its valves) keep to one row, as on his sheets;
  // a dimension overlapping another on that line (a chain's total, an
  // olet's location) gets a row of its own. The nearest free row wins, on
  // the side away from the middle of the drawing if it can.
  type Dim = LayoutSpecs['dims'][number];
  const rows: { dims: Dim[]; u: Pt; spans: [number, number][]; longest: number }[] = [];
  for (const dim of specs.dims) {
    const len = Math.hypot(dim.b.x - dim.a.x, dim.b.y - dim.a.y);
    if (len < 1e-6) continue;
    const u = { x: (dim.b.x - dim.a.x) / len, y: (dim.b.y - dim.a.y) / len };
    const row = rows.find((r) => {
      if (Math.abs(r.u.x * u.y - r.u.y * u.x) > 1e-3) return false;
      const o = r.dims[0].a;
      // On the same line: no distance across it.
      if (Math.abs((dim.a.x - o.x) * r.u.y - (dim.a.y - o.y) * r.u.x) > s * 0.05) return false;
      const t1 = (dim.a.x - o.x) * r.u.x + (dim.a.y - o.y) * r.u.y;
      const t2 = (dim.b.x - o.x) * r.u.x + (dim.b.y - o.y) * r.u.y;
      const lo = Math.min(t1, t2);
      const hi = Math.max(t1, t2);
      return r.spans.every(([a, b]) => hi <= a + s * 0.05 || lo >= b - s * 0.05);
    });
    if (row) {
      const o = row.dims[0].a;
      const t1 = (dim.a.x - o.x) * row.u.x + (dim.a.y - o.y) * row.u.y;
      const t2 = (dim.b.x - o.x) * row.u.x + (dim.b.y - o.y) * row.u.y;
      row.dims.push(dim);
      row.spans.push([Math.min(t1, t2), Math.max(t1, t2)]);
      row.longest = Math.max(row.longest, len);
    } else {
      rows.push({ dims: [dim], u, spans: [[0, len]], longest: len });
    }
  }
  // Short rows nearest the pipe, the long ones (totals) outside them.
  rows.sort((x, y) => x.longest - y.longest);
  const alongs = [0.5, 0.36, 0.64, 0.24, 0.76];
  for (const row of rows) {
    const { a: ra, b: rb } = row.dims[0];
    const len = Math.hypot(rb.x - ra.x, rb.y - ra.y);
    // One normal for the row; each dimension's own offset is signed to it.
    let n = { x: -(rb.y - ra.y) / len, y: (rb.x - ra.x) / len };
    const mid = { x: (ra.x + rb.x) / 2, y: (ra.y + rb.y) / 2 };
    if ((mid.x - specs.centroid.x) * n.x + (mid.y - specs.centroid.y) * n.y < 0) n = { x: -n.x, y: -n.y };
    const options: { off: number; cost: number }[] = [];
    // Not closer than three symbols: the pipe's letter goes between.
    for (const k of [3.0, 3.8, 4.6, 5.4, 6.4, 7.6, 9.0]) {
      for (const side of [1, -1]) options.push({ off: k * s * side, cost: k * s + (side < 0 ? s * 1.6 : 0) });
    }
    options.sort((x, y) => x.cost - y.cost);
    let best: { caps: Capsule[]; put: { key: string; n: Pt; along: number }[] } | null = null;
    let bestCost = Infinity;
    for (const o of options) {
      const caps: Capsule[] = [];
      const put: { key: string; n: Pt; along: number }[] = [];
      let clashes = 0;
      let skew = 0;
      for (const dim of row.dims) {
        const l = Math.hypot(dim.b.x - dim.a.x, dim.b.y - dim.a.y);
        // renderDimension turns its normal away from the middle of the
        // drawing; flip the offset where its normal is the row's opposite.
        let dn = { x: -(dim.b.y - dim.a.y) / l, y: (dim.b.x - dim.a.x) / l };
        const dm = { x: (dim.a.x + dim.b.x) / 2, y: (dim.a.y + dim.b.y) / 2 };
        if ((dm.x - specs.centroid.x) * dn.x + (dm.y - specs.centroid.y) * dn.y < 0) dn = { x: -dn.x, y: -dn.y };
        const sign = dn.x * n.x + dn.y * n.y < 0 ? -1 : 1;
        let pick = { along: 0.5, c: Infinity, caps: [] as Capsule[] };
        for (const along of alongs) {
          const cs = dimCapsules(dim.a, dim.b, dn, o.off * sign, along, dim.text, s);
          const c = clash(cs) + forDims(cs).reduce((m, cap) => m + hits(cap, forDims(caps), gap), 0);
          if (c < pick.c) pick = { along, c, caps: cs };
          if (c === 0) break;
        }
        clashes += pick.c;
        skew += Math.abs(pick.along - 0.5);
        caps.push(...pick.caps);
        put.push({ key: dim.key, n: dn, along: pick.along });
      }
      const cost = clashes * 1000 + o.cost + skew * s * 3;
      if (cost < bestCost) {
        bestCost = cost;
        best = { caps, put };
        for (const p of put) result.dims[p.key] = { offset: o.off * (p.n.x * n.x + p.n.y * n.y < 0 ? -1 : 1), along: p.along };
      }
      if (clashes === 0) break;
    }
    if (best) placed.push(...best.caps);
  }

  // Then the labels on leaders: the nearest free spot round what each
  // belongs to, square off its pipe rather than along it, the leader kept
  // clear of the pipe, the dimension lines and their extension lines, and
  // of every other label and leader. The leader is judged as it is drawn:
  // from the nearest point of its pipe for a pipe's balloon or letter,
  // else from its weld or item (his ask, 2026-09-26: "see how lines cross
  // and lie on each other; as far as possible, no lines cutting").
  type Label = { id: string; at: Pt; n: Pt; w: number; h: number; reaches: number[]; feet?: [Pt, Pt][]; home?: Pt; along?: Pt[] };
  const footOf = (label: Label, p: Pt): Pt => {
    if (!label.feet?.length) return label.at;
    let best = label.at;
    let bestD = Infinity;
    for (const [a, b] of label.feet) {
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const l2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2));
      const q = { x: a.x + vx * t, y: a.y + vy * t };
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    return best;
  };
  const shapesAt = (label: Label, p: Pt): { box: Capsule; leader: Capsule | null; whole: Capsule | null } => {
    const box = boxCapsule(p, label.w, label.h);
    const foot = footOf(label, p);
    const dist = Math.hypot(p.x - foot.x, p.y - foot.y);
    // A letter where it sits anyway, or right beside its pipe anywhere
    // along it, is drawn with no leader.
    const atHome = (label.home && Math.hypot(p.x - label.home.x, p.y - label.home.y) < 1e-6) || (label.along && dist < LETTER_BESIDE * s);
    if (atHome || dist < 1e-6) return { box, leader: null, whole: null };
    const ux = (p.x - foot.x) / dist;
    const uy = (p.y - foot.y) / dist;
    // From just off the pipe or weld mark to the label's edge.
    const start = Math.min(label.feet ? s * 0.45 : s * 0.6, dist * 0.4);
    const edge = Math.min(Math.abs(ux) > 1e-6 ? label.w / 2 / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-6 ? label.h / 2 / Math.abs(uy) : Infinity);
    const end = Math.max(start, dist - edge);
    return {
      box,
      // Off its own weld mark or pipe: what is tested against the drawing.
      leader: { a: { x: foot.x + ux * start, y: foot.y + uy * start }, b: { x: foot.x + ux * end, y: foot.y + uy * end }, r: s * 0.05 },
      // From the weld itself: what other leaders must not cross, the three
      // welds of a tee being close together.
      whole: { a: foot, b: { x: foot.x + ux * end, y: foot.y + uy * end }, r: s * 0.05, labelsOnly: true, kind: 'leader' },
    };
  };
  const own = new Map<string, Capsule[]>();
  const others = (id: string): Capsule[] => {
    const out: Capsule[] = [...placed];
    for (const [k, cs] of own) if (k !== id) out.push(...cs);
    return out;
  };
  // How badly each thing reads under a label, or across a leader: over
  // lettering or a pipe worst, a dimension line next, another leader, and
  // a thin dashed extension line least (his ask, 2026-09-26: "try as far
  // as possible that the lines do not cut").
  const UNDER_BOX: Record<string, number> = { pipe: 4, point: 4, text: 6, figure: 6, box: 6, dimline: 3, dimfull: 0, ext: 1, leader: 2 };
  const ACROSS: Record<string, number> = { dimfull: 2.5, ext: 0.8, leader: 1.5 };
  const costOf = (label: Label, p: Pt, rest: Capsule[]): number => {
    const { box, leader, whole } = shapesAt(label, p);
    let c = 0;
    for (const o of [...fixed, ...rest]) {
      if (segDistance(box.a, box.b, o.a, o.b) < box.r + o.r + gap) c += UNDER_BOX[o.kind ?? 'box'] ?? 4;
    }
    if (leader && whole) {
      // Against the drawing: a pipe only when crossed or run along (a weld
      // on a tee sits between pipes; leaving it, the leader is near them
      // whichever way it goes), and no symbol right by its own point.
      for (const o of fixed) {
        if (o.kind === 'point' && Math.hypot(o.a.x - whole.a.x, o.a.y - whole.a.y) < o.r + s * 1.6) continue;
        const reach = o.kind === 'pipe' ? s * 0.08 : o.r + leader.r;
        if (segDistance(leader.a, leader.b, o.a, o.b) < reach) c += o.kind === 'text' ? 3 : 3;
      }
      for (const o of rest) {
        const k = o.kind ?? 'box';
        if (k in ACROSS) {
          if (segDistance(whole.a, whole.b, o.a, o.b) < 1e-6 + (k === 'dimfull' ? o.r * 0.5 : 0)) c += ACROSS[k];
        } else if (k === 'box' || k === 'figure') {
          // Through another label, or a dimension's figure.
          if (segDistance(leader.a, leader.b, o.a, o.b) < o.r) c += 3;
        }
      }
    }
    return c;
  };
  const placeLabel = (label: Label): Pt => {
    const rest = others(label.id);
    const nl = Math.hypot(label.n.x, label.n.y) || 1;
    const nx = label.n.x / nl;
    const ny = label.n.y / nl;
    const options: { p: Pt; cost: number }[] = [];
    if (label.home) options.push({ p: label.home, cost: 0 });
    // Anywhere along its pipe, close beside it, before any leader.
    (label.along ?? []).forEach((p, i) => options.push({ p, cost: s * 0.05 * (i + 1) }));
    for (const reach of label.reaches) {
      for (let i = 0; i < 24; i += 1) {
        const ang = (i / 24) * Math.PI * 2;
        const dx = Math.cos(ang);
        const dy = Math.sin(ang);
        const square = Math.abs(dx * nx + dy * ny);
        options.push({ p: { x: label.at.x + dx * reach, y: label.at.y + dy * reach }, cost: reach + (1 - square) * s * 1.4 });
      }
    }
    options.sort((x, y) => x.cost - y.cost);
    let best = options[0].p;
    let bestScore = Infinity;
    for (const o of options) {
      const c = costOf(label, o.p, rest);
      // Clashes first; among equals, the nearer (options come nearest first).
      const score = c * 1000 + o.cost;
      if (score < bestScore) {
        best = o.p;
        bestScore = score;
      }
      if (c === 0) break;
    }
    const { box, whole } = shapesAt(label, best);
    own.set(label.id, whole ? [{ ...box, kind: 'box' }, whole] : [{ ...box, kind: 'box' }]);
    return best;
  };

  const labels: Label[] = [];
  for (const tag of specs.tags) {
    labels.push({
      id: `t:${tag.key}`,
      at: tag.at,
      n: tag.n,
      w: Math.max(s * 2.2, tag.text.length * s * 0.64 + s * 0.9),
      h: s * 1.55,
      reaches: [2.4, 3.1, 3.8, 4.6, 5.6, 6.8, 8.2, 10, 12].map((k) => k * s),
    });
  }
  for (const balloon of specs.balloons) {
    const r = s * 1.05;
    labels.push({ id: `b:${balloon.key}`, at: balloon.at, n: balloon.n, w: r * 2, h: r * 2, reaches: [2.8, 3.6, 4.4, 5.4, 6.6, 8.0, 9.6, 11.5].map((k) => k * s), feet: balloon.feet });
  }
  for (const letter of specs.letters) {
    labels.push({
      id: `l:${letter.key}`,
      at: letter.at,
      n: letter.n,
      w: Math.max(s * 1.7, letter.text.length * s * 0.8 + s * 0.7),
      h: s * 1.5,
      reaches: [1.8, 2.4, 3.0, 3.8, 4.8, 6.0].map((k) => k * s),
      feet: letter.feet,
      home: letter.dflt,
      along: besideAlong(letter.feet ?? [], letter.dflt, Math.max(s * 1.7, letter.text.length * s * 0.8 + s * 0.7), s * 1.5, s * 0.6),
    });
  }
  for (const note of specs.notes) {
    labels.push({ id: `e:${note.key}`, at: note.at, n: note.n, w: note.w, h: note.h, reaches: [2.4, 3.2, 4.2, 5.4, 7.0, 9.0].map((k) => k * s), home: note.dflt });
  }
  const where = new Map<string, Pt>();
  // Weld tags first, round their welds; then balloons; letters last, as
  // they slide along their pipe into whatever room is left.
  const order = labels;
  for (const label of order) where.set(label.id, placeLabel(label));
  // Laid down one after another, the first ones never saw the later ones:
  // each is placed again against all the rest, twice over.
  for (let pass = 0; pass < 3; pass += 1) {
    for (const label of order) {
      const p = where.get(label.id)!;
      if (costOf(label, p, others(label.id)) === 0) continue;
      where.set(label.id, placeLabel(label));
    }
  }
  for (const tag of specs.tags) {
    const p = where.get(`t:${tag.key}`)!;
    result.tags[tag.key] = { dx: p.x - tag.at.x, dy: p.y - tag.at.y };
  }
  for (const balloon of specs.balloons) {
    const p = where.get(`b:${balloon.key}`)!;
    result.balloons[balloon.key] = { dx: p.x - balloon.at.x, dy: p.y - balloon.at.y, line: balloon.line };
  }
  for (const note of specs.notes) {
    const p = where.get(`e:${note.key}`)!;
    if (Math.hypot(p.x - note.dflt.x, p.y - note.dflt.y) < 1e-6) continue;
    result.notes[note.key] = { dx: p.x - note.at.x, dy: p.y - note.at.y };
  }
  for (const letter of specs.letters) {
    const p = where.get(`l:${letter.key}`)!;
    // A letter where it would sit anyway needs no drag, and no leader.
    if (Math.hypot(p.x - letter.dflt.x, p.y - letter.dflt.y) < 1e-6) continue;
    result.letters[letter.key] = { dx: p.x - letter.at.x, dy: p.y - letter.at.y };
  }
  return result;
}

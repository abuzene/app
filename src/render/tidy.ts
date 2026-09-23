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
  balloons: { key: string; line: string; at: Pt; n: Pt }[];
  letters: { key: string; at: Pt; n: Pt; text: string; dflt: Pt }[];
}

export interface TidyResult {
  dims: Record<string, { offset: number; along: number }>;
  tags: Record<string, { dx: number; dy: number }>;
  balloons: Record<string, { dx: number; dy: number; line: string }>;
  letters: Record<string, { dx: number; dy: number }>;
}

interface Capsule {
  a: Pt;
  b: Pt;
  r: number;
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
  const line: Capsule = { a: { x: ax + ux * trim, y: ay + uy * trim }, b: { x: bx - ux * trim, y: by - uy * trim }, r: s * 0.15 };
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
  const figure: Capsule = { a: { x: cx - fx * half, y: cy - fy * half }, b: { x: cx + fx * half, y: cy + fy * half }, r: h / 2 };
  return [line, figure];
}

export function tidyLayout(specs: LayoutSpecs): TidyResult {
  const s = specs.size;
  const gap = s * 0.2;
  const fixed: Capsule[] = [
    ...specs.pipes.map(([a, b]) => ({ a, b, r: s * 0.3 })),
    ...specs.points.map(({ p, r }) => ({ a: p, b: p, r })),
    ...specs.texts.map(({ p, w, h }) => boxCapsule(p, w, h)),
  ];
  const placed: Capsule[] = [];
  const result: TidyResult = { dims: {}, tags: {}, balloons: {}, letters: {} };
  const clash = (cs: Capsule[]) => cs.reduce((n, c) => n + hits(c, fixed, gap) + hits(c, placed, gap), 0);

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
    for (const k of [2.2, 3.0, 3.8, 4.6, 5.4, 6.4, 7.6, 9.0]) {
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
          const c = clash(cs) + cs.reduce((m, cap) => m + hits(cap, caps, gap), 0);
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
  // clear of the pipe and of what is already down.
  const placeLabel = (at: Pt, n: Pt, w: number, h: number, reaches: number[]): Pt => {
    const nl = Math.hypot(n.x, n.y) || 1;
    const nx = n.x / nl;
    const ny = n.y / nl;
    const options: { p: Pt; cost: number }[] = [];
    for (const reach of reaches) {
      for (let i = 0; i < 16; i += 1) {
        const ang = (i / 16) * Math.PI * 2;
        const dx = Math.cos(ang);
        const dy = Math.sin(ang);
        const square = Math.abs(dx * nx + dy * ny);
        options.push({ p: { x: at.x + dx * reach, y: at.y + dy * reach }, cost: reach + (1 - square) * s * 1.4 });
      }
    }
    options.sort((x, y) => x.cost - y.cost);
    let best = options[0].p;
    let bestClash = Infinity;
    for (const o of options) {
      const box = boxCapsule(o.p, w, h);
      const dist = Math.hypot(o.p.x - at.x, o.p.y - at.y) || 1;
      const ux = (o.p.x - at.x) / dist;
      const uy = (o.p.y - at.y) / dist;
      // The leader, from just off the anchor to the label's edge.
      const start = Math.min(s * 1.1, dist * 0.4);
      const end = Math.max(start, dist - Math.min(w, h) / 2);
      const leader: Capsule = { a: { x: at.x + ux * start, y: at.y + uy * start }, b: { x: at.x + ux * end, y: at.y + uy * end }, r: s * 0.05 };
      const c = clash([box]) * 3 + hits(leader, fixed, 0) + hits(leader, placed, 0);
      if (c < bestClash) {
        best = o.p;
        bestClash = c;
      }
      if (c === 0) break;
    }
    placed.push(boxCapsule(best, w, h));
    // Its leader too, so the next label's leader does not cross it.
    const dist = Math.hypot(best.x - at.x, best.y - at.y) || 1;
    const start = Math.min(s * 1.1, dist * 0.4);
    placed.push({ a: { x: at.x + ((best.x - at.x) / dist) * start, y: at.y + ((best.y - at.y) / dist) * start }, b: best, r: s * 0.05 });
    return best;
  };

  for (const tag of specs.tags) {
    const w = Math.max(s * 2.2, tag.text.length * s * 0.64 + s * 0.9);
    const h = s * 1.55;
    const p = placeLabel(tag.at, tag.n, w, h, [2.4, 3.1, 3.8, 4.6, 5.6, 6.8, 8.2].map((k) => k * s));
    result.tags[tag.key] = { dx: p.x - tag.at.x, dy: p.y - tag.at.y };
  }
  for (const balloon of specs.balloons) {
    const r = s * 1.05;
    const p = placeLabel(balloon.at, balloon.n, r * 2, r * 2, [2.8, 3.6, 4.4, 5.4, 6.6, 8.0, 9.6].map((k) => k * s));
    result.balloons[balloon.key] = { dx: p.x - balloon.at.x, dy: p.y - balloon.at.y, line: balloon.line };
  }
  for (const letter of specs.letters) {
    const w = Math.max(s * 1.7, letter.text.length * s * 0.8 + s * 0.7);
    const h = s * 1.5;
    // A letter where it would sit anyway, if that is free, needs no leader.
    const home = boxCapsule(letter.dflt, w, h);
    if (clash([home]) === 0) {
      placed.push(home);
      continue;
    }
    const p = placeLabel(letter.at, letter.n, w, h, [1.8, 2.4, 3.0, 3.8, 4.8].map((k) => k * s));
    result.letters[letter.key] = { dx: p.x - letter.at.x, dy: p.y - letter.at.y };
  }
  return result;
}

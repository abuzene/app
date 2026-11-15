/**
 * A pipe support's detail sheet (his ask, 2026-11-15): the support seen
 * along the pipe, to a scale, with its members, plates, U-bolt and
 * dimensions; each plate drawn flat with its holes; and down the column
 * its parts list, how many are made, the support steel of the whole sheet,
 * the stamp and the title block, framed as the isometric sheet is.
 */
import type { Drawing } from '../model/types';
import { sizeLabel, sizeOf } from '../model/pipe-data';
import {
  membersOf,
  memberLengths,
  profileOf,
  supportMaterial,
  supportParts,
  supportUses,
  uBoltRod,
  SUPPORT_SHAPES,
  type Profile,
  type SupportPlate,
  type SupportType,
} from '../model/supports';
import { escapeText } from './renderer';
import { MARGIN, SHEETS, clip, hline, rect, sheetNotes, sheetStamp, stampBox, text, titleBlock, vline, type SheetSize } from './sheet';
import { scopeCss } from './style';

type Pt = { x: number; y: number };

/** A view drawn at a scale: model mm → sheet mm. */
class Pen {
  out = '';
  constructor(
    readonly ox: number,
    readonly oy: number,
    readonly s: number,
  ) {}
  X(x: number) {
    return this.ox + x * this.s;
  }
  Y(y: number) {
    return this.oy - y * this.s;
  }
  poly(points: Pt[], cls: string, closed = true) {
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${this.X(p.x).toFixed(2)} ${this.Y(p.y).toFixed(2)}`).join(' ') + (closed ? ' Z' : '');
    this.out += `<path class="${cls}" d="${d}"/>`;
  }
  box(x0: number, y0: number, x1: number, y1: number, cls: string) {
    this.poly(
      [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
      cls,
    );
  }
  line(a: Pt, b: Pt, cls: string) {
    this.out += `<line class="${cls}" x1="${this.X(a.x).toFixed(2)}" y1="${this.Y(a.y).toFixed(2)}" x2="${this.X(b.x).toFixed(2)}" y2="${this.Y(b.y).toFixed(2)}"/>`;
  }
  circle(c: Pt, r: number, cls: string) {
    this.out += `<circle class="${cls}" cx="${this.X(c.x).toFixed(2)}" cy="${this.Y(c.y).toFixed(2)}" r="${(r * this.s).toFixed(2)}"/>`;
  }
  raw(svg: string) {
    this.out += svg;
  }
}

/** A dimension between two points, `off` sheet mm to one side (+ up / right). */
function dim(pen: Pen, a: Pt, b: Pt, off: number, label: string, vertical = false): void {
  const ax = pen.X(a.x);
  const ay = pen.Y(a.y);
  const bx = pen.X(b.x);
  const by = pen.Y(b.y);
  const arrow = (x: number, y: number, dx: number, dy: number) =>
    `<path class="sd-arrow" d="M${x.toFixed(2)} ${y.toFixed(2)} L${(x + dx * 1.6 - dy * 0.45).toFixed(2)} ${(y + dy * 1.6 + dx * 0.45).toFixed(2)} L${(x + dx * 1.6 + dy * 0.45).toFixed(2)} ${(y + dy * 1.6 - dx * 0.45).toFixed(2)} Z"/>`;
  if (vertical) {
    const x = Math.min(ax, bx) - off;
    const [y1, y2] = ay < by ? [ay, by] : [by, ay];
    pen.raw(`<line class="sd-ext" x1="${(ax - 0.8 * Math.sign(off)).toFixed(2)}" y1="${ay.toFixed(2)}" x2="${(x - 1 * Math.sign(off)).toFixed(2)}" y2="${ay.toFixed(2)}"/>`);
    pen.raw(`<line class="sd-ext" x1="${(bx - 0.8 * Math.sign(off)).toFixed(2)}" y1="${by.toFixed(2)}" x2="${(x - 1 * Math.sign(off)).toFixed(2)}" y2="${by.toFixed(2)}"/>`);
    pen.raw(`<line class="sd-dim" x1="${x.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x.toFixed(2)}" y2="${y2.toFixed(2)}"/>`);
    pen.raw(arrow(x, y1, 0, 1) + arrow(x, y2, 0, -1));
    const my = (y1 + y2) / 2;
    pen.raw(`<text class="sd-dim-text" x="${(x - 0.9).toFixed(2)}" y="${my.toFixed(2)}" text-anchor="middle" transform="rotate(-90 ${(x - 0.9).toFixed(2)} ${my.toFixed(2)})">${escapeText(label)}</text>`);
    return;
  }
  const y = Math.min(ay, by) - off;
  const [x1, x2] = ax < bx ? [ax, bx] : [bx, ax];
  pen.raw(`<line class="sd-ext" x1="${ax.toFixed(2)}" y1="${(ay - 0.8 * Math.sign(off)).toFixed(2)}" x2="${ax.toFixed(2)}" y2="${(y - 1 * Math.sign(off)).toFixed(2)}"/>`);
  pen.raw(`<line class="sd-ext" x1="${bx.toFixed(2)}" y1="${(by - 0.8 * Math.sign(off)).toFixed(2)}" x2="${bx.toFixed(2)}" y2="${(y - 1 * Math.sign(off)).toFixed(2)}"/>`);
  pen.raw(`<line class="sd-dim" x1="${x1.toFixed(2)}" y1="${y.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y.toFixed(2)}"/>`);
  pen.raw(arrow(x1, y, 1, 0) + arrow(x2, y, -1, 0));
  pen.raw(`<text class="sd-dim-text" x="${((x1 + x2) / 2).toFixed(2)}" y="${(y - 0.9).toFixed(2)}" text-anchor="middle">${escapeText(label)}</text>`);
}

/** A part's mark in a circle on a leader, `dx`/`dy` sheet mm from the spot it points at. */
function balloon(pen: Pen, at: Pt, mark: number, dx: number, dy: number): void {
  const x = pen.X(at.x);
  const y = pen.Y(at.y);
  const cx = x + dx;
  const cy = y + dy;
  const r = 2.6;
  const len = Math.hypot(dx, dy) || 1;
  pen.raw(
    `<line class="sd-leader" x1="${x.toFixed(2)}" y1="${y.toFixed(2)}" x2="${(cx - (dx / len) * r).toFixed(2)}" y2="${(cy - (dy / len) * r).toFixed(2)}"/>` +
      `<circle class="sd-dot" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="0.45"/>` +
      `<circle class="sd-balloon" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r}"/>` +
      `<text class="sd-balloon-text" x="${cx.toFixed(2)}" y="${(cy + 1).toFixed(2)}" text-anchor="middle">${mark}</text>`,
  );
}

/** A member seen from its side: a band with the section's hidden or visible edges along it. */
function member(pen: Pen, p: Profile, a: Pt, b: Pt, width: number): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const nx = -uy;
  const ny = ux;
  const side = (o: number): [Pt, Pt] => [
    { x: a.x + nx * o, y: a.y + ny * o },
    { x: b.x + nx * o, y: b.y + ny * o },
  ];
  const [p0, p1] = side(-width / 2);
  const [q0, q1] = side(width / 2);
  pen.poly([p0, p1, q1, q0], 'sd-steel');
  if (p.kind === 'L') {
    const [l0, l1] = side(width / 2 - p.t);
    pen.line(l0, l1, 'sd-edge');
  } else {
    const [h0, h1] = side(-width / 2 + p.t);
    const [k0, k1] = side(width / 2 - p.t);
    pen.line(h0, h1, 'sd-hidden');
    pen.line(k0, k1, 'sd-hidden');
  }
}

/** The polygon of a brace from the wall face (x = 0) up to the arm's underside (y = top). */
function bracePolygon(foot: Pt, top: number, reach: number, width: number): Pt[] {
  const dx = reach;
  const dy = top - foot.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const out: Pt[] = [];
  for (const o of [-width / 2, width / 2]) {
    // A line through foot + n·o along (dx, dy): where it meets x = 0 and y = top.
    const px = foot.x + nx * o;
    const py = foot.y + ny * o;
    const atWall = { x: 0, y: py + ((0 - px) * dy) / dx };
    const atArm = { x: px + ((top - py) * dx) / dy, y: top };
    out.push(atWall, atArm);
  }
  return [out[0], out[1], out[3], out[2]];
}

interface Elevation {
  svg: string;
  /** Model extents, mm. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Where each part mark points, model mm, and which way the balloon goes. */
  marks: { mark: number; at: Pt; dx: number; dy: number }[];
  dims: ((pen: Pen) => void)[];
}

/** The support seen along the pipe, at scale s, its model origin at (ox, oy) on the sheet. */
function elevation(t: SupportType, pen: Pen | null): Elevation {
  const od = sizeOf(t.dn).od;
  const rp = od / 2;
  const rod = uBoltRod(t.dn);
  const ru = rp + rod / 2;
  const m = membersOf(t.shape);
  const lengths = memberLengths(t);
  const post = profileOf(t.post);
  const beam = profileOf(t.beam);
  const arm = profileOf(t.arm);
  const brace = profileOf(t.brace);
  const H = t.height;
  const base = t.basePlate;
  const top = t.topPlate;
  const wall = t.wallPlate;
  const parts = supportParts(t);
  const markOf = (prefix: string) => parts.find((p) => p.description.startsWith(prefix))?.mark ?? 0;
  const marks: Elevation['marks'] = [];
  const dims: Elevation['dims'] = [];
  const P = pen ?? new Pen(0, 0, 1);
  const ext = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const take = (x: number, y: number) => {
    ext.x0 = Math.min(ext.x0, x);
    ext.x1 = Math.max(ext.x1, x);
    ext.y0 = Math.min(ext.y0, y);
    ext.y1 = Math.max(ext.y1, y);
  };

  let pipeX = 0;
  // Where the pipe sits on steel: the top of that steel, and how deep the
  // U-bolt's legs go under it.
  let seat = H;
  let under = 0;

  if (m.post) {
    const tb = base?.t ?? 0;
    const bw = base?.w ?? post.h + 60;
    if (base) {
      P.box(-bw / 2, 0, bw / 2, tb, 'sd-steel');
      take(-bw / 2, 0);
      take(bw / 2, tb);
      marks.push({ mark: markOf('BASE PLATE'), at: { x: -bw / 2 + bw * 0.12, y: tb / 2 }, dx: -9, dy: 5 });
      // Holes through the base plate, seen as hidden lines.
      if (base.hole > 0) for (const hx of [-bw / 2 + base.edge, bw / 2 - base.edge]) {
        P.line({ x: hx - base.hole / 2, y: 0 }, { x: hx - base.hole / 2, y: tb }, 'sd-hidden');
        P.line({ x: hx + base.hole / 2, y: 0 }, { x: hx + base.hole / 2, y: tb }, 'sd-hidden');
      }
    }
    const postTop = t.shape === 'POST_LOW' ? H - (top?.t ?? 0) : t.shape === 'POST_T' ? H - beam.h : H;
    member(P, post, { x: 0, y: tb }, { x: 0, y: postTop }, post.h);
    take(-post.h / 2, postTop);
    marks.push({ mark: markOf('POST'), at: { x: -post.h / 2, y: tb + (postTop - tb) * 0.55 }, dx: -10, dy: 0 });
    // The floor.
    P.line({ x: -bw / 2 - 60, y: 0 }, { x: bw / 2 + 60, y: 0 }, 'sd-floor');
    for (let x = -bw / 2 - 55; x < bw / 2 + 60; x += 25) P.line({ x, y: 0 }, { x: x - 12, y: -12 }, 'sd-hatch');
    take(-bw / 2 - 60, -12);
    take(bw / 2 + 60, 0);
    dims.push((pen) => dim(pen, { x: -bw / 2 - 60, y: 0 }, { x: -bw / 2 - 60, y: H }, 4, `${Math.round(H)}`, true));
    dims.push((pen) => {
      pen.line({ x: -bw / 2 - 64, y: H }, { x: pipeX, y: H }, 'sd-ext');
      pen.raw(text(pen.X(-bw / 2 - 60) + 1.2, pen.Y(H) - 1, 'B.O.P.', 'sd-note'));
    });
    if (base) dims.push((pen) => dim(pen, { x: -bw / 2, y: 0 }, { x: bw / 2, y: 0 }, -8, `${base.w}`));

    if (t.shape === 'POST_LOW') {
      const tw = top?.w ?? od + 80;
      if (top) {
        P.box(-tw / 2, H - top.t, tw / 2, H, 'sd-steel');
        marks.push({ mark: markOf('TOP PLATE'), at: { x: tw / 2 - tw * 0.1, y: H - top.t / 2 }, dx: 10, dy: 4 });
        take(-tw / 2, H);
        take(tw / 2, H);
      }
      seat = H;
      under = top?.t ?? 0;
    } else if (t.shape === 'POST_T') {
      const L = lengths.beam ?? 400;
      pipeX = t.pipeAt ?? 0;
      member(P, beam, { x: -L / 2, y: H - beam.h / 2 }, { x: L / 2, y: H - beam.h / 2 }, beam.h);
      take(-L / 2, H - beam.h);
      take(L / 2, H);
      marks.push({ mark: markOf('BEAM'), at: { x: L / 2 - L * 0.12, y: H - beam.h / 2 }, dx: 9, dy: 6 });
      dims.push((pen) => dim(pen, { x: -L / 2, y: H - beam.h }, { x: L / 2, y: H - beam.h }, -6, `${Math.round(L)}`));
      if (pipeX) dims.push((pen) => dim(pen, { x: 0, y: H + od + 2 * rod }, { x: pipeX, y: H + od + 2 * rod }, 5, `${Math.round(pipeX)}`));
      seat = H;
      under = beam.t;
    } else {
      const A = lengths.arm ?? 300;
      const face = post.h / 2;
      pipeX = t.pipeAt ?? face + A / 2;
      member(P, arm, { x: face, y: H - arm.h / 2 }, { x: face + A, y: H - arm.h / 2 }, arm.h);
      take(face + A, H - arm.h);
      marks.push({ mark: markOf('ARM'), at: { x: face + A * 0.85, y: H - arm.h / 2 }, dx: 8, dy: 7 });
      dims.push((pen) => dim(pen, { x: face, y: H - arm.h }, { x: face + A, y: H - arm.h }, -6, `${Math.round(A)}`));
      dims.push((pen) => dim(pen, { x: 0, y: H + od + 2 * rod }, { x: pipeX, y: H + od + 2 * rod }, 5, `${Math.round(pipeX)}`));
      seat = H;
      under = arm.t;
    }
  } else {
    // From a wall: the plate on the wall's face at x = 0, the wall behind it.
    const A = lengths.arm ?? 300;
    const tw = wall?.t ?? 10;
    const armMid = H - arm.h / 2;
    const plateL = wall?.l ?? 200;
    const braced = m.brace;
    const drop = t.braceDrop ?? 300;
    const reach = t.braceReach ?? 250;
    const footY = H - arm.h - drop;
    const plateMid = braced ? (H + footY) / 2 : armMid;
    const pTop = plateMid + plateL / 2;
    const pBot = plateMid - plateL / 2;
    P.box(-tw, pBot, 0, pTop, 'sd-steel');
    marks.push({ mark: markOf('WALL PLATE'), at: { x: -tw / 2, y: pBot + plateL * 0.12 }, dx: -9, dy: 5 });
    P.line({ x: -tw, y: pBot - 60 }, { x: -tw, y: pTop + 60 }, 'sd-floor');
    for (let y = pBot - 55; y < pTop + 60; y += 25) P.line({ x: -tw, y }, { x: -tw - 12, y: y - 12 }, 'sd-hatch');
    take(-tw - 14, pBot - 60);
    take(0, pTop + 60);
    if (wall && wall.hole > 0) for (const hy of [pBot + wall.edge, pTop - wall.edge]) {
      P.line({ x: -tw, y: hy - wall.hole / 2 }, { x: 0, y: hy - wall.hole / 2 }, 'sd-hidden');
      P.line({ x: -tw, y: hy + wall.hole / 2 }, { x: 0, y: hy + wall.hole / 2 }, 'sd-hidden');
    }
    member(P, arm, { x: 0, y: armMid }, { x: A, y: armMid }, arm.h);
    take(A, H);
    marks.push({ mark: markOf('ARM'), at: { x: A * 0.85, y: armMid }, dx: 8, dy: 7 });
    pipeX = t.pipeAt ?? A / 2;
    if (braced) {
      const poly = bracePolygon({ x: 0, y: footY }, H - arm.h, reach, brace.h);
      P.poly(poly, 'sd-steel');
      marks.push({ mark: markOf('BRACE'), at: { x: reach * 0.55, y: footY + drop * 0.55 }, dx: 10, dy: 6 });
      dims.push((pen) => dim(pen, { x: reach, y: footY }, { x: reach, y: H - arm.h }, -(pen.X(A) - pen.X(reach)) - 6, `${Math.round(drop)}`, true));
      dims.push((pen) => dim(pen, { x: 0, y: footY }, { x: reach, y: footY }, -5, `${Math.round(reach)}`));
      take(reach, footY);
    }
    dims.push((pen) => dim(pen, { x: 0, y: H }, { x: A, y: H }, (od + 3 * rod) * pen.s + 11, `${Math.round(A)}`));
    dims.push((pen) => dim(pen, { x: 0, y: H }, { x: pipeX, y: H }, (od + 3 * rod) * pen.s + 5, `${Math.round(pipeX)}`));
    seat = H;
    under = arm.t;
  }

  // The pipe, its centre lines, and the U-bolt round it.
  const c = { x: pipeX, y: seat + rp };
  P.circle(c, rp, 'sd-pipe');
  P.line({ x: c.x - rp - 15, y: c.y }, { x: c.x + rp + 15, y: c.y }, 'sd-centre');
  P.line({ x: c.x, y: c.y - rp - 15 }, { x: c.x, y: c.y + rp + 15 }, 'sd-centre');
  take(c.x - rp - 15, c.y + rp + 15);
  take(c.x + rp + 15, c.y + rp + 15);
  if (pen) pen.raw(text(pen.X(c.x - ru) - rod * pen.s - 1.5, pen.Y(c.y + rp * 0.6), `${sizeLabel(t.dn)} PIPE`, 'sd-note', 'end'));
  if (t.uBolt) {
    const legBottom = seat - under - rod * 2.4;
    const s = P.s;
    const path =
      `M${P.X(c.x - ru).toFixed(2)} ${P.Y(legBottom).toFixed(2)} L${P.X(c.x - ru).toFixed(2)} ${P.Y(c.y).toFixed(2)} ` +
      `A${(ru * s).toFixed(2)} ${(ru * s).toFixed(2)} 0 0 1 ${P.X(c.x + ru).toFixed(2)} ${P.Y(c.y).toFixed(2)} ` +
      `L${P.X(c.x + ru).toFixed(2)} ${P.Y(legBottom).toFixed(2)}`;
    P.raw(`<path class="sd-ubolt" d="${path}" style="stroke-width:${Math.max(0.45, rod * s).toFixed(2)}px"/>`);
    // Two nuts on each leg, one each side of the steel it goes through.
    for (const sx of [-1, 1]) {
      const x = c.x + sx * ru;
      P.box(x - rod * 0.85, seat, x + rod * 0.85, seat + rod * 0.8, 'sd-nut');
      P.box(x - rod * 0.85, seat - under - rod * 0.8, x + rod * 0.85, seat - under, 'sd-nut');
    }
    marks.push({ mark: markOf('U-BOLT'), at: { x: c.x + ru * Math.cos(Math.PI / 4), y: c.y + ru * Math.sin(Math.PI / 4) }, dx: 9, dy: -7 });
  }
  return { svg: P.out, ...ext, marks, dims };
}

/** A plate drawn flat with its holes and dimensions. */
function plateView(pen: Pen, p: SupportPlate, holes: Pt[]): void {
  pen.box(-p.w / 2, -p.l / 2, p.w / 2, p.l / 2, 'sd-steel');
  for (const h of holes) {
    pen.circle(h, p.hole / 2, 'sd-hole');
    pen.line({ x: h.x - p.hole * 0.8, y: h.y }, { x: h.x + p.hole * 0.8, y: h.y }, 'sd-centre');
    pen.line({ x: h.x, y: h.y - p.hole * 0.8 }, { x: h.x, y: h.y + p.hole * 0.8 }, 'sd-centre');
  }
  dim(pen, { x: -p.w / 2, y: -p.l / 2 }, { x: p.w / 2, y: -p.l / 2 }, -5, `${p.w}`);
  dim(pen, { x: -p.w / 2, y: -p.l / 2 }, { x: -p.w / 2, y: p.l / 2 }, 5, `${p.l}`, true);
  if (holes.length >= 2) {
    const xs = [...new Set(holes.map((h) => Math.round(h.x)))].sort((a, b) => a - b);
    const ys = [...new Set(holes.map((h) => Math.round(h.y)))].sort((a, b) => a - b);
    if (xs.length > 1) dim(pen, { x: xs[0], y: p.l / 2 }, { x: xs[xs.length - 1], y: p.l / 2 }, 4, `${xs[xs.length - 1] - xs[0]}`);
    if (ys.length > 1) dim(pen, { x: p.w / 2, y: ys[0] }, { x: p.w / 2, y: ys[ys.length - 1] }, -5, `${ys[ys.length - 1] - ys[0]}`, true);
  }
}

/** The holes of each plate. */
function plateHoles(t: SupportType, which: 'base' | 'wall' | 'top'): Pt[] {
  const p = which === 'base' ? t.basePlate : which === 'wall' ? t.wallPlate : t.topPlate;
  if (!p || p.hole <= 0) return [];
  if (which === 'top') {
    const ru = sizeOf(t.dn).od / 2 + uBoltRod(t.dn) / 2;
    return [
      { x: -ru, y: 0 },
      { x: ru, y: 0 },
    ];
  }
  const ex = p.w / 2 - p.edge;
  const ey = p.l / 2 - p.edge;
  return [
    { x: -ex, y: -ey },
    { x: ex, y: -ey },
    { x: -ex, y: ey },
    { x: ex, y: ey },
  ];
}

const SCALES = [1, 2, 2.5, 5, 10, 15, 20, 25, 50];

/** The largest standard scale (1:n) at which w × h model mm fit in aw × ah sheet mm. */
function scaleFor(w: number, h: number, aw: number, ah: number): number {
  const need = Math.max(w / aw, h / ah);
  return SCALES.find((n) => n >= need) ?? Math.ceil(need);
}

/** The support seen along the pipe, fitted into a box: for the editor's picture. */
export function supportPreview(t: SupportType, w = 320, h = 260): string {
  const e = elevation(t, null);
  const pad = 30;
  const n = Math.max((e.x1 - e.x0) / (w - pad * 2), (e.y1 - e.y0) / (h - pad * 2));
  const pen = new Pen(pad - e.x0 / n + (w - pad * 2 - (e.x1 - e.x0) / n) / 2, h - pad + e.y0 / n - (h - pad * 2 - (e.y1 - e.y0) / n) / 2, 1 / n);
  const drawn = elevation(t, pen);
  for (const d of drawn.dims) d(pen);
  for (const mk of drawn.marks) if (mk.mark) balloon(pen, mk.at, mk.mark, mk.dx * 1.2, mk.dy * 1.2);
  return `<svg xmlns="http://www.w3.org/2000/svg" class="support-preview" viewBox="0 0 ${w} ${h}" width="100%"><style>${scopeCss(SUPPORT_CSS(3.2), '.support-preview')}</style><rect x="0" y="0" width="${w}" height="${h}" fill="#fff"/>${pen.out}</svg>`;
}

const SUPPORT_CSS = (k = 1) => `
.sd-steel { fill: #ffffff; stroke: #12161c; stroke-width: ${0.35 * k}px; stroke-linejoin: round; }
.sd-nut { fill: #12161c; stroke: none; }
.sd-edge { stroke: #12161c; stroke-width: ${0.25 * k}px; }
.sd-hidden { stroke: #12161c; stroke-width: ${0.18 * k}px; stroke-dasharray: ${1.2 * k} ${0.8 * k}; }
.sd-pipe { fill: #eef1f5; stroke: #12161c; stroke-width: ${0.4 * k}px; }
.sd-hole { fill: #ffffff; stroke: #12161c; stroke-width: ${0.25 * k}px; }
.sd-centre { stroke: #5b6675; stroke-width: ${0.13 * k}px; stroke-dasharray: ${3 * k} ${0.8 * k} ${0.5 * k} ${0.8 * k}; }
.sd-ubolt { fill: none; stroke: #2b3440; stroke-linecap: butt; }
.sd-floor { stroke: #12161c; stroke-width: ${0.35 * k}px; }
.sd-hatch { stroke: #12161c; stroke-width: ${0.15 * k}px; }
.sd-dim, .sd-ext { stroke: #12161c; stroke-width: ${0.15 * k}px; }
.sd-arrow { fill: #12161c; }
.sd-dim-text { font-size: ${2.3 * k}px; font-family: "Helvetica Neue", Arial, sans-serif; }
.sd-note { font-size: ${1.9 * k}px; fill: #3d4756; font-family: "Helvetica Neue", Arial, sans-serif; }
.sd-leader { stroke: #12161c; stroke-width: ${0.18 * k}px; }
.sd-dot { fill: #12161c; }
.sd-balloon { fill: #ffffff; stroke: #12161c; stroke-width: ${0.25 * k}px; }
.sd-balloon-text { font-size: ${2.4 * k}px; font-weight: 700; font-family: "Helvetica Neue", Arial, sans-serif; }
.sd-view-title { font-size: 2.6px; font-weight: 700; letter-spacing: 0.05em; text-decoration: underline; }
.sd-view-scale { font-size: 1.9px; fill: #3d4756; }
`;

let supportSheetSeq = 0;

/** A support type's detail sheet, framed as the isometric sheet is. */
export function renderSupportSheet(drawing: Drawing, t: SupportType, size: SheetSize = 'A3'): string {
  const { w: W, h: H } = SHEETS[size];
  const col = Math.min(112, W * 0.26);
  const dividerX = W - MARGIN - col;
  const area = { x: MARGIN + 6, y: MARGIN + 10, w: dividerX - MARGIN - 12, h: H - MARGIN * 2 - 16 };
  const k = size === 'A4' ? 0.82 : 1;

  // The elevation takes the left share, the plates stand in a column right of it.
  const plates: { title: string; plate: SupportPlate; holes: Pt[] }[] = [];
  if (t.basePlate) plates.push({ title: 'BASE PLATE', plate: t.basePlate, holes: plateHoles(t, 'base') });
  if (t.topPlate) plates.push({ title: 'TOP PLATE', plate: t.topPlate, holes: plateHoles(t, 'top') });
  if (t.wallPlate) plates.push({ title: 'WALL PLATE', plate: t.wallPlate, holes: plateHoles(t, 'wall') });
  const plateW = plates.length ? area.w * 0.3 : 0;
  const elevW = area.w - plateW - (plates.length ? 8 : 0);

  const model = elevation(t, null);
  const n = scaleFor(model.x1 - model.x0, model.y1 - model.y0, elevW - 34, area.h - 40);
  const s = 1 / n;
  const ew = (model.x1 - model.x0) * s;
  const eh = (model.y1 - model.y0) * s;
  const ox = area.x + 18 + (elevW - 34 - ew) / 2 - model.x0 * s;
  const oy = area.y + 14 + (area.h - 40 - eh) / 2 + eh + model.y0 * s;
  const pen = new Pen(ox, oy, s);
  const elev = elevation(t, pen);
  for (const d of elev.dims) d(pen);
  for (const mk of elev.marks) if (mk.mark) balloon(pen, mk.at, mk.mark, mk.dx, mk.dy);
  const shapeName = SUPPORT_SHAPES.find((x) => x.id === t.shape)?.name.toUpperCase() ?? t.shape;
  let views = text(area.x + elevW / 2, area.y + 2, `${t.name} — ${shapeName}, LOOKING ALONG THE PIPE`, 'sd-view-title', 'middle');
  views += text(area.x + elevW / 2, area.y + 5.4, `SCALE 1:${n}`, 'sd-view-scale', 'middle');
  views += pen.out;

  // Each plate in its own box down the right of the drawing area.
  if (plates.length) {
    const px = area.x + elevW + 8;
    const boxH = area.h / plates.length;
    const parts = supportParts(t);
    plates.forEach((pl, i) => {
      const by = area.y + boxH * i;
      const pn = scaleFor(pl.plate.w, pl.plate.l, plateW - 24, boxH - 26);
      const ps = 1 / pn;
      const pp = new Pen(px + plateW / 2 + 2, by + 12 + (boxH - 22) / 2, ps);
      plateView(pp, pl.plate, pl.holes);
      const mark = parts.find((p) => p.description.startsWith(pl.title))?.mark;
      views += text(px + plateW / 2, by + 2, `${mark ? `${mark} — ` : ''}${pl.title}${pl.title === 'WALL PLATE' ? ' (FACE)' : ''}`, 'sd-view-title', 'middle');
      views += text(px + plateW / 2, by + 5.4, `PL ${pl.plate.t}  ${pl.holes.length ? `${pl.holes.length} HOLES Ø${pl.plate.hole}` : 'NO HOLES'}  SCALE 1:${pn}`, 'sd-view-scale', 'middle');
      views += pp.out;
    });
    views += vline(px - 4, area.y - 4, area.y + area.h, 'rule-faint');
  }

  // The column: parts of one support, how many, the sheet's support steel.
  const uses = supportUses(drawing).get(t.id) ?? 0;
  const parts = supportParts(t);
  const rowH = 4.2;
  const headH = 5;
  let y = MARGIN;
  let colSvg = '';
  const table = (title: string, head: string[], cols: number[], rows: string[][], foot?: string) => {
    const h = headH * 2 + rowH * Math.max(rows.length, 1) + (foot ? rowH : 0);
    colSvg += rect(dividerX, y, col, h, 'block');
    colSvg += text(dividerX + 1.4, y + headH * 0.72, title, 'tb-head');
    colSvg += hline(dividerX, dividerX + col, y + headH, 'rule');
    const xs: number[] = [];
    let acc = dividerX;
    for (const c of cols) {
      xs.push(acc);
      acc += col * c;
    }
    for (let i = 1; i < xs.length; i += 1) colSvg += vline(xs[i], y + headH, y + h - (foot ? rowH : 0));
    head.forEach((hd, i) => (colSvg += text(xs[i] + 1.2, y + headH * 1.72, hd, 'tb-head')));
    colSvg += hline(dividerX, dividerX + col, y + headH * 2, 'rule-strong');
    rows.forEach((r, ri) => {
      const ry = y + headH * 2 + rowH * ri;
      if (ri > 0) colSvg += hline(dividerX, dividerX + col, ry, 'rule-faint');
      r.forEach((cell, ci) => (colSvg += text(xs[ci] + 1.2, ry + rowH * 0.7, clip(cell, Math.floor((col * cols[ci]) / 1.3)), 'tb-cell')));
    });
    if (rows.length === 0) colSvg += text(xs[0] + 1.2, y + headH * 2 + rowH * 0.7, 'None', 'tb-cell');
    if (foot) {
      const fy = y + h - rowH;
      colSvg += hline(dividerX, dividerX + col, fy, 'rule');
      colSvg += text(dividerX + col - 1.2, fy + rowH * 0.7, foot, 'tb-head', 'end');
    }
    y += h;
  };
  const one = parts.reduce((a, p) => a + p.kg, 0);
  table(
    `PARTS LIST — ${t.name}, ONE SUPPORT`,
    ['MK', 'DESCRIPTION', 'SIZE', 'QTY', 'KG'],
    [0.07, 0.5, 0.21, 0.09, 0.13],
    parts.map((p) => [String(p.mark), p.description, p.size, String(p.qty), p.kg ? p.kg.toFixed(1) : '—']),
    `${uses} OFF ON THIS SHEET · ${one.toFixed(1)} KG EACH · ${(one * uses).toFixed(1)} KG IN ALL`,
  );
  y += 3;
  const material = supportMaterial(drawing);
  table(
    'SUPPORT MATERIAL — ALL TYPES ON THIS SHEET',
    ['DESCRIPTION', 'LENGTH / SIZE', 'QTY', 'KG'],
    [0.54, 0.24, 0.09, 0.13],
    material.map((r) => [r.description, r.size, r.qty ? String(r.qty) : '', r.kg ? r.kg.toFixed(1) : '—']),
    `TOTAL ${material.reduce((a, r) => a + r.kg, 0).toFixed(1)} KG`,
  );

  const tbH = 50;
  const stampH = 13;
  const tbY = H - MARGIN - tbH;
  const stampY = tbY - stampH - 3;
  const noteWidth = Math.floor((col - 2.4) / (1.95 * 0.56));
  const notes = [
    ...sheetNotes(t.note, noteWidth),
    'ALL DIMENSIONS IN MILLIMETRES.',
    'STEEL S235, WELDS 5 MM FILLET ALL ROUND UNLESS NOTED.',
    'U-BOLT DIN 3570, ROD M' + uBoltRod(t.dn) + ', WITH 4 NUTS.',
    `SUPPORTS MARKED ${t.name} ON THE ISOMETRIC.`,
  ];
  const noteY = stampY - 4 - notes.length * 3.2;
  let notesSvg = '';
  notes.forEach((line, i) => (notesSvg += text(dividerX + 1.2, noteY + i * 3.2, line, 'note-text')));

  const meta = { ...drawing.meta, sheet: `SUPPORT ${t.name}` };
  const id = `iso-support-${++supportSheetSeq}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm">
<style>${scopeCss(`
text { font-family: "Helvetica Neue", Arial, sans-serif; }
.sheet-bg { fill: #ffffff; }
.frame { fill: none; stroke: #12161c; stroke-width: 0.5; }
.block { fill: none; stroke: #12161c; stroke-width: 0.35; }
.rule { stroke: #12161c; stroke-width: 0.25; }
.rule-strong { stroke: #12161c; stroke-width: 0.4; }
.rule-faint { stroke: #9aa5b4; stroke-width: 0.15; }
.tb-title { font-size: 3px; font-weight: 700; letter-spacing: 0.04em; }
.stamp { fill: none; stroke: #12161c; stroke-width: 0.5; }
.stamp-text { font-size: 3.6px; font-weight: 700; letter-spacing: 0.12em; }
.tb-label { font-size: 1.7px; fill: #5b6675; letter-spacing: 0.06em; }
.tb-value { font-size: 2.4px; fill: #12161c; }
.tb-head { font-size: 1.9px; font-weight: 700; letter-spacing: 0.05em; }
.tb-cell { font-size: 2.05px; }
.note-text { font-size: 1.95px; fill: #3d4756; }
${SUPPORT_CSS(k)}
`, `#${id}`)}</style>
<rect class="sheet-bg" x="0" y="0" width="${W}" height="${H}"/>
${rect(MARGIN, MARGIN, W - MARGIN * 2, H - MARGIN * 2, 'frame')}
${vline(dividerX, MARGIN, H - MARGIN, 'frame')}
${views}
${colSvg}
${notesSvg}
${stampBox(dividerX, stampY, col, stampH, sheetStamp(drawing))}
${titleBlock({ ...drawing, meta }, dividerX, tbY, col, tbH)}
</svg>`;
}

/** Every support type the sheet uses (or has), a detail sheet each. */
export function renderSupportSheets(drawing: Drawing, size: SheetSize = 'A3'): string[] {
  return (drawing.supportTypes ?? []).map((t) => renderSupportSheet(drawing, t, size));
}

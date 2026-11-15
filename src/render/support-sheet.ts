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
  basePlateName,
  membersOf,
  supportMarks,
  supportSheetGroups,
  memberLengths,
  profileOf,
  supportMaterial,
  supportParts,
  supportQty,
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
  /** A group he can drag on the arrange view (`data-sd`), moved by `by` sheet mm. */
  open(tag: string, by?: { dx: number; dy: number }, extra = '') {
    const move = by && (by.dx || by.dy) ? ` transform="translate(${by.dx.toFixed(2)} ${by.dy.toFixed(2)})"` : '';
    this.out += `<g data-sd="${tag}"${move}${extra}>`;
  }
  close() {
    this.out += '</g>';
  }
}

type Move = { dx: number; dy: number };
const NO_MOVE: Move = { dx: 0, dy: 0 };

/**
 * A dimension between two points, `off` sheet mm to one side (+ up / left).
 * Dragged (`move`), its line goes out or in square to itself and its figure
 * slides along it.
 */
function dim(pen: Pen, a: Pt, b: Pt, off: number, label: string, vertical = false, move: Move = NO_MOVE): void {
  const ax = pen.X(a.x);
  const ay = pen.Y(a.y);
  const bx = pen.X(b.x);
  const by = pen.Y(b.y);
  const arrow = (x: number, y: number, dx: number, dy: number) =>
    `<path class="sd-arrow" d="M${x.toFixed(2)} ${y.toFixed(2)} L${(x + dx * 1.6 - dy * 0.45).toFixed(2)} ${(y + dy * 1.6 + dx * 0.45).toFixed(2)} L${(x + dx * 1.6 + dy * 0.45).toFixed(2)} ${(y + dy * 1.6 - dx * 0.45).toFixed(2)} Z"/>`;
  if (vertical) {
    const x = Math.min(ax, bx) - off + move.dx;
    const side = Math.sign(x - Math.min(ax, bx)) || -1;
    const [y1, y2] = ay < by ? [ay, by] : [by, ay];
    pen.raw(`<line class="sd-ext" x1="${(ax + 0.8 * side).toFixed(2)}" y1="${ay.toFixed(2)}" x2="${(x + 1 * side).toFixed(2)}" y2="${ay.toFixed(2)}"/>`);
    pen.raw(`<line class="sd-ext" x1="${(bx + 0.8 * side).toFixed(2)}" y1="${by.toFixed(2)}" x2="${(x + 1 * side).toFixed(2)}" y2="${by.toFixed(2)}"/>`);
    pen.raw(`<line class="sd-dim" x1="${x.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x.toFixed(2)}" y2="${y2.toFixed(2)}"/>`);
    pen.raw(arrow(x, y1, 0, 1) + arrow(x, y2, 0, -1));
    const my = (y1 + y2) / 2 + move.dy;
    // A figure slid past the ends has the line carried on under it.
    if (my < y1 || my > y2) pen.raw(`<line class="sd-dim" x1="${x.toFixed(2)}" y1="${Math.min(my - 3, y1).toFixed(2)}" x2="${x.toFixed(2)}" y2="${Math.max(my + 3, y2).toFixed(2)}"/>`);
    pen.raw(`<text class="sd-dim-text" x="${(x - 0.9).toFixed(2)}" y="${my.toFixed(2)}" text-anchor="middle" transform="rotate(-90 ${(x - 0.9).toFixed(2)} ${my.toFixed(2)})">${escapeText(label)}</text>`);
    return;
  }
  const y = Math.min(ay, by) - off + move.dy;
  const side = Math.sign(y - Math.min(ay, by)) || -1;
  const [x1, x2] = ax < bx ? [ax, bx] : [bx, ax];
  pen.raw(`<line class="sd-ext" x1="${ax.toFixed(2)}" y1="${(ay + 0.8 * side).toFixed(2)}" x2="${ax.toFixed(2)}" y2="${(y + 1 * side).toFixed(2)}"/>`);
  pen.raw(`<line class="sd-ext" x1="${bx.toFixed(2)}" y1="${(by + 0.8 * side).toFixed(2)}" x2="${bx.toFixed(2)}" y2="${(y + 1 * side).toFixed(2)}"/>`);
  pen.raw(`<line class="sd-dim" x1="${x1.toFixed(2)}" y1="${y.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y.toFixed(2)}"/>`);
  pen.raw(arrow(x1, y, 1, 0) + arrow(x2, y, -1, 0));
  const mx = (x1 + x2) / 2 + move.dx;
  if (mx < x1 || mx > x2) pen.raw(`<line class="sd-dim" x1="${Math.min(mx - 3, x1).toFixed(2)}" y1="${y.toFixed(2)}" x2="${Math.max(mx + 3, x2).toFixed(2)}" y2="${y.toFixed(2)}"/>`);
  pen.raw(`<text class="sd-dim-text" x="${mx.toFixed(2)}" y="${(y - 0.9).toFixed(2)}" text-anchor="middle">${escapeText(label)}</text>`);
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
    (len > r ? `<line class="sd-leader" x1="${x.toFixed(2)}" y1="${y.toFixed(2)}" x2="${(cx - (dx / len) * r).toFixed(2)}" y2="${(cy - (dy / len) * r).toFixed(2)}"/>` : '') +
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

type PlateKey = 'basePlate' | 'topPlate' | 'wallPlate';

interface Elevation {
  /** Model extents, mm. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Where each part mark points, model mm, and which way its balloon goes. */
  marks: { mark: number; at: Pt; dx: number; dy: number }[];
  /** Each dimension by its key, drawn with the move he gave it. */
  dims: { key: string; draw: (pen: Pen, move: Move) => void }[];
  /** Whether a member is welded to steel already there (no plate). */
  existing: boolean;
}

/**
 * The support seen along the pipe. Drawn with `pen` (its model origin on
 * the sheet and its scale); with none, only measured. Each plate is a group
 * he can slide along its seat on the arrange view (`ps:<plate>`).
 */
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
  const plateGroup = (key: PlateKey) => P.open(`${t.id}|ps:${key}`, undefined, ` data-s="${P.s.toFixed(5)}"`);
  let existing = false;

  let pipeX = 0;
  // Where the pipe sits on steel: the top of that steel, and how deep the
  // U-bolt's legs go under it.
  let seat = H;
  let under = 0;

  if (t.shape === 'HANGER_ARM') {
    // Hung from above (his ask, 2026-11-16): the arm's underside at y = 0,
    // its top the pipe's bottom, the roof (or the steel up there) at the top.
    const A = lengths.arm ?? 300;
    const face = post.h / 2;
    const seatY = arm.h;
    const roof = seatY + H;
    const tb = base?.t ?? 0;
    const bw = base?.w ?? post.h + 60;
    const bs = base?.shift ?? 0;
    const left = Math.min(bs - bw / 2, -post.h / 2) - 60;
    const right = Math.max(bs + bw / 2, post.h / 2, face + A) + 40;
    if (base) {
      plateGroup('basePlate');
      P.box(bs - bw / 2, roof - tb, bs + bw / 2, roof, 'sd-steel');
      if (base.hole > 0) for (const hx of [bs - bw / 2 + base.edge, bs + bw / 2 - base.edge]) {
        P.line({ x: hx - base.hole / 2, y: roof - tb }, { x: hx - base.hole / 2, y: roof }, 'sd-hidden');
        P.line({ x: hx + base.hole / 2, y: roof - tb }, { x: hx + base.hole / 2, y: roof }, 'sd-hidden');
      }
      P.close();
      marks.push({ mark: markOf(basePlateName(t)), at: { x: bs - bw / 2 + bw * 0.12, y: roof - tb / 2 }, dx: -9, dy: -5 });
      if (base.hole > 0) marks.push({ mark: markOf('ANCHOR'), at: { x: bs + bw / 2 - base.edge, y: roof - tb / 2 }, dx: 9, dy: -7 });
      // The roof, hatched above.
      const rl = Math.min(left, bs - bw / 2 - 60);
      const rr = Math.max(bs + bw / 2 + 60, post.h / 2 + 60);
      P.line({ x: rl, y: roof }, { x: rr, y: roof }, 'sd-floor');
      for (let x = rl + 5; x < rr; x += 25) P.line({ x, y: roof }, { x: x + 12, y: roof + 12 }, 'sd-hatch');
      take(rl, roof + 12);
      take(rr, roof);
      dims.push({ key: 'base', draw: (pen, mv) => dim(pen, { x: bs - bw / 2, y: roof }, { x: bs + bw / 2, y: roof }, 8, `${base.w}`, false, mv) });
    } else {
      existing = true;
      P.box(left + 30, roof, Math.max(bw / 2, post.h / 2) + 30, roof + 22, 'sd-existing');
      for (let x = left + 40; x < Math.max(bw / 2, post.h / 2) + 30; x += 18) P.line({ x, y: roof }, { x: x + 12, y: roof + 12 }, 'sd-hatch');
      take(left, roof + 22);
      if (pen) pen.raw(text(pen.X(Math.max(bw / 2, post.h / 2) + 30) + 1.5, pen.Y(roof + 11) + 0.8, 'EXISTING STEEL', 'sd-note'));
    }
    member(P, post, { x: 0, y: 0 }, { x: 0, y: roof - tb }, post.h);
    take(-post.h / 2, 0);
    take(right, 0);
    marks.push({ mark: markOf('POST'), at: { x: -post.h / 2, y: (roof - tb) * 0.5 }, dx: -10, dy: 0 });
    member(P, arm, { x: face, y: seatY / 2 }, { x: face + A, y: seatY / 2 }, arm.h);
    marks.push({ mark: markOf('ARM'), at: { x: face + A * 0.85, y: seatY / 2 }, dx: 8, dy: 7 });
    pipeX = t.pipeAt ?? face + A / 2;
    dims.push({ key: 'height', draw: (pen, mv) => dim(pen, { x: left, y: seatY }, { x: left, y: roof }, 4, `${Math.round(H)}`, true, mv) });
    dims.push({
      key: 'bop',
      draw: (pen) => {
        pen.line({ x: left - 4 / pen.s, y: seatY }, { x: -post.h / 2, y: seatY }, 'sd-ext');
        pen.raw(text(pen.X(left) + 1.2, pen.Y(seatY) + 2.6, 'B.O.P.', 'sd-note'));
      },
    });
    dims.push({ key: 'arm', draw: (pen, mv) => dim(pen, { x: face, y: 0 }, { x: face + A, y: 0 }, -6, `${Math.round(A)}`, false, mv) });
    dims.push({ key: 'pipe', draw: (pen, mv) => dim(pen, { x: 0, y: seatY + od + 2 * rod }, { x: pipeX, y: seatY + od + 2 * rod }, 5, `${Math.round(pipeX)}`, false, mv) });
    seat = seatY;
    under = arm.t;
  } else if (m.post) {
    const tb = base?.t ?? 0;
    const bw = base?.w ?? post.h + 60;
    const bs = base?.shift ?? 0;
    const left = Math.min(bs - bw / 2, -post.h / 2) - 60;
    const right = Math.max(bs + bw / 2, post.h / 2) + 60;
    if (base) {
      plateGroup('basePlate');
      P.box(bs - bw / 2, 0, bs + bw / 2, tb, 'sd-steel');
      // Holes through the base plate, seen as hidden lines.
      if (base.hole > 0) for (const hx of [bs - bw / 2 + base.edge, bs + bw / 2 - base.edge]) {
        P.line({ x: hx - base.hole / 2, y: 0 }, { x: hx - base.hole / 2, y: tb }, 'sd-hidden');
        P.line({ x: hx + base.hole / 2, y: 0 }, { x: hx + base.hole / 2, y: tb }, 'sd-hidden');
      }
      P.close();
      take(bs - bw / 2, 0);
      take(bs + bw / 2, tb);
      marks.push({ mark: markOf('BASE PLATE'), at: { x: bs - bw / 2 + bw * 0.12, y: tb / 2 }, dx: -9, dy: 5 });
      // The floor.
      P.line({ x: left, y: 0 }, { x: right, y: 0 }, 'sd-floor');
      for (let x = left + 5; x < right; x += 25) P.line({ x, y: 0 }, { x: x - 12, y: -12 }, 'sd-hatch');
      take(left, -12);
      dims.push({ key: 'base', draw: (pen, mv) => dim(pen, { x: bs - bw / 2, y: 0 }, { x: bs + bw / 2, y: 0 }, -8, `${base.w}`, false, mv) });
      if (bs) dims.push({ key: 'base-shift', draw: (pen, mv) => dim(pen, { x: Math.min(0, bs - bw / 2), y: 0 }, { x: Math.max(0, bs - bw / 2), y: 0 }, -14, `${Math.round(Math.abs(bs - bw / 2))}`, false, mv) });
    } else {
      // Welded to steel already there (his ask, 2026-11-16): a beam's top
      // flange under the post, dashed, its name beside it.
      existing = true;
      P.box(left + 30, -22, right - 30, 0, 'sd-existing');
      for (let x = left + 40; x < right - 30; x += 18) P.line({ x, y: 0 }, { x: x - 12, y: -12 }, 'sd-hatch');
      take(left, -22);
      if (pen) pen.raw(text(pen.X(right - 30) + 1.5, pen.Y(-11) + 0.8, 'EXISTING STEEL', 'sd-note'));
    }
    take(right, 0);
    const postTop = t.shape === 'POST_LOW' ? H - (top?.t ?? 0) : t.shape === 'POST_T' ? H - beam.h : H;
    member(P, post, { x: 0, y: tb }, { x: 0, y: postTop }, post.h);
    take(-post.h / 2, postTop);
    marks.push({ mark: markOf('POST'), at: { x: post.h / 2, y: tb + (postTop - tb) * 0.45 }, dx: 10, dy: 0 });
    dims.push({ key: 'height', draw: (pen, mv) => dim(pen, { x: left, y: 0 }, { x: left, y: H }, 4, `${Math.round(H)}`, true, mv) });
    dims.push({
      key: 'bop',
      draw: (pen) => {
        pen.line({ x: left - 4 / pen.s, y: H }, { x: pipeX, y: H }, 'sd-ext');
        pen.raw(text(pen.X(left) + 1.2, pen.Y(H) - 1, 'B.O.P.', 'sd-note'));
      },
    });

    if (t.shape === 'POST_LOW') {
      if (top) {
        const tw = top.w;
        const ts = top.shift ?? 0;
        plateGroup('topPlate');
        P.box(ts - tw / 2, H - top.t, ts + tw / 2, H, 'sd-steel');
        P.close();
        marks.push({ mark: markOf('TOP PLATE'), at: { x: ts + tw / 2 - tw * 0.1, y: H - top.t / 2 }, dx: 10, dy: 4 });
        take(ts - tw / 2, H);
        take(ts + tw / 2, H);
        if (ts) dims.push({ key: 'top-shift', draw: (pen, mv) => dim(pen, { x: ts - tw / 2, y: H - top.t }, { x: 0, y: H - top.t }, -5, `${Math.round(Math.abs(ts - tw / 2))}`, false, mv) });
      }
      seat = H;
      under = top?.t ?? post.t;
    } else if (t.shape === 'POST_T') {
      const L = lengths.beam ?? 400;
      pipeX = t.pipeAt ?? 0;
      member(P, beam, { x: -L / 2, y: H - beam.h / 2 }, { x: L / 2, y: H - beam.h / 2 }, beam.h);
      take(-L / 2, H - beam.h);
      take(L / 2, H);
      marks.push({ mark: markOf('BEAM'), at: { x: L / 2 - L * 0.12, y: H - beam.h / 2 }, dx: 9, dy: 6 });
      dims.push({ key: 'beam', draw: (pen, mv) => dim(pen, { x: -L / 2, y: H - beam.h }, { x: L / 2, y: H - beam.h }, -6, `${Math.round(L)}`, false, mv) });
      if (pipeX) dims.push({ key: 'pipe', draw: (pen, mv) => dim(pen, { x: 0, y: H + od + 2 * rod }, { x: pipeX, y: H + od + 2 * rod }, 5, `${Math.round(pipeX)}`, false, mv) });
      seat = H;
      under = beam.t;
    } else {
      const A = lengths.arm ?? 300;
      const face = post.h / 2;
      pipeX = t.pipeAt ?? face + A / 2;
      member(P, arm, { x: face, y: H - arm.h / 2 }, { x: face + A, y: H - arm.h / 2 }, arm.h);
      take(face + A, H - arm.h);
      marks.push({ mark: markOf('ARM'), at: { x: face + A * 0.85, y: H - arm.h / 2 }, dx: 8, dy: 7 });
      dims.push({ key: 'arm', draw: (pen, mv) => dim(pen, { x: face, y: H - arm.h }, { x: face + A, y: H - arm.h }, -6, `${Math.round(A)}`, false, mv) });
      dims.push({ key: 'pipe', draw: (pen, mv) => dim(pen, { x: 0, y: H + od + 2 * rod }, { x: pipeX, y: H + od + 2 * rod }, 5, `${Math.round(pipeX)}`, false, mv) });
      seat = H;
      under = arm.t;
    }
  } else {
    // From a wall: the plate on the wall's face at x = 0, the wall behind it.
    const A = lengths.arm ?? 300;
    const armMid = H - arm.h / 2;
    const braced = m.brace;
    const drop = t.braceDrop ?? 300;
    const reach = t.braceReach ?? 250;
    const footY = H - arm.h - drop;
    if (wall) {
      const tw = wall.t;
      const plateL = wall.l;
      const plateMid = (braced ? (H + footY) / 2 : armMid) + (wall.shift ?? 0);
      const pTop = plateMid + plateL / 2;
      const pBot = plateMid - plateL / 2;
      plateGroup('wallPlate');
      P.box(-tw, pBot, 0, pTop, 'sd-steel');
      if (wall.hole > 0) for (const hy of [pBot + wall.edge, pTop - wall.edge]) {
        P.line({ x: -tw, y: hy - wall.hole / 2 }, { x: 0, y: hy - wall.hole / 2 }, 'sd-hidden');
        P.line({ x: -tw, y: hy + wall.hole / 2 }, { x: 0, y: hy + wall.hole / 2 }, 'sd-hidden');
      }
      P.close();
      marks.push({ mark: markOf('WALL PLATE'), at: { x: -tw / 2, y: pBot + plateL * 0.12 }, dx: -9, dy: 5 });
      const wTop = Math.max(pTop, H) + 60;
      const wBot = Math.min(pBot, footY) - 60;
      P.line({ x: -tw, y: wBot }, { x: -tw, y: wTop }, 'sd-floor');
      for (let y = wBot + 5; y < wTop; y += 25) P.line({ x: -tw, y }, { x: -tw - 12, y: y - 12 }, 'sd-hatch');
      take(-tw - 14, wBot);
      take(0, wTop);
      if (wall.shift) dims.push({ key: 'wall-shift', draw: (pen, mv) => dim(pen, { x: -tw, y: pTop }, { x: -tw, y: H }, 6, `${Math.round(Math.abs(pTop - H))}`, true, mv) });
    } else {
      // Welded to a column already there: its face dashed, its name up it.
      existing = true;
      const cTop = H + 80;
      const cBot = (braced ? footY : H - arm.h) - 80;
      P.box(-24, cBot, 0, cTop, 'sd-existing');
      for (let y = cBot + 8; y < cTop; y += 18) P.line({ x: 0, y }, { x: -12, y: y - 12 }, 'sd-hatch');
      take(-24, cBot);
      take(0, cTop);
      if (pen) pen.raw(text(pen.X(-12), pen.Y(cBot) + 3.2, 'EXISTING STEEL', 'sd-note', 'middle'));
    }
    member(P, arm, { x: 0, y: armMid }, { x: A, y: armMid }, arm.h);
    take(A, H);
    marks.push({ mark: markOf('ARM'), at: { x: A * 0.85, y: armMid }, dx: 8, dy: 7 });
    pipeX = t.pipeAt ?? A / 2;
    if (braced) {
      const poly = bracePolygon({ x: 0, y: footY }, H - arm.h, reach, brace.h);
      P.poly(poly, 'sd-steel');
      marks.push({ mark: markOf('BRACE'), at: { x: reach * 0.55, y: footY + drop * 0.55 }, dx: 10, dy: 6 });
      dims.push({ key: 'drop', draw: (pen, mv) => dim(pen, { x: reach, y: footY }, { x: reach, y: H - arm.h }, -(pen.X(A) - pen.X(reach)) - 6, `${Math.round(drop)}`, true, mv) });
      dims.push({ key: 'reach', draw: (pen, mv) => dim(pen, { x: 0, y: footY }, { x: reach, y: footY }, -5, `${Math.round(reach)}`, false, mv) });
      take(reach, footY);
    }
    dims.push({ key: 'arm', draw: (pen, mv) => dim(pen, { x: 0, y: H }, { x: A, y: H }, (od + 3 * rod) * pen.s + 11, `${Math.round(A)}`, false, mv) });
    dims.push({ key: 'pipe', draw: (pen, mv) => dim(pen, { x: 0, y: H }, { x: pipeX, y: H }, (od + 3 * rod) * pen.s + 5, `${Math.round(pipeX)}`, false, mv) });
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
  // Beside the pipe on the side the steel leaves free: right of it, clear of a post on its left.
  if (pen) pen.raw(text(pen.X(c.x + ru) + rod * pen.s + 1.5, pen.Y(c.y) + 0.7, `${sizeLabel(t.dn)} PIPE`, 'sd-note'));
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
  return { ...ext, marks, dims, existing };
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

/** The holes of each plate, from its middle. */
function plateHoles(t: SupportType, which: PlateKey): Pt[] {
  const p = t[which];
  if (!p || p.hole <= 0) return [];
  if (which === 'topPlate') {
    // At the U-bolt's legs, round the pipe on the post's centre line.
    const ru = sizeOf(t.dn).od / 2 + uBoltRod(t.dn) / 2;
    const at = -(p.shift ?? 0);
    return [
      { x: at - ru, y: 0 },
      { x: at + ru, y: 0 },
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
  const need = Math.max(w / Math.max(aw, 1), h / Math.max(ah, 1));
  return SCALES.find((n) => n >= need) ?? Math.ceil(need);
}

/** The support seen along the pipe, fitted into a box: for the editor's picture. */
export function supportPreview(t: SupportType, w = 320, h = 260): string {
  const e = elevation(t, null);
  const pad = 30;
  const n = Math.max((e.x1 - e.x0) / (w - pad * 2), (e.y1 - e.y0) / (h - pad * 2));
  const pen = new Pen(pad - e.x0 / n + (w - pad * 2 - (e.x1 - e.x0) / n) / 2, h - pad + e.y0 / n - (h - pad * 2 - (e.y1 - e.y0) / n) / 2, 1 / n);
  const drawn = elevation(t, pen);
  for (const d of drawn.dims) d.draw(pen, NO_MOVE);
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
.sd-existing { fill: none; stroke: #12161c; stroke-width: ${0.3 * k}px; stroke-dasharray: ${2 * k} ${1 * k}; }
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

type Box = { x: number; y: number; w: number; h: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Which supports on the line are of this type, by the names they carry there. */
function usedOn(drawing: Drawing, t: SupportType): string {
  const names = supportMarks(drawing)
    .filter((m) => m.type === t.id)
    .map((m) => m.name);
  return names.length ? `FOR SUPPORT${names.length === 1 ? '' : 'S'} ${names.join(', ')}` : 'NOT ON THE LINE YET';
}

/**
 * One support's detail in a box of the sheet: its title, the elevation with
 * dimensions and balloons, and each plate flat beside it, every element
 * where he dragged it (`t.layout`) and tagged so the arrange view can take
 * hold of it.
 */
function supportCell(drawing: Drawing, t: SupportType, box: Box, wide: boolean): string {
  const lay = (key: string): Move => t.layout?.[key] ?? NO_MOVE;
  const plates: { key: PlateKey; short: string; title: string; plate: SupportPlate; holes: Pt[] }[] = [];
  if (t.basePlate) plates.push({ key: 'basePlate', short: 'base', title: basePlateName(t), plate: t.basePlate, holes: plateHoles(t, 'basePlate') });
  if (t.topPlate) plates.push({ key: 'topPlate', short: 'top', title: 'TOP PLATE', plate: t.topPlate, holes: plateHoles(t, 'topPlate') });
  if (t.wallPlate) plates.push({ key: 'wallPlate', short: 'wall', title: 'WALL PLATE', plate: t.wallPlate, holes: plateHoles(t, 'wallPlate') });
  const top = box.y + 9;
  // In a tall box the plates go in a row under the support, else in a
  // column beside it.
  const below = plates.length > 0 && box.h > box.w * 1.15;
  const plateW = plates.length && !below ? box.w * (wide ? 0.3 : 0.36) : 0;
  const plateH = below ? Math.min(box.h * 0.32, 70) : 0;
  const h = box.h - 11 - plateH;
  const elevW = box.w - plateW - (plates.length && !below ? 4 : 0);

  const model = elevation(t, null);
  const n = scaleFor(model.x1 - model.x0, model.y1 - model.y0, elevW - 30, h - 24);
  const s = 1 / n;
  const ew = (model.x1 - model.x0) * s;
  const eh = (model.y1 - model.y0) * s;
  const ox = box.x + 16 + (elevW - 30 - ew) / 2 - model.x0 * s;
  const oy = top + 10 + (h - 24 - eh) / 2 + eh + model.y0 * s;
  const shift = lay('elev');
  const pen = new Pen(ox + clamp(shift.dx, -box.w / 2, box.w / 2), oy + clamp(shift.dy, -box.h / 2, box.h / 2), s);
  pen.open(`${t.id}|elev`, undefined, ' data-whole="1"');
  const elev = elevation(t, pen);
  for (const d of elev.dims) {
    pen.open(`${t.id}|dim:${d.key}`);
    d.draw(pen, lay(`dim:${d.key}`));
    pen.close();
  }
  for (const mk of elev.marks) {
    if (!mk.mark) continue;
    const mv = lay(`b:${mk.mark}`);
    pen.open(`${t.id}|b:${mk.mark}`);
    balloon(pen, mk.at, mk.mark, mk.dx + mv.dx, mk.dy + mv.dy);
    pen.close();
  }
  pen.close();
  const shapeName = SUPPORT_SHAPES.find((x) => x.id === t.shape)?.name.toUpperCase() ?? t.shape;
  let out = text(box.x + elevW / 2, box.y + 3.2, wide ? `${t.name} — ${shapeName}, LOOKING ALONG THE PIPE` : `${t.name} — ${shapeName}`, 'sd-view-title', 'middle');
  out += text(box.x + elevW / 2, box.y + 6.6, `${usedOn(drawing, t)} · SCALE 1:${n}`, 'sd-view-scale', 'middle');
  out += pen.out;

  // Each plate flat, down the right of the box, where he put it.
  if (plates.length) {
    const slotW = below ? box.w / plates.length : plateW;
    const slotH = below ? plateH : (box.h - 4) / plates.length;
    const parts = supportParts(t);
    plates.forEach((pl, i) => {
      const px = below ? box.x + slotW * i : box.x + elevW + 4;
      const by = below ? box.y + box.h - plateH : box.y + 2 + slotH * i;
      const pn = scaleFor(pl.plate.w, pl.plate.l, slotW - 22, slotH - 30);
      const mv = lay(`pv:${pl.short}`);
      // Anywhere, so long as its middle stays in the support's box.
      const dx = clamp(mv.dx, box.x - (px + slotW / 2), box.x + box.w - (px + slotW / 2));
      const dy = clamp(mv.dy, box.y - (by + slotH / 2), box.y + box.h - (by + slotH / 2));
      const pp = new Pen(px + slotW / 2 + 2, by + 15 + (slotH - 26) / 2, 1 / pn);
      pp.open(`${t.id}|pv:${pl.short}`, { dx, dy });
      const mark = parts.find((p) => p.description.startsWith(pl.title))?.mark;
      const plateW = slotW;
      pp.raw(text(px + plateW / 2, by + 2.6, `${mark ? `${mark} — ` : ''}${pl.title}${pl.key === 'wallPlate' ? ' (FACE)' : ''}`, 'sd-view-title', 'middle'));
      pp.raw(text(px + plateW / 2, by + 5.8, `PL ${pl.plate.t} · ${pl.holes.length ? `${pl.holes.length} × Ø${pl.plate.hole}` : 'NO HOLES'} · 1:${pn}`, 'sd-view-scale', 'middle'));
      plateView(pp, pl.plate, pl.holes);
      pp.close();
      out += pp.out;
    });
  }
  return out;
}

/** How a sheet's boxes stand: columns × rows for n supports. */
function grid(n: number): { cols: number; rows: number } {
  const cols = n <= 3 ? n : n === 4 ? 2 : 3;
  return { cols, rows: Math.ceil(n / cols) };
}

/**
 * A detail sheet of one or more support types (his ask, 2026-11-16: several
 * supports on one sheet with lines between them, or all on one), framed as
 * the isometric sheet is: the supports in boxes, and down the column each
 * one's parts, the support steel of the whole line, notes, stamp, title.
 */
export function renderSupportDetailSheet(drawing: Drawing, types: SupportType[], size: SheetSize = 'A3', page = 1, pages = 1): string {
  const { w: W, h: H } = SHEETS[size];
  const col = Math.min(112, W * 0.26);
  const dividerX = W - MARGIN - col;
  const area: Box = { x: MARGIN, y: MARGIN, w: dividerX - MARGIN, h: H - MARGIN * 2 };
  const k = size === 'A4' ? 0.82 : 1;
  const { cols, rows } = grid(types.length);
  const cw = area.w / cols;
  const ch = area.h / rows;
  let views = '';
  types.forEach((t, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    views += supportCell(drawing, t, { x: area.x + c * cw + 4, y: area.y + r * ch + 3, w: cw - 8, h: ch - 6 }, cols === 1);
  });
  // Lines between the supports.
  for (let c = 1; c < cols; c += 1) views += vline(area.x + c * cw, area.y, area.y + area.h, 'cell-rule');
  for (let r = 1; r < rows; r += 1) views += hline(area.x, area.x + area.w, area.y + r * ch, 'cell-rule');
  // A box short of a full last row is left blank, closed off by its line.
  const last = types.length % cols;
  if (rows > 1 && last) views += vline(area.x + last * cw, area.y + (rows - 1) * ch, area.y + area.h, 'cell-rule');

  // The column.
  const uses = supportQty(drawing);
  const rowH = types.length > 2 ? 3.5 : 4.2;
  const headH = 5;
  let y = MARGIN;
  let colSvg = '';
  const tbH = 50;
  const stampH = 13;
  const tbY = H - MARGIN - tbH;
  const stampY = tbY - stampH - 3;
  const noteWidth = Math.floor((col - 2.4) / (1.95 * 0.56));
  const existing = types.some((t) => elevation(t, null).existing);
  const notes = [
    ...types.flatMap((t) => (t.note ? sheetNotes(`${types.length > 1 ? `${t.name}: ` : ''}${t.note}`, noteWidth) : [])),
    'ALL DIMENSIONS IN MILLIMETRES.',
    'STEEL S235, WELDS 5 MM FILLET ALL ROUND UNLESS NOTED.',
    ...(existing ? ['NO PLATE: WELDED TO THE EXISTING STEEL ALL ROUND.'] : []),
    `U-BOLTS DIN 3570, ROD ${[...new Set(types.filter((t) => t.uBolt).map((t) => `M${uBoltRod(t.dn)}`))].join(' / ') || '—'}, WITH 4 NUTS.`,
    `SUPPORTS MARKED ${types.map((t) => t.name).join(', ')} ON THE ISOMETRIC.`,
  ];
  const noteY = stampY - 4 - notes.length * 3.2;
  const table = (title: string, head: string[], widths: number[], body: (string[] | { group: string })[], foot: string | undefined, room: number) => {
    const fits = Math.max(1, Math.floor((room - headH * 2 - (foot ? rowH : 0)) / rowH));
    const shown = body.length > fits ? [...body.slice(0, fits - 1), { group: `AND ${body.length - fits + 1} MORE LINES` }] : body;
    const h = headH * 2 + rowH * Math.max(shown.length, 1) + (foot ? rowH : 0);
    colSvg += rect(dividerX, y, col, h, 'block');
    colSvg += text(dividerX + 1.4, y + headH * 0.72, title, 'tb-head');
    colSvg += hline(dividerX, dividerX + col, y + headH, 'rule');
    const xs: number[] = [];
    let acc = dividerX;
    for (const c of widths) {
      xs.push(acc);
      acc += col * c;
    }
    head.forEach((hd, i) => (colSvg += text(xs[i] + 1.2, y + headH * 1.72, hd, 'tb-head')));
    colSvg += hline(dividerX, dividerX + col, y + headH * 2, 'rule-strong');
    shown.forEach((row, ri) => {
      const ry = y + headH * 2 + rowH * ri;
      if (ri > 0) colSvg += hline(dividerX, dividerX + col, ry, Array.isArray(row) ? 'rule-faint' : 'rule');
      if (!Array.isArray(row)) {
        colSvg += text(dividerX + 1.2, ry + rowH * 0.72, row.group, 'tb-head');
        return;
      }
      for (let i = 1; i < xs.length; i += 1) colSvg += vline(xs[i], ry, ry + rowH);
      row.forEach((cell, ci) => (colSvg += text(xs[ci] + 1.2, ry + rowH * 0.7, clip(cell, Math.floor((col * widths[ci]) / 1.3)), 'tb-cell')));
    });
    if (shown.length === 0) colSvg += text(xs[0] + 1.2, y + headH * 2 + rowH * 0.7, 'None', 'tb-cell');
    if (foot) {
      const fy = y + h - rowH;
      colSvg += hline(dividerX, dividerX + col, fy, 'rule');
      colSvg += text(dividerX + col - 1.2, fy + rowH * 0.7, foot, 'tb-head', 'end');
    }
    y += h;
  };
  const material = supportMaterial(drawing);
  const materialRoom = headH * 2 + rowH * (Math.max(material.length, 1) + 1);
  const partsRows: (string[] | { group: string })[] = [];
  let all = 0;
  for (const t of types) {
    const parts = supportParts(t);
    const one = parts.reduce((a, p) => a + p.kg, 0);
    const n = uses.get(t.id) ?? 0;
    all += one * n;
    if (types.length > 1) partsRows.push({ group: `${t.name} — ${n} OFF · ${one.toFixed(1)} KG EACH` });
    for (const p of parts) partsRows.push([String(p.mark), p.description, p.size, String(p.qty), p.kg ? p.kg.toFixed(1) : '—']);
  }
  const single = types.length === 1 ? types[0] : null;
  const oneKg = single ? supportParts(single).reduce((a, p) => a + p.kg, 0) : 0;
  table(
    single ? `PARTS LIST — ${single.name}, ONE SUPPORT` : 'PARTS LIST — ONE SUPPORT OF EACH',
    ['MK', 'DESCRIPTION', 'SIZE', 'QTY', 'KG'],
    [0.07, 0.5, 0.21, 0.09, 0.13],
    partsRows,
    single
      ? `${uses.get(single.id) ?? 0} OFF · ${oneKg.toFixed(1)} KG EACH · ${(oneKg * (uses.get(single.id) ?? 0)).toFixed(1)} KG IN ALL`
      : `THESE ${types.length} TYPES · ${all.toFixed(1)} KG IN ALL`,
    noteY - 5 - y - materialRoom - 3,
  );
  y += 3;
  table(
    'SUPPORT MATERIAL — ALL TYPES ON THIS SHEET',
    ['DESCRIPTION', 'LENGTH / SIZE', 'QTY', 'KG'],
    [0.54, 0.24, 0.09, 0.13],
    material.map((r) => [r.description, r.size, r.qty ? String(r.qty) : '', r.kg ? r.kg.toFixed(1) : '—']),
    `TOTAL ${material.reduce((a, r) => a + r.kg, 0).toFixed(1)} KG`,
    Math.max(materialRoom, noteY - 5 - y),
  );
  let notesSvg = '';
  notes.forEach((line, i) => (notesSvg += text(dividerX + 1.2, noteY + i * 3.2, line, 'note-text')));

  const sheetName = single ? `SUPPORT ${single.name}` : `SUPPORTS ${page} OF ${pages}`;
  const meta = { ...drawing.meta, sheet: sheetName };
  const id = `iso-support-${++supportSheetSeq}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" class="support-sheet" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm">
<style>${scopeCss(`
text { font-family: "Helvetica Neue", Arial, sans-serif; }
.sheet-bg { fill: #ffffff; }
.frame { fill: none; stroke: #12161c; stroke-width: 0.5; }
.cell-rule { stroke: #12161c; stroke-width: 0.4; }
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
.tb-cell { font-size: ${rowH < 4 ? 1.85 : 2.05}px; }
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

/** A support type's detail sheet of its own. */
export function renderSupportSheet(drawing: Drawing, t: SupportType, size: SheetSize = 'A3'): string {
  return renderSupportDetailSheet(drawing, [t], size);
}

/** The detail sheets of the line's support types, as he grouped them. */
export function renderSupportSheets(drawing: Drawing, size: SheetSize = 'A3'): string[] {
  const groups = supportSheetGroups(drawing);
  return groups.map((g, i) => renderSupportDetailSheet(drawing, g, size, i + 1, groups.length));
}

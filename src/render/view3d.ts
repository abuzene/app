/**
 * The line as a solid model: pipe at its outside diameter, elbows bent at
 * their radius, tees, olets, reducers, flanges, valves with their handles,
 * a dark bead at every weld. Seen from any side in the 3D view, and put on
 * the sheet as a picture (his ask, 2026-09-27: "can the pipe line be seen
 * in 3D — and a picture of it on the sheet, clearer for the shop").
 *
 * Drawn with WebGL and nothing else: no library, so the app stays small
 * and works offline. The model is built to true dimensions from the
 * drawing's points, whatever the sheet's not-to-scale drawing shows.
 */
import type { Axis, Drawing, InlineComponent, Run, Vec3 } from '../model/types';
import {
  type Analysis,
  isMark,
  isReducer,
  isValve,
  oletEntries,
  oletLegs,
  pipeSpans,
  reducerSides,
  resolveEnds,
  terminalWeldKind,
  valveOpenSide,
  nodeFittingTakeout,
} from '../model/drawing';
import { componentTakeout, flangeLength, reducerLength, sizeOf, valveFlangeKind } from '../model/pipe-data';
import { AXIS_VECTOR, direction, length3, scale3, sub } from '../model/iso';

type RGB = [number, number, number];

const PIPE: RGB = [0.62, 0.67, 0.73];
const FITTING: RGB = [0.5, 0.58, 0.68];
const FLANGE: RGB = [0.44, 0.49, 0.56];
const VALVE: RGB = [0.78, 0.2, 0.18];
const HANDLE: RGB = [0.16, 0.17, 0.2];
const ACTUATOR: RGB = [0.22, 0.44, 0.74];
const WELD: RGB = [0.12, 0.12, 0.14];
const PE: RGB = [0.14, 0.14, 0.15];
const COUPLING: RGB = [0.46, 0.54, 0.64];
const DASHED: RGB = [0.62, 0.67, 0.73];
const EQUIPMENT: RGB = [0.7, 0.74, 0.8];
const FILTER_BODY: RGB = [0.34, 0.52, 0.4];

/** Class 150 flange outside diameters (ASME B16.5), mm. */
const FLANGE_OD: Record<string, number> = {
  DN15: 89, DN20: 99, DN25: 108, DN32: 117, DN40: 127, DN50: 152, DN65: 178, DN80: 191, DN100: 229,
  DN125: 254, DN150: 279, DN200: 343, DN250: 406, DN300: 483, DN350: 533, DN400: 597, DN450: 635, DN500: 699, DN600: 813,
};

function flangeOd(dn: string): number {
  return FLANGE_OD[dn] ?? sizeOf(dn).od * 1.6 + 50;
}

function flangeThick(dn: string): number {
  return Math.max(11, flangeOd(dn) * 0.085);
}

/** A thing to write beside the model: a weld number, a box's name. */
export interface Label3D {
  pos: Vec3;
  text: string;
  kind: 'weld' | 'equipment';
}

export interface Model3D {
  /** Solid parts: position, normal, colour, three floats each. */
  solid: { pos: Float32Array; nor: Float32Array; col: Float32Array; count: number };
  /** See-through parts, drawn after: the next sheet's pipe, equipment boxes. */
  glass: { pos: Float32Array; nor: Float32Array; col: Float32Array; count: number };
  /** The middle of the model: every position above is taken from it. */
  centre: Vec3;
  /** Half the model's largest extent, for the depth range. */
  radius: number;
  labels: Label3D[];
}

type V = [number, number, number];

const v3 = (p: Vec3): V => [p.e, p.n, p.u];
const vadd = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vsub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vmul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const vdot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a: V) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a: V): V => {
  const l = vlen(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Two unit vectors square to `d` and to each other. */
function basis(d: V): [V, V] {
  const helper: V = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const a = vnorm(vcross(d, helper));
  const b = vcross(d, a);
  return [a, b];
}

/** Which way is "up" beside a line going `d`: up, unless the line is upright. */
function upBeside(d: V): V {
  return Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
}

const SIDES = 28;

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  min: V = [Infinity, Infinity, Infinity];
  max: V = [-Infinity, -Infinity, -Infinity];

  vertex(p: V, n: V, c: RGB): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    for (let i = 0; i < 3; i += 1) {
      if (p[i] < this.min[i]) this.min[i] = p[i];
      if (p[i] > this.max[i]) this.max[i] = p[i];
    }
  }

  tri(a: V, b: V, c: V, na: V, nb: V, nc: V, col: RGB): void {
    this.vertex(a, na, col);
    this.vertex(b, nb, col);
    this.vertex(c, nc, col);
  }

  /** A pipe or a cone from `a` (radius r1) to `b` (radius r2), ends closed when asked. */
  tube(a: V, b: V, r1: number, r2: number, col: RGB, caps: [boolean, boolean] = [false, false]): void {
    const axis = vsub(b, a);
    const len = vlen(axis);
    if (len < 0.01) return;
    const d = vmul(axis, 1 / len);
    const [x, y] = basis(d);
    const ring = (centre: V, r: number, i: number): V => {
      const t = (i / SIDES) * Math.PI * 2;
      return vadd(centre, vadd(vmul(x, Math.cos(t) * r), vmul(y, Math.sin(t) * r)));
    };
    const slope = (r1 - r2) / len;
    const normal = (i: number): V => {
      const t = (i / SIDES) * Math.PI * 2;
      return vnorm(vadd(vadd(vmul(x, Math.cos(t)), vmul(y, Math.sin(t))), vmul(d, slope)));
    };
    for (let i = 0; i < SIDES; i += 1) {
      const a0 = ring(a, r1, i);
      const a1 = ring(a, r1, i + 1);
      const b0 = ring(b, r2, i);
      const b1 = ring(b, r2, i + 1);
      const n0 = normal(i);
      const n1 = normal(i + 1);
      this.tri(a0, b0, b1, n0, n0, n1, col);
      this.tri(a0, b1, a1, n0, n1, n1, col);
      if (caps[0] && r1 > 0) this.tri(a, a1, a0, vmul(d, -1), vmul(d, -1), vmul(d, -1), col);
      if (caps[1] && r2 > 0) this.tri(b, b0, b1, d, d, d, col);
    }
  }

  /** A disc of thickness `t` centred on `c` across `d`: a flange, a blind, a wheel. */
  disc(c: V, d: V, r: number, t: number, col: RGB): void {
    this.tube(vadd(c, vmul(d, -t / 2)), vadd(c, vmul(d, t / 2)), r, r, col, [true, true]);
  }

  sphere(c: V, r: number, col: RGB): void {
    const rows = 12;
    const cols = SIDES;
    const at = (i: number, j: number): V => {
      const phi = (i / rows) * Math.PI;
      const th = (j / cols) * Math.PI * 2;
      return [Math.sin(phi) * Math.cos(th), Math.sin(phi) * Math.sin(th), Math.cos(phi)];
    };
    for (let i = 0; i < rows; i += 1) {
      for (let j = 0; j < cols; j += 1) {
        const n00 = at(i, j);
        const n10 = at(i + 1, j);
        const n11 = at(i + 1, j + 1);
        const n01 = at(i, j + 1);
        const p = (n: V) => vadd(c, vmul(n, r));
        this.tri(p(n00), p(n10), p(n11), n00, n10, n11, col);
        this.tri(p(n00), p(n11), p(n01), n00, n11, n01, col);
      }
    }
  }

  /** A box on `c`, its half sizes along three square directions. */
  box(c: V, axes: [V, V, V], half: [number, number, number], col: RGB): void {
    for (let k = 0; k < 3; k += 1) {
      for (const s of [1, -1]) {
        const n = vmul(axes[k], s);
        const u = axes[(k + 1) % 3];
        const w = axes[(k + 2) % 3];
        const hu = half[(k + 1) % 3];
        const hw = half[(k + 2) % 3];
        const face = vadd(c, vmul(n, half[k]));
        const corner = (a: number, b: number) => vadd(face, vadd(vmul(u, a * hu), vmul(w, b * hw)));
        const p = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
        if (s > 0) {
          this.tri(p[0], p[1], p[2], n, n, n, col);
          this.tri(p[0], p[2], p[3], n, n, n, col);
        } else {
          this.tri(p[0], p[2], p[1], n, n, n, col);
          this.tri(p[0], p[3], p[2], n, n, n, col);
        }
      }
    }
  }

  /**
   * A bend: the pipe swept round `theta` about `centre`, starting at
   * `start` going `along`, with the rings kept square to the sweep.
   */
  bend(start: V, along: V, centre: V, theta: number, r: number, col: RGB): void {
    const radial = vsub(start, centre);
    const R = vlen(radial);
    if (R < 0.01 || theta < 0.01) return;
    const a = vmul(radial, 1 / R);
    const b = along;
    const axis = vnorm(vcross(a, b));
    const steps = Math.max(6, Math.round((theta / (Math.PI / 2)) * 14));
    const frame = (s: number) => {
      const phi = (s / steps) * theta;
      const out = vadd(vmul(a, Math.cos(phi)), vmul(b, Math.sin(phi)));
      return { c: vadd(centre, vmul(out, R)), out };
    };
    const ring = (f: { c: V; out: V }, i: number): { p: V; n: V } => {
      const t = (i / SIDES) * Math.PI * 2;
      const n = vadd(vmul(f.out, Math.cos(t)), vmul(axis, Math.sin(t)));
      return { p: vadd(f.c, vmul(n, r)), n };
    };
    for (let s = 0; s < steps; s += 1) {
      const f0 = frame(s);
      const f1 = frame(s + 1);
      for (let i = 0; i < SIDES; i += 1) {
        const p00 = ring(f0, i);
        const p01 = ring(f0, i + 1);
        const p10 = ring(f1, i);
        const p11 = ring(f1, i + 1);
        this.tri(p00.p, p10.p, p11.p, p00.n, p10.n, p11.n, col);
        this.tri(p00.p, p11.p, p01.p, p00.n, p11.n, p01.n, col);
      }
    }
  }

  finish(centre: V) {
    const pos = new Float32Array(this.pos.length);
    for (let i = 0; i < this.pos.length; i += 3) {
      pos[i] = this.pos[i] - centre[0];
      pos[i + 1] = this.pos[i + 1] - centre[1];
      pos[i + 2] = this.pos[i + 2] - centre[2];
    }
    return { pos, nor: new Float32Array(this.nor), col: new Float32Array(this.col), count: this.pos.length / 3 };
  }
}

const od = (dn: string) => sizeOf(dn).od;

/** A flange on a pipe: its face at `face`, the hub going back along `back` into the pipe. */
function flangeAt(g: Builder, face: V, back: V, dn: string, kind: string): void {
  const F = flangeOd(dn);
  const t = flangeThick(dn);
  const length = kind === 'FLG_WN' ? flangeLength(dn) : Math.max(t * 1.6, componentTakeout('FLG_SO', dn));
  g.tube(face, vadd(face, vmul(back, t)), F / 2, F / 2, FLANGE, [true, true]);
  const hubStart = vadd(face, vmul(back, t));
  const hubEnd = vadd(face, vmul(back, Math.max(length, t + 2)));
  const pipe = od(dn) / 2;
  g.tube(hubStart, hubEnd, kind === 'FLG_WN' ? pipe * 1.38 + 4 : pipe * 1.3 + 4, kind === 'FLG_WN' ? pipe : pipe * 1.3 + 4, FLANGE, [false, kind !== 'FLG_WN']);
}

/** A blind plate on a face, standing out from it along `out`. */
function blindAt(g: Builder, face: V, out: V, dn: string): void {
  const t = flangeThick(dn) * 1.1;
  g.tube(face, vadd(face, vmul(out, t)), flangeOd(dn) / 2, flangeOd(dn) / 2, FLANGE, [true, true]);
}

function valveAt(g: Builder, drawing: Drawing, run: Run, comp: InlineComponent, c: V, d: V): void {
  const dn = comp.dn ?? run.dn;
  const joint = drawing.options.joint ?? 'BW';
  const ends = resolveEnds(comp.kind, dn, comp.ends, joint);
  const flanged = ends === 'FLG';
  const ff = componentTakeout(comp.kind, dn, false, comp.ff) * 2;
  const pipe = od(dn) / 2;
  const F = flangeOd(dn);
  const half = Math.max(ff / 2, pipe * 1.2);
  const faceA = vadd(c, vmul(d, -half));
  const faceB = vadd(c, vmul(d, half));
  const up = upBeside(d);
  const side = vcross(d, up);

  if (flanged) {
    const t = flangeThick(dn);
    // The valve's own end flanges, then the body between.
    g.disc(vadd(faceA, vmul(d, t / 2)), d, F / 2, t, VALVE);
    g.disc(vadd(faceB, vmul(d, -t / 2)), d, F / 2, t, VALVE);
    g.tube(vadd(faceA, vmul(d, t)), vadd(faceB, vmul(d, -t)), pipe * 1.15, pipe * 1.15, VALVE);
    if (comp.kind !== 'BUTTERFLY' && comp.kind !== 'FILTER') g.sphere(c, Math.min(half - t, F * 0.42), VALVE);
    // The flanges it is bolted between, unless left off or bolted to a valve.
    const open = valveOpenSide(drawing, run, comp);
    const kind = valveFlangeKind(joint);
    for (const s of [0, 1] as const) {
      const face = s === 0 ? faceA : faceB;
      const out = vmul(d, s === 0 ? -1 : 1);
      if (comp.bare === s) continue;
      if (open === s && comp.lastFlange === 'none') continue;
      if (open === s && comp.lastFlange === 'blind') {
        blindAt(g, face, out, dn);
        continue;
      }
      flangeAt(g, vadd(face, vmul(out, 1.5)), out, dn, kind);
    }
  } else {
    // Screwed or socket welded: a forged body with hex ends.
    g.tube(faceA, faceB, pipe * 1.45 + 3, pipe * 1.45 + 3, VALVE, [true, true]);
    g.sphere(c, pipe * 1.9 + 4, VALVE);
  }

  if (comp.kind === 'CHECK') return;
  if (comp.kind === 'FILTER') {
    // The filter's housing standing on the line, its cover on top.
    const r = Math.max(pipe * 1.6, F * 0.42);
    g.tube(vadd(c, vmul(up, -r * 0.9)), vadd(c, vmul(up, r * 1.6)), r, r, FILTER_BODY, [true, false]);
    g.tube(vadd(c, vmul(up, r * 1.6)), vadd(c, vmul(up, r * 1.75)), r * 1.12, r * 1.12, FLANGE, [true, true]);
    return;
  }
  if (comp.kind === 'RELIEF') {
    // An angle valve: in along the line, out to the side, its spring
    // bonnet standing on over the inlet's line.
    const out = vcross(d, up);
    const reach = Math.max(half, F * 0.6);
    g.tube(c, vadd(c, vmul(out, reach)), pipe * 1.1, pipe * 1.1, VALVE);
    g.disc(vadd(c, vmul(out, reach)), out, F / 2, flangeThick(dn), VALVE);
    g.tube(vadd(c, vmul(d, half * 0.5)), vadd(c, vmul(d, half + F * 0.9)), pipe * 0.9 + 6, pipe * 0.7 + 4, VALVE, [false, true]);
    return;
  }
  // The stem, then what works it: an actuator, a lever, a wheel.
  const body = flanged ? Math.min(half, F * 0.42) : pipe * 1.9 + 4;
  const stemTop = vadd(c, vmul(up, body + Math.max(30, F * 0.35)));
  g.tube(vadd(c, vmul(up, body * 0.8)), stemTop, Math.max(5, pipe * 0.18), Math.max(5, pipe * 0.18), HANDLE, [false, true]);
  if (comp.kind === 'REGULATOR') {
    // The diaphragm case on the stem, the spring case over it, and the
    // sensing line out to the pipe downstream (the way it flows).
    const R = Math.max(70, F * 0.62);
    g.tube(stemTop, vadd(stemTop, vmul(up, R * 0.35)), R, R, ACTUATOR, [true, true]);
    g.tube(vadd(stemTop, vmul(up, R * 0.35)), vadd(stemTop, vmul(up, R * 0.9)), R * 0.35, R * 0.28, ACTUATOR, [false, true]);
    const flow = vmul(d, comp.flip ? -1 : 1);
    const lineR = Math.max(4, pipe * 0.1);
    const start = vadd(vadd(stemTop, vmul(up, R * 0.17)), vmul(flow, R));
    const far = half + flangeLength(dn) + Math.max(150, F * 0.8);
    const over = vadd(vadd(c, vmul(flow, far)), vmul(up, vdot(vsub(start, c), up)));
    const tap = vadd(vadd(c, vmul(flow, far)), vmul(up, pipe));
    g.tube(start, over, lineR, lineR, HANDLE);
    g.sphere(over, lineR, HANDLE);
    g.tube(over, tap, lineR, lineR, HANDLE);
    return;
  }
  if (comp.kind === 'BALL_ACT' || comp.kind === 'CONTROL') {
    const s = Math.max(70, F * 0.62);
    g.box(vadd(stemTop, vmul(up, s / 2)), [d, side, up], [s * 0.7, s / 2, s / 2], ACTUATOR);
  } else if (comp.kind === 'BALL' || comp.kind === 'BUTTERFLY' || comp.kind === 'PLUG') {
    const lever = Math.max(120, F * 1.2);
    g.box(vadd(stemTop, vmul(d, lever / 2 - 10)), [d, side, up], [lever / 2, Math.max(6, F * 0.03), Math.max(4, F * 0.02)], HANDLE);
  } else if (comp.kind !== 'STRAINER') {
    g.disc(stemTop, up, Math.max(50, F * 0.42), Math.max(8, F * 0.04), HANDLE);
  }
}

function itemAt(g: Builder, drawing: Drawing, run: Run, comp: InlineComponent, a: V, d: V): void {
  if (isMark(comp.kind) || comp.kind === 'INSTRUMENT' || comp.kind === 'ANCHOR' || comp.kind === 'GUIDE') return;
  const c = vadd(a, vmul(d, comp.offset));
  const dn = comp.dn ?? run.dn;
  if (isValve(comp.kind)) return valveAt(g, drawing, run, comp, c, d);
  if (isReducer(comp.kind)) {
    const sides = reducerSides(comp, run.dn);
    const len = reducerLength(sides.start, sides.end);
    const r1 = od(sides.start) / 2;
    const r2 = od(sides.end) / 2;
    const s = vadd(c, vmul(d, -len / 2));
    const e = vadd(c, vmul(d, len / 2));
    // Eccentric: flat along the bottom, the small end lifted off the centre line.
    const drop = comp.kind === 'RED_ECC' ? vmul(upBeside(d), -Math.abs(r1 - r2)) : ([0, 0, 0] as V);
    const lift = (p: V, r: number) => (r < Math.max(r1, r2) ? vsub(p, vmul(drop, -1)) : p);
    const s2 = comp.kind === 'RED_ECC' ? lift(s, r1) : s;
    const e2 = comp.kind === 'RED_ECC' ? lift(e, r2) : e;
    const k = 0.18;
    g.tube(s2, vadd(s2, vmul(d, len * k)), r1, r1, FITTING);
    g.tube(vadd(s2, vmul(d, len * k)), vadd(e2, vmul(d, -len * k)), r1, r2, FITTING);
    g.tube(vadd(e2, vmul(d, -len * k)), e2, r2, r2, FITTING);
    return;
  }
  if (comp.kind.startsWith('FLG_')) {
    const t = flangeThick(dn);
    g.disc(c, d, flangeOd(dn) / 2, t, FLANGE);
    return;
  }
  if (comp.kind === 'COUPLING_SW' || comp.kind === 'COUPLING_THD') {
    const len = componentTakeout(comp.kind, dn) * 2 + od(dn) * 0.5;
    g.tube(vadd(c, vmul(d, -len / 2)), vadd(c, vmul(d, len / 2)), od(dn) * 0.66 + 3, od(dn) * 0.66 + 3, COUPLING, [true, true]);
    return;
  }
  if (comp.kind === 'UNION') {
    g.tube(vadd(c, vmul(d, -25)), vadd(c, vmul(d, 25)), od(dn) * 0.8 + 4, od(dn) * 0.8 + 4, COUPLING, [true, true]);
    return;
  }
  if (comp.kind === 'SPECTACLE') {
    g.disc(c, d, flangeOd(dn) / 2 - 10, 6, HANDLE);
    return;
  }
  if (comp.kind === 'CAP') {
    capAt(g, c, d, dn);
    return;
  }
  if (comp.kind === 'TRANSITION') {
    g.tube(c, vadd(c, vmul(d, 300)), od(dn) / 2 + 1, od(dn) / 2 + 1, PE);
  }
}

/** A cap closing the pipe at `c`, domed out along `out`. */
function capAt(g: Builder, c: V, out: V, dn: string): void {
  const r = od(dn) / 2;
  const h = r * 0.6;
  let prev = r;
  const steps = 6;
  for (let i = 0; i < steps; i += 1) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const r0 = prev;
    const r1 = r * Math.sqrt(Math.max(0, 1 - t1 * t1));
    g.tube(vadd(c, vmul(out, h * t0)), vadd(c, vmul(out, h * t1)), r0, Math.max(r1, 0.5), FITTING, [false, i === steps - 1]);
    prev = r1;
  }
}

function legOf(info: { legs: Vec3[] }, i: number): V {
  return v3(info.legs[i]);
}

/** The model of the drawing, to true dimensions. */
export function buildModel(drawing: Drawing, analysis: Analysis): Model3D {
  const g = new Builder();
  const glass = new Builder();
  const nodeById = analysis.nodeById;
  const labels: Label3D[] = [];

  for (const run of drawing.runs) {
    const na = nodeById.get(run.from);
    const nb = nodeById.get(run.to);
    if (!na || !nb) continue;
    const dir = direction(na.pos, nb.pos);
    if (!dir) continue;
    const a = v3(na.pos);
    const d = v3(dir);
    const r = od(run.dn) / 2;
    const target = run.dashed ? glass : g;
    for (const [lo, hi] of pipeSpans(drawing, analysis.nodeInfo, run)) {
      target.tube(vadd(a, vmul(d, lo)), vadd(a, vmul(d, hi)), r, r, run.dashed ? DASHED : PIPE);
    }
    if (run.dashed) continue;
    for (const comp of run.inline) itemAt(g, drawing, run, comp, a, d);
  }

  for (const info of analysis.nodeInfo.values()) {
    const node = info.node;
    const p = v3(node.pos);
    const dnOf = (i: number) => info.runs[i]?.dn ?? info.runs[0]?.dn ?? 'DN50';
    if (info.fitting === 'ELBOW_90' || info.fitting === 'ELBOW_45' || info.fitting === 'BEND') {
      const l1 = legOf(info, 0);
      const l2 = legOf(info, 1);
      const dn = dnOf(0);
      const t = nodeFittingTakeout(info, dn);
      const theta = Math.PI - Math.acos(Math.max(-1, Math.min(1, vdot(l1, l2))));
      const R = t / Math.tan(theta / 2);
      const start = vadd(p, vmul(l1, t));
      const inward = vnorm(vsub(l2, vmul(l1, vdot(l2, l1))));
      g.bend(start, vmul(l1, -1), vadd(start, vmul(inward, R)), theta, od(dn) / 2, FITTING);
    } else if (info.fitting === 'TEE' || info.fitting === 'TEE_REDUCING' || info.fitting === 'CROSS') {
      const header = Math.max(...info.runs.map((r) => od(r.dn)));
      info.runs.forEach((run, i) => {
        const t = nodeFittingTakeout(info, run.dn);
        g.tube(p, vadd(p, legOf(info, i).map((x) => x * t) as V), od(run.dn) / 2, od(run.dn) / 2, FITTING);
      });
      g.sphere(p, header / 2, FITTING);
    } else if (info.fitting === 'OLET') {
      const legs = oletLegs(info);
      const headerDn = legs?.header[0]?.dn ?? dnOf(0);
      const hr = od(headerDn) / 2;
      for (const entry of legs ? oletEntries(legs) : []) {
        const out = v3(AXIS_VECTOR[entry.dir as Axis]);
        const br = od(entry.dn) / 2;
        const top = hr + Math.max(22, Math.round(od(entry.dn) * 0.55));
        g.tube(vadd(p, vmul(out, hr * 0.6)), vadd(p, vmul(out, top)), br * 1.55 + 4, br * 1.05 + 2, FITTING, [false, !entry.run]);
      }
    } else if (info.fitting === 'COUPLING') {
      const dn = dnOf(0);
      const l = legOf(info, 0);
      const len = nodeFittingTakeout(info, dn) * 2 + od(dn) * 0.5;
      g.tube(vadd(p, vmul(l, -len / 2)), vadd(p, vmul(l, len / 2)), od(dn) * 0.66 + 3, od(dn) * 0.66 + 3, COUPLING, [true, true]);
    }

    // A flanged joint: a flange each side of the gasket.
    if (node.flange) {
      info.runs.forEach((run, i) => {
        const l = legOf(info, i);
        flangeAt(g, vadd(p, vmul(l, 1.5)), l, run.dn, node.flange === 'FLG_BLIND' ? 'FLG_WN' : node.flange!);
      });
    }

    // The end of the line: what closes it.
    if (info.degree === 1 && node.terminal && info.runs[0]) {
      const run = info.runs[0];
      const into = legOf(info, 0);
      const out = vmul(into, -1);
      const kind = node.terminal.kind;
      const under = terminalWeldKind(node.terminal);
      const dn = run.dn;
      if (under && under.startsWith('FLG_')) flangeAt(g, p, into, dn, under);
      if (kind === 'FLG_BLIND') blindAt(g, p, out, dn);
      if (kind === 'CAP') capAt(g, p, out, dn);
      if (kind === 'TRANSITION') {
        // The steel stub to its weld, then the PE pipe going on.
        g.tube(vadd(p, vmul(into, componentTakeout('TRANSITION', dn))), p, od(dn) / 2, od(dn) / 2, PIPE);
        g.tube(p, vadd(p, vmul(out, 300)), od(dn) / 2 + 1, od(dn) / 2 + 1, PE, [false, true]);
      }
    }
  }

  // A dark bead round the pipe at every weld, and its number beside it.
  for (const weld of analysis.welds) {
    if (weld.skipped) continue;
    const pos = v3(weld.pos);
    const axis = weldAxis(drawing, analysis, weld.pos);
    const r = od(weld.dn) / 2 + 1.5;
    if (axis) g.tube(vadd(pos, vmul(axis, -3)), vadd(pos, vmul(axis, 3)), r, r, WELD, [false, false]);
    if (weld.number) labels.push({ pos: weld.pos, text: weld.number, kind: 'weld' });
  }

  for (const box of drawing.equipment ?? []) {
    const axis = v3(AXIS_VECTOR[box.axis]);
    const across = v3(AXIS_VECTOR[box.across]);
    const third = vnorm(vcross(axis, across));
    const at = v3(box.at);
    const c = vadd(at, vmul(axis, box.length / 2));
    const height = Math.min(box.width, box.length);
    glass.box(c, [axis, across, third], [box.length / 2, box.width / 2, height / 2], EQUIPMENT);
    labels.push({ pos: { e: c[0], n: c[1], u: c[2] }, text: box.name || 'EQUIPMENT', kind: 'equipment' });
  }

  const min: V = [Math.min(g.min[0], glass.min[0]), Math.min(g.min[1], glass.min[1]), Math.min(g.min[2], glass.min[2])];
  const max: V = [Math.max(g.max[0], glass.max[0]), Math.max(g.max[1], glass.max[1]), Math.max(g.max[2], glass.max[2])];
  const empty = !Number.isFinite(min[0]);
  const centre: V = empty ? [0, 0, 0] : vmul(vadd(min, max), 0.5);
  const radius = empty ? 1000 : Math.max(200, vlen(vsub(max, min)) / 2);
  return {
    solid: g.finish(centre),
    glass: glass.finish(centre),
    centre: { e: centre[0], n: centre[1], u: centre[2] },
    radius,
    labels,
  };
}

/** The line a weld lies across: the run whose centre line it is on. */
function weldAxis(drawing: Drawing, analysis: Analysis, at: Vec3): V | null {
  let best: V | null = null;
  let bestGap = 2;
  for (const run of drawing.runs) {
    const a = analysis.nodeById.get(run.from);
    const b = analysis.nodeById.get(run.to);
    if (!a || !b) continue;
    const dir = direction(a.pos, b.pos);
    if (!dir) continue;
    const len = length3(sub(b.pos, a.pos));
    const rel = sub(at, a.pos);
    const t = rel.e * dir.e + rel.n * dir.n + rel.u * dir.u;
    if (t < -1 || t > len + 1) continue;
    const off = length3(sub(rel, scale3(dir, t)));
    if (off < bestGap) {
      bestGap = off;
      best = v3(dir);
    }
  }
  return best;
}

/* ----------------------------------------------------------- the camera */

/**
 * Where the model is seen from: `az` round the vertical (degrees; -45 is
 * the sheet's own isometric, from the south-east), `el` above the
 * horizontal; `zoom` screen pixels per mm, `panX`/`panY` pixels.
 */
export interface Camera {
  az: number;
  el: number;
  zoom: number;
  panX: number;
  panY: number;
}

/** The sheet's own isometric, turned as the sheet is turned. */
export function isoAngles(northRotation = 0): { az: number; el: number } {
  return { az: -45 + 90 * northRotation, el: 35.264 };
}

function frame(cam: Camera): { right: V; up: V; fwd: V } {
  const az = (cam.az * Math.PI) / 180;
  const el = (Math.max(-89.5, Math.min(89.5, cam.el)) * Math.PI) / 180;
  const eye: V = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  const fwd = vmul(eye, -1);
  const right = vnorm(vcross(fwd, [0, 0, 1]));
  const up = vcross(right, fwd);
  return { right, up, fwd };
}

/** A plant point on the screen, pixels from the top left; `depth` grows away. */
export function toScreen(model: Model3D, cam: Camera, p: Vec3, w: number, h: number): { x: number; y: number; depth: number } {
  const { right, up, fwd } = frame(cam);
  const q: V = [p.e - model.centre.e, p.n - model.centre.n, p.u - model.centre.u];
  return {
    x: w / 2 + vdot(q, right) * cam.zoom + cam.panX,
    y: h / 2 - (vdot(q, up) * cam.zoom + cam.panY),
    depth: vdot(q, fwd),
  };
}

/** The zoom and pan that fit the whole model to a `w` × `h` view, with a margin. */
export function fitCamera(model: Model3D, cam: Camera, w: number, h: number, margin = 0.08): Camera {
  const { right, up } = frame(cam);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const part of [model.solid, model.glass]) {
    const pos = part.pos;
    for (let i = 0; i < pos.length; i += 3) {
      const q: V = [pos[i], pos[i + 1], pos[i + 2]];
      const x = vdot(q, right);
      const y = vdot(q, up);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return { ...cam, zoom: Math.min(w, h) / 2000, panX: 0, panY: 0 };
  const zoom = Math.min((w * (1 - margin * 2)) / Math.max(maxX - minX, 1), (h * (1 - margin * 2)) / Math.max(maxY - minY, 1));
  return { ...cam, zoom, panX: (-(minX + maxX) / 2) * zoom, panY: (-(minY + maxY) / 2) * zoom };
}

/* ------------------------------------------------------------ WebGL draw */

const VERT = `
attribute vec3 aPos;
attribute vec3 aNor;
attribute vec3 aCol;
uniform mat4 uMat;
uniform mat3 uRot;
varying vec3 vNor;
varying vec3 vCol;
void main() {
  gl_Position = uMat * vec4(aPos, 1.0);
  vNor = uRot * aNor;
  vCol = aCol;
}`;

const FRAG = `
precision mediump float;
varying vec3 vNor;
varying vec3 vCol;
uniform float uAlpha;
void main() {
  vec3 n = normalize(vNor);
  // Lit from the side it is seen from, whichever way the triangle winds.
  if (n.z < 0.0) n = -n;
  vec3 l = normalize(vec3(-0.35, 0.6, 0.72));
  vec3 fill = normalize(vec3(0.5, -0.3, 0.4));
  float d = max(dot(n, l), 0.0);
  float f = max(dot(n, fill), 0.0) * 0.25;
  vec3 h = normalize(l + vec3(0.0, 0.0, 1.0));
  float s = pow(max(dot(n, h), 0.0), 28.0) * 0.28;
  vec3 c = vCol * (0.34 + 0.62 * d + f) + vec3(s);
  gl_FragColor = vec4(c, uAlpha);
}`;

interface Part {
  pos: WebGLBuffer;
  nor: WebGLBuffer;
  col: WebGLBuffer;
  count: number;
}

/** A WebGL view of a model on a canvas. */
export class Scene3D {
  readonly gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private parts: { solid: Part | null; glass: Part | null } = { solid: null, glass: null };
  private model: Model3D | null = null;

  static create(canvas: HTMLCanvasElement, keep = false): Scene3D | null {
    const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: keep, alpha: true }) as WebGLRenderingContext | null;
    if (!gl) return null;
    try {
      return new Scene3D(gl);
    } catch {
      return null;
    }
  }

  private constructor(gl: WebGLRenderingContext) {
    this.gl = gl;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'program');
    this.program = program;
  }

  setModel(model: Model3D): void {
    const gl = this.gl;
    for (const part of [this.parts.solid, this.parts.glass]) {
      if (!part) continue;
      gl.deleteBuffer(part.pos);
      gl.deleteBuffer(part.nor);
      gl.deleteBuffer(part.col);
    }
    const upload = (data: Model3D['solid']): Part | null => {
      if (data.count === 0) return null;
      const buffer = (array: Float32Array) => {
        const b = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
        return b;
      };
      return { pos: buffer(data.pos), nor: buffer(data.nor), col: buffer(data.col), count: data.count };
    };
    this.parts = { solid: upload(model.solid), glass: upload(model.glass) };
    this.model = model;
  }

  /** Draws the model seen by `cam` on the whole canvas (`w` × `h` pixels). */
  draw(cam: Camera, w: number, h: number, background: [number, number, number, number] = [0, 0, 0, 0]): void {
    const gl = this.gl;
    const model = this.model;
    gl.viewport(0, 0, w, h);
    gl.clearColor(...background);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!model) return;
    const { right, up, fwd } = frame(cam);
    const depth = model.radius * 1.2;
    const sx = (2 * cam.zoom) / w;
    const sy = (2 * cam.zoom) / h;
    // Column-major: clip = M · p.
    const m = new Float32Array([
      right[0] * sx, up[0] * sy, fwd[0] / depth, 0,
      right[1] * sx, up[1] * sy, fwd[1] / depth, 0,
      right[2] * sx, up[2] * sy, fwd[2] / depth, 0,
      (2 * cam.panX) / w, (2 * cam.panY) / h, 0, 1,
    ]);
    // Normals into the view: x right, y up, z toward the eye.
    const rot = new Float32Array([right[0], up[0], -fwd[0], right[1], up[1], -fwd[1], right[2], up[2], -fwd[2]]);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'uMat'), false, m);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.program, 'uRot'), false, rot);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const alpha = gl.getUniformLocation(this.program, 'uAlpha');
    const bind = (part: Part) => {
      for (const [name, buffer] of [
        ['aPos', part.pos],
        ['aNor', part.nor],
        ['aCol', part.col],
      ] as const) {
        const loc = gl.getAttribLocation(this.program, name);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, part.count);
    };
    if (this.parts.solid) {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1f(alpha, 1);
      bind(this.parts.solid);
    }
    if (this.parts.glass) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1f(alpha, 0.3);
      bind(this.parts.glass);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }
}

/* ------------------------------------------------------- the sheet's picture */

/** How the 3D picture on the sheet is seen: kept with the drawing. */
export interface SheetView3D {
  az: number;
  el: number;
  welds?: boolean;
}

let sheetCanvas: HTMLCanvasElement | null = null;
let sheetScene: Scene3D | null = null;

/**
 * The model drawn as a picture `w` × `h` pixels, seen as the sheet asks,
 * fitted to it on white, with the weld numbers when asked: a PNG data URI,
 * or null where there is no WebGL.
 */
export function render3dImage(drawing: Drawing, analysis: Analysis, view: SheetView3D, w: number, h: number, labelPx = 22): string | null {
  if (typeof document === 'undefined') return null;
  try {
    if (!sheetCanvas) {
      sheetCanvas = document.createElement('canvas');
      sheetScene = Scene3D.create(sheetCanvas, true);
    }
    if (!sheetScene) return null;
    sheetCanvas.width = w;
    sheetCanvas.height = h;
    const model = buildModel(drawing, analysis);
    let cam: Camera = { az: view.az, el: view.el, zoom: 1, panX: 0, panY: 0 };
    cam = fitCamera(model, cam, w, h, view.welds ? 0.1 : 0.05);
    sheetScene.setModel(model);
    sheetScene.draw(cam, w, h, [1, 1, 1, 1]);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(sheetCanvas, 0, 0);
    if (view.welds) drawLabels(ctx, model, cam, w, h, labelPx);
    return out.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** The weld numbers and equipment names, in boxes, on a 2D canvas over the model. */
export function drawLabels(ctx: CanvasRenderingContext2D, model: Model3D, cam: Camera, w: number, h: number, px: number): void {
  ctx.font = `700 ${px}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (const label of model.labels) {
    const s = toScreen(model, cam, label.pos, w, h);
    if (label.kind === 'equipment') {
      ctx.fillStyle = '#12161c';
      ctx.fillText(label.text, s.x, s.y);
      continue;
    }
    const tw = ctx.measureText(label.text).width + px * 0.6;
    const th = px * 1.35;
    const x = s.x + px * 0.6;
    const y = s.y - px * 1.4;
    ctx.strokeStyle = '#12161c';
    ctx.lineWidth = Math.max(1, px / 14);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(x, y + th / 2);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const r = th * 0.3;
    ctx.roundRect?.(x, y - th / 2, tw, th, r);
    if (!ctx.roundRect) ctx.rect(x, y - th / 2, tw, th);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#12161c';
    ctx.fillText(label.text, x + tw / 2, y + 1);
  }
}

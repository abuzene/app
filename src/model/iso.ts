import type { Axis, Vec3 } from './types';

/**
 * Isometric projection used throughout the app.
 *
 * Plant coordinates are east / north / up in millimetres. On screen the three
 * axes are laid out the way a piping isometric conventionally reads:
 *
 *   North -> up and to the right   (+30 degrees)
 *   East  -> down and to the right (-30 degrees)
 *   Up    -> straight up
 *
 * so South, West and Down are simply their opposites. Screen y grows downwards,
 * as in SVG.
 */
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

export const AXES: Axis[] = ['N', 'S', 'E', 'W', 'U', 'D'];

export const AXIS_VECTOR: Record<Axis, Vec3> = {
  N: { e: 0, n: 1, u: 0 },
  S: { e: 0, n: -1, u: 0 },
  E: { e: 1, n: 0, u: 0 },
  W: { e: -1, n: 0, u: 0 },
  U: { e: 0, n: 0, u: 1 },
  D: { e: 0, n: 0, u: -1 },
};

export const AXIS_NAME: Record<Axis, string> = {
  N: 'North',
  S: 'South',
  E: 'East',
  W: 'West',
  U: 'Up',
  D: 'Down',
};

export const OPPOSITE: Record<Axis, Axis> = {
  N: 'S',
  S: 'N',
  E: 'W',
  W: 'E',
  U: 'D',
  D: 'U',
};

export interface Pt {
  x: number;
  y: number;
}

/** Rotates the horizontal plane by `k` quarter turns about the vertical axis. */
function rotateHorizontal(e: number, n: number, k: number): [number, number] {
  switch (((k % 4) + 4) % 4) {
    case 1:
      return [n, -e];
    case 2:
      return [-e, -n];
    case 3:
      return [-n, e];
    default:
      return [e, n];
  }
}

/** Projects a plant coordinate to unscaled screen space (y grows downwards). */
export function project(p: Vec3, rotation = 0): Pt {
  const [e, n] = rotateHorizontal(p.e, p.n, rotation);
  return {
    x: COS30 * (e + n),
    y: SIN30 * (e - n) - p.u,
  };
}

/** The unit screen direction a given routing axis travels in. */
export function axisScreenDir(axis: Axis, rotation = 0): Pt {
  const v = project(AXIS_VECTOR[axis], rotation);
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

/**
 * Picks the routing axis whose screen direction best matches a drag vector.
 * Returns null for a drag too short to be meaningful.
 */
export function axisFromScreenDelta(dx: number, dy: number, rotation = 0, minLength = 4): Axis | null {
  const len = Math.hypot(dx, dy);
  if (len < minLength) return null;
  let best: Axis = 'N';
  let bestDot = -Infinity;
  for (const axis of AXES) {
    const d = axisScreenDir(axis, rotation);
    const dot = (dx * d.x + dy * d.y) / len;
    if (dot > bestDot) {
      bestDot = dot;
      best = axis;
    }
  }
  return best;
}

/**
 * How far along `axis` a drag reaches, in plant mm, given the screen scale.
 * Projected axes are foreshortened, so the drag is measured as a projection
 * onto the axis' screen direction and then divided back out.
 */
export function lengthAlongAxis(dx: number, dy: number, axis: Axis, scale: number, rotation = 0): number {
  const dir = axisScreenDir(axis, rotation);
  const screenLen = dx * dir.x + dy * dir.y;
  const unit = project(AXIS_VECTOR[axis], rotation);
  const foreshorten = Math.hypot(unit.x, unit.y) || 1;
  return screenLen / (scale * foreshorten);
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { e: a.e + b.e, n: a.n + b.n, u: a.u + b.u };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { e: a.e - b.e, n: a.n - b.n, u: a.u - b.u };
}

export function scale3(a: Vec3, k: number): Vec3 {
  return { e: a.e * k, n: a.n * k, u: a.u * k };
}

export function length3(a: Vec3): number {
  return Math.hypot(a.e, a.n, a.u);
}

export function equals3(a: Vec3, b: Vec3, tol = 0.01): boolean {
  return Math.abs(a.e - b.e) < tol && Math.abs(a.n - b.n) < tol && Math.abs(a.u - b.u) < tol;
}

/** Offsets `from` by `length` mm along `axis`. */
export function step(from: Vec3, axis: Axis, length: number): Vec3 {
  return add(from, scale3(AXIS_VECTOR[axis], length));
}

/** The routing axis from `a` to `b`, or null if the two are not axis-aligned. */
export function axisBetween(a: Vec3, b: Vec3): Axis | null {
  const d = sub(b, a);
  const nonZero = (['e', 'n', 'u'] as const).filter((k) => Math.abs(d[k]) > 0.01);
  if (nonZero.length !== 1) return null;
  const k = nonZero[0];
  if (k === 'e') return d.e > 0 ? 'E' : 'W';
  if (k === 'n') return d.n > 0 ? 'N' : 'S';
  return d.u > 0 ? 'U' : 'D';
}

/** Unit direction from `a` to `b`, or null when the two coincide. */
export function direction(a: Vec3, b: Vec3): Vec3 | null {
  const d = sub(b, a);
  const len = length3(d);
  if (len < 0.01) return null;
  return scale3(d, 1 / len);
}

/** Angle in degrees between two unit vectors. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const dot = Math.max(-1, Math.min(1, a.e * b.e + a.n * b.n + a.u * b.u));
  return (Math.acos(dot) * 180) / Math.PI;
}

import type { ComponentKind, FlangeKind, JointType, TerminalKind } from '../model/types';

/** Placement frame for a symbol: its centre, the pipe direction and the perpendicular. */
/**
 * Where and how a symbol is drawn.
 *
 * A symbol on an isometric is not a flat badge stuck on the pipe: it is a real
 * object seen in projection. So the frame carries three screen directions, not
 * two — along the pipe, across it within the drawing plane, and genuinely up.
 * A valve body then spreads across the pipe the way the pipe itself is drawn,
 * and its stem stands up the page, which is what makes the symbol read as part
 * of the drawing rather than pasted onto it.
 */
export interface Frame {
  cx: number;
  cy: number;
  /** Unit vector along the pipe, in screen space. */
  dx: number;
  dy: number;
  /** Across the pipe, in the drawing plane. */
  nx: number;
  ny: number;
  /** Up, in the drawing plane. */
  ux: number;
  uy: number;
  /** Nominal symbol half-size in paper units. */
  s: number;
}

/** Which way a one-sided symbol (a flange, a cap) faces along the pipe. */
export type Facing = 1 | -1;

export interface Dir2 {
  x: number;
  y: number;
}

/**
 * Builds a frame along a drawn run. `across` and `up` are the screen directions
 * of the two isometric axes the symbol is drawn in; left out, the frame falls
 * back to the flat screen perpendicular, which is all a skewed run can offer.
 */
export function frameFor(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  at: number,
  s: number,
  across?: Dir2,
  up?: Dir2,
): Frame {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const dx = (x2 - x1) / len;
  const dy = (y2 - y1) / len;
  const n = across ?? { x: -dy, y: dx };
  const u = up ?? { x: -dy, y: dx };
  return {
    cx: x1 + dx * at * len,
    cy: y1 + dy * at * len,
    dx,
    dy,
    nx: n.x,
    ny: n.y,
    ux: u.x,
    uy: u.y,
    s,
  };
}

function pt(f: Frame, along: number, across: number, up = 0): [number, number] {
  return [
    f.cx + f.dx * along + f.nx * across + f.ux * up,
    f.cy + f.dy * along + f.ny * across + f.uy * up,
  ];
}

function fmt(points: [number, number][]): string {
  return points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
}

function poly(points: [number, number][], cls: string): string {
  return `<polygon class="${cls}" points="${fmt(points)}"/>`;
}

type P = [number, number] | [number, number, number];

function line(f: Frame, a: P, b: P, cls: string): string {
  const [x1, y1] = pt(f, a[0], a[1], a[2] ?? 0);
  const [x2, y2] = pt(f, b[0], b[1], b[2] ?? 0);
  return `<line class="${cls}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
}

function circle(f: Frame, along: number, across: number, r: number, cls: string, up = 0): string {
  const [x, y] = pt(f, along, across, up);
  return `<circle class="${cls}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r.toFixed(2)}"/>`;
}

/* ------------------------------------------------------------------ joints */

/**
 * The mark where a fitting, flange or valve meets the pipe. Which mark is drawn
 * says how the joint is made, following the usual fabrication convention:
 *
 *   butt weld    a filled dot
 *   socket weld  a bracket, the socket the pipe enters
 *   threaded     a single bar across the pipe
 *
 * A field weld carries the weld flag as well, so a site joint is picked out
 * from a shop one without changing what the mark itself means.
 */
export function jointMark(f: Frame, joint: JointType, facing: Facing = 1): string {
  const s = f.s;
  let out = '';
  switch (joint) {
    case 'SW':
      // The bracket is the socket, so it wraps towards the fitting side.
      out =
        line(f, [0, 0, -s * 0.62], [0, 0, s * 0.62], 'sym-line') +
        line(f, [0, 0, -s * 0.62], [facing * s * 0.5, 0, -s * 0.62], 'sym-line') +
        line(f, [0, 0, s * 0.62], [facing * s * 0.5, 0, s * 0.62], 'sym-line');
      break;
    case 'THD':
      out = line(f, [0, 0, -s * 0.62], [0, 0, s * 0.62], 'sym-line');
      break;
    default:
      out = circle(f, 0, 0, s * 0.42, 'joint-bw');
      break;
  }
  return out;
}

/* ----------------------------------------------------------------- flanges */

export type { FlangeKind };

const FLANGE_KINDS: FlangeKind[] = ['FLG_WN', 'FLG_SO', 'FLG_SW', 'FLG_THD', 'FLG_LAP', 'FLG_BLIND'];

export function isFlange(kind: string): kind is FlangeKind {
  return (FLANGE_KINDS as string[]).includes(kind);
}

/** The joint a flange makes with the pipe it is attached to. */
export function flangeJoint(kind: FlangeKind): JointType | null {
  switch (kind) {
    case 'FLG_WN':
    case 'FLG_LAP':
      return 'BW';
    case 'FLG_SW':
      return 'SW';
    case 'FLG_THD':
      return 'THD';
    default:
      // A slip-on is fillet welded and a blind bolts on; neither takes a mark
      // of its own on the pipe side.
      return null;
  }
}

/**
 * One flange, drawn the way the fabrication sheets draw it.
 *
 * The frame sits on the flange FACE — the point the pipe is dimensioned to —
 * and `facing` says which way that face looks. Behind the face is the flange
 * plate, a thin outlined rectangle the full flange diameter; behind that, on a
 * weld neck, the hub tapers back to the weld. The weld mark itself is placed by
 * the analysis at the true distance, so `hub` is that distance in paper units
 * and the taper ends exactly where the dot is drawn.
 */
/**
 * How far behind its face a flange reaches, in paper units: where its weld or
 * socket mark sits. Every flange of a kind is drawn the same whatever its
 * size, which is how the sheets read.
 */
export function flangeHub(kind: FlangeKind, s: number): number {
  switch (kind) {
    case 'FLG_SW':
    case 'FLG_THD':
      return s * 0.7;
    case 'FLG_SO':
      return s * 0.77;
    default:
      return s * 1.1;
  }
}

export function flangeSymbol(f: Frame, kind: FlangeKind, facing: Facing = 1, hub?: number): string {
  const s = f.s;
  const d = facing;
  const r = s * 1.0;
  const t = s * 0.2;
  const reach = Math.max(hub ?? flangeHub(kind, s), t * 1.5);

  // The plate, from the face back by its thickness.
  const plate = (from: number, thick: number, cls = 'sym-fill') =>
    poly(
      [pt(f, from, 0, -r), pt(f, from - d * thick, 0, -r), pt(f, from - d * thick, 0, r), pt(f, from, 0, r)],
      cls,
    );
  // The hub: a taper from the back of the plate to the weld.
  const taper = (from: number, to: number, wide: number, narrow: number, cls = 'sym-fill') =>
    poly([pt(f, from, 0, -wide), pt(f, from, 0, wide), pt(f, to, 0, narrow), pt(f, to, 0, -narrow)], cls);
  // A short parallel hub, for the flanges the pipe slides or screws into.
  const socket = (from: number, len: number, half: number) =>
    poly([pt(f, from, 0, -half), pt(f, from, 0, half), pt(f, from - d * len, 0, half), pt(f, from - d * len, 0, -half)], 'sym-fill');

  switch (kind) {
    case 'FLG_WN':
      return taper(-d * t, -d * reach, r * 0.62, r * 0.3) + plate(0, t);
    case 'FLG_SO':
      // A slip-on is a thicker plate the pipe passes into; no hub to speak of.
      return socket(-d * t * 1.6, s * 0.45, r * 0.34) + plate(0, t * 1.6);
    case 'FLG_SW':
    case 'FLG_THD':
      return socket(-d * t, s * 0.5, r * 0.4) + plate(0, t);
    case 'FLG_LAP': {
      // The stub end's flare at the face, with the loose backing flange behind it.
      const flare = s * 0.35;
      return plate(-d * flare, t) + taper(0, -d * flare, r * 0.9, r * 0.5);
    }
    case 'FLG_BLIND':
      return plate(0, t * 1.6, 'sym-solid');
    default:
      return plate(0, t);
  }
}

/**
 * The flange on the other side of the joint that is not this line's to make:
 * the equipment nozzle, the valve, the flange the line bolts to. Drawn in
 * outline, dashed, facing back towards the pipe.
 */
export function counterFlange(f: Frame, kind: FlangeKind, facing: Facing = 1, gap = 0): string {
  const s = f.s;
  const d = facing;
  const r = s * 1.0;
  const t = s * 0.2;
  const at = d * gap;
  const plate = poly(
    [pt(f, at, 0, -r), pt(f, at + d * t, 0, -r), pt(f, at + d * t, 0, r), pt(f, at, 0, r)],
    'sym-dashed',
  );
  if (kind === 'FLG_BLIND') return plate;
  const hub = poly(
    [
      pt(f, at + d * t, 0, -r * 0.62),
      pt(f, at + d * t, 0, r * 0.62),
      pt(f, at + d * (t + s * 0.8), 0, r * 0.3),
      pt(f, at + d * (t + s * 0.8), 0, -r * 0.3),
    ],
    'sym-dashed',
  );
  return plate + hub;
}

/** The small gap between two bolted faces, with the gasket's centre line. */
export function gasketLine(f: Frame, at: number): string {
  const r = f.s * 1.15;
  return line(f, [at, 0, -r], [at, 0, r], 'sym-thin');
}

/** A flanged joint: two flanges bolted face to face. */
export function flangePair(f: Frame, kind: FlangeKind, hub?: number): string {
  const gap = f.s * 0.25;
  const back: Frame = { ...f, cx: f.cx - f.dx * gap, cy: f.cy - f.dy * gap };
  const front: Frame = { ...f, cx: f.cx + f.dx * gap, cy: f.cy + f.dy * gap };
  return gasketLine(f, 0) + flangeSymbol(back, kind, 1, hub) + flangeSymbol(front, kind, -1, hub);
}

/* ---------------------------------------------------------------- fittings */

/** A cap, closing the end of the pipe in the `facing` direction. */
export function capSymbol(f: Frame, facing: Facing = 1): string {
  const s = f.s;
  const r = s * 0.85;
  const [x1, y1] = pt(f, 0, 0, -r);
  const [x2, y2] = pt(f, 0, 0, r);
  const sweep = facing > 0 ? 1 : 0;
  return (
    line(f, [0, 0, -r], [0, 0, r], 'sym-line') +
    `<path class="sym-hollow" d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}"/>`
  );
}

/**
 * A concentric reducer: both ends on the same centreline, the body tapering
 * between them. Filled, so the pipe does not show through the middle of it.
 */
function concentricReducer(f: Frame, reach = f.s * 0.9): string {
  const s = f.s;
  const big = s * 0.85;
  const small = s * 0.42;
  return poly(
    [pt(f, -reach, 0, -big), pt(f, -reach, 0, big), pt(f, reach, 0, small), pt(f, reach, 0, -small)],
    'sym-fill',
  );
}

/**
 * An eccentric reducer: the same taper with one side flat, so the two ends
 * share that side rather than a centreline. Drawn flat on the bottom, which is
 * how it is fitted on a horizontal line to keep the invert level and let the
 * line drain.
 */
function eccentricReducer(f: Frame, reach = f.s * 0.9): string {
  const s = f.s;
  const big = s * 0.85;
  const small = s * 0.42;
  return poly(
    [pt(f, -reach, 0, -big), pt(f, -reach, 0, big), pt(f, reach, 0, -big + small * 2), pt(f, reach, 0, -big)],
    'sym-fill',
  );
}

/**
 * An olet: the forged body that straddles the header where the branch leaves
 * it, drawn as the hexagon these sheets use. The frame runs along the branch,
 * so the hexagon is laid out in the plane the branch and header share.
 */
export function oletSymbol(f: Frame): string {
  const r = f.s * 0.6;
  const points: [number, number][] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 3) * i + Math.PI / 6;
    points.push(pt(f, r * Math.sin(angle) + f.s * 0.15, 0, r * Math.cos(angle)));
  }
  return poly(points, 'sym-fill');
}

/* -------------------------------------------------------- inline components */

/** The two opposed triangles that read as a valve body on an isometric. */
function bowtie(f: Frame, cls = 'sym-fill', reach = f.s): string {
  const s = f.s;
  return (
    poly([pt(f, -reach, 0, -s * 0.85), pt(f, -reach, 0, s * 0.85), pt(f, 0, 0, 0)], cls) +
    poly([pt(f, reach, 0, -s * 0.85), pt(f, reach, 0, s * 0.85), pt(f, 0, 0, 0)], cls)
  );
}

function stem(f: Frame, height = 1.5): string {
  return line(f, [0, 0, 0], [0, 0, f.s * height], 'sym-line');
}

/** The lever or handwheel, lying across the pipe at the top of the stem. */
function handwheel(f: Frame, at = 1.5): string {
  return line(f, [0, -f.s * 0.55, f.s * at], [0, f.s * 0.55, f.s * at], 'sym-line');
}

/**
 * `reach` is half the valve's face-to-face in paper units: the body is drawn
 * out to its real faces, so the flanges bolted to it sit hard against it and
 * the joint marks land on its ends, as they do on the sheets.
 */
export function componentSymbol(kind: ComponentKind, f: Frame, reach?: number): string {
  const s = f.s;
  if (isFlange(kind)) return flangePair(f, kind);
  const body = (cls?: string) => bowtie(f, cls, Math.max(s, reach ?? s));

  switch (kind) {
    case 'GATE':
      return body() + stem(f) + handwheel(f);
    case 'GLOBE':
      return body() + circle(f, 0, 0, s * 0.45, 'sym-solid') + stem(f) + handwheel(f);
    case 'BALL':
      return body() + circle(f, 0, 0, s * 0.42, 'sym-hollow') + stem(f) + handwheel(f);
    case 'BALL_ACT': {
      const [ax, ay] = pt(f, 0, 0, s * 2.1);
      return (
        body() +
        circle(f, 0, 0, s * 0.42, 'sym-hollow') +
        stem(f, 1.35) +
        // Pneumatic actuator: the cylinder sitting on the stem, with its
        // air connection out of the top.
        `<rect class="sym-hollow" x="${(ax - s * 1.05).toFixed(2)}" y="${(ay - s * 0.75).toFixed(2)}" width="${(s * 2.1).toFixed(2)}" height="${(s * 1.5).toFixed(2)}" rx="${(s * 0.35).toFixed(2)}"/>` +
        line(f, [0, 0, s * 2.85], [0, 0, s * 3.4], 'sym-line') +
        line(f, [0, -s * 0.45, s * 3.4], [0, s * 0.45, s * 3.4], 'sym-line')
      );
    }
    case 'PLUG':
      return (
        body() +
        poly(
          [
            pt(f, -s * 0.3, 0, -s * 0.45),
            pt(f, s * 0.3, 0, -s * 0.45),
            pt(f, s * 0.3, 0, s * 0.45),
            pt(f, -s * 0.3, 0, s * 0.45),
          ],
          'sym-solid',
        ) +
        stem(f)
      );
    case 'NEEDLE':
      return body() + stem(f) + poly([pt(f, 0, 0), pt(f, 0, -s * 0.25, s * 1.2), pt(f, 0, s * 0.25, s * 1.2)], 'sym-solid');
    case 'CHECK':
      return (
        body() +
        line(f, [s * 0.05, 0, -s * 0.85], [s * 0.05, 0, s * 0.85], 'sym-line') +
        line(f, [-s * 0.6, 0, 0], [s * 0.9, 0, 0], 'sym-line') +
        poly(
          [pt(f, s * 1.5, 0, 0), pt(f, s * 0.9, 0, -s * 0.35), pt(f, s * 0.9, 0, s * 0.35)],
          'sym-solid',
        )
      );
    case 'BUTTERFLY':
      return body() + line(f, [-s * 0.55, 0, -s * 0.55], [s * 0.55, 0, s * 0.55], 'sym-line') + stem(f) + handwheel(f);
    case 'CONTROL': {
      const [ax, ay] = pt(f, 0, 0, s * 1.8);
      return (
        body() +
        stem(f, 1.8) +
        `<ellipse class="sym-hollow" cx="${ax.toFixed(2)}" cy="${ay.toFixed(2)}" rx="${(s * 0.9).toFixed(2)}" ry="${(s * 0.5).toFixed(2)}"/>`
      );
    }
    case 'RELIEF':
      return (
        body() +
        stem(f, 2) +
        poly(
          [
            pt(f, 0, -s * 0.6, s * 2),
            pt(f, 0, s * 0.6, s * 2),
            pt(f, 0, s * 0.6, s * 2.9),
            pt(f, 0, -s * 0.6, s * 2.9),
          ],
          'sym-hollow',
        )
      );
    case 'SPECTACLE':
      // Drawn along the pipe: the closed disc and the open ring on one web.
      return (
        circle(f, -s * 0.42, 0, s * 0.4, 'sym-solid') +
        circle(f, s * 0.42, 0, s * 0.4, 'sym-hollow') +
        line(f, [-s * 0.42, 0, 0], [s * 0.42, 0, 0], 'sym-line')
      );
    case 'RED_CONC':
      // Drawn to its real length, so the weld on each end lands on its end.
      return concentricReducer(f, Math.max(s * 0.6, reach ?? s * 0.9));
    case 'RED_ECC':
      return eccentricReducer(f, Math.max(s * 0.6, reach ?? s * 0.9));
    case 'CAP':
      return capSymbol(f, 1);
    case 'UNION':
      return (
        line(f, [-s * 0.4, 0, -s], [-s * 0.4, 0, s], 'sym-line') +
        line(f, [s * 0.4, 0, -s], [s * 0.4, 0, s], 'sym-line') +
        line(f, [0, 0, -s * 0.7], [0, 0, s * 0.7], 'sym-line')
      );
    case 'STRAINER':
      return (
        bowtie(f) +
        line(f, [0, 0, 0], [s * 1.1, 0, -s * 1.1], 'sym-line') +
        poly(
          [
            pt(f, s * 0.7, 0, -s * 0.9),
            pt(f, s * 1.3, 0, -s * 0.9),
            pt(f, s * 1.3, 0, -s * 1.6),
            pt(f, s * 0.7, 0, -s * 1.6),
          ],
          'sym-hollow',
        )
      );
    case 'INSTRUMENT':
      return line(f, [0, 0, 0], [0, 0, s * 1.6], 'sym-line') + circle(f, 0, 0, s * 0.85, 'sym-hollow', s * 2.4);
    case 'SUPPORT':
      return poly([pt(f, 0, -s * 0.8, -s * 0.2), pt(f, 0, s * 0.8, -s * 0.2), pt(f, 0, 0, -s * 1.4)], 'sym-solid');
    case 'ANCHOR':
      return (
        poly([pt(f, 0, -s * 0.8, -s * 0.2), pt(f, 0, s * 0.8, -s * 0.2), pt(f, 0, 0, -s * 1.4)], 'sym-solid') +
        line(f, [0, -s * 1.1, -s * 1.5], [0, s * 1.1, -s * 1.5], 'sym-line')
      );
    case 'GUIDE':
      return (
        line(f, [-s * 0.8, 0, s * 0.9], [-s * 0.8, 0, -s * 0.9], 'sym-line') +
        line(f, [s * 0.8, 0, s * 0.9], [s * 0.8, 0, -s * 0.9], 'sym-line') +
        line(f, [-s * 0.8, 0, -s * 0.9], [s * 0.8, 0, -s * 0.9], 'sym-line')
      );
    default:
      return circle(f, 0, 0, s * 0.6, 'sym-hollow');
  }
}

/** Symbol drawn on a free end of the line, facing out of the pipe. */
export function terminalSymbol(kind: TerminalKind, f: Frame, joint: JointType = 'BW', hub?: number): string {
  if (kind === 'FLG_BLIND') {
    // A blind bolts to a flange on the pipe: the weld neck, the gap, the blind.
    return flangeSymbol(f, 'FLG_WN', 1, hub) + gasketLine(f, f.s * 0.25) + counterFlange(f, 'FLG_BLIND', 1, f.s * 0.5);
  }
  if (isFlange(kind)) {
    // Just this line's flange: what bolts to it is somebody else's to draw.
    return flangeSymbol(f, kind, 1, hub);
  }
  const s = f.s;
  switch (kind) {
    case 'CAP':
      // A socket or threaded cap reads from its end mark; only a butt welded
      // one carries the domed body.
      return joint === 'BW' ? capSymbol(f, 1) : '';
    case 'CONTINUATION':
      return poly([pt(f, 0, 0, -s), pt(f, s * 1.4, 0, 0), pt(f, 0, 0, s)], 'sym-hollow');
    case 'EQUIPMENT':
      // A nozzle face on the vessel it belongs to.
      return (
        line(f, [0, 0, -s * 0.9], [0, 0, s * 0.9], 'sym-heavy') +
        line(f, [s * 0.45, 0, -s * 1.5], [s * 0.45, 0, s * 1.5], 'sym-heavy') +
        line(f, [0, 0, 0], [s * 0.45, 0, 0], 'sym-line')
      );
    default:
      return '';
  }
}

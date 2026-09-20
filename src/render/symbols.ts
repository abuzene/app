import type { ComponentKind, JointType, TerminalKind } from '../model/types';

/** Placement frame for a symbol: its centre, the pipe direction and the perpendicular. */
export interface Frame {
  cx: number;
  cy: number;
  /** Unit vector along the pipe, in screen space. */
  dx: number;
  dy: number;
  /** Unit vector perpendicular to the pipe, in screen space. */
  nx: number;
  ny: number;
  /** Nominal symbol half-size in paper units. */
  s: number;
}

/** Which way a one-sided symbol (a flange, a cap) faces along the pipe. */
export type Facing = 1 | -1;

export function frameFor(x1: number, y1: number, x2: number, y2: number, at: number, s: number): Frame {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const dx = (x2 - x1) / len;
  const dy = (y2 - y1) / len;
  return { cx: x1 + dx * at * len, cy: y1 + dy * at * len, dx, dy, nx: -dy, ny: dx, s };
}

function pt(f: Frame, along: number, across: number): [number, number] {
  return [f.cx + f.dx * along + f.nx * across, f.cy + f.dy * along + f.ny * across];
}

function fmt(points: [number, number][]): string {
  return points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
}

function poly(points: [number, number][], cls: string): string {
  return `<polygon class="${cls}" points="${fmt(points)}"/>`;
}

function line(f: Frame, a: [number, number], b: [number, number], cls: string): string {
  const [x1, y1] = pt(f, a[0], a[1]);
  const [x2, y2] = pt(f, b[0], b[1]);
  return `<line class="${cls}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
}

function circle(f: Frame, along: number, across: number, r: number, cls: string): string {
  const [x, y] = pt(f, along, across);
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
export function jointMark(f: Frame, joint: JointType, field = false, facing: Facing = 1): string {
  const s = f.s;
  let out = '';
  switch (joint) {
    case 'SW':
      // The bracket is the socket, so it wraps towards the fitting side.
      out =
        line(f, [0, -s * 0.62], [0, s * 0.62], 'sym-line') +
        line(f, [0, -s * 0.62], [facing * s * 0.5, -s * 0.62], 'sym-line') +
        line(f, [0, s * 0.62], [facing * s * 0.5, s * 0.62], 'sym-line');
      break;
    case 'THD':
      out = line(f, [0, -s * 0.62], [0, s * 0.62], 'sym-line');
      break;
    default:
      out = circle(f, 0, 0, s * 0.3, 'joint-bw');
      break;
  }
  if (field) out += weldFlag(f);
  return out;
}

/** The flag that marks a joint made on site rather than in the shop. */
function weldFlag(f: Frame): string {
  const s = f.s;
  return (
    line(f, [0, 0], [0, -s * 1.35], 'sym-line') +
    poly([pt(f, 0, -s * 1.35), pt(f, s * 0.75, -s * 1.35), pt(f, 0, -s * 0.92)], 'sym-solid')
  );
}

/* ----------------------------------------------------------------- flanges */

export type FlangeKind = 'FLG_WN' | 'FLG_SO' | 'FLG_SW' | 'FLG_THD' | 'FLG_LAP' | 'FLG_BLIND';

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
 * One flange, drawn from the pipe outwards. `facing` is the direction the
 * flange face lies in, so a pair on either side of a joint mirror each other.
 */
export function flangeSymbol(f: Frame, kind: FlangeKind, facing: Facing = 1): string {
  const s = f.s;
  const d = facing;
  const face = (at: number, half = 1) =>
    line(f, [d * at, -s * half], [d * at, s * half], 'sym-heavy');

  switch (kind) {
    case 'FLG_WN':
      // Butt weld, then the hub opening out to the face.
      return (
        poly(
          [
            pt(f, 0, -s * 0.28),
            pt(f, 0, s * 0.28),
            pt(f, d * s * 0.62, s * 0.72),
            pt(f, d * s * 0.62, -s * 0.72),
          ],
          'sym-solid',
        ) + face(0.62)
      );
    case 'FLG_SO':
      return face(0);
    case 'FLG_SW':
      return (
        line(f, [0, -s * 0.62], [0, s * 0.62], 'sym-line') +
        line(f, [0, -s * 0.62], [d * s * 0.5, -s * 0.62], 'sym-line') +
        line(f, [0, s * 0.62], [d * s * 0.5, s * 0.62], 'sym-line') +
        face(0.62)
      );
    case 'FLG_THD':
      return (
        poly(
          [
            pt(f, 0, -s * 0.34),
            pt(f, 0, s * 0.34),
            pt(f, d * s * 0.62, s * 0.62),
            pt(f, d * s * 0.62, -s * 0.62),
          ],
          'sym-solid',
        ) + face(0.62)
      );
    case 'FLG_LAP':
      // Butt weld to a stub end, with the loose backing flange behind it.
      return (
        line(f, [d * s * 0.3, -s * 0.72], [d * s * 0.3, s * 0.72], 'sym-line') +
        line(f, [d * s * 0.3, -s * 0.72], [d * s * 0.62, -s * 0.72], 'sym-line') +
        line(f, [d * s * 0.3, s * 0.72], [d * s * 0.62, s * 0.72], 'sym-line') +
        face(0.62)
      );
    case 'FLG_BLIND':
      return face(0) + poly([pt(f, 0, -s), pt(f, d * s * 0.42, -s), pt(f, d * s * 0.42, s), pt(f, 0, s)], 'sym-solid');
    default:
      return face(0);
  }
}

/** A flanged joint: two flanges bolted face to face. */
export function flangePair(f: Frame, kind: FlangeKind): string {
  const back: Frame = { ...f, cx: f.cx - f.dx * f.s * 0.12, cy: f.cy - f.dy * f.s * 0.12 };
  const front: Frame = { ...f, cx: f.cx + f.dx * f.s * 0.12, cy: f.cy + f.dy * f.s * 0.12 };
  return flangeSymbol(back, kind, -1) + flangeSymbol(front, kind, 1);
}

/* ---------------------------------------------------------------- fittings */

/** A cap, closing the end of the pipe in the `facing` direction. */
export function capSymbol(f: Frame, facing: Facing = 1): string {
  const s = f.s;
  const r = s * 0.85;
  const [x1, y1] = pt(f, 0, -r);
  const [x2, y2] = pt(f, 0, r);
  const sweep = facing > 0 ? 1 : 0;
  return (
    line(f, [0, -r], [0, r], 'sym-line') +
    `<path class="sym-hollow" d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}"/>`
  );
}

/** A concentric reducer: large end square on, tapering to the small end. */
function concentricReducer(f: Frame): string {
  const s = f.s;
  return poly([pt(f, -s * 0.9, -s * 0.85), pt(f, -s * 0.9, s * 0.85), pt(f, s * 0.9, 0)], 'sym-hollow');
}

/** An eccentric reducer: the same taper, flat on one side. */
function eccentricReducer(f: Frame): string {
  const s = f.s;
  return poly(
    [
      pt(f, -s * 0.9, -s * 0.85),
      pt(f, -s * 0.9, s * 0.85),
      pt(f, s * 0.9, s * 0.85),
      pt(f, s * 0.9, s * 0.35),
    ],
    'sym-hollow',
  );
}

/* -------------------------------------------------------- inline components */

/** The two opposed triangles that read as a valve body on an isometric. */
function bowtie(f: Frame, cls = 'sym-fill'): string {
  const s = f.s;
  return (
    poly([pt(f, -s, -s * 0.8), pt(f, -s, s * 0.8), pt(f, 0, 0)], cls) +
    poly([pt(f, s, -s * 0.8), pt(f, s, s * 0.8), pt(f, 0, 0)], cls)
  );
}

function stem(f: Frame, height = 1.5): string {
  return line(f, [0, 0], [0, -f.s * height], 'sym-line');
}

function handwheel(f: Frame, at = 1.5): string {
  return line(f, [-f.s * 0.5, -f.s * at], [f.s * 0.5, -f.s * at], 'sym-line');
}

export function componentSymbol(kind: ComponentKind, f: Frame): string {
  const s = f.s;
  if (isFlange(kind)) return flangePair(f, kind);

  switch (kind) {
    case 'GATE':
      return bowtie(f) + stem(f) + handwheel(f);
    case 'GLOBE':
      return bowtie(f) + circle(f, 0, 0, s * 0.45, 'sym-solid') + stem(f) + handwheel(f);
    case 'BALL':
      return bowtie(f) + circle(f, 0, 0, s * 0.42, 'sym-hollow') + stem(f) + handwheel(f);
    case 'BALL_ACT': {
      const [ax, ay] = pt(f, 0, -s * 2.1);
      return (
        bowtie(f) +
        circle(f, 0, 0, s * 0.42, 'sym-hollow') +
        stem(f, 1.35) +
        // Pneumatic actuator: the cylinder sitting on the stem, with its
        // air connection out of the top.
        `<rect class="sym-hollow" x="${(ax - s * 1.05).toFixed(2)}" y="${(ay - s * 0.75).toFixed(2)}" width="${(s * 2.1).toFixed(2)}" height="${(s * 1.5).toFixed(2)}" rx="${(s * 0.35).toFixed(2)}"/>` +
        line(f, [0, -s * 2.85], [0, -s * 3.4], 'sym-line') +
        line(f, [-s * 0.45, -s * 3.4], [s * 0.45, -s * 3.4], 'sym-line')
      );
    }
    case 'PLUG':
      return (
        bowtie(f) +
        poly(
          [pt(f, -s * 0.3, -s * 0.4), pt(f, s * 0.3, -s * 0.4), pt(f, s * 0.3, s * 0.4), pt(f, -s * 0.3, s * 0.4)],
          'sym-solid',
        ) +
        stem(f)
      );
    case 'NEEDLE':
      return bowtie(f) + stem(f) + poly([pt(f, 0, 0), pt(f, -s * 0.25, -s * 1.2), pt(f, s * 0.25, -s * 1.2)], 'sym-solid');
    case 'CHECK':
      return (
        bowtie(f) +
        line(f, [s * 0.05, -s * 0.8], [s * 0.05, s * 0.8], 'sym-line') +
        line(f, [-s * 0.6, 0], [s * 0.9, 0], 'sym-line') +
        poly([pt(f, s * 1.5, 0), pt(f, s * 0.9, -s * 0.35), pt(f, s * 0.9, s * 0.35)], 'sym-solid')
      );
    case 'BUTTERFLY':
      return bowtie(f) + line(f, [-s * 0.55, s * 0.55], [s * 0.55, -s * 0.55], 'sym-line') + stem(f) + handwheel(f);
    case 'CONTROL': {
      const [ax, ay] = pt(f, 0, -s * 1.8);
      return (
        bowtie(f) +
        stem(f, 1.8) +
        `<ellipse class="sym-hollow" cx="${ax.toFixed(2)}" cy="${ay.toFixed(2)}" rx="${(s * 0.9).toFixed(2)}" ry="${(s * 0.5).toFixed(2)}"/>`
      );
    }
    case 'RELIEF':
      return (
        bowtie(f) +
        stem(f, 2) +
        poly(
          [pt(f, -s * 0.6, -s * 2), pt(f, s * 0.6, -s * 2), pt(f, s * 0.6, -s * 2.9), pt(f, -s * 0.6, -s * 2.9)],
          'sym-hollow',
        )
      );
    case 'SPECTACLE':
      // Drawn along the pipe: the closed disc and the open ring on one web.
      return (
        circle(f, -s * 0.42, 0, s * 0.4, 'sym-solid') +
        circle(f, s * 0.42, 0, s * 0.4, 'sym-hollow') +
        line(f, [-s * 0.42, 0], [s * 0.42, 0], 'sym-line')
      );
    case 'RED_CONC':
      return concentricReducer(f);
    case 'RED_ECC':
      return eccentricReducer(f);
    case 'CAP':
      return capSymbol(f, 1);
    case 'UNION':
      return (
        line(f, [-s * 0.4, -s], [-s * 0.4, s], 'sym-line') +
        line(f, [s * 0.4, -s], [s * 0.4, s], 'sym-line') +
        line(f, [0, -s * 0.7], [0, s * 0.7], 'sym-line')
      );
    case 'STRAINER':
      return (
        bowtie(f) +
        line(f, [0, 0], [s * 1.1, s * 1.1], 'sym-line') +
        poly(
          [pt(f, s * 0.7, s * 0.9), pt(f, s * 1.3, s * 0.9), pt(f, s * 1.3, s * 1.6), pt(f, s * 0.7, s * 1.6)],
          'sym-hollow',
        )
      );
    case 'INSTRUMENT':
      return line(f, [0, 0], [0, -s * 1.6], 'sym-line') + circle(f, 0, -s * 2.4, s * 0.85, 'sym-hollow');
    case 'SUPPORT':
      return poly([pt(f, -s * 0.8, s * 0.2), pt(f, s * 0.8, s * 0.2), pt(f, 0, s * 1.4)], 'sym-solid');
    case 'ANCHOR':
      return (
        poly([pt(f, -s * 0.8, s * 0.2), pt(f, s * 0.8, s * 0.2), pt(f, 0, s * 1.4)], 'sym-solid') +
        line(f, [-s * 1.1, s * 1.5], [s * 1.1, s * 1.5], 'sym-line')
      );
    case 'GUIDE':
      return (
        line(f, [-s * 0.8, -s * 0.9], [-s * 0.8, s * 0.9], 'sym-line') +
        line(f, [s * 0.8, -s * 0.9], [s * 0.8, s * 0.9], 'sym-line') +
        line(f, [-s * 0.8, s * 0.9], [s * 0.8, s * 0.9], 'sym-line')
      );
    default:
      return circle(f, 0, 0, s * 0.6, 'sym-hollow');
  }
}

/** Symbol drawn on a free end of the line, facing out of the pipe. */
export function terminalSymbol(kind: TerminalKind, f: Frame, joint: JointType = 'BW'): string {
  if (isFlange(kind)) return flangeSymbol(f, kind, 1);
  const s = f.s;
  switch (kind) {
    case 'CAP':
      // A socket or threaded cap reads from its end mark; only a butt welded
      // one carries the domed body.
      return joint === 'BW' ? capSymbol(f, 1) : '';
    case 'CONTINUATION':
      return poly([pt(f, 0, -s), pt(f, s * 1.4, 0), pt(f, 0, s)], 'sym-hollow');
    case 'EQUIPMENT':
      // A nozzle face on the vessel it belongs to.
      return (
        line(f, [0, -s * 0.9], [0, s * 0.9], 'sym-heavy') +
        line(f, [s * 0.45, -s * 1.5], [s * 0.45, s * 1.5], 'sym-heavy') +
        line(f, [0, 0], [s * 0.45, 0], 'sym-line')
      );
    default:
      return '';
  }
}

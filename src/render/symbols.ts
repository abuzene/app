import type { ComponentKind, TerminalKind } from '../model/types';

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

export function frameFor(x1: number, y1: number, x2: number, y2: number, at: number, s: number): Frame {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const dx = (x2 - x1) / len;
  const dy = (y2 - y1) / len;
  return { cx: x1 + dx * at * len, cy: y1 + dy * at * len, dx, dy, nx: -dy, ny: dx, s };
}

function pt(f: Frame, along: number, across: number): [number, number] {
  return [f.cx + f.dx * along + f.nx * across, f.cy + f.dy * along + f.ny * across];
}

function poly(points: [number, number][], cls: string): string {
  return `<polygon class="${cls}" points="${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')}"/>`;
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

/** A single flange face: the disc line plus a hub when the flange is a weld neck. */
function flangeFace(f: Frame, along: number, hub: boolean): string {
  const s = f.s;
  let out = line(f, [along, -s], [along, s], 'sym-line');
  if (hub) {
    const inward = along >= 0 ? -1 : 1;
    out +=
      line(f, [along, -s], [along + inward * s * 0.7, -s * 0.45], 'sym-line') +
      line(f, [along, s], [along + inward * s * 0.7, s * 0.45], 'sym-line');
  }
  return out;
}

export function componentSymbol(kind: ComponentKind, f: Frame, dn2Smaller = false): string {
  const s = f.s;
  switch (kind) {
    case 'GATE':
      return bowtie(f) + stem(f) + line(f, [-s * 0.5, -s * 1.5], [s * 0.5, -s * 1.5], 'sym-line');
    case 'GLOBE':
      return bowtie(f) + circle(f, 0, 0, s * 0.45, 'sym-solid') + stem(f) + line(f, [-s * 0.5, -s * 1.5], [s * 0.5, -s * 1.5], 'sym-line');
    case 'BALL':
      return bowtie(f) + circle(f, 0, 0, s * 0.42, 'sym-hollow') + stem(f) + line(f, [-s * 0.5, -s * 1.5], [s * 0.5, -s * 1.5], 'sym-line');
    case 'PLUG':
      return bowtie(f) + poly([pt(f, -s * 0.3, -s * 0.4), pt(f, s * 0.3, -s * 0.4), pt(f, s * 0.3, s * 0.4), pt(f, -s * 0.3, s * 0.4)], 'sym-solid') + stem(f);
    case 'NEEDLE':
      return bowtie(f) + stem(f) + poly([pt(f, 0, 0), pt(f, -s * 0.25, -s * 1.2), pt(f, s * 0.25, -s * 1.2)], 'sym-solid');
    case 'CHECK':
      // Body with the flap and a flow arrow, so the direction is unambiguous.
      return (
        bowtie(f) +
        line(f, [s * 0.05, -s * 0.8], [s * 0.05, s * 0.8], 'sym-line') +
        line(f, [-s * 0.6, 0], [s * 0.9, 0], 'sym-line') +
        poly([pt(f, s * 1.5, 0), pt(f, s * 0.9, -s * 0.35), pt(f, s * 0.9, s * 0.35)], 'sym-solid')
      );
    case 'BUTTERFLY':
      return (
        bowtie(f) +
        line(f, [-s * 0.55, s * 0.55], [s * 0.55, -s * 0.55], 'sym-line') +
        stem(f) +
        line(f, [-s * 0.5, -s * 1.5], [s * 0.5, -s * 1.5], 'sym-line')
      );
    case 'CONTROL':
      return (
        bowtie(f) +
        stem(f, 1.8) +
        `<ellipse class="sym-hollow" cx="${pt(f, 0, -s * 1.8)[0].toFixed(2)}" cy="${pt(f, 0, -s * 1.8)[1].toFixed(2)}" rx="${(s * 0.9).toFixed(2)}" ry="${(s * 0.5).toFixed(2)}"/>`
      );
    case 'RELIEF':
      return (
        bowtie(f) +
        stem(f, 2) +
        poly([pt(f, -s * 0.6, -s * 2), pt(f, s * 0.6, -s * 2), pt(f, s * 0.6, -s * 2.9), pt(f, -s * 0.6, -s * 2.9)], 'sym-hollow')
      );
    case 'FLG_WN':
      return flangeFace(f, -s * 0.35, true) + flangeFace(f, s * 0.35, true);
    case 'FLG_SO':
      return flangeFace(f, -s * 0.3, false) + flangeFace(f, s * 0.3, false);
    case 'FLG_BLIND':
      return flangeFace(f, -s * 0.3, false) + poly([pt(f, s * 0.1, -s), pt(f, s * 0.45, -s), pt(f, s * 0.45, s), pt(f, s * 0.1, s)], 'sym-solid');
    case 'SPECTACLE':
      return (
        line(f, [0, -s], [0, s], 'sym-line') +
        circle(f, 0, -s * 0.55, s * 0.35, 'sym-solid') +
        circle(f, 0, s * 0.55, s * 0.35, 'sym-hollow')
      );
    case 'RED_CONC': {
      const big = s * 0.85;
      const small = s * 0.45;
      return poly([pt(f, -s, -big), pt(f, -s, big), pt(f, s, small), pt(f, s, -small)], 'sym-hollow');
    }
    case 'RED_ECC': {
      const big = s * 0.85;
      const small = s * 0.9;
      // Flat on one side: the offset is what distinguishes it on the drawing.
      return poly([pt(f, -s, -big), pt(f, -s, big), pt(f, s, big), pt(f, s, big - small)], 'sym-hollow');
    }
    case 'UNION':
      return line(f, [-s * 0.4, -s], [-s * 0.4, s], 'sym-line') + line(f, [s * 0.4, -s], [s * 0.4, s], 'sym-line') + line(f, [0, -s * 0.7], [0, s * 0.7], 'sym-line');
    case 'STRAINER':
      return (
        bowtie(f) +
        line(f, [0, 0], [s * 1.1, s * 1.1], 'sym-line') +
        poly([pt(f, s * 0.7, s * 0.9), pt(f, s * 1.3, s * 0.9), pt(f, s * 1.3, s * 1.6), pt(f, s * 0.7, s * 1.6)], 'sym-hollow')
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
      return circle(f, 0, 0, s * 0.6, 'sym-hollow') + (dn2Smaller ? '' : '');
  }
}

/** Symbol drawn on the free end of a line. */
export function terminalSymbol(kind: TerminalKind, f: Frame): string {
  const s = f.s;
  switch (kind) {
    case 'FLG_WN':
      return flangeFace(f, 0, true);
    case 'FLG_SO':
      return flangeFace(f, 0, false);
    case 'FLG_BLIND':
      return flangeFace(f, 0, false) + poly([pt(f, 0, -s), pt(f, s * 0.35, -s), pt(f, s * 0.35, s), pt(f, 0, s)], 'sym-solid');
    case 'CAP':
      return `<path class="sym-hollow" d="M ${pt(f, 0, -s * 0.8).map((v) => v.toFixed(2)).join(' ')} L ${pt(f, s * 0.5, -s * 0.8).map((v) => v.toFixed(2)).join(' ')} A ${(s * 0.8).toFixed(2)} ${(s * 0.8).toFixed(2)} 0 0 1 ${pt(f, s * 0.5, s * 0.8).map((v) => v.toFixed(2)).join(' ')} L ${pt(f, 0, s * 0.8).map((v) => v.toFixed(2)).join(' ')} Z"/>`;
    case 'CONTINUATION':
      return poly([pt(f, 0, -s), pt(f, s * 1.4, 0), pt(f, 0, s)], 'sym-hollow');
    case 'EQUIPMENT':
      return line(f, [0, -s * 1.3], [0, s * 1.3], 'sym-heavy');
    default:
      return '';
  }
}

/**
 * Weld marks. A field weld reads as a filled circle, a shop weld as an open one
 * with a tick across the pipe — the usual convention on a fabrication isometric.
 */
export function weldSymbol(f: Frame, field: boolean): string {
  if (field) return circle(f, 0, 0, f.s * 0.42, 'weld-field');
  return line(f, [0, -f.s * 0.5], [0, f.s * 0.5], 'weld-tick') + circle(f, 0, 0, f.s * 0.34, 'weld-shop');
}

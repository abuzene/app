/**
 * Metric pipe and fitting data.
 *
 * Outside diameters and wall thicknesses follow ASME B36.10M, fitting take-outs
 * follow ASME B16.9 (long radius elbows, equal tees) and valve face-to-face
 * dimensions follow ASME B16.10 Class 150. Everything is in millimetres.
 *
 * Take-outs matter because the isometric dimensions a fabricator reads are
 * centre-to-centre, while the pipe they actually cut is shorter by the take-out
 * of whatever sits at each end.
 */

export interface PipeSize {
  dn: string;
  nps: string;
  /** Outside diameter, mm. */
  od: number;
  /** Wall thickness by schedule, mm. */
  walls: Record<string, number>;
  /** 90 degree long radius elbow centre-to-face, mm. */
  elbow90: number;
  /** 45 degree long radius elbow centre-to-face, mm. */
  elbow45: number;
  /** Equal tee centre-to-face, mm. */
  tee: number;
}

type SizeRow = [
  dn: string,
  nps: string,
  od: number,
  elbow90: number,
  elbow45: number,
  tee: number,
  walls: Record<string, number>,
];

const ROWS: SizeRow[] = [
  ['DN15', '1/2"', 21.3, 38, 16, 25, { SCH10: 2.11, STD: 2.77, SCH40: 2.77, XS: 3.73, SCH80: 3.73, SCH160: 4.78, XXS: 7.47 }],
  ['DN20', '3/4"', 26.9, 38, 19, 29, { SCH10: 2.11, STD: 2.87, SCH40: 2.87, XS: 3.91, SCH80: 3.91, SCH160: 5.56, XXS: 7.82 }],
  ['DN25', '1"', 33.7, 38, 22, 38, { SCH10: 2.77, STD: 3.38, SCH40: 3.38, XS: 4.55, SCH80: 4.55, SCH160: 6.35, XXS: 9.09 }],
  ['DN32', '1 1/4"', 42.4, 48, 25, 48, { SCH10: 2.77, STD: 3.56, SCH40: 3.56, XS: 4.85, SCH80: 4.85, SCH160: 6.35, XXS: 9.7 }],
  ['DN40', '1 1/2"', 48.3, 57, 29, 57, { SCH10: 2.77, STD: 3.68, SCH40: 3.68, XS: 5.08, SCH80: 5.08, SCH160: 7.14, XXS: 10.15 }],
  ['DN50', '2"', 60.3, 76, 35, 64, { SCH10: 2.77, STD: 3.91, SCH40: 3.91, XS: 5.54, SCH80: 5.54, SCH160: 8.74, XXS: 11.07 }],
  ['DN65', '2 1/2"', 73.0, 95, 44, 76, { SCH10: 3.05, STD: 5.16, SCH40: 5.16, XS: 7.01, SCH80: 7.01, SCH160: 9.53, XXS: 14.02 }],
  ['DN80', '3"', 88.9, 114, 51, 86, { SCH10: 3.05, STD: 5.49, SCH40: 5.49, XS: 7.62, SCH80: 7.62, SCH160: 11.13, XXS: 15.24 }],
  ['DN100', '4"', 114.3, 152, 64, 105, { SCH10: 3.05, STD: 6.02, SCH40: 6.02, XS: 8.56, SCH80: 8.56, SCH120: 11.13, SCH160: 13.49, XXS: 17.12 }],
  ['DN125', '5"', 141.3, 190, 79, 124, { SCH10: 3.4, STD: 6.55, SCH40: 6.55, XS: 9.53, SCH80: 9.53, SCH120: 12.7, SCH160: 15.88, XXS: 19.05 }],
  ['DN150', '6"', 168.3, 229, 95, 143, { SCH10: 3.4, STD: 7.11, SCH40: 7.11, XS: 10.97, SCH80: 10.97, SCH120: 14.27, SCH160: 18.26, XXS: 21.95 }],
  ['DN200', '8"', 219.1, 305, 127, 178, { SCH10: 3.76, SCH20: 6.35, SCH30: 7.04, STD: 8.18, SCH40: 8.18, SCH60: 10.31, XS: 12.7, SCH80: 12.7, SCH100: 15.09, SCH120: 18.26, SCH140: 20.62, SCH160: 23.01, XXS: 22.23 }],
  ['DN250', '10"', 273.0, 381, 159, 216, { SCH10: 4.19, SCH20: 6.35, SCH30: 7.8, STD: 9.27, SCH40: 9.27, SCH60: 12.7, XS: 12.7, SCH80: 15.09, SCH100: 18.26, SCH120: 21.44, SCH140: 25.4, SCH160: 28.58, XXS: 25.4 }],
  ['DN300', '12"', 323.8, 457, 190, 254, { SCH10: 4.57, SCH20: 6.35, SCH30: 8.38, STD: 9.53, SCH40: 10.31, XS: 12.7, SCH60: 14.27, SCH80: 17.48, SCH100: 21.44, SCH120: 25.4, SCH140: 28.58, SCH160: 33.32, XXS: 25.4 }],
  ['DN350', '14"', 355.6, 533, 222, 279, { SCH10: 6.35, SCH20: 7.92, SCH30: 9.53, STD: 9.53, SCH40: 11.13, XS: 12.7, SCH60: 15.09, SCH80: 19.05, SCH100: 23.83, SCH120: 27.79, SCH140: 31.75, SCH160: 35.71 }],
  ['DN400', '16"', 406.4, 610, 254, 305, { SCH10: 6.35, SCH20: 7.92, SCH30: 9.53, STD: 9.53, SCH40: 12.7, XS: 12.7, SCH60: 16.66, SCH80: 21.44, SCH100: 26.19, SCH120: 30.96, SCH140: 36.53, SCH160: 40.49 }],
  ['DN450', '18"', 457.0, 686, 286, 343, { SCH10: 6.35, SCH20: 7.92, SCH30: 11.13, STD: 9.53, SCH40: 14.27, XS: 12.7, SCH60: 19.05, SCH80: 23.83, SCH100: 29.36, SCH120: 34.93, SCH140: 39.67, SCH160: 45.24 }],
  ['DN500', '20"', 508.0, 762, 318, 381, { SCH10: 6.35, SCH20: 9.53, SCH30: 12.7, STD: 9.53, SCH40: 15.09, XS: 12.7, SCH60: 20.62, SCH80: 26.19, SCH100: 32.54, SCH120: 38.1, SCH140: 44.45, SCH160: 50.01 }],
  ['DN600', '24"', 610.0, 914, 381, 432, { SCH10: 6.35, SCH20: 9.53, SCH30: 14.27, STD: 9.53, SCH40: 17.48, XS: 12.7, SCH60: 24.61, SCH80: 30.96, SCH100: 38.89, SCH120: 46.02, SCH140: 52.37, SCH160: 59.54 }],
];

export const SIZES: PipeSize[] = ROWS.map(([dn, nps, od, elbow90, elbow45, tee, walls]) => ({
  dn,
  nps,
  od,
  elbow90,
  elbow45,
  tee,
  walls,
}));

const BY_DN = new Map(SIZES.map((s) => [s.dn, s]));

export const DN_LIST = SIZES.map((s) => s.dn);

/** Every size by its nominal inch label, for reading typed input. */
const BY_NPS = new Map(SIZES.map((s) => [s.nps.replace(/"/g, '').replace(/\s+/g, ' ').trim(), s]));

export function sizeOf(dn: string): PipeSize {
  return BY_DN.get(dn) ?? SIZES[7];
}

/**
 * How a size is written on the drawing and in the tables: the nominal inch
 * size, the way pipe is ordered and called on site. The internal key stays
 * `DN…` so drawings saved before the change still open.
 */
export function sizeLabel(dn: string): string {
  return sizeOf(dn).nps;
}

export const SIZE_LABELS: Record<string, string> = Object.fromEntries(
  SIZES.map((s) => [s.dn, s.nps]),
);

/**
 * Reads a size written any of the ways it gets typed: 3", 3in, 1 1/2", 1-1/2,
 * or the internal DN80. Returns null when it is not a size at all.
 */
export function parseSize(token: string): string | null {
  const text = token.trim().toUpperCase();
  if (/^DN\d+$/.test(text)) return BY_DN.has(text) ? text : null;
  const cleaned = text
    .replace(/["”]|IN$|INCH(ES)?$/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return BY_NPS.get(cleaned)?.dn ?? null;
}

/** Schedules valid for a given size, in the order they should be offered. */
const SCHEDULE_ORDER = [
  'SCH10',
  'SCH20',
  'SCH30',
  'STD',
  'SCH40',
  'SCH60',
  'XS',
  'SCH80',
  'SCH100',
  'SCH120',
  'SCH140',
  'SCH160',
  'XXS',
];

export function schedulesFor(dn: string): string[] {
  const walls = sizeOf(dn).walls;
  return SCHEDULE_ORDER.filter((s) => s in walls);
}

export function wallThickness(dn: string, schedule: string): number {
  const walls = sizeOf(dn).walls;
  return walls[schedule] ?? walls.STD ?? 0;
}

/** Mass of pipe in kg per metre, for the bill of materials. */
export function massPerMetre(dn: string, schedule: string): number {
  const od = sizeOf(dn).od;
  const t = wallThickness(dn, schedule);
  // Steel at 7850 kg/m3; od and t are in mm.
  return (Math.PI * (od - t) * t * 7850) / 1e6;
}

/** Class 150 valve face-to-face, mm, keyed by DN. Used for cut-length take-off. */
const VALVE_FF: Record<string, Record<string, number>> = {
  GATE: { DN15: 108, DN20: 117, DN25: 127, DN32: 140, DN40: 165, DN50: 178, DN65: 190, DN80: 203, DN100: 229, DN125: 254, DN150: 267, DN200: 292, DN250: 330, DN300: 356, DN350: 381, DN400: 406, DN450: 432, DN500: 457, DN600: 508 },
  GLOBE: { DN15: 108, DN20: 117, DN25: 127, DN32: 140, DN40: 165, DN50: 203, DN65: 216, DN80: 241, DN100: 292, DN125: 330, DN150: 356, DN200: 495, DN250: 622, DN300: 699 },
  BALL: { DN15: 108, DN20: 117, DN25: 127, DN32: 140, DN40: 165, DN50: 178, DN65: 190, DN80: 203, DN100: 229, DN125: 254, DN150: 267, DN200: 292, DN250: 330, DN300: 356 },
  CHECK: { DN15: 108, DN20: 117, DN25: 127, DN32: 140, DN40: 165, DN50: 203, DN65: 216, DN80: 241, DN100: 292, DN125: 330, DN150: 356, DN200: 495, DN250: 622, DN300: 699 },
  BUTTERFLY: { DN50: 43, DN65: 46, DN80: 46, DN100: 52, DN125: 56, DN150: 56, DN200: 60, DN250: 68, DN300: 78, DN350: 78, DN400: 102, DN450: 114, DN500: 127, DN600: 154 },
  PLUG: { DN15: 108, DN25: 127, DN50: 178, DN80: 203, DN100: 229, DN150: 267, DN200: 292, DN250: 330, DN300: 356 },
  NEEDLE: { DN15: 108, DN20: 117, DN25: 127 },
  CONTROL: { DN25: 184, DN40: 222, DN50: 254, DN80: 298, DN100: 352, DN150: 451, DN200: 543, DN250: 673, DN300: 737 },
  RELIEF: { DN25: 200, DN40: 230, DN50: 260, DN80: 320, DN100: 380 },
  STRAINER: { DN25: 127, DN40: 165, DN50: 178, DN80: 203, DN100: 229, DN150: 267, DN200: 292, DN250: 330, DN300: 356 },
};

/** Class 150 flange length through hub, mm. */
const FLANGE_LEN: Record<string, Record<string, number>> = {
  WN: { DN15: 48, DN20: 52, DN25: 56, DN32: 57, DN40: 62, DN50: 62, DN65: 68, DN80: 68, DN100: 75, DN125: 87, DN150: 87, DN200: 100, DN250: 100, DN300: 113, DN350: 125, DN400: 125, DN450: 138, DN500: 143, DN600: 151 },
  SO: { DN15: 14, DN20: 14, DN25: 17, DN32: 21, DN40: 22, DN50: 25, DN65: 29, DN80: 30, DN100: 33, DN125: 36, DN150: 40, DN200: 44, DN250: 49, DN300: 56, DN350: 57, DN400: 64, DN450: 68, DN500: 73, DN600: 83 },
};

/** Interpolates a missing DN by falling back to the nearest tabulated size. */
function lookup(table: Record<string, number>, dn: string): number | undefined {
  if (dn in table) return table[dn];
  const target = sizeOf(dn).od;
  let best: number | undefined;
  let bestDelta = Infinity;
  for (const [key, value] of Object.entries(table)) {
    const delta = Math.abs(sizeOf(key).od - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = value;
    }
  }
  return best;
}

/**
 * The size at and below which a valve is threaded rather than flanged. Small
 * bore valves are screwed in; anything larger comes with flanges.
 */
const LARGEST_THREADED = sizeOf('DN25').od;

/** How a valve of this size is connected unless told otherwise. */
export function defaultValveEnds(dn: string): 'FLG' | 'THD' {
  return sizeOf(dn).od <= LARGEST_THREADED + 0.01 ? 'THD' : 'FLG';
}

/** Length one flange adds beyond the component it is bolted to. */
export function flangeLength(dn: string): number {
  return lookup(FLANGE_LEN.WN, dn) ?? 0;
}

/**
 * How much centre-to-centre length a component consumes, measured from its
 * centre to the pipe weld either side. Returns half the face-to-face for
 * symmetric items, so two ends sum back to the full dimension. A flanged
 * component also carries the flange bolted to each of its faces.
 */
export function componentTakeout(kind: string, dn: string, flanged = false): number {
  if (kind === 'FLG_WN' || kind === 'FLG_BLIND') return lookup(FLANGE_LEN.WN, dn) ?? 0;
  if (kind === 'FLG_SO') return lookup(FLANGE_LEN.SO, dn) ?? 0;
  if (kind === 'SPECTACLE') return 0;
  if (kind === 'RED_CONC' || kind === 'RED_ECC') return reducerLength(dn, dn) / 2;
  if (kind === 'UNION') return 25;
  // A PE/steel transition: the steel stub to its weld is about this long.
  if (kind === 'TRANSITION') return 120;
  if (kind === 'INSTRUMENT' || kind === 'SUPPORT' || kind === 'ANCHOR' || kind === 'GUIDE') return 0;
  const table = VALVE_FF[kind];
  if (table) return (lookup(table, dn) ?? 0) / 2 + (flanged ? flangeLength(dn) : 0);
  return 0;
}

/** Concentric reducer end-to-end length per ASME B16.9, mm. */
export function reducerLength(large: string, small: string): number {
  const a = sizeOf(large).od;
  const b = sizeOf(small).od;
  const big = Math.max(a, b);
  if (big <= 60.3) return 76;
  if (big <= 88.9) return 89;
  if (big <= 114.3) return 102;
  if (big <= 168.3) return 140;
  if (big <= 219.1) return 152;
  if (big <= 273.0) return 178;
  if (big <= 323.8) return 203;
  if (big <= 406.4) return 330;
  if (big <= 508.0) return 381;
  return 508;
}

/** Take-out at a node for the fitting that connectivity implies. */
/**
 * How much of the branch an olet occupies, measured from the header centreline
 * to the branch weld: half the header, plus the height the olet stands off it.
 * The header itself loses nothing — an olet is welded to its wall, not cut into
 * it — which is the whole reason to use one.
 */
export function oletTakeout(headerDn: string, branchDn: string): number {
  const header = sizeOf(headerDn);
  const branch = sizeOf(branchDn);
  // Olet height runs roughly with the branch size; this tracks the
  // manufacturers' tables closely enough for a cut length.
  const height = Math.max(22, Math.round(branch.od * 0.55));
  return Math.round(header.od / 2 + height);
}

export function fittingTakeout(fitting: string, dn: string): number {
  const size = sizeOf(dn);
  switch (fitting) {
    case 'ELBOW_90':
    case 'BEND':
      return size.elbow90;
    case 'ELBOW_45':
      return size.elbow45;
    case 'TEE':
    case 'TEE_REDUCING':
    case 'CROSS':
      return size.tee;
    case 'MITRE':
      return size.od / 2;
    default:
      return 0;
  }
}

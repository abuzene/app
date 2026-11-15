/**
 * Pipe supports made up of standard steel sections (his ask, 2026-11-15: "a
 * way to draw pipe supports from standard profiles such as U and RHS, with
 * a U-bolt and plates with holes"). A support type (PS-1, PS-2 …) is one of
 * five shapes he makes, built of members cut from a profile, plates with
 * holes and a U-bolt round the pipe; supports on the isometric point at a
 * type, and each type gets a detail sheet of its own with its parts list.
 */
import type { Drawing } from './types';
import { sizeLabel, sizeOf } from './pipe-data';

/** The shapes he makes (his answer, same day). */
export type SupportShape = 'POST_LOW' | 'POST_T' | 'POST_ARM' | 'BRACKET_L' | 'BRACKET_BRACED' | 'HANGER_ARM';

export const SUPPORT_SHAPES: { id: SupportShape; name: string; hint: string }[] = [
  { id: 'POST_LOW', name: 'Low post', hint: 'A short post on a base plate, the pipe on a top plate, held by a U-bolt.' },
  { id: 'POST_T', name: 'T post', hint: 'A post on a base plate with a beam across its top; the pipe on the beam.' },
  { id: 'POST_ARM', name: 'Post with arm', hint: 'A post on a base plate with a profile coming out of its side; the pipe on the arm.' },
  // His ask, 2026-11-16: "a profile coming down, fixed at the top to the
  // steel there or a plate bolted to the roof, a profile out of it to the
  // side and the pipe on it with a U-bolt".
  { id: 'HANGER_ARM', name: 'Hanger with arm', hint: 'A profile coming down from the steel above, or from a plate bolted to the roof, with a profile out of its foot to the side; the pipe on the arm.' },
  { id: 'BRACKET_L', name: 'Arm from wall', hint: 'A profile from a plate fixed to a wall or column; the pipe on it.' },
  { id: 'BRACKET_BRACED', name: 'Braced arm', hint: 'An arm from a wall plate with a diagonal brace under it.' },
];

/** A plate with a hole at each corner. */
export interface SupportPlate {
  /** Across the view and into it, mm. */
  w: number;
  l: number;
  t: number;
  /** Hole diameter, mm; 0 for no holes. */
  hole: number;
  /** From each edge to the hole centre, mm. */
  edge: number;
  /**
   * Where it sits, moved off its middle (his ask, 2026-11-16: "set the
   * plate where I choose"), mm: a base or top plate across the view (+ to
   * the right), a wall plate up the wall (+ up).
   */
  shift?: number;
}

export interface SupportType {
  id: string;
  /** PS-1 … */
  name: string;
  shape: SupportShape;
  /** The pipe size it carries (sizes the U-bolt and the drawing). */
  dn: string;
  /** Member profiles, from `PROFILES` by name ('RHS 100x100x5', 'UPN 100', 'L 50x50x5'). */
  post?: string;
  beam?: string;
  arm?: string;
  brace?: string;
  /** Floor (top of base plate's underside) to the bottom of the pipe, mm. */
  height: number;
  /** Beam length (T post), mm. */
  beamLength?: number;
  /** Arm length, from the post's or the wall's face, mm. */
  armLength?: number;
  /** The pipe's centre from the post's centre line or the wall's face, mm. */
  pipeAt?: number;
  /** Braced arm: brace foot below the arm on the wall, and its top along the arm from the wall, mm. */
  braceDrop?: number;
  braceReach?: number;
  basePlate?: SupportPlate;
  wallPlate?: SupportPlate;
  topPlate?: SupportPlate;
  /** A U-bolt round the pipe (DIN 3570). */
  uBolt: boolean;
  /**
   * A triangular rib (gusset) in the corner between two members (his ask,
   * 2026-11-16): `leg` along each member, `t` thick, mm. Where it goes is
   * the shape's: under an arm or beam against its post or wall.
   */
  gusset?: { leg: number; t: number };
  note?: string;
  /**
   * Which detail sheet it is drawn on (his ask, 2026-11-16: several
   * supports on one sheet, lines between them); unset, a sheet of its own
   * after the numbered ones. Types with one number share a sheet.
   */
  sheet?: number;
  /**
   * Its detail as he arranged it (same ask: "move the plate drawn in the
   * detail, set the dimensions and balloons"): by element, how far it was
   * dragged on the sheet, mm — `elev` the view, `pv:base|top|wall` a
   * plate's flat view, `b:<mark>` a balloon, `dim:<key>` a dimension.
   */
  layout?: Record<string, { dx: number; dy: number }>;
  /**
   * How many to make (his ask, 2026-11-16: "more than one of the same
   * shape — let me enter a quantity and count it in the total weight");
   * unset, as many as the supports on the line of this type.
   */
  qty?: number;
}

/** A section's dimensions: depth h, width b, wall/flange thickness t, mass kg/m. */
export interface Profile {
  name: string;
  kind: 'RHS' | 'UPN' | 'L';
  h: number;
  b: number;
  t: number;
  kgm: number;
}

const rhs = (h: number, b: number, t: number): Profile => ({
  name: `RHS ${h}x${b}x${t}`,
  kind: 'RHS',
  h,
  b,
  t,
  // Square corners: a little over the catalogue's, which round them off.
  kgm: Math.round(((2 * (h + b) - 4 * t) * t * 7.85) / 10) / 100,
});
const angle = (a: number, t: number): Profile => ({ name: `L ${a}x${a}x${t}`, kind: 'L', h: a, b: a, t, kgm: Math.round((2 * a - t) * t * 7.85 / 10) / 100 });
// UPN (DIN 1026-1): depth, flange width, web, mass.
const upn = (h: number, b: number, t: number, kgm: number): Profile => ({ name: `UPN ${h}`, kind: 'UPN', h, b, t, kgm });

export const PROFILES: Profile[] = [
  rhs(40, 40, 3), rhs(50, 50, 3), rhs(50, 50, 4), rhs(60, 60, 4), rhs(80, 80, 4), rhs(100, 100, 5), rhs(120, 120, 6), rhs(150, 150, 6),
  rhs(60, 40, 3), rhs(80, 40, 4), rhs(100, 50, 4), rhs(120, 60, 5), rhs(150, 100, 6), rhs(200, 100, 6),
  upn(50, 38, 5, 5.59), upn(65, 42, 5.5, 7.09), upn(80, 45, 6, 8.64), upn(100, 50, 6, 10.6), upn(120, 55, 7, 13.4),
  upn(140, 60, 7, 16.0), upn(160, 65, 7.5, 18.8), upn(180, 70, 8, 22.0), upn(200, 75, 8.5, 25.3),
  angle(40, 4), angle(50, 5), angle(60, 6), angle(70, 7), angle(80, 8), angle(100, 10),
];

export function profileOf(name: string | undefined): Profile {
  return PROFILES.find((p) => p.name === name) ?? PROFILES.find((p) => p.name === 'RHS 100x100x5')!;
}

/** U-bolt (DIN 3570) rod by pipe outside diameter. */
export function uBoltRod(dn: string): number {
  const od = sizeOf(dn).od;
  return od <= 42.4 ? 10 : od <= 114.3 ? 12 : od <= 219.1 ? 16 : 20;
}

/** Which members a shape has. */
export function membersOf(shape: SupportShape): { post: boolean; beam: boolean; arm: boolean; brace: boolean; base: boolean; wall: boolean; top: boolean } {
  return {
    post: shape === 'POST_LOW' || shape === 'POST_T' || shape === 'POST_ARM' || shape === 'HANGER_ARM',
    beam: shape === 'POST_T',
    arm: shape === 'POST_ARM' || shape === 'BRACKET_L' || shape === 'BRACKET_BRACED' || shape === 'HANGER_ARM',
    brace: shape === 'BRACKET_BRACED',
    base: shape === 'POST_LOW' || shape === 'POST_T' || shape === 'POST_ARM' || shape === 'HANGER_ARM',
    wall: shape === 'BRACKET_L' || shape === 'BRACKET_BRACED',
    top: shape === 'POST_LOW',
  };
}

/** A plate where the shape has one, as a new type would have it. */
export function defaultPlate(t: SupportType, which: 'basePlate' | 'topPlate' | 'wallPlate'): SupportPlate {
  const fresh = newSupportType(t.shape, t.dn, t.name, t.id);
  return fresh[which] ?? { w: 200, l: 200, t: 10, hole: 18, edge: 30 };
}

/** The supports on the line, by the names they carry on the drawing ("SUPPORT 2", "SUPPORT A"). */
export function supportMarks(drawing: Drawing): { id: string; name: string; type?: string }[] {
  const out: { id: string; name: string; type?: string }[] = [];
  let n = 0;
  for (const run of drawing.runs)
    for (const c of run.inline)
      if (c.kind === 'SUPPORT' || c.kind === 'SUPPORT_L') {
        n += 1;
        out.push({ id: c.id, name: (c.tag || String(n)).toUpperCase(), type: c.supportType });
      }
  return out;
}

/** The detail sheets: the types on each, in order (numbered first, then the rest a sheet each). */
export function supportSheetGroups(drawing: Drawing, most = 6): SupportType[][] {
  const types = drawing.supportTypes ?? [];
  const numbered = new Map<number, SupportType[]>();
  for (const t of types) if (t.sheet && t.sheet > 0) numbered.set(t.sheet, [...(numbered.get(t.sheet) ?? []), t]);
  const out: SupportType[][] = [];
  for (const k of [...numbered.keys()].sort((a, b) => a - b)) {
    const g = numbered.get(k)!;
    for (let i = 0; i < g.length; i += most) out.push(g.slice(i, i + most));
  }
  for (const t of types) if (!(t.sheet && t.sheet > 0)) out.push([t]);
  return out;
}

/** A new type of a shape, sized for a pipe: what he would most likely make. */
export function newSupportType(shape: SupportShape, dn: string, name: string, id: string): SupportType {
  const od = sizeOf(dn).od;
  const m = membersOf(shape);
  const plate = (w: number, t: number, hole: number): SupportPlate => ({ w, l: w, t, hole, edge: Math.round(w * 0.15) });
  return {
    id,
    name,
    shape,
    dn,
    post: m.post ? 'RHS 100x100x5' : undefined,
    beam: m.beam ? 'UPN 100' : undefined,
    arm: m.arm ? (shape === 'POST_ARM' || shape === 'HANGER_ARM' ? 'L 70x70x7' : 'UPN 100') : undefined,
    brace: m.brace ? 'L 50x50x5' : undefined,
    height: shape === 'POST_LOW' ? 400 : shape === 'HANGER_ARM' ? 600 : 800,
    beamLength: m.beam ? Math.max(300, Math.round((od + 200) / 50) * 50) : undefined,
    armLength: m.arm ? Math.max(250, Math.round((od + 150) / 50) * 50) : undefined,
    pipeAt: m.arm ? Math.max(150, Math.round((od / 2 + 100) / 10) * 10) : 0,
    braceDrop: m.brace ? 300 : undefined,
    braceReach: m.brace ? Math.round((Math.max(250, Math.round((od + 150) / 50) * 50) * 0.7) / 10) * 10 : undefined,
    basePlate: m.base ? plate(200, 10, 18) : undefined,
    wallPlate: m.wall ? { w: 200, l: shape === 'BRACKET_BRACED' ? 500 : 200, t: 10, hole: 18, edge: 30 } : undefined,
    topPlate: m.top ? { w: Math.max(150, Math.round((od + 80) / 10) * 10), l: 150, t: 10, hole: uBoltRod(dn) + 2, edge: 0 } : undefined,
    uBolt: true,
  };
}

/** The plate at the post's fixed end: on the floor, or on the roof for a hanger. */
export function basePlateName(t: SupportType): string {
  return t.shape === 'HANGER_ARM' ? 'ROOF PLATE' : 'BASE PLATE';
}

/** One line of a support's parts list. */
export interface SupportPart {
  mark: number;
  description: string;
  /** Cut length (members) or size (plates), as printed. */
  size: string;
  qty: number;
  kg: number;
}

const plateKg = (p: SupportPlate) => Math.round(p.w * p.l * p.t * 7.85e-6 * 100) / 100;

/** The brace's length along its centre line and the angle it stands at. */
export function braceGeometry(t: SupportType): { length: number; angle: number } {
  const d = t.braceDrop ?? 300;
  const r = t.braceReach ?? 250;
  return { length: Math.round(Math.hypot(d, r)), angle: Math.round((Math.atan2(d, r) * 180) / Math.PI) };
}

/** How long each member is cut. */
export function memberLengths(t: SupportType): { post?: number; beam?: number; arm?: number; brace?: number } {
  const base = t.basePlate?.t ?? 0;
  const top = t.topPlate?.t ?? 0;
  switch (t.shape) {
    case 'POST_LOW':
      return { post: Math.max(0, t.height - base - top) };
    case 'POST_T':
      return { post: Math.max(0, t.height - base - profileOf(t.beam).h), beam: t.beamLength ?? 400 };
    case 'POST_ARM':
      return { post: Math.max(0, t.height - base), arm: t.armLength ?? 300 };
    case 'HANGER_ARM':
      // From the roof plate (or the steel above) down to the arm's underside:
      // the arm is welded to its foot, its top the pipe's bottom.
      return { post: Math.max(0, t.height + profileOf(t.arm).h - base), arm: t.armLength ?? 300 };
    case 'BRACKET_L':
      return { arm: t.armLength ?? 300 };
    case 'BRACKET_BRACED':
      return { arm: t.armLength ?? 300, brace: braceGeometry(t).length };
  }
}

/** Everything a support of this type is made of, numbered as on its sheet. */
export function supportParts(t: SupportType): SupportPart[] {
  const parts: SupportPart[] = [];
  const len = memberLengths(t);
  const member = (what: string, profile: string | undefined, length: number | undefined, qty = 1) => {
    if (!profile || !length) return;
    const p = profileOf(profile);
    parts.push({ mark: parts.length + 1, description: `${what} ${p.name}`, size: `L=${Math.round(length)}`, qty, kg: Math.round(((p.kgm * length) / 1000) * qty * 100) / 100 });
  };
  const plate = (what: string, p: SupportPlate | undefined) => {
    if (!p) return;
    const holes = p.hole > 0 ? (what === 'TOP PLATE' ? ` 2 HOLES Ø${p.hole}` : ` 4 HOLES Ø${p.hole}`) : '';
    parts.push({ mark: parts.length + 1, description: `${what} PL ${p.t}${holes}`, size: `${p.w}x${p.l}`, qty: 1, kg: plateKg(p) });
  };
  member('POST', t.post, len.post);
  member('BEAM', t.beam, len.beam);
  member('ARM', t.arm, len.arm);
  member('BRACE', t.brace, len.brace);
  plate(basePlateName(t), t.basePlate);
  // A hanger's roof plate is bolted up: an anchor in each hole, 2 mm under it.
  if (t.shape === 'HANGER_ARM' && t.basePlate && t.basePlate.hole > 2)
    parts.push({ mark: parts.length + 1, description: `ANCHOR BOLT M${Math.round(t.basePlate.hole - 2)} WITH NUT AND WASHER`, size: 'TO SUIT ROOF', qty: 4, kg: 0 });
  plate('TOP PLATE', t.topPlate);
  plate('WALL PLATE', t.wallPlate);
  const ribs = gussetCount(t);
  if (t.gusset && ribs) {
    const { leg, t: th } = t.gusset;
    parts.push({ mark: parts.length + 1, description: `GUSSET PL ${th} TRIANGLE`, size: `${leg}x${leg}`, qty: ribs, kg: Math.round(((leg * leg) / 2) * th * 7.85e-6 * ribs * 100) / 100 });
  }
  if (t.uBolt) {
    const rod = uBoltRod(t.dn);
    parts.push({ mark: parts.length + 1, description: `U-BOLT M${rod} DIN 3570 WITH 4 NUTS`, size: `FOR ${sizeLabel(t.dn)} PIPE`, qty: 1, kg: 0 });
  }
  return parts;
}

/** How many ribs a shape takes: one in each corner between two of its members. */
export function gussetCount(t: SupportType): number {
  switch (t.shape) {
    case 'POST_T':
      return 2; // under the beam, each side of the post
    case 'POST_ARM':
    case 'HANGER_ARM':
    case 'BRACKET_L':
    case 'BRACKET_BRACED':
      return 1; // in the corner of the arm and the post or wall
    default:
      return 0; // one member only
  }
}

/**
 * The least a support counts in the weight he charges by (his ask,
 * 2026-11-16: "a support may weigh under 5 kg on its own, but the total I
 * bill the customer by counts at least 5 kg a support").
 */
export const SUPPORT_BILL_MIN_KG = 5;

/** Each type: how many, what one weighs, what they count for in the bill. */
export function supportSchedule(drawing: Drawing): { rows: { id: string; name: string; shape: SupportShape; qty: number; kg: number; billed: number }[]; steel: number; billed: number } {
  const qty = supportQty(drawing);
  const rows = (drawing.supportTypes ?? []).map((t) => {
    const kg = Math.round(supportParts(t).reduce((a, p) => a + p.kg, 0) * 100) / 100;
    const n = qty.get(t.id) ?? 0;
    return { id: t.id, name: t.name, shape: t.shape, qty: n, kg, billed: Math.round(Math.max(kg, SUPPORT_BILL_MIN_KG) * n * 10) / 10 };
  });
  return {
    rows,
    steel: Math.round(rows.reduce((a, r) => a + r.kg * r.qty, 0) * 10) / 10,
    billed: Math.round(rows.reduce((a, r) => a + r.billed, 0) * 10) / 10,
  };
}

/** How many supports on the sheet are of each type. */
export function supportUses(drawing: Drawing): Map<string, number> {
  const out = new Map<string, number>();
  for (const run of drawing.runs) for (const c of run.inline) if (c.supportType) out.set(c.supportType, (out.get(c.supportType) ?? 0) + 1);
  return out;
}

/** How many of each type are made: the quantity typed, else the supports on the line of it. */
export function supportQty(drawing: Drawing): Map<string, number> {
  const uses = supportUses(drawing);
  const out = new Map<string, number>();
  // A type made but given to no support on the line yet counts one (his
  // DESHANIM sheet, 2026-11-16: two types, neither ticked on a support, and
  // the weight came out nothing).
  for (const t of drawing.supportTypes ?? []) out.set(t.id, t.qty !== undefined && t.qty >= 0 ? t.qty : uses.get(t.id) || 1);
  return out;
}

/** The next free name: PS-1, PS-2 … */
export function nextSupportName(drawing: Drawing): string {
  const taken = new Set((drawing.supportTypes ?? []).map((t) => t.name));
  let n = 1;
  while (taken.has(`PS-${n}`)) n += 1;
  return `PS-${n}`;
}

/** The sheet's support material, all types together, times the supports of each. */
export function supportMaterial(drawing: Drawing): { description: string; size: string; qty: number; kg: number }[] {
  const uses = supportQty(drawing);
  const rows = new Map<string, { description: string; size: string; qty: number; kg: number; length: number }>();
  for (const t of drawing.supportTypes ?? []) {
    const n = uses.get(t.id) ?? 0;
    if (n === 0) continue;
    for (const p of supportParts(t)) {
      const member = p.size.startsWith('L=');
      // Members by profile, as metres to order; plates and U-bolts by size.
      const name = member ? p.description.replace(/^(POST|BEAM|ARM|BRACE) /, '') : p.description.replace(/^(BASE|TOP|WALL|ROOF) PLATE /, 'PLATE ');
      const key = member ? name : `${name}|${p.size}`;
      const row = rows.get(key) ?? { description: name, size: member ? '' : p.size, qty: 0, kg: 0, length: 0 };
      if (member) row.length += Number(p.size.slice(2)) * p.qty * n;
      else row.qty += p.qty * n;
      row.kg += p.kg * n;
      rows.set(key, row);
    }
  }
  return [...rows.values()].map((r) => ({ description: r.description, size: r.length ? `${(r.length / 1000).toFixed(2)} m` : r.size, qty: r.length ? 0 : r.qty, kg: Math.round(r.kg * 10) / 10 }));
}

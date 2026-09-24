import type {
  Axis,
  Drawing,
  EndType,
  DrawingOptions,
  FittingKind,
  InlineComponent,
  IsoNode,
  JointType,
  Meta,
  Run,
  Vec3,
  Weld,
  WeldReach,
} from './types';
import { AXIS_VECTOR, add, angleBetween, direction, equals3, length3, scale3, sub } from './iso';
import { componentTakeout, defaultValveEnds, fittingTakeout, oletTakeout, sizeLabel, valveFlangeKind } from './pipe-data';
import { flangeJoint, isFlange } from '../render/symbols';
import platinumLogo from '../assets/platinum-logo.png';

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * The company mark carried on every sheet. Imported rather than pasted in as a
 * string so the build inlines it, which keeps it out of the source and out of
 * every saved drawing that has not replaced it.
 */
export const DEFAULT_LOGO = platinumLogo;

export function emptyMeta(): Meta {
  return {
    project: '',
    lineNumber: '',
    drawingNo: '',
    sheet: '1 of 1',
    revision: '0',
    date: new Date().toISOString().slice(0, 10),
    drawnBy: '',
    logo: DEFAULT_LOGO,
  };
}

export function defaultOptions(): DrawingOptions {
  return {
    snap: 50,
    scale: 0.06,
    schematic: false,
    schematicLength: 1500,
    showDimensions: true,
    // Welds carry the numbers a welder's records are kept against, so they are
    // shown by default here even though a typical sheet leaves them off.
    showWelds: true,
    showItems: true,
    showNodeLabels: true,
    showGrid: true,
    northRotation: 0,
    joint: 'BW',
    pipeSchedule: 'SCH40',
    fittingThickness: 'STD',
    sheetScale: 15,
  };
}

export function emptyDrawing(): Drawing {
  return {
    version: 1,
    meta: emptyMeta(),
    options: defaultOptions(),
    nodes: [],
    runs: [],
    weldOverrides: {},
  };
}

export interface NodeInfo {
  node: IsoNode;
  /** Runs touching this node. */
  runs: Run[];
  /** Unit vectors leaving the node along each connected run, in run order. */
  legs: Vec3[];
  fitting: FittingKind;
  degree: number;
}

/** One thing on the drawing, carrying the material list number it balloons to. */
export interface ItemInstance {
  key: string;
  number: number;
  pos: Vec3;
  /** The list line it is counted on. */
  line: string;
}

export interface BomLine {
  /** Identifies the line so the things on the drawing can point at it. */
  key?: string;
  category: 'PIPE' | 'FITTING' | 'VALVE' | 'FLANGE' | 'ITEM';
  description: string;
  dn: string;
  schedule: string;
  /** Metres for pipe, otherwise a count. */
  quantity: number;
  unit: 'm' | 'off';
}

export interface RunLengths {
  run: Run;
  /** Centre-to-centre length in mm — the dimension shown on the isometric. */
  centre: number;
  /** Pipe actually cut, after deducting fitting and component take-outs. */
  cut: number;
}

/**
 * One length of pipe as it is cut: from one weld to the next, with the
 * fittings' take-outs off and a root gap left at every fitting butt-welded
 * to it. What the fitter marks on the pipe.
 */
export interface PipePiece {
  /** Its letter on the drawing and in the lists: A, B, C… along the route. */
  letter: string;
  /** For the letter's dragged position: "piece:<run>:<n>". */
  key: string;
  /** Where the letter is hung: a third of the way along the piece. */
  pos: Vec3;
  /** The runs it lies along: two where it carries straight through an olet. */
  runIds: string[];
  dn: string;
  schedule: string;
  /** End to end, take-outs off, before the root gaps. */
  length: number;
  /** What is left to cut once the root gaps are off. */
  net: number;
  /** The joint at each end, if there is one, and the gap left for it. */
  ends: [PieceEnd, PieceEnd];
}

export interface PieceEnd {
  key?: string;
  gap: number;
}

/** The root gap left at a butt weld to a fitting, in mm. */
export const ROOT_GAP = 2.5;

export interface Analysis {
  nodeInfo: Map<string, NodeInfo>;
  nodeById: Map<string, IsoNode>;
  /** Every mark where the pipe meets something, threaded joints included. */
  joints: Weld[];
  /** The joints that are actually welds, numbered along the route. */
  welds: Weld[];
  runLengths: Map<string, RunLengths>;
  /** Every length of pipe as cut, with the welds at its ends. */
  pieces: PipePiece[];
  bom: BomLine[];
  /** Every ballooned thing on the drawing, with its material list number. */
  items: ItemInstance[];
  /** Node positions used for drawing, which differ from true positions in schematic mode. */
  display: Map<string, Vec3>;
  /** Headers running straight through one or more olets, dimensioned as one. */
  chains: HeaderChain[];
  chainOfRun: Map<string, HeaderChain>;
  /** Each point's joint as made: its own, else its line's (a branch off a
   * threaded or socket-weld olet), else the drawing's. */
  nodeJoint: Map<string, JointType>;
  /** Points whose joint comes from the olet their line is drawn from. */
  inheritedJoint: Map<string, { joint: JointType; from: string }>;
  /** Not to scale: where things are drawn along each run (none to scale). */
  stations: Map<string, DrawnStations>;
  warnings: string[];
}

function inferFitting(legs: Vec3[], runs: Run[], override?: FittingKind, pendingOlet = false): FittingKind {
  // An olet with no branch yet rides on the line, waiting for one; an olet
  // whose branch was deleted closes back up to a plain butt joint rather
  // than keeping a fitting that is no longer there.
  if (override === 'OLET' && legs.length < 3) {
    return pendingOlet && legs.length === 2 && 180 - angleBetween(legs[0], legs[1]) < 1 ? 'OLET' : 'NONE';
  }
  if (override) return override;
  if (legs.length <= 1) return 'NONE';
  if (legs.length === 2) {
    const deviation = 180 - angleBetween(legs[0], legs[1]);
    if (deviation < 1) return 'NONE';
    if (Math.abs(deviation - 90) < 1) return 'ELBOW_90';
    if (Math.abs(deviation - 45) < 1) return 'ELBOW_45';
    return 'BEND';
  }
  if (legs.length === 3) {
    // A branch of a different size makes it a reducing tee, which is drawn
    // and taken off differently from an equal one.
    const sizes = new Set(runs.map((r) => r.dn));
    return sizes.size > 1 ? 'TEE_REDUCING' : 'TEE';
  }
  return 'CROSS';
}

export function isReducer(kind: string): boolean {
  return kind === 'RED_CONC' || kind === 'RED_ECC';
}

/** What a reducer is called, by its two sizes: "CON RED 4" X 2"". */
export function reducerName(comp: InlineComponent, runDn: string): string {
  const large = comp.dn ?? runDn;
  const small = comp.dn2 ?? large;
  return `${comp.kind === 'RED_ECC' ? 'ECC RED' : 'CON RED'} ${sizeLabel(large)} X ${sizeLabel(small)}`;
}

/**
 * The size either side of a reducer along its run: the large end is on the
 * run's start side unless it is turned round.
 */
export function reducerSides(comp: InlineComponent, runDn: string): { start: string; end: string } {
  const large = comp.dn ?? runDn;
  const small = comp.dn2 ?? large;
  return comp.flip ? { start: small, end: large } : { start: large, end: small };
}

/** What an in-line item is called in a weld's name: a reducer by its sizes. */
export function inlineLabel(comp: InlineComponent, runDn: string): string {
  return isReducer(comp.kind) ? reducerName(comp, runDn) : COMPONENT_LABEL[comp.kind] ?? comp.kind;
}

/** What a line's end piece takes off the pipe: a flange's length, a transition's stub. */
export function terminalTakeoutOf(kind: string | undefined, dn: string): number {
  return kind === 'FLG_WN' || kind === 'FLG_SO' || kind === 'TRANSITION' ? componentTakeout(kind, dn) : 0;
}

/**
 * The item whose face sits right on one end of a run: against the flange or
 * cap there, with no pipe between, or on the open point itself. A reducer's
 * size there is its own end's. `face` is how far the face is from the point.
 */
export function itemAtEnd(
  drawing: Drawing,
  run: Run,
  atStart: boolean,
): { comp: InlineComponent; dn: string; face: number } | null {
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  if (!a || !b) return null;
  const node = atStart ? a : b;
  const total = length3(sub(b.pos, a.pos));
  const defaultJoint = drawing.options.joint ?? 'BW';
  for (const comp of run.inline) {
    const dn = comp.dn ?? run.dn;
    const ends = resolveEnds(comp.kind, dn, comp.ends, defaultJoint);
    const half = componentTakeout(comp.kind, dn, ends === 'FLG' && valveFlangeKind(defaultJoint), comp.ff);
    if (half <= 0) continue;
    const sides = reducerSides(comp, run.dn);
    const sideDn = isReducer(comp.kind) ? (atStart ? sides.start : sides.end) : dn;
    const face = atStart ? comp.offset - half : total - comp.offset - half;
    if (Math.abs(face - terminalTakeoutOf(node.terminal?.kind, sideDn)) < 0.5) return { comp, dn: sideDn, face };
  }
  return null;
}

/** Half an item's length along its run, flanges included: how far it reaches from its centre. */
export function itemHalf(drawing: Drawing, run: Run, comp: InlineComponent): number {
  if (isMark(comp.kind)) return 0;
  const dn = comp.dn ?? run.dn;
  const joint = drawing.options.joint ?? 'BW';
  const ends = resolveEnds(comp.kind, dn, comp.ends, joint);
  return componentTakeout(comp.kind, dn, ends === 'FLG' && valveFlangeKind(joint), comp.ff);
}

/**
 * The side (0 start, 1 end) of a flanged valve that faces the open end of
 * its line — the "last flange" — or null when the valve is not on an open
 * end. Open means the end point has no other run and wears no end piece.
 */
export function valveOpenSide(drawing: Drawing, run: Run, comp: InlineComponent): 0 | 1 | null {
  if (!isValve(comp.kind)) return null;
  const joint = drawing.options.joint ?? 'BW';
  const dn = comp.dn ?? run.dn;
  if (resolveEnds(comp.kind, dn, comp.ends, joint) !== 'FLG') return null;
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  if (!a || !b) return null;
  const total = length3(sub(b.pos, a.pos));
  const half = componentTakeout(comp.kind, dn, valveFlangeKind(joint), comp.ff);
  const open = (node: IsoNode) =>
    drawing.runs.filter((r) => r.from === node.id || r.to === node.id).length === 1 && (!node.terminal || node.terminal.kind === 'OPEN');
  if (comp.offset + half >= total - 0.5 && open(b)) return 1;
  if (comp.offset - half <= 0.5 && open(a)) return 0;
  return null;
}

/** The size at a run's end: the item welded straight to the end piece there, else the run's. */
export function endDn(drawing: Drawing, run: Run, atStart: boolean): string {
  return itemAtEnd(drawing, run, atStart)?.dn ?? run.dn;
}

/** What an olet is called, which follows how its branch is joined. */
export function oletLabel(joint: JointType): string {
  if (joint === 'SW') return 'SOCKOLET';
  if (joint === 'THD') return 'THREADOLET';
  return 'WELDOLET';
}

/**
 * At an olet the two collinear runs are the header and the odd one out is the
 * branch. Returns null when the node is not shaped like an olet at all.
 */
export interface OletMark {
  dir: Axis;
  dn: string;
}

/** The olets marked on a point, however they were stored. */
export function oletMarks(node: IsoNode): OletMark[] {
  return node.olets ?? (node.olet ? [node.olet] : []);
}

export interface OletLegs {
  /** The two collinear header runs. */
  header: Run[];
  /** The branches drawn, each with the way it leaves. */
  branches: { run: Run; dir: Axis }[];
  /** The first branch, for what only ever wants one. */
  branch: Run | null;
  /** Olets marked but not yet drawn from, with their place in the marks. */
  pending: { dir: Axis; dn: string; markIndex: number }[];
}

/**
 * The runs at an olet point: the two header runs the line runs straight
 * through, and every branch off it — drawn, or only marked so far. More
 * than one olet can sit on one point, leaving different ways.
 */
export function oletLegs(info: NodeInfo): OletLegs | null {
  if (info.runs.length < 2 || info.legs.length !== info.runs.length) return null;
  let header: [number, number] | null = null;
  for (let i = 0; i < info.runs.length && !header; i += 1) {
    for (let j = i + 1; j < info.runs.length; j += 1) {
      if (180 - angleBetween(info.legs[i], info.legs[j]) < 1) {
        header = [i, j];
        break;
      }
    }
  }
  if (!header) return null;
  const marks = oletMarks(info.node);
  const branches = info.runs
    .map((run, k) => ({ run, dir: axisOf(info.legs[k]) }))
    .filter((_, k) => k !== header![0] && k !== header![1])
    .filter((b): b is { run: Run; dir: Axis } => b.dir !== null);
  if (branches.length === 0 && marks.length === 0) return null;
  // A mark is spent by the branch drawn its way; a branch drawn some other
  // way spends the next mark still waiting, so a branch never leaves a
  // second olet behind on the point.
  let pending = marks.map((mark, markIndex) => ({ ...mark, markIndex }));
  const unmatched = branches.filter((b) => {
    const at = pending.findIndex((mark) => mark.dir === b.dir);
    if (at < 0) return true;
    pending = pending.filter((_, i) => i !== at);
    return false;
  });
  pending = pending.slice(unmatched.length);
  return { header: [info.runs[header[0]], info.runs[header[1]]], branches, branch: branches[0]?.run ?? null, pending };
}

/** The axis a unit leg lies along, if it lies along one. */
function axisOf(leg: Vec3): Axis | null {
  for (const axis of ['N', 'S', 'E', 'W', 'U', 'D'] as Axis[]) {
    const v = AXIS_VECTOR[axis];
    if (leg.e * v.e + leg.n * v.n + leg.u * v.u > 0.999) return axis;
  }
  return null;
}

/** Every olet on a point: the branches drawn, then the ones marked and waiting. */
export function oletEntries(legs: OletLegs): { dir: Axis; dn: string; run: Run | null }[] {
  return [...legs.branches.map((b) => ({ dir: b.dir, dn: b.run.dn, run: b.run as Run | null })), ...legs.pending.map((p) => ({ dir: p.dir, dn: p.dn, run: null }))];
}

/**
 * The centre-to-centre length at which the fittings at a run's two ends
 * touch: the sum of their take-outs. Zero when neither end is a fitting.
 */
export function fittingsTouchLength(drawing: Drawing, analysis: Analysis, run: Run): number {
  const a = analysis.nodeById.get(run.from);
  const b = analysis.nodeById.get(run.to);
  return (
    endTakeout(analysis.nodeInfo.get(run.from), run) +
    endTakeout(analysis.nodeInfo.get(run.to), run) +
    (a ? terminalTakeout(a, endDn(drawing, run, true)) : 0) +
    (b ? terminalTakeout(b, endDn(drawing, run, false)) : 0)
  );
}

/** What a line's end piece takes off the pipe: a flange's length, a transition's stub. */
function terminalTakeout(node: IsoNode, dn: string): number {
  return terminalTakeoutOf(node.terminal?.kind, dn);
}

export function fittingLabel(kind: FittingKind): string {
  switch (kind) {
    case 'ELBOW_90':
      return '90 ELBOW LR';
    case 'ELBOW_45':
      return '45 ELBOW LR';
    case 'BEND':
      return 'BEND';
    case 'TEE':
      return 'EQUAL TEE';
    case 'TEE_REDUCING':
      return 'REDUCING TEE';
    case 'CROSS':
      return 'CROSS';
    case 'OLET':
      // Named properly by oletLabel, which knows how the branch is joined.
      return 'OLET';
    case 'MITRE':
      return 'MITRE BEND';
    default:
      return '';
  }
}

/** How a fitting's make is named in the list: welded ones plainly, socket and screwed ones by their joint. */
export function jointSuffix(joint: JointType): string {
  return joint === 'SW' ? ' SW 3000#' : joint === 'THD' ? " SCR'D 3000#" : '';
}

export const COMPONENT_LABEL: Record<string, string> = {
  GATE: 'GATE VALVE',
  GLOBE: 'GLOBE VALVE',
  BALL: 'BALL VALVE',
  BALL_ACT: 'BALL VALVE, AIR ACTUATED',
  CHECK: 'CHECK VALVE',
  BUTTERFLY: 'BUTTERFLY VALVE',
  PLUG: 'PLUG VALVE',
  NEEDLE: 'NEEDLE VALVE',
  CONTROL: 'CONTROL VALVE',
  RELIEF: 'RELIEF VALVE',
  FLG_WN: 'WELD NECK FLANGE',
  FLG_SO: 'SLIP-ON FLANGE',
  FLG_SW: 'SOCKET WELD FLANGE',
  FLG_THD: 'THREADED FLANGE',
  FLG_LAP: 'LAP JOINT FLANGE',
  FLG_BLIND: 'BLIND FLANGE',
  SPECTACLE: 'SPECTACLE BLIND',
  RED_CONC: 'CON RED',
  RED_ECC: 'ECC RED',
  CAP: 'CAP',
  UNION: 'UNION',
  TRANSITION: 'TRANSITION JOINT PE/CS',
  STRAINER: 'STRAINER',
  INSTRUMENT: 'INSTRUMENT',
  SUPPORT: 'PIPE SUPPORT',
  SUPPORT_L: 'PIPE SUPPORT L50',
  ANCHOR: 'ANCHOR',
  GUIDE: 'GUIDE',
  GROUND: 'AG/UG',
};

export const TERMINAL_LABEL: Record<string, string> = {
  OPEN: 'OPEN END',
  FLG_WN: 'WELD NECK FLANGE',
  FLG_SO: 'SLIP-ON FLANGE',
  FLG_SW: 'SOCKET WELD FLANGE',
  FLG_THD: 'THREADED FLANGE',
  FLG_LAP: 'LAP JOINT FLANGE',
  FLG_BLIND: 'BLIND FLANGE',
  CAP: 'CAP',
  TRANSITION: 'TRANSITION JOINT PE/CS',
  CONTINUATION: 'CONTINUATION',
  EQUIPMENT: 'EQUIPMENT CONNECTION',
};

/**
 * How a component joins the pipe either side of it, or null when it makes no
 * mark of its own — a support clamps on, a blind bolts between flanges.
 */
function componentJoint(c: InlineComponent, fallback: JointType, dn: string): JointType | null {
  if (['SUPPORT', 'SUPPORT_L', 'ANCHOR', 'GUIDE', 'INSTRUMENT', 'SPECTACLE', 'GROUND'].includes(c.kind)) return null;
  // A flange's own type says how it joins the pipe, whatever the default is.
  if (isFlange(c.kind)) return flangeJoint(c.kind);
  // The size decides how a valve is connected, so it has to be the size the
  // component actually is — its own, or the run's.
  const ends = resolveEnds(c.kind, dn, c.ends, fallback);
  // A flanged component meets the pipe through its flanges, which are joined
  // to the pipe the way the line is: weld neck on a butt welded line, socket
  // weld or threaded flanges on those.
  if (ends === 'FLG') return flangeJoint(valveFlangeKind(fallback));
  return ends === 'BW' || ends === 'SW' || ends === 'THD' ? ends : null;
}

/** How a line end joins whatever terminates it. */
function terminalJoint(kind: string, fallback: JointType): JointType | null {
  if (isFlange(kind)) return flangeJoint(kind);
  // A transition joint is welded on its steel side; the plastic side is fused.
  if (kind === 'TRANSITION') return 'BW';
  return kind === 'CAP' ? fallback : null;
}

/** Marks placed on the line that are neither material nor joints: a support, the AG/UG line. */
export function isMark(kind: string): boolean {
  return isSupport(kind) || kind === 'GROUND';
}

/** The supports: a note on the drawing, numbered along the line. */
export function isSupport(kind: string): boolean {
  return kind === 'SUPPORT' || kind === 'SUPPORT_L';
}

/** Valves are the components that come flanged or threaded by size. */
export function isValve(kind: string): boolean {
  return categoryOf(kind) === 'VALVE';
}

/**
 * How a component is connected. A valve follows the shop rule — flanged over
 * an inch, threaded at an inch and under — unless it has been set explicitly.
 * Everything else follows the drawing's joint type.
 */
export function resolveEnds(
  kind: string,
  dn: string,
  ends: EndType | undefined,
  fallback: JointType,
): EndType {
  if (ends) return ends;
  if (isValve(kind)) return defaultValveEnds(dn);
  if (isFlange(kind)) return 'FLG';
  return fallback;
}

function categoryOf(kind: string): BomLine['category'] {
  if (kind.startsWith('FLG_') || kind === 'SPECTACLE') return 'FLANGE';
  if (['RED_CONC', 'RED_ECC', 'UNION', 'TRANSITION'].includes(kind)) return 'FITTING';
  if (['SUPPORT', 'SUPPORT_L', 'ANCHOR', 'GUIDE', 'INSTRUMENT', 'GROUND'].includes(kind)) return 'ITEM';
  return 'VALVE';
}

/**
 * Lays out node positions for drawing. In schematic mode every run is drawn at
 * the same visual length regardless of its true dimension, which is how a
 * fabrication isometric is normally presented; otherwise true lengths are used
 * with a floor so that short runs stay readable.
 */
/** Half-size of a symbol on the sheet, in sheet millimetres; symbols are a set size on paper. */
export const SYMBOL_MM = 2.4;

/**
 * How long a run is drawn when the sheet is not to scale, in the same units
 * as its true length: where the pencil put it (`run.visual`), else its true
 * length capped at the sheet's even spacing, so a 19 m header is drawn no
 * longer than the rest; and never shorter than a few symbols, so a run holds
 * the fittings drawn on it and can be picked up by its ends (his complaint,
 * 2026-09-23: a 19 m pipe drawn as a stub, the sheet unusable not to scale).
 */
export function drawnLength(drawing: Drawing, run: Run, trueLength: number): number {
  const minDrawn = minDrawnLength(drawing);
  const cap = drawing.options.schematicLength;
  // A drawn length under the floor is a leftover (a run split down to its
  // reducer, a stub dragged in), not a choice: drawn as if never set.
  // A hair under the floor is the floor: a drag clamped to it once came
  // back 1e-13 short and the run was drawn at its whole length instead.
  const chosen = run.visual !== undefined && run.visual >= minDrawn - 0.5 ? run.visual : undefined;
  return Math.max(runDrawnFloor(drawing, run), chosen ?? Math.min(trueLength, cap));
}

/** The shortest a run is drawn not to scale: six symbols, so its fittings fit on it. */
export function minDrawnLength(drawing: Drawing): number {
  return SYMBOL_MM * (drawing.options.sheetScale ?? 15) * 6;
}

/**
 * Where things are drawn along a run not to scale: true distances from the
 * run's start (`at`) and where each is drawn (`drawn`, in drawing mm), a
 * piecewise line through the faces of the items on it. Each item takes the
 * width of its symbol and each length of pipe between them at least a
 * couple of symbols, the rest shared by true length — so two valves close
 * together never overlap and the spool between them stays there to see,
 * tap and measure (his complaint, 2026-09-24: "spool 8 is drawn squashed
 * and I can't change its length; the print is fine").
 */
export interface DrawnStations {
  at: number[];
  drawn: number[];
  /** The drawn length the stations add up to. */
  length: number;
}

/** The shortest a length of pipe between two items is drawn, in symbol half-sizes. */
const PIECE_SYMBOLS = 2.5;
/** How far a symbol at a point reaches into the run: an elbow's sweep, a tee, a flange. */
const END_SYMBOLS = 1.4;

function drawnPieces(drawing: Drawing, run: Run, trueLength: number) {
  const s = SYMBOL_MM * (drawing.options.sheetScale ?? 15);
  const joint = drawing.options.joint ?? 'BW';
  const hub = joint === 'BW' ? 1.1 : 0.7;
  const endOf = (nodeId: string): number => {
    const node = drawing.nodes.find((n) => n.id === nodeId);
    const degree = drawing.runs.filter((r) => r.from === nodeId || r.to === nodeId).length;
    return degree > 1 || (node?.terminal && node.terminal.kind !== 'OPEN') ? END_SYMBOLS * s : 0;
  };
  const items = run.inline
    .filter((c) => !isMark(c.kind) && componentTakeout(c.kind, c.dn ?? run.dn, false, c.ff) > 0)
    .sort((x, y) => x.offset - y.offset);
  // Alternating: pipe, item, pipe, item, … pipe. An item has its true reach
  // either side of its centre and its drawn one.
  const segs: { kind: 'pipe' | 'item'; lo: number; hi: number; min: number; fixed: boolean; drawnLo?: number; drawnHi?: number }[] = [];
  let cursor = 0;
  items.forEach((comp, i) => {
    const dn = comp.dn ?? run.dn;
    const face = componentTakeout(comp.kind, dn, false, comp.ff);
    const flanged = resolveEnds(comp.kind, dn, comp.ends, joint) === 'FLG' && (isValve(comp.kind) || isReducer(comp.kind));
    const flangeLen = flanged ? componentTakeout(comp.kind, dn, valveFlangeKind(joint), comp.ff) - face : 0;
    const open = flanged ? valveOpenSide(drawing, run, comp) : null;
    const hasFlange = (side: 0 | 1) => flanged && comp.bare !== side && !(comp.lastFlange && open === side);
    const trueLo = face + (hasFlange(0) ? flangeLen : 0);
    const trueHi = face + (hasFlange(1) ? flangeLen : 0);
    const drawnLo = 1.2 * s + (hasFlange(0) ? hub * s : 0);
    const drawnHi = 1.2 * s + (hasFlange(1) ? hub * s : 0);
    const lo = Math.max(cursor, Math.min(trueLength, comp.offset - trueLo));
    const hi = Math.max(lo, Math.min(trueLength, comp.offset + trueHi));
    const gap = lo - cursor;
    const first = i === 0;
    // Against the flange on the line's end: that flange's hub, no pipe.
    const onEnd = first && itemAtEnd(drawing, run, true)?.comp.id === comp.id;
    const startNode = drawing.nodes.find((n) => n.id === run.from);
    const termHub = startNode?.terminal && isFlange(startNode.terminal.kind) ? (startNode.terminal.kind === 'FLG_SW' || startNode.terminal.kind === 'FLG_THD' ? 0.7 : 1.1) * s : 0;
    if (onEnd) segs.push({ kind: 'pipe', lo: cursor, hi: lo, min: termHub, fixed: true });
    else if (gap <= 0.5) segs.push({ kind: 'pipe', lo: cursor, hi: lo, min: 0, fixed: true });
    else segs.push({ kind: 'pipe', lo: cursor, hi: lo, min: PIECE_SYMBOLS * s + (first ? endOf(run.from) : 0), fixed: false });
    segs.push({ kind: 'item', lo, hi, min: drawnLo + drawnHi, fixed: true, drawnLo, drawnHi });
    cursor = hi;
  });
  const gap = trueLength - cursor;
  const last = items[items.length - 1];
  const endNode = drawing.nodes.find((n) => n.id === run.to);
  const onEnd = !!last && itemAtEnd(drawing, run, false)?.comp.id === last.id;
  const termHub = endNode?.terminal && isFlange(endNode.terminal.kind) ? (endNode.terminal.kind === 'FLG_SW' || endNode.terminal.kind === 'FLG_THD' ? 0.7 : 1.1) * s : 0;
  if (onEnd) segs.push({ kind: 'pipe', lo: cursor, hi: trueLength, min: termHub, fixed: true });
  else if (items.length > 0 && gap <= 0.5) segs.push({ kind: 'pipe', lo: cursor, hi: trueLength, min: 0, fixed: true });
  else segs.push({ kind: 'pipe', lo: cursor, hi: trueLength, min: PIECE_SYMBOLS * s + (items.length > 0 ? endOf(run.to) : 0), fixed: false });
  return segs;
}

/** The shortest this run can be drawn not to scale: its items' symbols and a length of pipe between each. */
export function runDrawnFloor(drawing: Drawing, run: Run, trueLength?: number): number {
  const floor = minDrawnLength(drawing);
  if (!run.inline.some((c) => !isMark(c.kind))) return floor;
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  const len = trueLength ?? (a && b ? length3(sub(b.pos, a.pos)) : 0);
  const segs = drawnPieces(drawing, run, len);
  return Math.max(floor, segs.reduce((sum, seg) => sum + seg.min, 0));
}

/** The stations of a run drawn `drawn` long (see `DrawnStations`). */
export function drawnStations(drawing: Drawing, run: Run, trueLength: number, drawn: number): DrawnStations {
  const segs = drawnPieces(drawing, run, trueLength);
  const need = segs.reduce((sum, seg) => sum + seg.min, 0);
  const free = segs.filter((seg) => !seg.fixed);
  const freeTrue = free.reduce((sum, seg) => sum + (seg.hi - seg.lo), 0);
  const extra = Math.max(0, drawn - need);
  // With no pipe to take the rest, everything is drawn in proportion.
  const stretch = free.length === 0 || freeTrue <= 0 ? (need > 0 ? Math.max(1, drawn / need) : 1) : 1;
  const at: number[] = [0];
  const out: number[] = [0];
  let d = 0;
  for (const seg of segs) {
    if (seg.kind === 'item') {
      const centre = seg.lo + (seg.hi - seg.lo) * (seg.drawnLo! / (seg.drawnLo! + seg.drawnHi!));
      at.push(centre, seg.hi);
      out.push(d + seg.drawnLo! * stretch, d + seg.min * stretch);
      d += seg.min * stretch;
    } else {
      const share = !seg.fixed && freeTrue > 0 ? (extra * (seg.hi - seg.lo)) / freeTrue : 0;
      d += seg.min * stretch + share;
      at.push(seg.hi);
      out.push(d);
    }
  }
  return { at, drawn: out, length: d };
}

/** Where a true distance along a run is drawn, as a share of its drawn length. */
export function drawnShare(stations: DrawnStations | undefined, mm: number, trueLength: number): number {
  if (!stations || stations.length <= 0) return trueLength > 0 ? Math.max(0, Math.min(1, mm / trueLength)) : 0.5;
  const { at, drawn } = stations;
  if (mm <= at[0]) return 0;
  for (let i = 1; i < at.length; i += 1) {
    if (mm > at[i] && i < at.length - 1) continue;
    const span = at[i] - at[i - 1];
    const t = span > 1e-9 ? Math.max(0, Math.min(1, (mm - at[i - 1]) / span)) : 1;
    return Math.max(0, Math.min(1, (drawn[i - 1] + (drawn[i] - drawn[i - 1]) * t) / stations.length));
  }
  return 1;
}

/** The true distance along a run drawn at a share of its drawn length: `drawnShare` backwards. */
export function trueAtShare(stations: DrawnStations | undefined, share: number, trueLength: number): number {
  if (!stations || stations.length <= 0) return share * trueLength;
  const { at, drawn } = stations;
  const d = share * stations.length;
  for (let i = 1; i < drawn.length; i += 1) {
    if (d > drawn[i] && i < drawn.length - 1) continue;
    const span = drawn[i] - drawn[i - 1];
    const t = span > 1e-9 ? Math.max(0, Math.min(1, (d - drawn[i - 1]) / span)) : 0;
    return at[i - 1] + (at[i] - at[i - 1]) * t;
  }
  return trueLength;
}

function layout(drawing: Drawing, nodeById: Map<string, IsoNode>, adjacency: Map<string, Run[]>): Map<string, Vec3> {
  const display = new Map<string, Vec3>();

  // True layout is simply the plant coordinates.
  if (!drawing.options.schematic) {
    for (const node of drawing.nodes) display.set(node.id, { ...node.pos });
    return display;
  }

  // Schematic layout walks the graph and draws every run at the same visual
  // length, the way a fabrication isometric is normally presented. Closed loops
  // cannot stay closed under that distortion, so the first path to reach a node
  // wins and the loop is left to close visually as best it can.
  const remaining = new Set(drawing.nodes.map((n) => n.id));
  // The points of lines drawn on from an equipment box's far side: laid out
  // after the line the box stands on, from the box.
  const beyondBoxes = new Set<string>();
  for (const box of drawing.equipment ?? []) {
    if (!box.next || !nodeById.has(box.next)) continue;
    const queue = [box.next];
    beyondBoxes.add(box.next);
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const run of adjacency.get(id) ?? []) {
        const other = run.from === id ? run.to : run.from;
        if (!beyondBoxes.has(other)) {
          beyondBoxes.add(other);
          queue.push(other);
        }
      }
    }
  }
  while (remaining.size > 0) {
    // Each piece starts from where it really is, so two pieces keep apart —
    // except a line drawn on from the far side of an equipment box, which
    // starts from the box's far face as drawn, the box standing on its
    // point where that point is drawn.
    const beyond = (drawing.equipment ?? []).find((box) => box.next && remaining.has(box.next) && box.stand && display.has(box.stand));
    const startId = beyond?.next ?? [...remaining].find((id) => !beyondBoxes.has(id)) ?? [...remaining][0];
    display.set(
      startId,
      beyond
        ? add(add(display.get(beyond.stand!)!, sub(beyond.at, nodeById.get(beyond.stand!)!.pos)), scale3(AXIS_VECTOR[beyond.axis], beyond.length))
        : { ...nodeById.get(startId)!.pos },
    );
    remaining.delete(startId);

    const queue = [startId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const here = display.get(id)!;
      const hereTrue = nodeById.get(id)!.pos;
      for (const run of adjacency.get(id) ?? []) {
        const otherId = run.from === id ? run.to : run.from;
        if (display.has(otherId)) continue;
        const otherTrue = nodeById.get(otherId)!.pos;
        const delta = sub(otherTrue, hereTrue);
        const trueLen = length3(delta);
        if (trueLen < 0.01) continue;
        const visual = drawnLength(drawing, run, trueLen);
        display.set(otherId, add(here, scale3(delta, visual / trueLen)));
        remaining.delete(otherId);
        queue.push(otherId);
      }
    }
  }
  return display;
}

/**
 * How much length a run loses at one of its ends. Everywhere but an olet this
 * is just the fitting's take-out; at an olet the header runs lose nothing,
 * because the olet sits on the header rather than in it, and the branch pays
 * for the whole thing.
 */
function endTakeout(info: NodeInfo | undefined, run: Run): number {
  if (!info) return 0;
  // A flanged joint: the pipe stops at the flange face, and the flange itself
  // is what fills the length from there to the weld.
  if (info.node.flange) return componentTakeout(info.node.flange, run.dn);
  if (info.fitting !== 'OLET') return fittingTakeout(info.fitting, run.dn);
  const legs = oletLegs(info);
  if (!legs) return 0;
  if (!legs.branches.some((b) => b.run.id === run.id)) return 0;
  return oletTakeout(legs.header[0]?.dn ?? run.dn, run.dn);
}

/**
 * A header that runs straight on through one or more olets. The olets only
 * sit on it, so it is one length of pipe, dimensioned end to end as one,
 * with each olet placed by its own dimension from the start.
 */
export interface HeaderChain {
  /** The first run's id: what its dimensions are keyed by. */
  id: string;
  from: string;
  to: string;
  /** In order from `from` to `to`; `forward` when the run itself points that way. */
  runs: { run: Run; forward: boolean; start: number; length: number }[];
  total: number;
  /** The olet points along it, with their distance from `from`. */
  olets: { nodeId: string; along: number }[];
}

/**
 * The runs that make one pipe with this one: a header carried straight on
 * through its olets is one pipe to pick, size, measure and delete (his
 * complaint, 2026-09-23: "an olet still cuts the pipe in the middle").
 * Any other run is a pipe of its own.
 */
export function runGroupIds(analysis: Analysis, runId: string): string[] {
  const chain = analysis.chainOfRun.get(runId);
  return chain && chain.runs.length > 1 ? chain.runs.map((leg) => leg.run.id) : [runId];
}

function headerChains(drawing: Drawing, nodeInfo: Map<string, NodeInfo>): HeaderChain[] {
  const runLen = (run: Run) => {
    const a = drawing.nodes.find((n) => n.id === run.from);
    const b = drawing.nodes.find((n) => n.id === run.to);
    return a && b ? length3(sub(b.pos, a.pos)) : 0;
  };
  /** The header run carrying on through the olet at `nodeId` from `run`, if it is one. */
  const through = (nodeId: string, run: Run): Run | null => {
    const info = nodeInfo.get(nodeId);
    if (!info || info.fitting !== 'OLET') return null;
    const legs = oletLegs(info);
    if (!legs || legs.header.length !== 2 || !legs.header.some((r) => r.id === run.id)) return null;
    return legs.header.find((r) => r.id !== run.id) ?? null;
  };
  const seen = new Set<string>();
  const chains: HeaderChain[] = [];
  for (const run of drawing.runs) {
    if (seen.has(run.id)) continue;
    // Walk back to the start of the header, then forward along it.
    let first = run;
    let node = run.from;
    const back = new Set<string>([run.id]);
    for (;;) {
      const prev = through(node, first);
      if (!prev || back.has(prev.id)) break;
      back.add(prev.id);
      node = prev.from === node ? prev.to : prev.from;
      first = prev;
    }
    const legs: HeaderChain['runs'] = [];
    const olets: HeaderChain['olets'] = [];
    let at = node;
    let cur: Run | null = first;
    let along = 0;
    while (cur && !legs.some((l) => l.run.id === cur!.id)) {
      const forward = cur.from === at;
      const length = runLen(cur);
      legs.push({ run: cur, forward, start: along, length });
      along += length;
      at = forward ? cur.to : cur.from;
      const next: Run | null = through(at, cur);
      if (next) olets.push({ nodeId: at, along });
      cur = next;
    }
    for (const leg of legs) seen.add(leg.run.id);
    if (legs.length < 2) continue;
    chains.push({ id: legs[0].run.id, from: node, to: at, runs: legs, total: along, olets });
  }
  return chains;
}

/** A point along a run, as a distance along its chain. */
function chainCoord(leg: HeaderChain['runs'][number], offset: number): number {
  return leg.forward ? leg.start + offset : leg.start + leg.length - offset;
}

/**
 * Where a header chain's dimension breaks, in mm from its start: at each
 * valve face along it and at each olet's centre (his ask, 2026-09-24:
 * "each piece measured to the centre of the olet"); the whole length is
 * dimensioned on its own further out.
 */
export function chainStops(drawing: Drawing, chain: HeaderChain): number[] {
  const breaks: number[] = chain.olets.map((o) => o.along);
  for (const leg of chain.runs) {
    const stops = dimensionStops(drawing, leg.run);
    for (const mm of stops.slice(1, -1)) breaks.push(chainCoord(leg, mm));
  }
  const inside = breaks.filter((mm) => mm > 0.5 && mm < chain.total - 0.5).sort((x, y) => x - y);
  return [0, ...inside, chain.total];
}

export function analyse(drawing: Drawing): Analysis {
  const nodeById = new Map(drawing.nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, Run[]>();
  const warnings: string[] = [];

  for (const node of drawing.nodes) adjacency.set(node.id, []);
  for (const run of drawing.runs) {
    adjacency.get(run.from)?.push(run);
    adjacency.get(run.to)?.push(run);
  }

  // Connectivity and fittings.
  const nodeInfo = new Map<string, NodeInfo>();
  for (const node of drawing.nodes) {
    const runs = adjacency.get(node.id) ?? [];
    const legs: Vec3[] = [];
    for (const run of runs) {
      const otherId = run.from === node.id ? run.to : run.from;
      const other = nodeById.get(otherId);
      const dir = other ? direction(node.pos, other.pos) : null;
      if (dir) legs.push(dir);
    }
    const fitting = inferFitting(legs, runs, node.fittingOverride, oletMarks(node).length > 0);
    nodeInfo.set(node.id, { node, runs, legs, fitting, degree: runs.length });
    if (runs.length > 4) warnings.push(`Node ${node.label ?? node.id} has ${runs.length} connections.`);
  }

  // A line drawn from a threaded or socket-weld olet is a small-bore line of
  // that kind: its elbows, tees and joints take the olet's joint unless they
  // are set on their own (his complaint, 2026-09-24: the elbow on a line off
  // a threadolet came out butt welded). The olet's branch is followed out to
  // another olet, a flange or a point with its own joint.
  const defaultPointJoint = drawing.options.joint ?? 'BW';
  const inheritedJoint = new Map<string, { joint: JointType; from: string }>();
  for (const info of nodeInfo.values()) {
    const olet = info.node;
    if (olet.fittingOverride !== 'OLET') continue;
    const joint = olet.joint ?? defaultPointJoint;
    if (joint === defaultPointJoint) continue;
    const legs = oletLegs(info);
    if (!legs) continue;
    const seen = new Set([olet.id]);
    const queue = legs.branches.map((b) => ({ run: b.run, from: olet.id }));
    while (queue.length > 0) {
      const { run, from } = queue.shift()!;
      const nextId = run.from === from ? run.to : run.from;
      if (seen.has(nextId)) continue;
      seen.add(nextId);
      const next = nodeById.get(nextId);
      if (!next || next.joint || next.fittingOverride === 'OLET' || next.flange) continue;
      if (!inheritedJoint.has(nextId)) inheritedJoint.set(nextId, { joint, from: olet.id });
      for (const onward of nodeInfo.get(nextId)?.runs ?? []) if (onward.id !== run.id) queue.push({ run: onward, from: nextId });
    }
  }
  /** The joint a point is made with: its own, its line's, or the drawing's. */
  const pointJoint = (node: IsoNode): JointType => node.joint ?? inheritedJoint.get(node.id)?.joint ?? defaultPointJoint;
  const nodeJoint = new Map<string, JointType>(drawing.nodes.map((n) => [n.id, pointJoint(n)]));

  // Run lengths and cut lengths.
  const runLengths = new Map<string, RunLengths>();
  /** Runs whose two fittings meet with no pipe between. */
  const touching = new Set<string>();
  for (const run of drawing.runs) {
    const a = nodeById.get(run.from);
    const b = nodeById.get(run.to);
    if (!a || !b) continue;
    const centre = length3(sub(b.pos, a.pos));
    const fromInfo = nodeInfo.get(run.from);
    const toInfo = nodeInfo.get(run.to);
    let cut = centre - endTakeout(fromInfo, run) - endTakeout(toInfo, run);
    // Fittings joined to each other directly: there is no pipe to cut.
    if (run.direct) cut = -1;
    cut -= terminalTakeout(a, endDn(drawing, run, true)) + terminalTakeout(b, endDn(drawing, run, false));
    for (const comp of run.inline) {
      const dn = comp.dn ?? run.dn;
      const ends = resolveEnds(comp.kind, dn, comp.ends, drawing.options.joint ?? 'BW');
      const half = componentTakeout(comp.kind, dn, ends === 'FLG' && valveFlangeKind(drawing.options.joint ?? 'BW'), comp.ff);
      // A valve on the open end may reach past it (its last flange taken
      // off, the end brought in to its face): only what lies on the run counts.
      const open = valveOpenSide(drawing, run, comp) !== null;
      // A side bolted straight to the next valve has no flange on it.
      const flangeLen = half - componentTakeout(comp.kind, dn, false, comp.ff);
      const lo = comp.offset - half + (comp.bare === 0 ? flangeLen : 0);
      const hi = comp.offset + half - (comp.bare === 1 ? flangeLen : 0);
      cut -= open ? Math.min(hi, centre) - Math.max(lo, 0) : hi - lo;
    }
    runLengths.set(run.id, { run, centre, cut: Math.max(0, cut) });
    // Nothing left to cut between two fittings: they meet, and there is one
    // weld between them — whether the run was marked so or is simply that
    // short. Two welds on one spot, one to be struck off by hand, is no use.
    const ends = endTakeout(fromInfo, run) + endTakeout(toInfo, run) + terminalTakeout(a, endDn(drawing, run, true)) + terminalTakeout(b, endDn(drawing, run, false));
    if (run.direct || (run.inline.length === 0 && cut <= 0.5 && ends > 0.5)) touching.add(run.id);
    if (cut < 0) {
      warnings.push(`Run ${sizeLabel(run.dn)} of ${Math.round(centre)} mm is shorter than its fittings require.`);
    }
  }

  // Joint marks. Keys are stable so that shop/field choices survive edits.
  const jointMap = new Map<string, Weld & { sortRun: number; sortDist: number }>();
  const runIndex = new Map(drawing.runs.map((r, i) => [r.id, i]));
  const defaultJoint = drawing.options.joint ?? 'BW';

  const pushJoint = (
    key: string,
    joint: JointType,
    dn: string,
    schedule: string,
    joins: string,
    pos: Vec3,
    facing: 1 | -1,
    sortRun: number,
    sortDist: number,
    on?: { anchor: Vec3; reach: WeldReach },
  ) => {
    if (jointMap.has(key)) return;
    jointMap.set(key, {
      key,
      number: '',
      joint,
      dn,
      schedule,
      joins,
      pos,
      facing,
      sortRun,
      sortDist,
      anchor: on?.anchor,
      reach: on?.reach,
    });
  };

  /** Whether an item along a run touching this point has a face right on it. */
  const faceOnNode = (nodeId: string): boolean =>
    drawing.runs.some((run) => (run.from === nodeId && !!itemAtEnd(drawing, run, true)) || (run.to === nodeId && !!itemAtEnd(drawing, run, false)));

  for (const run of drawing.runs) {
    const a = nodeById.get(run.from);
    const b = nodeById.get(run.to);
    if (!a || !b) continue;
    const dir = direction(a.pos, b.pos);
    if (!dir) continue;
    const idx = runIndex.get(run.id) ?? 0;
    const total = length3(sub(b.pos, a.pos));

    // Fittings joined directly: the one weld is where they meet, between the
    // two, and neither fitting has a pipe weld of its own on this run.
    if (touching.has(run.id)) {
      const name = (node: IsoNode) => {
        const info = nodeInfo.get(node.id);
        if (info && info.fitting !== 'NONE') return fittingLabel(info.fitting);
        if (node.flange) return COMPONENT_LABEL[node.flange] ?? node.flange;
        const terminal = node.terminal?.kind;
        if (terminal && terminal !== 'OPEN' && terminal !== 'CONTINUATION' && terminal !== 'EQUIPMENT') return TERMINAL_LABEL[terminal] ?? terminal;
        // A plain point with an item's face on it, from the run beyond.
        for (const other of drawing.runs) {
          if (other.id === run.id) continue;
          const on = other.from === node.id ? itemAtEnd(drawing, other, true) : other.to === node.id ? itemAtEnd(drawing, other, false) : null;
          if (on) return inlineLabel(on.comp, other.dn);
        }
        return 'PIPE';
      };
      // The weld is where the two meet: the first one's take-out along the
      // run, or half way when that does not fall inside it.
      const meet = endTakeout(nodeInfo.get(run.from), run) + terminalTakeout(a, endDn(drawing, run, true));
      const at = meet > 0.5 && meet < total - 0.5 ? meet : total / 2;
      pushJoint(
        `d:${run.id}`,
        pointJoint(a),
        run.dn,
        run.schedule,
        `${name(a)} / ${name(b)}`,
        add(a.pos, scale3(dir, at)),
        1,
        idx,
        at,
      );
      continue;
    }

    for (const [node, atStart] of [
      [a, true],
      [b, false],
    ] as const) {
      const info = nodeInfo.get(node.id);
      if (!info) continue;
      // An olet's joint type belongs to its branch. Until the branch is drawn
      // there is no olet, so the header closes up with the drawing's own joint
      // rather than wearing a mark for a fitting that is not there.
      const nodeJoint =
        node.fittingOverride === 'OLET' && info.fitting !== 'OLET'
          ? defaultJoint
          : pointJoint(node);
      const takeout = fittingTakeout(info.fitting, run.dn);
      const distance = atStart ? takeout : total - takeout;
      const pos = add(a.pos, scale3(dir, distance));
      // A mark faces the thing it joins the pipe to.
      const facing: 1 | -1 = atStart ? -1 : 1;

      if (info.degree === 1) {
        const terminal = node.terminal?.kind ?? 'OPEN';
        const joint = terminalJoint(terminal, nodeJoint);
        if (joint) {
          // The point is the flange face; the weld is a flange length back
          // along the pipe, where the neck meets it. An item sitting right
          // against the flange is welded to it there, with no pipe between:
          // one weld, named for the two, the size of the item's end.
          const meets = itemAtEnd(drawing, run, atStart);
          const dnAt = meets?.dn ?? run.dn;
          const back = isFlange(terminal) || terminal === 'TRANSITION' ? componentTakeout(terminal, dnAt) : 0;
          const at = atStart ? back : total - back;
          pushJoint(
            `n:${node.id}:term`,
            joint,
            dnAt,
            run.schedule,
            `${meets ? inlineLabel(meets.comp, run.dn) : 'PIPE'} / ${TERMINAL_LABEL[terminal] ?? terminal}`,
            add(a.pos, scale3(dir, at)),
            facing,
            idx,
            at,
            isFlange(terminal)
              ? { anchor: node.pos, reach: { kind: 'flange', flange: terminal === 'FLG_BLIND' ? 'FLG_WN' : terminal, paired: false } }
              : terminal === 'TRANSITION'
                ? { anchor: node.pos, reach: { kind: 'transition' } }
                : undefined,
          );
        }
      } else if (info.fitting === 'OLET') {
        const legs = oletLegs(info);
        if (legs) {
          const branchIndex = legs.branches.findIndex((b) => b.run.id === run.id);
          if (branchIndex >= 0) {
            // The branch joint: this is what makes it a weldolet, sockolet or
            // threadolet, so it follows the node's joint type. A second olet
            // on the point keys its welds by the way its branch leaves.
            const distance2 = atStart
              ? oletTakeout(legs.header[0]?.dn ?? run.dn, run.dn)
              : total - oletTakeout(legs.header[0]?.dn ?? run.dn, run.dn);
            pushJoint(
              branchIndex === 0 ? `n:${node.id}:branch` : `n:${node.id}:branch:${legs.branches[branchIndex].dir}`,
              nodeJoint,
              run.dn,
              run.schedule,
              `BRANCH / ${oletLabel(nodeJoint)}`,
              add(a.pos, scale3(dir, distance2)),
              facing,
              idx,
              distance2,
              { anchor: node.pos, reach: { kind: 'olet' } },
            );
          } else {
            // Each olet is welded to the header wall whatever its branch is.
            oletEntries(legs).forEach((entry, k) => {
              pushJoint(
                k === 0 ? `n:${node.id}:header` : `n:${node.id}:header:${entry.dir}`,
                'BW',
                legs.header[0]?.dn ?? run.dn,
                run.schedule,
                `HEADER / ${oletLabel(nodeJoint)}`,
                node.pos,
                facing,
                idx,
                distance,
              );
            });
          }
        }
      } else if (info.fitting === 'NONE' && node.flange) {
        // Bolted flange to flange: each side has its own flange, welded to
        // its own pipe a flange length back from the joint.
        const joint = flangeJoint(node.flange);
        if (joint) {
          const back = componentTakeout(node.flange, run.dn);
          const at = atStart ? back : total - back;
          pushJoint(
            `n:${node.id}:flg:${run.id}`,
            joint,
            run.dn,
            run.schedule,
            `PIPE / ${COMPONENT_LABEL[node.flange] ?? node.flange}`,
            add(a.pos, scale3(dir, at)),
            facing,
            idx,
            at,
            { anchor: node.pos, reach: { kind: 'flange', flange: node.flange, paired: true } },
          );
        }
      } else if (info.fitting === 'NONE') {
        // An item whose face sits right on the point — a reducer at the end
        // of its run, say — is what the pipe beyond is welded to, so the
        // point itself is no joint.
        if (!faceOnNode(node.id)) {
          pushJoint(
            `n:${node.id}`,
            nodeJoint,
            run.dn,
            run.schedule,
            'PIPE / PIPE',
            node.pos,
            facing,
            idx,
            distance,
          );
        }
      } else {
        pushJoint(
          `n:${node.id}:${run.id}`,
          nodeJoint,
          run.dn,
          run.schedule,
          `PIPE / ${fittingLabel(info.fitting)}`,
          pos,
          facing,
          idx,
          distance,
          { anchor: node.pos, reach: { kind: 'fitting' } },
        );
      }
    }

    for (const comp of run.inline) {
      const dn = comp.dn ?? run.dn;
      const joint = componentJoint(comp, defaultJoint, dn);
      if (!joint) continue;
      const ends = resolveEnds(comp.kind, dn, comp.ends, defaultJoint);
      const takeout = componentTakeout(comp.kind, dn, ends === 'FLG' && valveFlangeKind(defaultJoint), comp.ff);
      const faceHalf = componentTakeout(comp.kind, dn, false, comp.ff);
      const centre = add(a.pos, scale3(dir, comp.offset));
      const reach: WeldReach = { kind: 'valve', trueHalf: faceHalf, flange: ends === 'FLG' && !isFlange(comp.kind) ? valveFlangeKind(defaultJoint) : undefined, comp: comp.id };
      // Against the line's end piece, the weld to it is that piece's own.
      const onTerminal = (atStart: boolean): boolean => {
        const end = atStart ? a : b;
        const kind = end.terminal?.kind;
        if (!kind || !terminalJoint(kind, pointJoint(end))) return false;
        return itemAtEnd(drawing, run, atStart)?.comp.id === comp.id;
      };
      // A flanged item is bolted to its flanges; what the pipe is welded to
      // is the flange, and that is what the weld list should say.
      const joinedTo =
        ends === 'FLG' && !isFlange(comp.kind)
          ? COMPONENT_LABEL[valveFlangeKind(defaultJoint)] ?? 'FLANGE'
          : isReducer(comp.kind)
            ? reducerName(comp, run.dn)
            : COMPONENT_LABEL[comp.kind] ?? comp.kind;
      for (const side of [0, 1] as const) {
        // A transition joint is welded on its steel side only; the plastic
        // side is fused, which is no weld of ours.
        if (comp.kind === 'TRANSITION' && side === (comp.flip ? 1 : 0)) continue;
        if (onTerminal(side === 0)) continue;
        // No flange on the valve's last face (or a blind there): nothing welded.
        if (comp.lastFlange && valveOpenSide(drawing, run, comp) === side) continue;
        // Bolted straight to the valve beside it: no flange, no weld.
        if (comp.bare === side) continue;
        const distance = side === 0 ? comp.offset - takeout : comp.offset + takeout;
        // A reducer's two welds are each the size of their own end.
        const sideDn = isReducer(comp.kind) ? (side === 0 ? reducerSides(comp, run.dn).start : reducerSides(comp, run.dn).end) : dn;
        pushJoint(
          `c:${comp.id}:${side}`,
          joint,
          sideDn,
          run.schedule,
          `PIPE / ${joinedTo}`,
          add(a.pos, scale3(dir, distance)),
          side === 0 ? 1 : -1,
          idx,
          distance,
          { anchor: centre, reach },
        );
      }
    }
  }

  const ordered = [...jointMap.values()].sort(
    (x, y) => x.sortRun - y.sortRun || x.sortDist - y.sortDist,
  );

  // Threaded joints are marked on the drawing but are not welds, so the weld
  // numbers run over the welded joints only.
  let weldNumber = 0;
  const joints: Weld[] = ordered.map((j) => {
    const override = drawing.weldOverrides[j.key];
    // A joint marked as not welded after all keeps its mark, and the numbers
    // run on past it.
    const skipped = !!override?.skip;
    const welded = j.joint !== 'THD' && !skipped;
    if (welded) weldNumber += 1;
    const number = welded ? override?.number ?? `W${weldNumber}` : '';
    return {
      key: j.key,
      number,
      joint: j.joint,
      dn: j.dn,
      schedule: j.schedule,
      joins: j.joins,
      pos: j.pos,
      facing: j.facing,
      skipped: skipped || undefined,
      anchor: j.anchor,
      reach: j.reach,
    };
  });
  const welds = joints.filter((j) => j.joint !== 'THD' && !j.skipped);

  // The pipe as it is cut: the lengths between the welds. Each run's pipe
  // starts past the fitting at one end and stops short of the one at the
  // other, and whatever sits in the line takes its own length out of the
  // middle. A butt weld to a fitting keeps a root gap, and so does a pipe
  // to pipe weld, off one of the two; the olet sitting on a header takes
  // none, and a header carries straight on through its olet as one length.
  const jointByKey = new Map(joints.map((j) => [j.key, j]));
  const jointAt = (idx: number, distance: number, nodeId: string | null, at: Vec3): Weld | undefined => {
    for (let i = 0; i < ordered.length; i += 1) {
      const o = ordered[i];
      if (o.sortRun === idx && Math.abs(o.sortDist - distance) < 0.5) return joints[i];
    }
    const onNode = nodeId ? jointByKey.get(`n:${nodeId}`) : undefined;
    // The far weld of an item on the run before — a reducer's small end —
    // sits on this piece's end though it belongs to that run.
    return onNode ?? joints.find((j) => equals3(j.pos, at, 0.5));
  };
  const endFor = (weld: Weld | undefined): PieceEnd => {
    if (!weld) return { gap: 0 };
    const fitting = weld.joint === 'BW' && !weld.skipped && weld.joins !== 'PIPE / PIPE' && !weld.joins.startsWith('HEADER');
    return { key: weld.key, gap: fitting ? ROOT_GAP : 0 };
  };
  const pieces: PipePiece[] = [];
  /** Header pieces ending on each olet, with the end that is not on it. */
  const atOlet = new Map<string, { piece: PipePiece; far: PieceEnd }[]>();
  for (const run of drawing.runs) {
    const a = nodeById.get(run.from);
    const b = nodeById.get(run.to);
    if (!a || !b || touching.has(run.id) || run.dashed) continue;
    const idx = runIndex.get(run.id) ?? 0;
    const total = length3(sub(b.pos, a.pos));
    const terminalBack = (node: IsoNode) => terminalTakeout(node, endDn(drawing, run, node.id === run.from));
    const fromInfo = nodeInfo.get(run.from);
    const toInfo = nodeInfo.get(run.to);
    const start = endTakeout(fromInfo, run) + terminalBack(a);
    const finish = total - endTakeout(toInfo, run) - terminalBack(b);
    const taken: [number, number][] = [];
    for (const comp of run.inline) {
      const dn = comp.dn ?? run.dn;
      const ends = resolveEnds(comp.kind, dn, comp.ends, defaultJoint);
      const half = componentTakeout(comp.kind, dn, ends === 'FLG' && valveFlangeKind(defaultJoint), comp.ff);
      if (half > 0) taken.push([comp.offset - half, comp.offset + half]);
    }
    taken.sort((x, y) => x[0] - y[0]);
    let cursor = start;
    const spans: [number, number][] = [];
    for (const [lo, hi] of taken) {
      if (lo > cursor + 0.5) spans.push([cursor, Math.min(lo, finish)]);
      cursor = Math.max(cursor, hi);
    }
    if (finish > cursor + 0.5) spans.push([cursor, finish]);
    const headerOf = (info: NodeInfo | undefined) => {
      if (info?.fitting !== 'OLET') return false;
      const legs = oletLegs(info);
      return !!legs && !legs.branches.some((b) => b.run.id === run.id);
    };
    const dir = direction(a.pos, b.pos) ?? { e: 0, n: 0, u: 0 };
    spans.forEach(([lo, hi], n) => {
      if (hi - lo < 0.5) return;
      const first = endFor(jointAt(idx, lo, lo < 0.5 ? run.from : null, add(a.pos, scale3(dir, lo))));
      const last = endFor(jointAt(idx, hi, hi > total - 0.5 ? run.to : null, add(a.pos, scale3(dir, hi))));
      // The letter hangs off the piece a third of the way along, clear of
      // the dimension figure and the balloon leader at its middle.
      const piece: PipePiece = {
        letter: '',
        key: `piece:${run.id}:${n}`,
        pos: add(a.pos, scale3(dir, lo + (hi - lo) * 0.33)),
        runIds: [run.id],
        dn: run.dn,
        schedule: run.schedule,
        length: hi - lo,
        net: 0,
        ends: [first, last],
      };
      pieces.push(piece);
      if (lo < 0.5 && headerOf(fromInfo)) atOlet.set(run.from, [...(atOlet.get(run.from) ?? []), { piece, far: last }]);
      if (hi > total - 0.5 && headerOf(toInfo)) atOlet.set(run.to, [...(atOlet.get(run.to) ?? []), { piece, far: first }]);
    });
  }
  // A header carries straight on through its olet: its two pieces are one.
  for (const two of atOlet.values()) {
    if (two.length !== 2 || two[0].piece === two[1].piece) continue;
    const [p, q] = two;
    const merged: PipePiece = {
      letter: '',
      key: p.piece.key,
      pos: p.piece.pos,
      runIds: [...p.piece.runIds, ...q.piece.runIds],
      dn: p.piece.dn,
      schedule: p.piece.schedule,
      length: p.piece.length + q.piece.length,
      net: 0,
      ends: [p.far, q.far],
    };
    pieces.splice(pieces.indexOf(p.piece), 1, merged);
    pieces.splice(pieces.indexOf(q.piece), 1);
    // A header through more than one olet: the pieces waiting at the next
    // olet now stand for the joined length, with its far end as their far
    // end. The two just joined are noted first, since the entries here are
    // among those rewritten (a later olet once merged a piece twice).
    const first = p.piece;
    const second = q.piece;
    for (const list of atOlet.values()) {
      for (const entry of list) {
        if (entry.piece !== first && entry.piece !== second) continue;
        const here = entry.piece.ends[0] === entry.far ? entry.piece.ends[1] : entry.piece.ends[0];
        entry.far = merged.ends[0] === here ? merged.ends[1] : merged.ends[0];
        entry.piece = merged;
      }
    }
  }
  // Pipe to pipe: the root gap comes off one of the two, whichever; the
  // first in route order takes it.
  for (const joint of joints) {
    if (joint.joins !== 'PIPE / PIPE' || joint.joint !== 'BW' || joint.skipped) continue;
    const at = pieces.flatMap((p) => p.ends.filter((e) => e.key === joint.key));
    if (at.length > 0) at[0].gap = ROOT_GAP;
  }
  pieces.forEach((piece, i) => {
    piece.net = Math.max(0, piece.length - piece.ends[0].gap - piece.ends[1].gap);
    piece.letter = pieceLetter(i);
  });

  // Material list, and the item number each thing on the drawing carries.
  //
  // A fabrication isometric identifies what it is made of by ballooning every
  // pipe run, fitting, flange and valve with the number of its line in the
  // list. That is what the fitter reads, so the numbering is built here
  // alongside the list rather than bolted on in the renderer.
  const bom: BomLine[] = [];
  const instances: { key: string; bomKey: string; pos: Vec3 }[] = [];
  const fittingThickness = drawing.options.fittingThickness ?? 'STD';

  const pipeKey = (dn: string, schedule: string) => `PIPE|${dn}|${schedule}`;
  const pipeTotals = new Map<string, number>();
  for (const { run, cut } of runLengths.values()) {
    // Pipe drawn dashed is carried on to the next sheet: listed and cut there.
    if (run.dashed) continue;
    const key = `${run.dn}|${run.schedule}`;
    pipeTotals.set(key, (pipeTotals.get(key) ?? 0) + cut);
    const a = nodeById.get(run.from);
    const b = nodeById.get(run.to);
    // No pipe between fittings joined directly, so nothing to balloon.
    if (a && b && !touching.has(run.id)) {
      instances.push({
        key: `run:${run.id}`,
        bomKey: pipeKey(run.dn, run.schedule),
        pos: {
          e: (a.pos.e + b.pos.e) / 2,
          n: (a.pos.n + b.pos.n) / 2,
          u: (a.pos.u + b.pos.u) / 2,
        },
      });
    }
  }
  for (const [key, mm] of pipeTotals) {
    // A size with no pipe cut in it (a run that is all reducer) has no line.
    if (mm <= 0.5) continue;
    const [dn, schedule] = key.split('|');
    const metres = mm / 1000;
    bom.push({
      key: pipeKey(dn, schedule),
      category: 'PIPE',
      description: `PIPE, SMLS, ${sizeLabel(dn)} x ${schedule}`,
      dn,
      schedule,
      quantity: metres,
      unit: 'm',
    });
  }

  const counts = new Map<string, { line: Omit<BomLine, 'quantity'>; quantity: number }>();
  /** Adds one to a material list line and returns the key it was counted under. */
  const tally = (line: Omit<BomLine, 'quantity' | 'key'>): string => {
    const key = `${line.category}|${line.description}|${line.dn}|${line.schedule}`;
    const existing = counts.get(key);
    if (existing) existing.quantity += 1;
    else counts.set(key, { line: { ...line, key }, quantity: 1 });
    return key;
  };

  for (const info of nodeInfo.values()) {
    if (info.fitting === 'OLET') {
      const legs = oletLegs(info);
      const joint = info.node.joint ?? drawing.options.joint ?? 'BW';
      if (legs) {
        oletEntries(legs).forEach((entry, k) => {
          instances.push({
            key: k === 0 ? `node:${info.node.id}` : `node:${info.node.id}:${entry.dir}`,
            bomKey: tally({
              category: 'FITTING',
              description: `${oletLabel(joint)} ${sizeLabel(legs.header[0].dn)} x ${sizeLabel(entry.dn)}`,
              dn: legs.header[0].dn,
              schedule: fittingThickness,
              unit: 'off',
            }),
            pos: info.node.pos,
          });
        });
      }
      continue;
    }
    if (info.fitting !== 'NONE' && info.degree > 1) {
      const dn = info.runs[0]?.dn ?? 'DN80';
      const branch = info.runs.find((r) => r.dn !== dn);
      instances.push({
        key: `node:${info.node.id}`,
        bomKey: tally({
          category: 'FITTING',
          description:
            (info.fitting === 'TEE_REDUCING' && branch
              ? `${fittingLabel(info.fitting)} ${sizeLabel(dn)} x ${sizeLabel(branch.dn)}`
              : fittingLabel(info.fitting)) + jointSuffix(pointJoint(info.node)),
          dn,
          schedule: fittingThickness,
          unit: 'off',
        }),
        pos: info.node.pos,
      });
    }
    if (info.fitting === 'NONE' && info.node.flange && info.degree === 2) {
      // One flange on each run, ballooned on its own side of the joint.
      for (const run of info.runs) {
        const other = nodeById.get(run.from === info.node.id ? run.to : run.from);
        const dir = other ? direction(info.node.pos, other.pos) : null;
        const back = componentTakeout(info.node.flange, run.dn) * 0.5;
        instances.push({
          key: `flg:${info.node.id}:${run.id}`,
          bomKey: tally({
            category: 'FLANGE',
            description: COMPONENT_LABEL[info.node.flange],
            dn: run.dn,
            schedule: fittingThickness,
            unit: 'off',
          }),
          pos: dir ? add(info.node.pos, scale3(dir, back)) : info.node.pos,
        });
      }
    }
    if (info.degree === 1 && info.node.terminal && info.node.terminal.kind !== 'OPEN') {
      const kind = info.node.terminal.kind;
      const endRun = info.runs[0];
      const dn = endRun ? endDn(drawing, endRun, endRun.from === info.node.id) : 'DN80';
      if (kind !== 'CONTINUATION' && kind !== 'EQUIPMENT') {
        instances.push({
          key: `term:${info.node.id}`,
          bomKey: tally({
            category: kind === 'CAP' || kind === 'TRANSITION' ? 'FITTING' : 'FLANGE',
            // A blind closes the line by bolting to a flange on the pipe, so
            // the pipe end wears a weld neck and the blind is counted as well.
            description: kind === 'FLG_BLIND' ? TERMINAL_LABEL.FLG_WN : TERMINAL_LABEL[kind],
            dn,
            schedule: fittingThickness,
            unit: 'off',
          }),
          pos: info.node.pos,
        });
        if (kind === 'FLG_BLIND') {
          const run = info.runs[0];
          const other = run ? nodeById.get(run.from === info.node.id ? run.to : run.from) : undefined;
          const out = other ? direction(other.pos, info.node.pos) : null;
          instances.push({
            key: `blind:${info.node.id}`,
            bomKey: tally({ category: 'FLANGE', description: TERMINAL_LABEL.FLG_BLIND, dn, schedule: fittingThickness, unit: 'off' }),
            pos: out ? add(info.node.pos, scale3(out, componentTakeout('FLG_WN', dn) * 0.6)) : info.node.pos,
          });
        }
      }
    }
  }

  for (const run of drawing.runs) {
    const a = nodeById.get(run.from);
    const b = nodeById.get(run.to);
    const dir = a && b ? direction(a.pos, b.pos) : null;
    for (const comp of run.inline) {
      // A support or a ground mark is a note on the drawing, not material on
      // the list: the sheets call a support out by name beside it.
      if (isMark(comp.kind)) continue;
      const dn = comp.dn ?? run.dn;
      // A valve socket welded or screwed into the line is ordered as such,
      // named the way fittings of that kind are: "BALL VALVE SW 3000#".
      const valveEnds = isValve(comp.kind) ? resolveEnds(comp.kind, dn, comp.ends, drawing.options.joint ?? 'BW') : null;
      const description = isReducer(comp.kind)
        ? reducerName(comp, run.dn)
        : (COMPONENT_LABEL[comp.kind] ?? comp.kind) + (valveEnds === 'SW' || valveEnds === 'THD' ? jointSuffix(valveEnds) : '');
      const at = a && dir ? add(a.pos, scale3(dir, comp.offset)) : (a?.pos ?? { e: 0, n: 0, u: 0 });
      instances.push({
        key: `comp:${comp.id}`,
        bomKey: tally({ category: categoryOf(comp.kind), description, dn, schedule: fittingThickness, unit: 'off' }),
        pos: at,
      });

      // A flanged component is bolted between a pair of flanges, which have to
      // be ordered, welded on and ballooned just the same.
      const ends = resolveEnds(comp.kind, dn, comp.ends, drawing.options.joint ?? 'BW');
      if (ends === 'FLG' && !isFlange(comp.kind)) {
        const flange = valveFlangeKind(drawing.options.joint ?? 'BW');
        const takeout = componentTakeout(comp.kind, dn, flange, comp.ff);
        const lastSide = comp.lastFlange ? valveOpenSide(drawing, run, comp) : null;
        for (const side of [-1, 1] as const) {
          if (comp.bare !== undefined && side === (comp.bare === 0 ? -1 : 1)) continue;
          if (lastSide !== null && side === (lastSide === 0 ? -1 : 1)) {
            // The last flange taken off, or a blind bolted on in its place.
            if (comp.lastFlange === 'blind') {
              instances.push({
                key: `comp:${comp.id}:blind`,
                bomKey: tally({ category: 'FLANGE', description: TERMINAL_LABEL.FLG_BLIND, dn, schedule: fittingThickness, unit: 'off' }),
                pos: a && dir ? add(a.pos, scale3(dir, comp.offset + side * takeout * 0.75)) : at,
              });
            }
            continue;
          }
          const bomKey = tally({
            category: 'FLANGE',
            description: COMPONENT_LABEL[flange],
            dn,
            schedule: fittingThickness,
            unit: 'off',
          });
          instances.push({
            key: `comp:${comp.id}:flg${side}`,
            bomKey,
            pos: a && dir ? add(a.pos, scale3(dir, comp.offset + side * takeout * 0.75)) : at,
          });
        }
      }
    }
  }

  for (const { line, quantity } of counts.values()) bom.push({ ...line, quantity } as BomLine);

  // The list keeps its own order, by the names it gave the lines, so item
  // numbers stay put when a line is renamed by hand.
  const order: Record<BomLine['category'], number> = { PIPE: 0, FITTING: 1, FLANGE: 2, VALVE: 3, ITEM: 4 };
  bom.sort((x, y) => order[x.category] - order[y.category] || x.description.localeCompare(y.description));
  for (const line of bom) {
    const given = line.key ? drawing.bomNames?.[line.key]?.trim() : undefined;
    if (given) line.description = given;
  }

  // The list is now in its final order, so the item numbers follow from it.
  const numberOf = new Map<string, number>();
  bom.forEach((line, i) => {
    if (line.key) numberOf.set(line.key, i + 1);
  });
  // Every place an item is, in route order. One balloon per line of the
  // list is enough — the fitter reads the rest from the list — and which
  // place carries it is chosen where it is drawn: the one with most room,
  // or the one picked by hand.
  const items: ItemInstance[] = instances
    .map((inst) => ({ key: inst.key, number: numberOf.get(inst.bomKey) ?? 0, pos: inst.pos, line: inst.bomKey }))
    .filter((inst) => inst.number > 0);

  const chains = headerChains(drawing, nodeInfo);
  const chainOfRun = new Map<string, HeaderChain>();
  for (const chain of chains) for (const leg of chain.runs) chainOfRun.set(leg.run.id, chain);

  return {
    nodeJoint,
    inheritedJoint,
    nodeInfo,
    nodeById,
    joints,
    welds,
    runLengths,
    pieces,
    bom,
    items,
    display: layout(drawing, nodeById, adjacency),
    stations: runStations(drawing, nodeById),
    chains,
    chainOfRun,
    warnings,
  };
}

function runStations(drawing: Drawing, nodeById: Map<string, IsoNode>): Map<string, DrawnStations> {
  const out = new Map<string, DrawnStations>();
  if (!drawing.options.schematic) return out;
  for (const run of drawing.runs) {
    const a = nodeById.get(run.from);
    const b = nodeById.get(run.to);
    if (!a || !b) continue;
    const len = length3(sub(b.pos, a.pos));
    if (len < 0.01) continue;
    out.set(run.id, drawnStations(drawing, run, len, drawnLength(drawing, run, len)));
  }
  return out;
}

/** A, B, … Z, then AA, AB, … : the letters the pipes are marked with. */
export function pieceLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * The cut length of the pipe at a weld, as text: what the fitter marks on
 * the pipe this weld joins, with the pipe's letter. Pipe to pipe has one
 * either side; an olet's header weld shows the header whole, since it sits
 * on it.
 */
export function pipeNetAt(analysis: Analysis, key: string): string {
  let at = analysis.pieces.filter((p) => p.ends.some((e) => e.key === key));
  const header = key.match(/^n:(.+):header(?::[NSEWUD])?$/);
  if (at.length === 0 && header) {
    const info = analysis.nodeInfo.get(header[1]);
    const legs = info ? oletLegs(info) : null;
    if (legs) at = analysis.pieces.filter((p) => legs.header.every((r) => p.runIds.includes(r.id)));
  }
  if (at.length === 0) return '';
  return at.map((p) => `${p.letter} ${fmtMm(p.net)}`).join(' / ');
}

/** Millimetres to the half, plainly: 2881 or 2878.5. */
export function fmtMm(mm: number): string {
  const half = Math.round(mm * 2) / 2;
  return Number.isInteger(half) ? String(half) : half.toFixed(1);
}

/**
 * Where a run's dimension breaks, in mm from its start: at each valve face,
 * since the pipe either side of a valve is its own piece and the valve's
 * face-to-face stands on its own between them.
 */
export function dimensionStops(drawing: Drawing, run: Run): number[] {
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  const total = a && b ? length3(sub(b.pos, a.pos)) : 0;
  const breaks: number[] = [];
  for (const comp of run.inline) {
    if (!isValve(comp.kind)) continue;
    const half = componentTakeout(comp.kind, comp.dn ?? run.dn, false, comp.ff);
    if (half <= 0) continue;
    breaks.push(comp.offset - half, comp.offset + half);
  }
  return [0, ...breaks.filter((mm) => mm > 0.5 && mm < total - 0.5).sort((x, y) => x - y), total];
}

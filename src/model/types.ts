/** Core data model for a metric piping isometric. All linear values are millimetres. */

/** The six routing directions of an orthogonal piping isometric. */
export type Axis = 'N' | 'S' | 'E' | 'W' | 'U' | 'D';

/** A point in plant coordinates: east, north, up — all in mm. */
export interface Vec3 {
  e: number;
  n: number;
  u: number;
}

/**
 * How a joint is made. This is what decides the mark drawn where a fitting
 * meets the pipe — a filled dot for a butt weld, a bracket for a socket weld,
 * a single bar for a threaded joint — and whether the joint is a weld at all.
 */
export type JointType = 'BW' | 'SW' | 'THD';

/** How a component or pipe end is joined. Drives weld generation. */
export type EndType = JointType | 'FLG' | 'PLAIN';

/** Inline components sit part-way along a run, at an offset from its start node. */
export type ComponentKind =
  | 'BALL_ACT'
  | 'GATE'
  | 'GLOBE'
  | 'BALL'
  | 'CHECK'
  | 'BUTTERFLY'
  | 'PLUG'
  | 'NEEDLE'
  | 'CONTROL'
  | 'RELIEF'
  | 'FLG_WN'
  | 'FLG_SO'
  | 'FLG_SW'
  | 'FLG_THD'
  | 'FLG_LAP'
  | 'FLG_BLIND'
  | 'SPECTACLE'
  | 'RED_CONC'
  | 'RED_ECC'
  | 'CAP'
  | 'UNION'
  /** A coupling joining two pipes: socket weld, or threaded (NPT). His ask, 2026-09-26. */
  | 'COUPLING_SW'
  | 'COUPLING_THD'
  | 'TRANSITION'
  | 'STRAINER'
  | 'INSTRUMENT'
  | 'SUPPORT'
  | 'ANCHOR'
  | 'GUIDE'
  /** The simple support: an L50 angle with a clamp. */
  | 'SUPPORT_L'
  /** Where the line goes into or comes out of the ground: the AG/UG mark. */
  | 'GROUND';

/** The flanges a line can be joined or terminated with. */
export type FlangeKind = 'FLG_WN' | 'FLG_SO' | 'FLG_SW' | 'FLG_THD' | 'FLG_LAP' | 'FLG_BLIND';

/** What terminates a free end of the pipe. */
export type TerminalKind =
  | 'OPEN'
  | 'FLG_WN'
  | 'FLG_SO'
  | 'FLG_SW'
  | 'FLG_THD'
  | 'FLG_LAP'
  | 'FLG_BLIND'
  | 'CAP'
  | 'TRANSITION'
  | 'CONTINUATION'
  | 'EQUIPMENT';

export interface InlineComponent {
  id: string;
  kind: ComponentKind;
  /** Distance in mm from the run's start node, measured along the run. */
  offset: number;
  /** Nominal size, e.g. 'DN80'. Defaults to the host run's size. */
  dn?: string;
  /** Second size for reducers — the size downstream of the component. */
  dn2?: string;
  /** End preparation. Left unset, the component follows the drawing's default. */
  ends?: EndType;
  /** Turns a one-way item round: a transition joint's steel side goes the other way. */
  flip?: boolean;
  tag?: string;
  note?: string;
  /**
   * A flanged valve on the open end of a line: what its last face wears.
   * Unset, its own flange; 'none', no flange (the face is left open, or
   * bolts to something drawn elsewhere); 'blind', a blind bolted straight
   * on the valve's face. His ask, 2026-09-23.
   */
  lastFlange?: 'none' | 'blind';
  /**
   * Put in by the app: a coupling every 6 m along small-bore pipe, placed
   * again after every change. Moved by hand, it is his and stays put.
   */
  auto?: boolean;
  /**
   * The side (0 start, 1 end) of a flanged valve bolted straight to the
   * valve beside it: no flange there, nothing welded, off the list.
   */
  bare?: 0 | 1;
  /**
   * A valve's own face-to-face in mm, typed over its dimension on the
   * drawing (his ask, 2026-09-24); unset, the table's for its size.
   */
  ff?: number;
}

export interface Terminal {
  kind: TerminalKind;
  tag?: string;
  /** Free text such as 'TO V-101 NOZZLE N3' or a continuation sheet reference. */
  note?: string;
  /** A line coming in from the sheet before: the size and schedule it left that sheet at. */
  dn?: string;
  schedule?: string;
}

export interface IsoNode {
  id: string;
  pos: Vec3;
  /** Optional user label drawn next to the node. */
  label?: string;
  /** Present only on free ends (nodes with a single connected run). */
  terminal?: Terminal;
  /**
   * A flanged joint: the two runs meeting here are bolted together flange to
   * flange, one flange of this kind on each. A flange is a break in the line —
   * the pipe stops at its face, so this always sits on a point of its own,
   * never part way along a run.
   */
  flange?: FlangeKind;
  /** Overrides the fitting inferred from connectivity. */
  fittingOverride?: FittingKind;
  /**
   * A coupling put here by the app, one every 6 m of small-bore pipe; placed
   * again after every change. Moved by hand it is his, and the flag goes.
   */
  autoCoupling?: boolean;
  /** Overrides the drawing's default joint type at this point. */
  joint?: JointType;
  /**
   * An olet riding on the line here: which way its branch goes and what size
   * it is. Set when the olet is placed, before any branch is drawn; the
   * branch run, once drawn, is what the analysis then goes by.
   */
  olet?: { dir: Axis; dn: string };
  /** Several olets on one point, each with its own way and size. Read through `oletMarks`. */
  olets?: { dir: Axis; dn: string }[];
}

/** A dimension put in by hand between two points of the drawing. */
export interface Measure {
  id: string;
  a: string;
  b: string;
}

/**
 * A piece of equipment drawn as a dashed box with a name in it: a pump, a
 * tank, a skid. A note on the drawing, not material — no list line, no
 * welds. It stands on a point of the drawing (`at`), reaches `length` along
 * `axis` from there and is `width` wide across, centred on that line.
 */
export interface Equipment {
  id: string;
  at: Vec3;
  axis: Axis;
  across: Axis;
  length: number;
  width: number;
  name: string;
  /** The point it stands on, and where that point was when last in step: the box goes with it. */
  stand?: string;
  standPos?: Vec3;
  /** The point on its far side a line was drawn on from: that line goes with the box. */
  next?: string;
}

export type FittingKind =
  | 'NONE'
  | 'ELBOW_90'
  | 'ELBOW_45'
  | 'BEND'
  | 'TEE'
  | 'TEE_REDUCING'
  | 'CROSS'
  | 'OLET'
  | 'MITRE'
  /** A coupling on a point, joining the two pipes either side (SW, or NPT on a threaded point). */
  | 'COUPLING';

export interface Run {
  id: string;
  from: string;
  to: string;
  dn: string;
  schedule: string;
  inline: InlineComponent[];
  /** Suppresses the automatic length dimension for this run. */
  noDim?: boolean;
  /** No coupling put in every 6 m along this pipe (one of them was taken out by hand). */
  noAutoCoupling?: boolean;
  /**
   * The fittings at each end are joined to each other directly, with no pipe
   * between: one weld where they meet, no cut length, no pipe on the list.
   */
  direct?: boolean;
  /** Text beside the run on the drawing: "CONT. ON NEXT SHEET" on a dashed run. */
  note?: string;
  /**
   * Drawn dashed: pipe carried on from this sheet to the next (or existing
   * pipe), so not this sheet's material: no pipe on the list, no cut length.
   */
  dashed?: boolean;
  /**
   * How long the run is drawn when the sheet is not to scale, in the same
   * units as its true length. Set from where the pencil put the end down, so
   * a not-to-scale line still ends where it was drawn to.
   */
  visual?: number;
}



/**
 * Welds are derived from connectivity on every recalculation, but user choices
 * (shop vs field, manual renumbering) persist against the stable `key`.
 */
/**
 * Every place the pipe meets something else. Threaded joints are marked on the
 * drawing but are not welds, so only the welded ones reach the weld schedule.
 */
export interface Weld {
  key: string;
  number: string;
  joint: JointType;
  dn: string;
  schedule: string;
  /** What the joint connects, for the weld schedule table. */
  joins: string;
  pos: Vec3;
  /** Which way a one-sided symbol at this joint should face. */
  facing: 1 | -1;
  /** Marked as not welded after all: drawn hollow, not numbered or counted. */
  skipped?: boolean;
  /**
   * What the weld belongs to, and how far out from it the mark is drawn. A
   * weld mark is part of the fitting's symbol: it sits on the symbol's end,
   * a set distance from the point or the item, whatever the true take-out.
   */
  anchor?: Vec3;
  reach?: WeldReach;
}

export type WeldReach =
  /** An elbow, bend or tee: a symbol length out from the point. */
  | { kind: 'fitting' }
  /** The branch weld of an olet. */
  | { kind: 'olet' }
  /** A flange on a point: the end of its hub, plus half the gasket gap when paired. */
  | { kind: 'flange'; flange: FlangeKind; paired: boolean }
  /** A coupling on a point: its sleeve's end, a set distance out. */
  | { kind: 'coupling' }
  /** An in-line item: its face, plus a flange when it is flanged. `comp` names it, so the mark sits where the item is drawn. */
  | { kind: 'valve'; trueHalf: number; flange?: FlangeKind; comp?: string }
  /** A PE/steel transition on the end: the weld on its steel side. */
  | { kind: 'transition' };

export interface WeldOverride {
  number?: string;
  /** No weld here after all: the joint is marked but not numbered or counted. */
  skip?: boolean;
  /** Where the number tag was dragged to, in paper units from the weld. */
  tag?: { dx: number; dy: number };
}

/**
 * What the title block carries. This is a fabrication drawing, so it names the
 * job and who drew it and stops there — the design data a specification would
 * carry is not what anyone building the line reads off the sheet.
 */
export interface Meta {
  project: string;
  lineNumber: string;
  drawingNo: string;
  sheet: string;
  revision: string;
  date: string;
  drawnBy: string;
  /** The company logo, held as a data URI so it travels with the drawing. */
  logo?: string;
  /** The stamp printed over the title block: one of `SHEET_STAMPS`; AS MADE when unset. */
  stamp?: string;
  /** His own notes, one per line, printed with the sheet's notes above the stamp. */
  notes?: string;
}

export interface DrawingOptions {
  /** Grid snap increment in mm for mouse drawing. */
  snap: number;
  /** Screen millimetres drawn per 1000 mm of pipe, before zoom. */
  scale: number;
  /** Isometrics are conventionally not to scale; clamp run lengths when true. */
  schematic: boolean;
  /** Visual length used for every run in schematic mode. */
  schematicLength: number;
  /**
   * The scale the sheet prints at, as the R in 1:R; 0 fits the drawing to
   * the sheet. Symbols are a set size on the sheet, so this is also what
   * sizes them against the pipe on the screen.
   */
  sheetScale?: number;
  showDimensions: boolean;
  /** Weld numbers. Off by default: the balloons carry what a fitter reads. */
  showWelds: boolean;
  /** Item balloons keyed to the material list. */
  showItems: boolean;
  showNodeLabels: boolean;
  showGrid: boolean;
  /** Rotates which screen direction North points to, in 90-degree steps. */
  northRotation: 0 | 1 | 2 | 3;
  /**
   * Turns the north arrow alone, clockwise in degrees, without turning the
   * drawing: for a sheet whose north lies off the isometric axes.
   */
  northArrow?: number;
  /** How fittings are joined unless a point says otherwise. */
  joint: JointType;
  /** The schedule new runs take, and what "set every run" applies. */
  pipeSchedule: string;
  /**
   * Wall thickness the fittings are made to. Fittings are normally standard
   * weight even where the pipe is a heavier schedule, so the take-off records
   * the two separately rather than assuming the pipe's.
   */
  fittingThickness: string;
}

export interface Drawing {
  version: 1;
  /** This drawing's own name in the library; given when it is first kept. */
  id?: string;
  meta: Meta;
  options: DrawingOptions;
  nodes: IsoNode[];
  runs: Run[];
  weldOverrides: Record<string, WeldOverride>;
  /** Where an item balloon was dragged to, in paper units from the item, by item key. */
  itemOverrides?: Record<string, { dx: number; dy: number }>;
  /** Dimensions moved or hidden by hand, by "runId:piece". */
  dimOverrides?: Record<string, DimOverride>;
  /** Names typed over the material list's own, by list line key. */
  bomNames?: Record<string, string>;
  /** Equipment boxes drawn on the sheet. */
  equipment?: Equipment[];
  /** Dimensions put in by hand between two points. */
  measures?: Measure[];
  /**
   * Where each item balloon is, by list line key: on a chosen one of the
   * item's places on the drawing, or taken off altogether. Unset, it goes
   * where there is most room.
   */
  balloons?: Record<string, { at?: string; hidden?: boolean }>;
}

export interface DimOverride {
  hidden?: boolean;
  /** How far from the pipe the dimension line sits, in paper units; negative is the other side. */
  offset?: number;
  /** Where along the line the figure sits, 0 to 1. */
  along?: number;
}

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
}

export interface Terminal {
  kind: TerminalKind;
  tag?: string;
  /** Free text such as 'TO V-101 NOZZLE N3' or a continuation sheet reference. */
  note?: string;
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
  /** Overrides the drawing's default joint type at this point. */
  joint?: JointType;
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
  | 'MITRE';

export interface Run {
  id: string;
  from: string;
  to: string;
  dn: string;
  schedule: string;
  inline: InlineComponent[];
  /** Suppresses the automatic length dimension for this run. */
  noDim?: boolean;
  /**
   * The fittings at each end are joined to each other directly, with no pipe
   * between: one weld where they meet, no cut length, no pipe on the list.
   */
  direct?: boolean;
  note?: string;
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
}

export interface DimOverride {
  hidden?: boolean;
  /** How far from the pipe the dimension line sits, in paper units; negative is the other side. */
  offset?: number;
  /** Where along the line the figure sits, 0 to 1. */
  along?: number;
}

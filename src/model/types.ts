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
  | 'STRAINER'
  | 'INSTRUMENT'
  | 'SUPPORT'
  | 'ANCHOR'
  | 'GUIDE';

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
  note?: string;
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
}

export interface WeldOverride {
  number?: string;
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
  meta: Meta;
  options: DrawingOptions;
  nodes: IsoNode[];
  runs: Run[];
  weldOverrides: Record<string, WeldOverride>;
}

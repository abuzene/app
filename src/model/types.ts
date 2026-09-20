/** Core data model for a metric piping isometric. All linear values are millimetres. */

/** The six routing directions of an orthogonal piping isometric. */
export type Axis = 'N' | 'S' | 'E' | 'W' | 'U' | 'D';

/** A point in plant coordinates: east, north, up — all in mm. */
export interface Vec3 {
  e: number;
  n: number;
  u: number;
}

/** How a component or pipe end is joined. Drives weld generation. */
export type EndType = 'BW' | 'SW' | 'THD' | 'FLG' | 'PLAIN';

/** Inline components sit part-way along a run, at an offset from its start node. */
export type ComponentKind =
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
  | 'FLG_BLIND'
  | 'SPECTACLE'
  | 'RED_CONC'
  | 'RED_ECC'
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
  ends: EndType;
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
}

export type FittingKind =
  | 'NONE'
  | 'ELBOW_90'
  | 'ELBOW_45'
  | 'BEND'
  | 'TEE'
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

export type WeldType = 'SHOP' | 'FIELD';

/**
 * Welds are derived from connectivity on every recalculation, but user choices
 * (shop vs field, manual renumbering) persist against the stable `key`.
 */
export interface Weld {
  key: string;
  number: string;
  type: WeldType;
  dn: string;
  schedule: string;
  /** What the weld joins, for the weld schedule table. */
  joins: string;
  pos: Vec3;
}

export interface WeldOverride {
  type?: WeldType;
  number?: string;
}

export interface Meta {
  project: string;
  client: string;
  lineNumber: string;
  drawingNo: string;
  sheet: string;
  revision: string;
  date: string;
  drawnBy: string;
  checkedBy: string;
  spec: string;
  service: string;
  material: string;
  insulation: string;
  pwht: string;
  ndt: string;
  designPressure: string;
  designTemp: string;
  testPressure: string;
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
  showWelds: boolean;
  showNodeLabels: boolean;
  showGrid: boolean;
  /** Rotates which screen direction North points to, in 90-degree steps. */
  northRotation: 0 | 1 | 2 | 3;
}

export interface Drawing {
  version: 1;
  meta: Meta;
  options: DrawingOptions;
  nodes: IsoNode[];
  runs: Run[];
  weldOverrides: Record<string, WeldOverride>;
}

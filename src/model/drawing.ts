import type {
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
import { add, angleBetween, direction, length3, scale3, sub } from './iso';
import { componentTakeout, defaultValveEnds, fittingTakeout, oletTakeout, sizeLabel } from './pipe-data';
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

export interface Analysis {
  nodeInfo: Map<string, NodeInfo>;
  nodeById: Map<string, IsoNode>;
  /** Every mark where the pipe meets something, threaded joints included. */
  joints: Weld[];
  /** The joints that are actually welds, numbered along the route. */
  welds: Weld[];
  runLengths: Map<string, RunLengths>;
  bom: BomLine[];
  /** Every ballooned thing on the drawing, with its material list number. */
  items: ItemInstance[];
  /** Node positions used for drawing, which differ from true positions in schematic mode. */
  display: Map<string, Vec3>;
  warnings: string[];
}

function inferFitting(legs: Vec3[], runs: Run[], override?: FittingKind): FittingKind {
  // An olet needs a branch: delete the branch and the header closes back up to
  // a plain butt joint rather than keeping a fitting that is no longer there.
  if (override === 'OLET' && legs.length < 3) {
    return legs.length === 2 ? 'NONE' : 'NONE';
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
export function oletLegs(info: NodeInfo): { header: Run[]; branch: Run } | null {
  if (info.runs.length !== 3 || info.legs.length !== 3) return null;
  for (let i = 0; i < 3; i += 1) {
    const others = [0, 1, 2].filter((k) => k !== i);
    const deviation = 180 - angleBetween(info.legs[others[0]], info.legs[others[1]]);
    if (deviation < 1) return { header: [info.runs[others[0]], info.runs[others[1]]], branch: info.runs[i] };
  }
  return null;
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
  RED_CONC: 'CONCENTRIC REDUCER',
  RED_ECC: 'ECCENTRIC REDUCER',
  CAP: 'CAP',
  UNION: 'UNION',
  TRANSITION: 'TRANSITION JOINT PE/CS',
  STRAINER: 'STRAINER',
  INSTRUMENT: 'INSTRUMENT',
  SUPPORT: 'PIPE SUPPORT',
  ANCHOR: 'ANCHOR',
  GUIDE: 'GUIDE',
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
  if (['SUPPORT', 'ANCHOR', 'GUIDE', 'INSTRUMENT', 'SPECTACLE'].includes(c.kind)) return null;
  // A flange's own type says how it joins the pipe, whatever the default is.
  if (isFlange(c.kind)) return flangeJoint(c.kind);
  // The size decides how a valve is connected, so it has to be the size the
  // component actually is — its own, or the run's.
  const ends = resolveEnds(c.kind, dn, c.ends, fallback);
  // A flanged component meets the pipe through its flanges, which are weld
  // neck and so butt welded to it.
  if (ends === 'FLG') return 'BW';
  return ends === 'BW' || ends === 'SW' || ends === 'THD' ? ends : null;
}

/** How a line end joins whatever terminates it. */
function terminalJoint(kind: string, fallback: JointType): JointType | null {
  if (isFlange(kind)) return flangeJoint(kind);
  // A transition joint is welded on its steel side; the plastic side is fused.
  if (kind === 'TRANSITION') return 'BW';
  return kind === 'CAP' ? fallback : null;
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
  if (['SUPPORT', 'ANCHOR', 'GUIDE', 'INSTRUMENT'].includes(kind)) return 'ITEM';
  return 'VALVE';
}

/**
 * Lays out node positions for drawing. In schematic mode every run is drawn at
 * the same visual length regardless of its true dimension, which is how a
 * fabrication isometric is normally presented; otherwise true lengths are used
 * with a floor so that short runs stay readable.
 */
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
  while (remaining.size > 0) {
    const startId = [...remaining][0];
    display.set(startId, { e: 0, n: 0, u: 0 });
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
        const visual = run.visual ?? drawing.options.schematicLength;
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
  if (legs.branch.id !== run.id) return 0;
  return oletTakeout(legs.header[0]?.dn ?? run.dn, run.dn);
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
    const fitting = inferFitting(legs, runs, node.fittingOverride);
    nodeInfo.set(node.id, { node, runs, legs, fitting, degree: runs.length });
    if (runs.length > 4) warnings.push(`Node ${node.label ?? node.id} has ${runs.length} connections.`);
  }

  // Run lengths and cut lengths.
  const runLengths = new Map<string, RunLengths>();
  for (const run of drawing.runs) {
    const a = nodeById.get(run.from);
    const b = nodeById.get(run.to);
    if (!a || !b) continue;
    const centre = length3(sub(b.pos, a.pos));
    const fromInfo = nodeInfo.get(run.from);
    const toInfo = nodeInfo.get(run.to);
    let cut = centre - endTakeout(fromInfo, run) - endTakeout(toInfo, run);
    for (const end of [a, b]) {
      if (end.terminal && (end.terminal.kind === 'FLG_WN' || end.terminal.kind === 'FLG_SO' || end.terminal.kind === 'TRANSITION')) {
        cut -= componentTakeout(end.terminal.kind, run.dn);
      }
    }
    for (const comp of run.inline) {
      const dn = comp.dn ?? run.dn;
      const ends = resolveEnds(comp.kind, dn, comp.ends, drawing.options.joint ?? 'BW');
      cut -= componentTakeout(comp.kind, dn, ends === 'FLG') * 2;
    }
    runLengths.set(run.id, { run, centre, cut: Math.max(0, cut) });
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

  for (const run of drawing.runs) {
    const a = nodeById.get(run.from);
    const b = nodeById.get(run.to);
    if (!a || !b) continue;
    const dir = direction(a.pos, b.pos);
    if (!dir) continue;
    const idx = runIndex.get(run.id) ?? 0;
    const total = length3(sub(b.pos, a.pos));

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
          : node.joint ?? defaultJoint;
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
          // along the pipe, where the neck meets it.
          const back = isFlange(terminal) || terminal === 'TRANSITION' ? componentTakeout(terminal, run.dn) : 0;
          const at = atStart ? back : total - back;
          pushJoint(
            `n:${node.id}:term`,
            joint,
            run.dn,
            run.schedule,
            `PIPE / ${TERMINAL_LABEL[terminal] ?? terminal}`,
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
          const isBranch = legs.branch.id === run.id;
          if (isBranch) {
            // The branch joint: this is what makes it a weldolet, sockolet or
            // threadolet, so it follows the node's joint type.
            const distance2 = atStart
              ? oletTakeout(legs.header[0]?.dn ?? run.dn, run.dn)
              : total - oletTakeout(legs.header[0]?.dn ?? run.dn, run.dn);
            pushJoint(
              `n:${node.id}:branch`,
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
            // The olet is welded to the header wall whatever its branch is.
            pushJoint(
              `n:${node.id}:header`,
              'BW',
              legs.header[0]?.dn ?? run.dn,
              run.schedule,
              `HEADER / ${oletLabel(nodeJoint)}`,
              node.pos,
              facing,
              idx,
              distance,
            );
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
      const takeout = componentTakeout(comp.kind, dn, ends === 'FLG');
      const faceHalf = componentTakeout(comp.kind, dn, false);
      const centre = add(a.pos, scale3(dir, comp.offset));
      const isReducer = comp.kind === 'RED_CONC' || comp.kind === 'RED_ECC';
      const reach: WeldReach = isReducer
        ? { kind: 'reducer' }
        : { kind: 'valve', trueHalf: faceHalf, flange: ends === 'FLG' && !isFlange(comp.kind) ? 'FLG_WN' : undefined };
      for (const side of [0, 1] as const) {
        // A transition joint is welded on its steel side only; the plastic
        // side is fused, which is no weld of ours.
        if (comp.kind === 'TRANSITION' && side === (comp.flip ? 1 : 0)) continue;
        const distance = side === 0 ? comp.offset - takeout : comp.offset + takeout;
        pushJoint(
          `c:${comp.id}:${side}`,
          joint,
          dn,
          run.schedule,
          `PIPE / ${COMPONENT_LABEL[comp.kind] ?? comp.kind}`,
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
    const welded = j.joint !== 'THD';
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
      anchor: j.anchor,
      reach: j.reach,
    };
  });
  const welds = joints.filter((j) => j.joint !== 'THD');

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
    const key = `${run.dn}|${run.schedule}`;
    pipeTotals.set(key, (pipeTotals.get(key) ?? 0) + cut);
    const a = nodeById.get(run.from);
    const b = nodeById.get(run.to);
    if (a && b) {
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
        instances.push({
          key: `node:${info.node.id}`,
          bomKey: tally({
            category: 'FITTING',
            description: `${oletLabel(joint)} ${sizeLabel(legs.header[0].dn)} x ${sizeLabel(legs.branch.dn)}`,
            dn: legs.header[0].dn,
            schedule: fittingThickness,
            unit: 'off',
          }),
          pos: info.node.pos,
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
              : fittingLabel(info.fitting)) + jointSuffix(info.node.joint ?? drawing.options.joint ?? 'BW'),
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
      const dn = info.runs[0]?.dn ?? 'DN80';
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
      const dn = comp.dn ?? run.dn;
      const isReducer = comp.kind === 'RED_CONC' || comp.kind === 'RED_ECC';
      const description = isReducer
        ? `${COMPONENT_LABEL[comp.kind]} ${sizeLabel(dn)} x ${sizeLabel(comp.dn2 ?? dn)}`
        : COMPONENT_LABEL[comp.kind] ?? comp.kind;
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
        const takeout = componentTakeout(comp.kind, dn, true);
        for (const side of [-1, 1] as const) {
          const bomKey = tally({
            category: 'FLANGE',
            description: 'WELD NECK FLANGE',
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

  const order: Record<BomLine['category'], number> = { PIPE: 0, FITTING: 1, FLANGE: 2, VALVE: 3, ITEM: 4 };
  bom.sort((x, y) => order[x.category] - order[y.category] || x.description.localeCompare(y.description));

  // The list is now in its final order, so the item numbers follow from it.
  const numberOf = new Map<string, number>();
  bom.forEach((line, i) => {
    if (line.key) numberOf.set(line.key, i + 1);
  });
  // One balloon per line of the list is enough: the first place each item
  // number appears carries it, and the fitter reads the rest from the list.
  const ballooned = new Set<number>();
  const items: ItemInstance[] = instances
    .map((inst) => ({ key: inst.key, number: numberOf.get(inst.bomKey) ?? 0, pos: inst.pos }))
    .filter((inst) => {
      if (inst.number <= 0 || ballooned.has(inst.number)) return false;
      ballooned.add(inst.number);
      return true;
    });

  return {
    nodeInfo,
    nodeById,
    joints,
    welds,
    runLengths,
    bom,
    items,
    display: layout(drawing, nodeById, adjacency),
    warnings,
  };
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
    const half = componentTakeout(comp.kind, comp.dn ?? run.dn, false);
    if (half <= 0) continue;
    breaks.push(comp.offset - half, comp.offset + half);
  }
  return [0, ...breaks.filter((mm) => mm > 0.5 && mm < total - 0.5).sort((x, y) => x - y), total];
}

import type {
  Drawing,
  DrawingOptions,
  FittingKind,
  InlineComponent,
  IsoNode,
  JointType,
  Meta,
  Run,
  Vec3,
  Weld,
} from './types';
import { add, angleBetween, direction, length3, scale3, sub } from './iso';
import { componentTakeout, fittingTakeout, sizeLabel } from './pipe-data';
import { flangeJoint, isFlange } from '../render/symbols';

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyMeta(): Meta {
  return {
    project: '',
    lineNumber: '',
    drawingNo: '',
    sheet: '1 of 1',
    revision: '0',
    date: new Date().toISOString().slice(0, 10),
    drawnBy: '',
  };
}

export function defaultOptions(): DrawingOptions {
  return {
    snap: 50,
    scale: 0.06,
    schematic: false,
    schematicLength: 1500,
    showDimensions: true,
    showWelds: true,
    showNodeLabels: true,
    showGrid: true,
    northRotation: 0,
    joint: 'BW',
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

export interface BomLine {
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
  /** Node positions used for drawing, which differ from true positions in schematic mode. */
  display: Map<string, Vec3>;
  warnings: string[];
}

function inferFitting(legs: Vec3[], runs: Run[], override?: FittingKind): FittingKind {
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
      return 'OLET';
    case 'MITRE':
      return 'MITRE BEND';
    default:
      return '';
  }
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
  CONTINUATION: 'CONTINUATION',
  EQUIPMENT: 'EQUIPMENT CONNECTION',
};

/**
 * How a component joins the pipe either side of it, or null when it makes no
 * mark of its own — a support clamps on, a blind bolts between flanges.
 */
function componentJoint(c: InlineComponent, fallback: JointType): JointType | null {
  if (['SUPPORT', 'ANCHOR', 'GUIDE', 'INSTRUMENT', 'SPECTACLE'].includes(c.kind)) return null;
  // A flange's own type says how it joins the pipe, whatever the default is.
  if (isFlange(c.kind)) return flangeJoint(c.kind);
  const ends = c.ends ?? fallback;
  return ends === 'BW' || ends === 'SW' || ends === 'THD' ? ends : null;
}

/** How a line end joins whatever terminates it. */
function terminalJoint(kind: string, fallback: JointType): JointType | null {
  if (isFlange(kind)) return flangeJoint(kind);
  return kind === 'CAP' ? fallback : null;
}

function categoryOf(kind: string): BomLine['category'] {
  if (kind.startsWith('FLG_') || kind === 'SPECTACLE') return 'FLANGE';
  if (['RED_CONC', 'RED_ECC', 'UNION'].includes(kind)) return 'FITTING';
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
        const visual = drawing.options.schematicLength;
        display.set(otherId, add(here, scale3(delta, visual / trueLen)));
        remaining.delete(otherId);
        queue.push(otherId);
      }
    }
  }
  return display;
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
    const fromFitting = nodeInfo.get(run.from)?.fitting ?? 'NONE';
    const toFitting = nodeInfo.get(run.to)?.fitting ?? 'NONE';
    let cut = centre - fittingTakeout(fromFitting, run.dn) - fittingTakeout(toFitting, run.dn);
    for (const end of [a, b]) {
      if (end.terminal && (end.terminal.kind === 'FLG_WN' || end.terminal.kind === 'FLG_SO')) {
        cut -= componentTakeout(end.terminal.kind, run.dn);
      }
    }
    for (const comp of run.inline) {
      cut -= componentTakeout(comp.kind, comp.dn ?? run.dn) * 2;
    }
    runLengths.set(run.id, { run, centre, cut: Math.max(0, cut) });
    if (cut < 0) {
      warnings.push(`Run ${run.dn} of ${Math.round(centre)} mm is shorter than its fittings require.`);
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
  ) => {
    if (jointMap.has(key)) return;
    jointMap.set(key, {
      key,
      number: '',
      type: 'SHOP',
      joint,
      dn,
      schedule,
      joins,
      pos,
      facing,
      sortRun,
      sortDist,
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
      const nodeJoint = node.joint ?? defaultJoint;
      const takeout = fittingTakeout(info.fitting, run.dn);
      const distance = atStart ? takeout : total - takeout;
      const pos = add(a.pos, scale3(dir, distance));
      // A mark faces the thing it joins the pipe to.
      const facing: 1 | -1 = atStart ? -1 : 1;

      if (info.degree === 1) {
        const terminal = node.terminal?.kind ?? 'OPEN';
        const joint = terminalJoint(terminal, nodeJoint);
        if (joint) {
          pushJoint(
            `n:${node.id}:term`,
            joint,
            run.dn,
            run.schedule,
            `PIPE / ${TERMINAL_LABEL[terminal] ?? terminal}`,
            atStart ? a.pos : b.pos,
            facing,
            idx,
            atStart ? 0 : total,
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
        );
      }
    }

    for (const comp of run.inline) {
      const joint = componentJoint(comp, defaultJoint);
      if (!joint) continue;
      const dn = comp.dn ?? run.dn;
      const takeout = componentTakeout(comp.kind, dn);
      for (const side of [0, 1] as const) {
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
    const type = override?.type ?? j.type;
    const welded = j.joint !== 'THD';
    if (welded) weldNumber += 1;
    const number = welded ? override?.number ?? `${type === 'FIELD' ? 'FW' : 'SW'}${weldNumber}` : '';
    return {
      key: j.key,
      number,
      type,
      joint: j.joint,
      dn: j.dn,
      schedule: j.schedule,
      joins: j.joins,
      pos: j.pos,
      facing: j.facing,
    };
  });
  const welds = joints.filter((j) => j.joint !== 'THD');

  // Bill of materials.
  const bom: BomLine[] = [];
  const pipeTotals = new Map<string, number>();
  for (const { run, cut } of runLengths.values()) {
    const key = `${run.dn}|${run.schedule}`;
    pipeTotals.set(key, (pipeTotals.get(key) ?? 0) + cut);
  }
  for (const [key, mm] of pipeTotals) {
    const [dn, schedule] = key.split('|');
    const metres = mm / 1000;
    bom.push({
      category: 'PIPE',
      description: `PIPE, SMLS, ${sizeLabel(dn)} x ${schedule}`,
      dn,
      schedule,
      quantity: metres,
      unit: 'm',
    });
  }

  const counts = new Map<string, { line: Omit<BomLine, 'quantity'>; quantity: number }>();
  const tally = (line: Omit<BomLine, 'quantity'>) => {
    const key = `${line.category}|${line.description}|${line.dn}|${line.schedule}`;
    const existing = counts.get(key);
    if (existing) existing.quantity += 1;
    else counts.set(key, { line, quantity: 1 });
  };

  for (const info of nodeInfo.values()) {
    if (info.fitting !== 'NONE' && info.degree > 1) {
      const dn = info.runs[0]?.dn ?? 'DN80';
      const schedule = info.runs[0]?.schedule ?? 'STD';
      const branch = info.runs.find((r) => r.dn !== dn);
      tally({
        category: 'FITTING',
        description:
          info.fitting === 'TEE_REDUCING' && branch
            ? `${fittingLabel(info.fitting)} ${sizeLabel(dn)} x ${sizeLabel(branch.dn)}`
            : fittingLabel(info.fitting),
        dn,
        schedule,
        unit: 'off',
      });
    }
    if (info.degree === 1 && info.node.terminal && info.node.terminal.kind !== 'OPEN') {
      const kind = info.node.terminal.kind;
      if (kind !== 'CONTINUATION' && kind !== 'EQUIPMENT') {
        tally({
          category: kind === 'CAP' ? 'FITTING' : 'FLANGE',
          description: TERMINAL_LABEL[kind],
          dn: info.runs[0]?.dn ?? 'DN80',
          schedule: info.runs[0]?.schedule ?? 'STD',
        unit: 'off',
        });
      }
    }
  }

  for (const run of drawing.runs) {
    for (const comp of run.inline) {
      const dn = comp.dn ?? run.dn;
      const isReducer = comp.kind === 'RED_CONC' || comp.kind === 'RED_ECC';
      const description = isReducer
        ? `${COMPONENT_LABEL[comp.kind]} ${sizeLabel(dn)} x ${sizeLabel(comp.dn2 ?? dn)}`
        : COMPONENT_LABEL[comp.kind] ?? comp.kind;
      tally({ category: categoryOf(comp.kind), description, dn, schedule: run.schedule, unit: 'off' });
    }
  }

  for (const { line, quantity } of counts.values()) bom.push({ ...line, quantity });

  const order: Record<BomLine['category'], number> = { PIPE: 0, FITTING: 1, FLANGE: 2, VALVE: 3, ITEM: 4 };
  bom.sort((x, y) => order[x.category] - order[y.category] || x.description.localeCompare(y.description));

  return {
    nodeInfo,
    nodeById,
    joints,
    welds,
    runLengths,
    bom,
    display: layout(drawing, nodeById, adjacency),
    warnings,
  };
}

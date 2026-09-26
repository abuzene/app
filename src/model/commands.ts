import type { Axis, ComponentKind, Drawing, FlangeKind, TerminalKind } from './types';
import { addComponent, addFlangeJoint, ensureNode, route, runLength } from './edit';
import { parseSize, schedulesFor } from './pipe-data';

export interface CommandState {
  currentNode: string | null;
  lastRun: string | null;
  dn: string;
  schedule: string;
  marks: Record<string, string>;
}

export interface CommandError {
  line: number;
  text: string;
  message: string;
}

export interface CommandResult {
  state: CommandState;
  errors: CommandError[];
  applied: number;
}

export function initialCommandState(dn = 'DN80', schedule = 'STD'): CommandState {
  return { currentNode: null, lastRun: null, dn, schedule, marks: {} };
}

const AXIS_ALIAS: Record<string, Axis> = {
  N: 'N',
  NORTH: 'N',
  S: 'S',
  SOUTH: 'S',
  E: 'E',
  EAST: 'E',
  W: 'W',
  WEST: 'W',
  U: 'U',
  UP: 'U',
  D: 'D',
  DN: 'D',
  DOWN: 'D',
};

const COMPONENT_ALIAS: Record<string, ComponentKind> = {
  GATE: 'GATE',
  GV: 'GATE',
  GLOBE: 'GLOBE',
  BALL: 'BALL',
  BV: 'BALL',
  GROUND: 'GROUND',
  SUPPORTL: 'SUPPORT_L',
  L50: 'SUPPORT_L',
  AGUG: 'GROUND',
  BALLAIR: 'BALL_ACT',
  BALL_ACT: 'BALL_ACT',
  ACT: 'BALL_ACT',
  CHECK: 'CHECK',
  NRV: 'CHECK',
  BUTTERFLY: 'BUTTERFLY',
  BFV: 'BUTTERFLY',
  PLUG: 'PLUG',
  NEEDLE: 'NEEDLE',
  CONTROL: 'CONTROL',
  CV: 'CONTROL',
  RELIEF: 'RELIEF',
  PSV: 'RELIEF',
  FLG: 'FLG_WN',
  FLANGE: 'FLG_WN',
  FLG_WN: 'FLG_WN',
  WN: 'FLG_WN',
  FLG_SO: 'FLG_SO',
  SO: 'FLG_SO',
  BLIND: 'FLG_BLIND',
  FLG_BLIND: 'FLG_BLIND',
  SPEC: 'SPECTACLE',
  SPECTACLE: 'SPECTACLE',
  RED: 'RED_CONC',
  RED_CONC: 'RED_CONC',
  REDUCER: 'RED_CONC',
  RED_ECC: 'RED_ECC',
  ECC: 'RED_ECC',
  UNION: 'UNION',
  CPLSW: 'COUPLING_SW',
  COUPLING_SW: 'COUPLING_SW',
  CPLNPT: 'COUPLING_THD',
  CPLTHD: 'COUPLING_THD',
  COUPLING_NPT: 'COUPLING_THD',
  COUPLING_THD: 'COUPLING_THD',
  STRAINER: 'STRAINER',
  INST: 'INSTRUMENT',
  INSTRUMENT: 'INSTRUMENT',
  SUPPORT: 'SUPPORT',
  SUP: 'SUPPORT',
  ANCHOR: 'ANCHOR',
  GUIDE: 'GUIDE',
};

const TERMINAL_ALIAS: Record<string, TerminalKind> = {
  OPEN: 'OPEN',
  FLG: 'FLG_WN',
  FLANGE: 'FLG_WN',
  WN: 'FLG_WN',
  SO: 'FLG_SO',
  BLIND: 'FLG_BLIND',
  CAP: 'CAP',
  TRANS: 'TRANSITION',
  TRANSITION: 'TRANSITION',
  CONT: 'CONTINUATION',
  CONTINUATION: 'CONTINUATION',
  EQUIP: 'EQUIPMENT',
  EQUIPMENT: 'EQUIPMENT',
};

export const COMMAND_HELP = `3"              set the size for following runs (also 1 1/2", DN80)
STD | SCH40 | XS | SCH80 ...   set the schedule
N 1500          route 1500 mm north  (also S E W U/UP D/DOWN)
+BALL           add a ball valve at the middle of the last run
+BALLAIR 50%    add an air actuated ball valve half way along it
+FLG 200        add a weld neck flange 200 mm along the last run
+RED            add a concentric reducer  (+ECC for eccentric)
MARK t1         remember this point as 't1'
GOTO t1         continue routing from 't1' — creates a tee
END FLG         terminate this end with a weld neck flange  (also CAP, BLIND, CONT)
LABEL N1        label the current point
ORIGIN 0,0,0    set the start coordinates in mm
# comment`;

function parseLength(token: string, total: number): number | null {
  if (token.endsWith('%')) {
    const pct = Number(token.slice(0, -1));
    if (!Number.isFinite(pct)) return null;
    return (total * pct) / 100;
  }
  const value = Number(token.replace(/MM$/i, ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * Applies a block of routing commands to a drawing. Parsing is line by line and
 * failures are reported per line rather than aborting, so one typo does not
 * discard the rest of the input.
 */
export function runCommands(drawing: Drawing, text: string, state: CommandState): CommandResult {
  const errors: CommandError[] = [];
  const next: CommandState = { ...state, marks: { ...state.marks } };
  let applied = 0;

  const lines = text.split(/[\n;]/);
  lines.forEach((raw, index) => {
    const line = raw.replace(/(#|\/\/).*$/, '').trim();
    if (!line) return;
    const tokens = line.split(/[\s,]+/).filter(Boolean);
    const head = tokens[0].toUpperCase();
    const fail = (message: string) => errors.push({ line: index + 1, text: raw.trim(), message });

    // Size, written the way it is called on site: 3", 1 1/2", or DN80.
    const sized = parseSize(line);
    if (sized) {
      next.dn = sized;
      if (!schedulesFor(sized).includes(next.schedule)) next.schedule = schedulesFor(sized)[0] ?? 'STD';
      applied += 1;
      return;
    }

    // Schedule.
    if (/^(STD|XS|XXS|SCH\d+)$/.test(head) && tokens.length === 1) {
      next.schedule = head;
      applied += 1;
      return;
    }

    // Origin.
    if (head === 'ORIGIN') {
      const nums = tokens.slice(1).map(Number);
      if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) {
        fail('ORIGIN needs three numbers: east, north, up in mm.');
        return;
      }
      next.currentNode = ensureNode(drawing, { e: nums[0], n: nums[1], u: nums[2] });
      applied += 1;
      return;
    }

    // Marks.
    if (head === 'MARK') {
      if (!tokens[1]) return fail('MARK needs a name.');
      if (!next.currentNode) return fail('Nothing to mark yet — route a run first.');
      next.marks[tokens[1].toUpperCase()] = next.currentNode;
      applied += 1;
      return;
    }
    if (head === 'GOTO') {
      const name = tokens[1]?.toUpperCase();
      if (!name) return fail('GOTO needs a mark name.');
      const target = next.marks[name];
      if (!target) return fail(`No mark called '${tokens[1]}'.`);
      next.currentNode = target;
      applied += 1;
      return;
    }

    // Labels and terminals.
    if (head === 'LABEL') {
      if (!next.currentNode) return fail('Nothing to label yet.');
      const node = drawing.nodes.find((n) => n.id === next.currentNode);
      if (node) node.label = line.slice(line.indexOf(tokens[1] ?? '')).trim();
      applied += 1;
      return;
    }
    if (head === 'END') {
      if (!next.currentNode) return fail('Nothing to terminate yet.');
      const kind = TERMINAL_ALIAS[(tokens[1] ?? 'OPEN').toUpperCase()];
      if (!kind) return fail(`Unknown end type '${tokens[1]}'.`);
      const node = drawing.nodes.find((n) => n.id === next.currentNode);
      if (node) node.terminal = { kind, note: tokens.slice(2).join(' ') || undefined };
      applied += 1;
      return;
    }

    // Inline components.
    if (head.startsWith('+')) {
      const kind = COMPONENT_ALIAS[head.slice(1)];
      if (!kind) return fail(`Unknown component '${head.slice(1)}'.`);
      if (!next.lastRun) return fail('Route a run before adding a component to it.');
      const run = drawing.runs.find((r) => r.id === next.lastRun);
      if (!run) return fail('The last run no longer exists.');
      let offset: number | undefined;
      if (tokens[1]) {
        const parsed = parseLength(tokens[1], runLength(drawing, run));
        if (parsed === null) return fail(`Could not read the offset '${tokens[1]}'.`);
        offset = parsed;
      }
      // A flange breaks the line: the run is cut there and bolted back
      // together, and the route carries on from the far half.
      if (kind.startsWith('FLG_')) {
        const at = offset ?? runLength(drawing, run) / 2;
        const nodeId = addFlangeJoint(drawing, run.id, at, kind as FlangeKind);
        if (!nodeId) return fail('The flange has to sit part way along the run.');
        const tail = drawing.runs.find((r) => r.from === nodeId && r.id !== run.id);
        if (tail) next.lastRun = tail.id;
        applied += 1;
        return;
      }
      // A spectacle blind bolts between flanges; everything else follows the
      // drawing's default end preparation.
      const ends = kind === 'SPECTACLE' ? 'FLG' : undefined;
      addComponent(drawing, run.id, kind, offset, ends);
      applied += 1;
      return;
    }

    // Routing.
    const axis = AXIS_ALIAS[head];
    if (axis) {
      const length = tokens[1] === undefined ? null : parseLength(tokens[1], 0);
      if (length === null) return fail(`${head} needs a length in mm, for example '${head} 1500'.`);
      if (length <= 0) return fail('Length must be greater than zero.');
      if (!next.currentNode) next.currentNode = ensureNode(drawing, { e: 0, n: 0, u: 0 });
      const result = route(drawing, next.currentNode, axis, length, next.dn, next.schedule);
      if (!result) return fail('Could not route from the current point.');
      next.currentNode = result.nodeId;
      if (result.run) next.lastRun = result.run.id;
      applied += 1;
      return;
    }

    fail(`Unrecognised command '${tokens[0]}'.`);
  });

  return { state: next, errors, applied };
}

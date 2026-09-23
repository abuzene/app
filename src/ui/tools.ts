import type { ComponentKind, FlangeKind, JointType, Run, TerminalKind } from '../model/types';
import type { Host } from './types';
import { COMPONENT_LABEL, TERMINAL_LABEL, dimensionStops, isValve, oletEntries, oletLegs, oletMarks, terminalTakeoutOf } from '../model/drawing';
import { addComponent, addEquipment, addFlangeJoint, applyReducer, runLength, setTerminal, splitRun } from '../model/edit';
import { axisBetween } from '../model/iso';
import { DN_LIST, componentTakeout, fittingTakeout, sizeLabel } from '../model/pipe-data';
import { isFlange } from '../render/symbols';
import { componentSymbol, jointMark, oletSymbol, type Frame } from '../render/symbols';

/** Branch fittings act on the header, they do not sit in the line. */
type BranchTool = { branch: 'TEE' } | { olet: JointType } | { weld: 'BW' } | { equipment: true } | { measure: true };
type Tool = ComponentKind | BranchTool;

function isBranch(tool: Tool): tool is BranchTool {
  return typeof tool === 'object';
}

interface ToolGroup {
  label: string;
  kinds: Tool[];
}

const GROUPS: ToolGroup[] = [
  { label: 'Flanges', kinds: ['FLG_WN', 'FLG_SW', 'FLG_THD', 'FLG_BLIND'] },
  { label: 'Fittings', kinds: ['RED_CONC', 'RED_ECC', 'CAP', 'TRANSITION'] },
  { label: 'Valves', kinds: ['BALL', 'BALL_ACT'] },
  { label: 'Branch', kinds: [{ branch: 'TEE' }, { olet: 'BW' }, { olet: 'SW' }, { olet: 'THD' }] },
  { label: 'Marks', kinds: ['SUPPORT', 'SUPPORT_L', 'GROUND', { equipment: true }, { measure: true }] },
  { label: 'Joints', kinds: [{ weld: 'BW' }] },
];

const SHORT: Partial<Record<ComponentKind, string>> = {
  BALL: 'Ball',
  BALL_ACT: 'Ball air',
  FLG_WN: 'WN',
  FLG_SO: 'SO',
  FLG_SW: 'SW',
  FLG_THD: 'Thd',
  FLG_LAP: 'Lap',
  FLG_BLIND: 'Blind',
  SPECTACLE: 'Spec',
  RED_CONC: 'Conc',
  RED_ECC: 'Ecc',
  CAP: 'Cap',
  TRANSITION: 'PE/CS',
  SUPPORT: 'Support',
  SUPPORT_L: 'L50',
  GROUND: 'AG/UG',
};


const OLET_SHORT: Record<JointType, string> = { BW: 'Weldolet', SW: 'Sockolet', THD: 'Thredolet' };

/**
 * The palette draws its icons on a real isometric stub of pipe, in the same
 * frame the drawing uses, so what you pick is exactly what you get. Drawn flat
 * they looked like a different set of symbols from the ones on the sheet.
 */
const COS30 = Math.cos(Math.PI / 6);
const EAST = { x: COS30, y: 0.5 };
const NORTH = { x: COS30, y: -0.5 };
const UP = { x: 0, y: -1 };

const ICON_W = 60;
const ICON_H = 38;
const ICON_CX = 30;
const ICON_CY = 24;

function stub(dir: { x: number; y: number }, reach = 21): string {
  return (
    `<line class="icon-pipe" x1="${(ICON_CX - dir.x * reach).toFixed(1)}" y1="${(ICON_CY - dir.y * reach).toFixed(1)}" ` +
    `x2="${(ICON_CX + dir.x * reach).toFixed(1)}" y2="${(ICON_CY + dir.y * reach).toFixed(1)}"/>`
  );
}

function iconSvg(inner: string): string {
  return `<svg viewBox="0 0 ${ICON_W} ${ICON_H}" aria-hidden="true">${inner}</svg>`;
}

/** The palette icons are the drawing symbols themselves, so nothing can drift. */
function icon(kind: ComponentKind): string {
  const f: Frame = {
    cx: ICON_CX,
    cy: ICON_CY,
    dx: EAST.x,
    dy: EAST.y,
    nx: NORTH.x,
    ny: NORTH.y,
    ux: UP.x,
    uy: UP.y,
    s: 5.2,
  };
  return iconSvg(stub(EAST) + componentSymbol(kind, f));
}

/** A dimension between two points. */
function measureIcon(): string {
  return (
    `<svg class="tool-icon" viewBox="0 0 48 48" aria-hidden="true">` +
    `<line x1="8" y1="34" x2="40" y2="34" stroke="currentColor" stroke-width="1.6"/>` +
    `<line x1="8" y1="26" x2="8" y2="40" stroke="currentColor" stroke-width="1.6"/>` +
    `<line x1="40" y1="26" x2="40" y2="40" stroke="currentColor" stroke-width="1.6"/>` +
    `<text x="24" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">1500</text>` +
    `</svg>`
  );
}

/** A dashed box with a name in it. */
function equipmentIcon(): string {
  return (
    `<svg class="tool-icon" viewBox="0 0 48 48" aria-hidden="true">` +
    `<polygon class="sym-dashed" points="6,30 24,40 42,30 24,20" style="stroke-dasharray:3 2"/>` +
    `<text x="24" y="15" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor">P-101</text>` +
    `</svg>`
  );
}

/** An olet on a length of header, branch going up. */
function oletIcon(): string {
  const f: Frame = {
    cx: ICON_CX,
    cy: ICON_CY + 5,
    dx: UP.x,
    dy: UP.y,
    nx: NORTH.x,
    ny: NORTH.y,
    ux: EAST.x,
    uy: EAST.y,
    s: 5.2,
  };
  return iconSvg(
    `<line class="icon-pipe" x1="${(ICON_CX - EAST.x * 20).toFixed(1)}" y1="${(ICON_CY + 5 - EAST.y * 20).toFixed(1)}" x2="${(ICON_CX + EAST.x * 20).toFixed(1)}" y2="${(ICON_CY + 5 + EAST.y * 20).toFixed(1)}"/>` +
      `<line class="sym-line" x1="${ICON_CX}" y1="${ICON_CY + 5}" x2="${ICON_CX}" y2="${ICON_CY - 13}"/>` +
      oletSymbol(f),
  );
}

/** A butt weld in a straight length of pipe: pipe to pipe. */
function weldIcon(): string {
  const f: Frame = {
    cx: ICON_CX,
    cy: ICON_CY,
    dx: EAST.x,
    dy: EAST.y,
    nx: NORTH.x,
    ny: NORTH.y,
    ux: UP.x,
    uy: UP.y,
    s: 5.2,
  };
  return iconSvg(stub(EAST) + jointMark(f, 'BW'));
}

/** A tee: a branch off a header, with a joint mark on each of its three ends. */
function teeIcon(): string {
  const cy = ICON_CY + 5;
  const frame = (dx: number, dy: number, at: number): Frame => ({
    cx: ICON_CX + dx * at,
    cy: cy + dy * at,
    dx,
    dy,
    nx: NORTH.x,
    ny: NORTH.y,
    ux: UP.x,
    uy: UP.y,
    s: 4.2,
  });
  return iconSvg(
    `<line class="icon-pipe" x1="${(ICON_CX - EAST.x * 20).toFixed(1)}" y1="${(cy - EAST.y * 20).toFixed(1)}" x2="${(ICON_CX + EAST.x * 20).toFixed(1)}" y2="${(cy + EAST.y * 20).toFixed(1)}"/>` +
      `<line class="sym-line" x1="${ICON_CX}" y1="${cy}" x2="${ICON_CX}" y2="${cy - 15}"/>` +
      jointMark(frame(EAST.x, EAST.y, -10), 'BW') +
      jointMark(frame(-EAST.x, -EAST.y, -10), 'BW') +
      jointMark(frame(UP.x, UP.y, -9), 'BW'),
  );
}

/** Kinds that can close or terminate a line rather than sit along it. */
const TERMINATING: ComponentKind[] = ['FLG_WN', 'FLG_SO', 'FLG_SW', 'FLG_THD', 'FLG_LAP', 'FLG_BLIND', 'CAP', 'TRANSITION'];

/** The run a newly picked component should be added to. */
function targetRun(host: Host): Run | null {
  const { drawing, selection } = host.state;
  if (selection?.kind === 'run') {
    return drawing.runs.find((r) => r.id === selection.id) ?? null;
  }
  if (selection?.kind === 'component') {
    return drawing.runs.find((r) => r.inline.some((c) => c.id === selection.id)) ?? null;
  }
  if (selection?.kind === 'node') {
    const touching = drawing.runs.filter((r) => r.from === selection.id || r.to === selection.id);
    if (touching.length >= 1) return touching[0];
  }
  return drawing.runs.length === 1 ? drawing.runs[0] : null;
}

/** Anything the palette can be applied to right now. */
function hasTarget(host: Host): boolean {
  return host.state.selection?.kind === 'node' || targetRun(host) !== null;
}

/**
 * A reducer is asked about before it goes in: its two sizes and which way
 * round. On an open end it sits with its far face on the end, and drawing
 * can carry on from there at the new size; along a run it sits at the
 * middle and the run is cut at its far face, so the pipe beyond is the new
 * size. The pipe either side is made the size of the end it meets.
 */
async function placeReducer(host: Host, kind: 'RED_CONC' | 'RED_ECC'): Promise<void> {
  const { selection, analysis } = host.state;
  const info = selection?.kind === 'node' ? analysis.nodeInfo.get(selection.id) : undefined;
  const endNode = info && info.degree === 1 ? info.node : null;
  const run = endNode ? info!.runs[0] : targetRun(host);
  if (!run) {
    host.notify('Select the end of the line, or a run, first.');
    return;
  }
  const large = run.dn;
  const at = DN_LIST.indexOf(large);
  const small = DN_LIST[Math.max(0, at - 1)] ?? large;
  // On an end that already wears a flange, the reducer sits against it.
  const terminal = endNode?.terminal?.kind;
  const against = terminal && terminal !== 'OPEN' && terminal !== 'CONTINUATION' && terminal !== 'EQUIPMENT' ? TERMINAL_LABEL[terminal] ?? terminal : undefined;
  const choice = await host.reducerDialog({ kind, large, small, atEnd: !!endNode, drawOn: !!endNode && !against, against });
  if (!choice) return;
  const half = componentTakeout(kind, choice.large);
  const outward = choice.largeOutward ? choice.large : choice.small;
  let addedId: string | null = null;
  let continueAt: string | null = null;
  host.edit(`Add ${kind === 'RED_ECC' ? 'ECC RED' : 'CON RED'}`, (d) => {
    const target = d.runs.find((r) => r.id === run.id);
    if (!target) return;
    const total = runLength(d, target);
    if (endNode) {
      // Its far face on the open end, or against the flange there; the large
      // end inward unless expanding. Its near face is a point of its own, so
      // the line can be picked up at either end of it.
      const atStart = target.from === endNode.id;
      const back = terminalTakeoutOf(endNode.terminal?.kind, outward);
      const near = back + half * 2;
      if (near > total + 0.5) return;
      const offset = atStart ? back + half : total - back - half;
      const comp = addComponent(d, target.id, kind, offset);
      if (!comp) return;
      addedId = comp.id;
      if (near < total - 0.5) splitRun(d, target.id, atStart ? near : total - near);
      // "Large outward" means the large end at the open end: on the run's
      // start side when the open end is the start, else on its end side.
      const flip = atStart ? !choice.largeOutward : choice.largeOutward;
      applyReducer(d, comp.id, choice.large, choice.small, flip);
      continueAt = endNode.id;
      return;
    }
    const comp = addComponent(d, target.id, kind, total / 2);
    if (!comp) return;
    addedId = comp.id;
    // The run is cut at both faces: each is a point the line can be picked
    // up at, and the pipe beyond the far one is its own size.
    const far = comp.offset + half;
    const nearFace = comp.offset - half;
    if (far < total - 0.5) splitRun(d, target.id, far);
    if (nearFace > 0.5) splitRun(d, target.id, nearFace);
    applyReducer(d, comp.id, choice.large, choice.small, choice.largeOutward);
  });
  if (!addedId) {
    host.notify('The run is too short for a reducer.');
    return;
  }
  if (continueAt && choice.drawOn) {
    host.continueFrom(continueAt);
    host.setCurrentSize(outward);
    host.notify(`Carry on drawing at ${sizeLabel(outward)} from the reducer.`);
  } else {
    host.select({ kind: 'component', id: addedId });
  }
}

/**
 * Puts a picked item where it is meant to go.
 *
 * A flange or a cap picked with the end of the line selected terminates that
 * line — it does not land half way along the last run, which is never what is
 * meant. Picked against a point in the middle of a route it sits at that point;
 * picked against a run it sits along that run.
 */
function place(host: Host, kind: ComponentKind): void {
  const { selection, analysis } = host.state;
  const label = COMPONENT_LABEL[kind] ?? kind;

  if (kind === 'RED_CONC' || kind === 'RED_ECC') {
    void placeReducer(host, kind);
    return;
  }

  if (selection?.kind === 'node') {
    const info = analysis.nodeInfo.get(selection.id);
    const nodeId = selection.id;

    if (info && info.degree <= 1 && TERMINATING.includes(kind)) {
      host.edit(`End with ${label}`, (d) => setTerminal(d, nodeId, kind as TerminalKind));
      // Ending with a flange ends the line: the pencil is put down, so the
      // next tap does not draw on from it. The line can still carry on later,
      // by drawing from the point again — another flange bolts to this one.
      host.stopDrawing();
      host.select({ kind: 'node', id: nodeId });
      return;
    }
    if (kind === 'TRANSITION') {
      host.notify('A PE/CS transition goes on the end of the steel — pick the end point first.');
      return;
    }

    // A flange on a point the line runs straight through makes that point a
    // flanged joint. On a corner or a branch it has to sit on a point of its
    // own a little way along, since a flange is a break in the pipe.
    if (info && isFlange(kind)) {
      if (kind === 'FLG_BLIND') {
        host.notify('A blind closes the end of a line — select the end point first.');
        return;
      }
      if (info.fitting === 'NONE' && info.degree === 2) {
        host.edit(`Flange joint: ${label}`, (d) => {
          const node = d.nodes.find((n) => n.id === nodeId);
          if (node) node.flange = kind;
        });
        host.select({ kind: 'node', id: nodeId });
        return;
      }
      const run = info.runs[0];
      if (run) {
        placeFlangeOnRun(host, run, kind, run.from === nodeId ? 'start' : 'end', fittingTakeout(info.fitting, run.dn));
        return;
      }
    }

    // A point part way along the route: sit the item against that point.
    const run = info?.runs[0];
    if (run) {
      let addedId: string | null = null;
      host.edit(`Add ${label}`, (d) => {
        const target = d.runs.find((r) => r.id === run.id);
        if (!target) return;
        const offset = target.from === nodeId ? 0 : runLength(d, target);
        const comp = addComponent(d, target.id, kind, offset, kind === 'SPECTACLE' ? 'FLG' : undefined);
        addedId = comp?.id ?? null;
      });
      if (addedId) host.select({ kind: 'component', id: addedId });
      return;
    }
  }

  const run = targetRun(host);
  if (!run) {
    host.notify('Select the end of the line, a point, or a run first.');
    return;
  }
  if (kind === 'TRANSITION') {
    host.notify('A PE/CS transition goes on the end of the steel — pick the end point first.');
    return;
  }
  if (isFlange(kind)) {
    if (kind === 'FLG_BLIND') {
      host.notify('A blind closes the end of a line — select the end point first.');
      return;
    }
    placeFlangeOnRun(host, run, kind, 'middle', 0);
    return;
  }
  let addedId: string | null = null;
  host.edit(`Add ${label}`, (d) => {
    const comp = addComponent(d, run.id, kind, undefined, kind === 'SPECTACLE' ? 'FLG' : undefined);
    addedId = comp?.id ?? null;
  });
  if (addedId) {
    host.select({ kind: 'component', id: addedId });
    // A valve is placed by the pipe up to its face; the rest follows.
    if (isValve(kind)) {
      const d = host.state.drawing;
      const target = d.runs.find((r) => r.id === run.id);
      const comp = target?.inline.find((c) => c.id === addedId);
      if (target && comp) {
        const face = comp.offset - componentTakeout(comp.kind, comp.dn ?? target.dn, false);
        const stops = dimensionStops(d, target);
        const index = stops.findIndex((mm, i) => i > 0 && Math.abs(mm - face) < 0.5) - 1;
        host.editDimension(`${run.id}:${Math.max(0, index)}`);
      }
    }
  }
}

/**
 * Breaks a run with a flanged joint. Against a fitting at one end it sits
 * just clear of the fitting, with room for the flange itself; otherwise it
 * lands in the middle. Either way it slides along the run afterwards.
 */
function placeFlangeOnRun(host: Host, run: Run, kind: FlangeKind, where: 'start' | 'middle' | 'end', clearOf: number): void {
  const d = host.state.drawing;
  const total = runLength(d, run);
  const snap = Math.max(1, d.options.snap);
  const room = clearOf + componentTakeout(kind, run.dn) + snap;
  let at = total / 2;
  if (where === 'start') at = Math.min(total / 2, Math.ceil(room / snap) * snap);
  if (where === 'end') at = Math.max(total / 2, total - Math.ceil(room / snap) * snap);
  if (at <= 0 || at >= total) {
    host.notify('The run is too short to take a flange there.');
    return;
  }
  let nodeId: string | null = null;
  host.edit(`Add ${COMPONENT_LABEL[kind]}`, (dd) => {
    nodeId = addFlangeJoint(dd, run.id, at, kind);
  });
  if (nodeId) {
    host.select({ kind: 'node', id: nodeId });
    openDimensionUpTo(host, nodeId);
  } else {
    host.notify('The run is too short to take a flange there.');
  }
}

/**
 * Opens a branch on the header: the run is broken at that point so the branch
 * has somewhere to leave from, and the fitting is set on the new point.
 *
 * A tee is cut into the header and takes length out of all three legs; an olet
 * is welded to its wall and takes nothing from the header at all. Either way
 * the branch itself is drawn next, by dragging from the point.
 */
function placeBranch(host: Host, tool: BranchTool): void {
  if ('olet' in tool) {
    void placeOlet(host, tool.olet);
    return;
  }
  const run = targetRun(host);
  if (!run) {
    host.notify('Select the header run first, then pick a branch fitting.');
    return;
  }
  void placeTee(host, run);
}

/**
 * A tee is cut into the header. Equal, or reducing with a smaller branch:
 * asked first, then the branch is drawn from the new point at that size,
 * which is what makes it the one or the other. The dimension up to the tee
 * opens for typing; dragging the point slides it along the header.
 */
async function placeTee(host: Host, run: Run): Promise<void> {
  const { drawing } = host.state;
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  const choice = await host.oletDialog({ kind: 'tee', joint: 'BW', header: run.dn, along: a && b ? axisBetween(a.pos, b.pos) : null });
  if (!choice) return;
  const at = runLength(host.state.drawing, run) / 2;
  let nodeId: string | null = null;
  host.edit('Add tee', (d) => {
    nodeId = splitRun(d, run.id, at);
    if (!nodeId) return;
    const node = d.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    // A tee is what connectivity infers anyway, and it works out equal or
    // reducing from the branch size once the branch is drawn.
    node.fittingOverride = undefined;
    node.joint = undefined;
  });
  if (!nodeId) {
    host.notify('The run is too short for a tee.');
    return;
  }
  // The route is left ready at the new point, so the branch is drawn by
  // tapping where it goes, at the branch size picked.
  host.continueFrom(nodeId);
  host.setCurrentSize(choice.dn);
  host.notify(`Tap where the branch goes: ${sizeLabel(choice.dn)} off the tee.`);
  openDimensionUpTo(host, nodeId);
}

/**
 * An olet rides on the header: it is welded to the wall and takes nothing
 * from the pipe, which stays one length. It is placed first — which way its
 * branch will go and what size — and waits there; the branch is drawn from
 * it whenever wanted, at that size. A plain point along a line becomes the
 * olet itself; a run picked is marked at its middle, and the dimension up to
 * it opens for typing.
 */
async function placeOlet(host: Host, joint: JointType): Promise<void> {
  const { selection, analysis, drawing } = host.state;
  const info = selection?.kind === 'node' ? analysis.nodeInfo.get(selection.id) : undefined;
  // A second olet on a point that already has one leaves another way.
  const onOlet = info && info.fitting === 'OLET' ? oletLegs(info) : null;
  const onNode = onOlet ? info!.node : info && info.degree === 2 && info.fitting === 'NONE' && !info.node.flange ? info.node : null;
  const run = onOlet ? onOlet.header[0] : onNode ? info!.runs[0] : targetRun(host);
  if (!run) {
    host.notify('Select the header run first, then pick the olet.');
    return;
  }
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  const taken = onOlet ? oletEntries(onOlet).map((entry) => entry.dir) : [];
  const choice = await host.oletDialog({ joint, header: run.dn, along: a && b ? axisBetween(a.pos, b.pos) : null, taken });
  if (!choice) return;
  let nodeId: string | null = onNode?.id ?? null;
  host.edit(`Add ${OLET_SHORT[joint].toLowerCase()}`, (d) => {
    if (!nodeId) nodeId = splitRun(d, run.id, runLength(d, run) / 2);
    const node = nodeId ? d.nodes.find((n) => n.id === nodeId) : undefined;
    if (!node) return;
    node.fittingOverride = 'OLET';
    node.joint = joint;
    node.olets = [...oletMarks(node), { dir: choice.dir, dn: choice.dn }];
    node.olet = undefined;
  });
  if (!nodeId) {
    host.notify('The run is too short for an olet.');
    return;
  }
  host.select({ kind: 'node', id: nodeId });
  if (!onNode) openDimensionUpTo(host, nodeId);
}

/** A dashed equipment box on the picked point, named there and then in its panel. */
function placeEquipment(host: Host): void {
  const { selection, analysis } = host.state;
  const info = selection?.kind === 'node' ? analysis.nodeInfo.get(selection.id) : undefined;
  if (!info) {
    host.notify('Select the point the equipment stands at, then pick Equipment.');
    return;
  }
  let id: string | null = null;
  host.edit('Add equipment', (d) => {
    id = addEquipment(d, info.node.id, 'EQUIPMENT')?.id ?? null;
  });
  if (id) host.select({ kind: 'equipment', id });
}

/**
 * Something put into a drawn line is placed by typing the length up to it;
 * the far side takes the rest. So the piece ending at the new point opens.
 */
/**
 * A butt weld in a straight length of pipe — where two lengths are joined,
 * a shop or field splice. The run is cut in two at the middle with a plain
 * point between, which the analysis welds pipe to pipe; the dimension up
 * to it opens for typing, and the point slides along the line by dragging.
 */
function placeWeld(host: Host): void {
  const run = targetRun(host);
  if (!run) {
    host.notify('Select the run to put the weld in first.');
    return;
  }
  const at = runLength(host.state.drawing, run) / 2;
  let nodeId: string | null = null;
  host.edit('Add weld', (d) => {
    nodeId = splitRun(d, run.id, at);
    const node = nodeId ? d.nodes.find((n) => n.id === nodeId) : undefined;
    if (node) {
      node.fittingOverride = undefined;
      node.joint = 'BW';
    }
  });
  if (!nodeId) {
    host.notify('The run is too short to cut there.');
    return;
  }
  host.select({ kind: 'node', id: nodeId });
  openDimensionUpTo(host, nodeId);
}

function openDimensionUpTo(host: Host, nodeId: string): void {
  // An olet on a header is placed by its own dimension from the header's start.
  if (host.state.analysis.chains.some((c) => c.olets.some((o) => o.nodeId === nodeId))) {
    host.editDimension(`olet:${nodeId}`);
    return;
  }
  const before = host.state.drawing.runs.find((r) => r.to === nodeId);
  if (!before) return;
  const stops = dimensionStops(host.state.drawing, before);
  host.editDimension(`${before.id}:${Math.max(0, stops.length - 2)}`);
}

export function renderTools(container: HTMLElement, host: Host): void {
  const enabled = hasTarget(host);
  container.innerHTML = GROUPS.map(
    (group) =>
      `<div class="tool-group-label">${group.label}</div>` +
      group.kinds
        .map((tool) => {
          if (isBranch(tool)) {
            if ('measure' in tool) {
              return (
                `<button class="tool" data-measure="1" title="A dimension between two points: pick one, then tap the other"${enabled ? '' : ' disabled'}>` +
                measureIcon() +
                `<span class="tool-name">Dimension</span>` +
                `</button>`
              );
            }
            if ('equipment' in tool) {
              return (
                `<button class="tool" data-equipment="1" title="Equipment box: a dashed outline with a name"${enabled ? '' : ' disabled'}>` +
                equipmentIcon() +
                `<span class="tool-name">Equipment</span>` +
                `</button>`
              );
            }
            if ('weld' in tool) {
              return (
                `<button class="tool" data-weld="BW" title="Butt weld in the pipe"${enabled ? '' : ' disabled'}>` +
                weldIcon() +
                `<span class="tool-name">Weld</span>` +
                `</button>`
              );
            }
            const olet = 'olet' in tool;
            const name = olet ? OLET_SHORT[tool.olet] : 'Tee';
            const attr = olet ? `data-olet="${tool.olet}"` : 'data-branch="TEE"';
            return (
              `<button class="tool" ${attr} title="${name}"${enabled ? '' : ' disabled'}>` +
              (olet ? oletIcon() : teeIcon()) +
              `<span class="tool-name">${name}</span>` +
              `</button>`
            );
          }
          return (
            `<button class="tool" data-kind="${tool}" title="${COMPONENT_LABEL[tool]}"${enabled ? '' : ' disabled'}>` +
            icon(tool) +
            `<span class="tool-name">${SHORT[tool] ?? tool}</span>` +
            `</button>`
          );
        })
        .join(''),
  ).join('');

  container.querySelectorAll<HTMLButtonElement>('.tool').forEach((button) => {
    button.addEventListener('click', () => {
      const olet = button.dataset.olet as JointType | undefined;
      if (button.dataset.weld) placeWeld(host);
      else if (button.dataset.equipment) placeEquipment(host);
      else if (button.dataset.measure) {
        const sel = host.state.selection;
        if (sel?.kind === 'node') host.measureFrom(sel.id);
        else host.notify('Pick the first point, then Dimension, then tap the other point.');
      }
      else if (olet) placeBranch(host, { olet });
      else if (button.dataset.branch === 'TEE') placeBranch(host, { branch: 'TEE' });
      else place(host, button.dataset.kind as ComponentKind);
    });
  });
}

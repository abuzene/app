import type { ComponentKind, FlangeKind, JointType, Run, TerminalKind } from '../model/types';
import type { Host } from './types';
import { COMPONENT_LABEL, dimensionStops, isValve } from '../model/drawing';
import { addComponent, addFlangeJoint, runLength, splitRun } from '../model/edit';
import { componentTakeout, fittingTakeout } from '../model/pipe-data';
import { isFlange } from '../render/symbols';
import { componentSymbol, jointMark, oletSymbol, type Frame } from '../render/symbols';

/** Branch fittings act on the header, they do not sit in the line. */
type BranchTool = { branch: 'TEE' } | { olet: JointType };
type Tool = ComponentKind | BranchTool;

function isBranch(tool: Tool): tool is BranchTool {
  return typeof tool === 'object';
}

interface ToolGroup {
  label: string;
  kinds: Tool[];
}

const GROUPS: ToolGroup[] = [
  { label: 'Flanges', kinds: ['FLG_WN', 'FLG_SO', 'FLG_SW', 'FLG_THD', 'FLG_LAP', 'FLG_BLIND'] },
  { label: 'Fittings', kinds: ['RED_CONC', 'RED_ECC', 'CAP'] },
  { label: 'Valves', kinds: ['BALL', 'BALL_ACT'] },
  { label: 'Branch', kinds: [{ branch: 'TEE' }, { olet: 'BW' }, { olet: 'SW' }, { olet: 'THD' }] },
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
const TERMINATING: ComponentKind[] = ['FLG_WN', 'FLG_SO', 'FLG_SW', 'FLG_THD', 'FLG_LAP', 'FLG_BLIND', 'CAP'];

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

  if (selection?.kind === 'node') {
    const info = analysis.nodeInfo.get(selection.id);
    const nodeId = selection.id;

    if (info && info.degree <= 1 && TERMINATING.includes(kind)) {
      host.edit(`End with ${label}`, (d) => {
        const node = d.nodes.find((n) => n.id === nodeId);
        if (node) node.terminal = { kind: kind as TerminalKind, note: node.terminal?.note };
      });
      // The line can carry on past a flange, by bolting another to it: the
      // route stays ready here. A cap or a blind closes the line for good.
      if (kind !== 'CAP' && kind !== 'FLG_BLIND') host.continueFrom(nodeId);
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
        host.editDimension(run.id, Math.max(0, index));
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
  const run = targetRun(host);
  if (!run) {
    host.notify('Select the header run first, then pick a branch fitting.');
    return;
  }
  const isOlet = 'olet' in tool;
  const label = isOlet ? OLET_SHORT[tool.olet].toLowerCase() : 'tee';
  const at = runLength(host.state.drawing, run) / 2;
  let nodeId: string | null = null;
  host.edit(`Add ${label}`, (d) => {
    nodeId = splitRun(d, run.id, at);
    if (!nodeId) return;
    const node = d.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (isOlet) {
      node.fittingOverride = 'OLET';
      node.joint = tool.olet;
    } else {
      // A tee is what connectivity infers anyway, and it works out equal or
      // reducing from the branch size once the branch is drawn.
      node.fittingOverride = undefined;
      node.joint = undefined;
    }
  });
  if (nodeId) {
    // The route is left ready at the new point, so the branch is drawn by
    // clicking where it goes. Dragging the point instead slides it along the
    // header, which is how it gets to where it actually belongs.
    host.continueFrom(nodeId);
    openDimensionUpTo(host, nodeId);
  }
}

/**
 * Something put into a drawn line is placed by typing the length up to it;
 * the far side takes the rest. So the piece ending at the new point opens.
 */
function openDimensionUpTo(host: Host, nodeId: string): void {
  const before = host.state.drawing.runs.find((r) => r.to === nodeId);
  if (!before) return;
  const stops = dimensionStops(host.state.drawing, before);
  host.editDimension(before.id, Math.max(0, stops.length - 2));
}

export function renderTools(container: HTMLElement, host: Host): void {
  const enabled = hasTarget(host);
  container.innerHTML = GROUPS.map(
    (group) =>
      `<div class="tool-group-label">${group.label}</div>` +
      group.kinds
        .map((tool) => {
          if (isBranch(tool)) {
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
      if (olet) placeBranch(host, { olet });
      else if (button.dataset.branch === 'TEE') placeBranch(host, { branch: 'TEE' });
      else place(host, button.dataset.kind as ComponentKind);
    });
  });
}

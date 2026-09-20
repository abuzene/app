import type { ComponentKind, JointType, Run, TerminalKind } from '../model/types';
import type { Host } from './types';
import { COMPONENT_LABEL } from '../model/drawing';
import { addComponent, runLength, splitRun } from '../model/edit';
import { componentSymbol, oletSymbol, type Frame } from '../render/symbols';

/** Olets are fittings on the header, not items sitting in the line. */
type OletTool = { olet: JointType };
type Tool = ComponentKind | OletTool;

function isOlet(tool: Tool): tool is OletTool {
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
  { label: 'Branch', kinds: [{ olet: 'BW' }, { olet: 'SW' }, { olet: 'THD' }] },
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

/** The olet icon shows the saddle on a length of header, branch going up. */
function oletIcon(): string {
  const f: Frame = { cx: 29, cy: 26, dx: 0, dy: -1, nx: 1, ny: 0, s: 7 };
  return (
    `<svg viewBox="0 0 58 36" aria-hidden="true">` +
    `<line class="icon-pipe" x1="4" y1="26" x2="54" y2="26"/>` +
    `<line class="sym-line" x1="29" y1="26" x2="29" y2="5"/>` +
    oletSymbol(f) +
    `</svg>`
  );
}

/** The palette icons are the drawing symbols themselves, so nothing can drift. */
function icon(kind: ComponentKind): string {
  // The frame leaves headroom for the symbols that carry a stem and actuator.
  const f: Frame = { cx: 29, cy: 21, dx: 1, dy: 0, nx: 0, ny: 1, s: 7 };
  // A stub of pipe gives the compact symbols — flanges, reducers — something to
  // read against, exactly as they appear on the drawing.
  const stub = `<line class="icon-pipe" x1="4" y1="${f.cy}" x2="54" y2="${f.cy}"/>`;
  return `<svg viewBox="0 0 58 36" aria-hidden="true">${stub}${componentSymbol(kind, f)}</svg>`;
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
      return;
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
  let addedId: string | null = null;
  host.edit(`Add ${label}`, (d) => {
    const comp = addComponent(d, run.id, kind, undefined, kind === 'SPECTACLE' ? 'FLG' : undefined);
    addedId = comp?.id ?? null;
  });
  if (addedId) host.select({ kind: 'component', id: addedId });
}

/**
 * Puts an olet on the header: the run is broken at that point so the branch has
 * somewhere to leave from, but the header is still one pipe as far as the cut
 * lengths and the take-off are concerned.
 */
function placeOlet(host: Host, joint: JointType): void {
  const run = targetRun(host);
  if (!run) {
    host.notify('Select the header run first, then pick an olet.');
    return;
  }
  const at = runLength(host.state.drawing, run) / 2;
  let nodeId: string | null = null;
  host.edit(`Add ${OLET_SHORT[joint].toLowerCase()}`, (d) => {
    nodeId = splitRun(d, run.id, at);
    if (!nodeId) return;
    const node = d.nodes.find((n) => n.id === nodeId);
    if (node) {
      node.fittingOverride = 'OLET';
      node.joint = joint;
    }
  });
  if (nodeId) {
    host.select({ kind: 'node', id: nodeId });
    host.notify('Now drag from the olet to route the branch.');
  }
}

export function renderTools(container: HTMLElement, host: Host): void {
  const enabled = hasTarget(host);
  container.innerHTML = GROUPS.map(
    (group) =>
      `<div class="tool-group-label">${group.label}</div>` +
      group.kinds
        .map((tool, i) => {
          if (isOlet(tool)) {
            return (
              `<button class="tool" data-olet="${tool.olet}" title="${OLET_SHORT[tool.olet]}"${enabled ? '' : ' disabled'}>` +
              oletIcon() +
              `<span class="tool-name">${OLET_SHORT[tool.olet]}</span>` +
              `</button>`
            );
          }
          void i;
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
      if (olet) placeOlet(host, olet);
      else place(host, button.dataset.kind as ComponentKind);
    });
  });
}

import type { ComponentKind, Run, TerminalKind } from '../model/types';
import type { Host } from './types';
import { COMPONENT_LABEL } from '../model/drawing';
import { addComponent, runLength } from '../model/edit';
import { componentSymbol, type Frame } from '../render/symbols';

interface ToolGroup {
  label: string;
  kinds: ComponentKind[];
}

const GROUPS: ToolGroup[] = [
  { label: 'Flanges', kinds: ['FLG_WN', 'FLG_SO', 'FLG_SW', 'FLG_THD', 'FLG_LAP', 'FLG_BLIND'] },
  { label: 'Fittings', kinds: ['RED_CONC', 'RED_ECC', 'CAP'] },
  { label: 'Valves', kinds: ['BALL', 'BALL_ACT'] },
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

export function renderTools(container: HTMLElement, host: Host): void {
  const run = hasTarget(host);
  container.innerHTML = GROUPS.map(
    (group) =>
      `<div class="tool-group-label">${group.label}</div>` +
      group.kinds
        .map(
          (kind) =>
            `<button class="tool" data-kind="${kind}" title="${COMPONENT_LABEL[kind]}"${run ? '' : ' disabled'}>` +
            icon(kind) +
            `<span class="tool-name">${SHORT[kind] ?? kind}</span>` +
            `</button>`,
        )
        .join(''),
  ).join('');

  container.querySelectorAll<HTMLButtonElement>('.tool').forEach((button) => {
    button.addEventListener('click', () => {
      place(host, button.dataset.kind as ComponentKind);
    });
  });
}

import type { ComponentKind, Run } from '../model/types';
import type { Host } from './types';
import { COMPONENT_LABEL } from '../model/drawing';
import { addComponent } from '../model/edit';
import { componentSymbol, type Frame } from '../render/symbols';

interface ToolGroup {
  label: string;
  kinds: ComponentKind[];
}

const GROUPS: ToolGroup[] = [
  { label: 'Valves', kinds: ['GATE', 'GLOBE', 'BALL', 'CHECK', 'BUTTERFLY', 'CONTROL', 'RELIEF', 'PLUG', 'NEEDLE'] },
  { label: 'Flanges', kinds: ['FLG_WN', 'FLG_SO', 'FLG_SW', 'FLG_THD', 'FLG_LAP', 'FLG_BLIND', 'SPECTACLE'] },
  { label: 'Fittings', kinds: ['RED_CONC', 'RED_ECC', 'CAP', 'UNION', 'STRAINER'] },
  { label: 'Supports', kinds: ['SUPPORT', 'ANCHOR', 'GUIDE', 'INSTRUMENT'] },
];

const SHORT: Partial<Record<ComponentKind, string>> = {
  GATE: 'Gate',
  GLOBE: 'Globe',
  BALL: 'Ball',
  CHECK: 'Check',
  BUTTERFLY: 'Btfly',
  CONTROL: 'Ctrl',
  RELIEF: 'PSV',
  PLUG: 'Plug',
  NEEDLE: 'Ndl',
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
  UNION: 'Union',
  STRAINER: 'Strnr',
  SUPPORT: 'Supp',
  ANCHOR: 'Anch',
  GUIDE: 'Guide',
  INSTRUMENT: 'Inst',
};

/** The palette icons are the drawing symbols themselves, so nothing can drift. */
function icon(kind: ComponentKind): string {
  // The frame leaves headroom for the symbols that carry a stem and actuator.
  const f: Frame = { cx: 23, cy: 18, dx: 1, dy: 0, nx: 0, ny: 1, s: 5.4 };
  // A stub of pipe gives the compact symbols — flanges, reducers — something to
  // read against, exactly as they appear on the drawing.
  const stub = `<line class="icon-pipe" x1="4" y1="${f.cy}" x2="42" y2="${f.cy}"/>`;
  return `<svg viewBox="0 0 46 32" aria-hidden="true">${stub}${componentSymbol(kind, f)}</svg>`;
}

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
    if (touching.length === 1) return touching[0];
  }
  return drawing.runs.length === 1 ? drawing.runs[0] : null;
}

export function renderTools(container: HTMLElement, host: Host): void {
  const run = targetRun(host);
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
      const kind = button.dataset.kind as ComponentKind;
      const target = targetRun(host);
      if (!target) {
        host.notify('Select a run first, then pick a component.');
        return;
      }
      const ends = kind === 'SPECTACLE' ? 'FLG' : undefined;
      let addedId: string | null = null;
      host.edit(`Add ${COMPONENT_LABEL[kind]}`, (drawing) => {
        const comp = addComponent(drawing, target.id, kind, undefined, ends);
        addedId = comp?.id ?? null;
      });
      if (addedId) host.select({ kind: 'component', id: addedId });
    });
  });
}

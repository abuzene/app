import type { ComponentKind, EndType, FittingKind, FlangeKind, JointType, TerminalKind } from '../model/types';
import type { Host, TabId } from './types';
import { COMPONENT_LABEL, DEFAULT_LOGO, TERMINAL_LABEL, fittingLabel, isMark, isSupport, isValve, oletLabel, resolveEnds } from '../model/drawing';
import { COMMAND_HELP } from '../model/commands';
import { DN_LIST, SIZE_LABELS, defaultValveEnds, schedulesFor, sizeLabel } from '../model/pipe-data';
import { axisBetween } from '../model/iso';
import { projectsOf } from '../model/library';
import { deleteNode, deleteRun, removeComponent, runLength, setRunLength, splitRun } from '../model/edit';

const TABS: { id: TabId; label: string }[] = [
  { id: 'route', label: 'Route' },
  { id: 'command', label: 'Command' },
  { id: 'items', label: 'Items' },
  { id: 'welds', label: 'Welds' },
  { id: 'title', label: 'Title' },
  { id: 'projects', label: 'Projects' },
];

const TERMINALS: TerminalKind[] = ['OPEN', 'FLG_WN', 'FLG_SO', 'FLG_SW', 'FLG_THD', 'FLG_LAP', 'FLG_BLIND', 'CAP', 'TRANSITION', 'CONTINUATION', 'EQUIPMENT'];
const FITTINGS: FittingKind[] = ['ELBOW_90', 'ELBOW_45', 'BEND', 'TEE', 'TEE_REDUCING', 'CROSS', 'OLET', 'MITRE'];
const JOINTS: JointType[] = ['BW', 'SW', 'THD'];
const FLANGE_KINDS: FlangeKind[] = ['FLG_WN', 'FLG_SO', 'FLG_SW', 'FLG_THD', 'FLG_LAP'];
const JOINT_LABEL: Record<string, string> = {
  BW: 'Butt weld',
  SW: 'Socket weld',
  THD: 'Threaded',
};
const END_TYPES: EndType[] = ['BW', 'SW', 'THD', 'FLG', 'PLAIN'];
const COMPONENT_KINDS = (Object.keys(COMPONENT_LABEL) as ComponentKind[]).filter((k) => k !== 'TRANSITION');

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function options(values: string[], selected: string, labels?: Record<string, string>): string {
  return values
    .map(
      (v) =>
        `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(labels?.[v] ?? v)}</option>`,
    )
    .join('');
}

function mm(value: number): string {
  return Math.round(value).toLocaleString('en-GB');
}

export function renderTabs(nav: HTMLElement, host: Host): void {
  nav.innerHTML = TABS.map(
    (t) => `<button data-tab="${t.id}"${host.state.tab === t.id ? ' class="active"' : ''}>${t.label}</button>`,
  ).join('');
  nav.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.addEventListener('click', () => host.setTab(b.dataset.tab as TabId));
  });
}

/* ------------------------------------------------------------------ route */

function runDirection(host: Host, runId: string): string {
  const { drawing } = host.state;
  const run = drawing.runs.find((r) => r.id === runId);
  if (!run) return '—';
  const a = drawing.nodes.find((n) => n.id === run.from);
  const b = drawing.nodes.find((n) => n.id === run.to);
  if (!a || !b) return '—';
  return axisBetween(a.pos, b.pos) ?? 'SKEW';
}

function runProperties(host: Host, runId: string): string {
  const { drawing, analysis } = host.state;
  const run = drawing.runs.find((r) => r.id === runId);
  if (!run) return '';
  const lengths = analysis.runLengths.get(run.id);
  return `
<div class="section" data-editor="run" data-id="${run.id}">
  <h3>Run — ${runDirection(host, run.id)}</h3>
  <div class="row"><label>Length</label><input type="number" data-f="length" step="1" min="1" value="${Math.round(lengths?.centre ?? 0)}" /></div>
  <div class="row"><label>Size</label><select data-f="dn">${options(DN_LIST, run.dn, SIZE_LABELS)}</select></div>
  <div class="row"><label>Schedule</label><select data-f="schedule">${options(schedulesFor(run.dn), run.schedule)}</select></div>
  <div class="row"><label>Note</label><input type="text" data-f="note" value="${esc(run.note ?? '')}" placeholder="optional" /></div>
  <div class="row"><label>Dimension</label><select data-f="nodim">${options(['show', 'hide'], run.noDim ? 'hide' : 'show')}</select></div>
  <p class="empty-note">Cut length after take-outs: <strong>${mm(lengths?.cut ?? 0)} mm</strong></p>
  <div class="btn-row">
    <button class="btn-line" data-a="split">Split in half</button>
    <button class="btn-line danger" data-a="delete-run">Delete run</button>
  </div>
</div>`;
}

/**
 * For a point the line runs straight through — a tee, an olet, a flange, a
 * plain joint — the two lengths either side of it. Setting one slides the
 * point and the other takes up the difference, which is how something put
 * into a drawn line is placed where it belongs.
 */
function alongLine(host: Host, nodeId: string): string {
  const { drawing, analysis } = host.state;
  const info = analysis.nodeInfo.get(nodeId);
  if (!info) return '';
  for (let i = 0; i < info.legs.length; i += 1) {
    for (let j = i + 1; j < info.legs.length; j += 1) {
      const a = info.legs[i];
      const b = info.legs[j];
      if (a.e * b.e + a.n * b.n + a.u * b.u > -0.999) continue;
      const back = info.runs[i];
      const on = info.runs[j];
      const len = (r: import('../model/types').Run) => Math.round(analysis.runLengths.get(r.id)?.centre ?? runLength(drawing, r));
      return `
  <div class="row"><label>Before</label><input type="number" data-slide="${back.id}" data-node="${nodeId}" step="1" min="1" value="${len(back)}" /></div>
  <div class="row"><label>After</label><input type="number" data-slide="${on.id}" data-node="${nodeId}" step="1" min="1" value="${len(on)}" /></div>`;
    }
  }
  return '';
}

function nodeProperties(host: Host, nodeId: string): string {
  const { drawing, analysis } = host.state;
  const node = drawing.nodes.find((n) => n.id === nodeId);
  if (!node) return '';
  const info = analysis.nodeInfo.get(nodeId);
  const isEnd = (info?.degree ?? 0) <= 1;
  const fitting = info?.fitting ?? 'NONE';

  const isOlet = fitting === 'OLET';
  const nodeJoint = node.joint ?? host.state.drawing.options.joint;
  const straight = fitting === 'NONE' && (info?.degree ?? 0) === 2;
  const flanged = straight && !!node.flange;
  const heading = isOlet
    ? oletLabel(nodeJoint)
    : flanged
      ? `flanged joint — ${COMPONENT_LABEL[node.flange!] ?? node.flange}`
      : fitting === 'NONE'
        ? isEnd
          ? 'line end'
          : 'joint'
        : fittingLabel(fitting);

  return `
<div class="section" data-editor="node" data-id="${node.id}">
  <h3>Point — ${esc(heading)}</h3>
  <div class="row"><label>Label</label><input type="text" data-f="label" value="${esc(node.label ?? '')}" placeholder="e.g. N1" /></div>
  <div class="row"><label>East</label><input type="number" data-f="e" step="1" value="${Math.round(node.pos.e)}" /></div>
  <div class="row"><label>North</label><input type="number" data-f="n" step="1" value="${Math.round(node.pos.n)}" /></div>
  <div class="row"><label>Up</label><input type="number" data-f="u" step="1" value="${Math.round(node.pos.u)}" /></div>
  ${
    isEnd
      ? `<div class="row"><label>End type</label><select data-f="terminal">${options(TERMINALS, node.terminal?.kind ?? 'OPEN', TERMINAL_LABEL)}</select></div>
         <div class="row"><label>End note</label><input type="text" data-f="termnote" value="${esc(node.terminal?.note ?? '')}" placeholder="e.g. TO V-101 N3" /></div>`
      : `<div class="row"><label>Fitting</label><select data-f="fitting">${options(['auto', ...FITTINGS], node.fittingOverride ?? 'auto', { auto: `Automatic (${fittingLabel(fitting) || 'none'})` })}</select></div>`
  }
  ${
    straight
      ? `<div class="row"><label>Flange</label><select data-f="flange">${options(['none', ...FLANGE_KINDS], node.flange ?? 'none', { ...COMPONENT_LABEL, none: 'None — welded through' })}</select></div>`
      : ''
  }
  ${alongLine(host, nodeId)}
  ${
    isOlet
      ? `<div class="row"><label>Olet type</label><select data-f="joint">${options(JOINTS, nodeJoint, { BW: 'Weldolet', SW: 'Sockolet', THD: 'Threadolet' })}</select></div>`
      : flanged
        ? ''
        : `<div class="row"><label>Joint</label><select data-f="joint">${options(['auto', ...JOINTS], node.joint ?? 'auto', { ...JOINT_LABEL, auto: `Drawing default (${JOINT_LABEL[host.state.drawing.options.joint] ?? 'butt weld'})` })}</select></div>`
  }
  <p class="empty-note">${
    isOlet
      ? 'Drag from this point to route the branch. The header keeps its full length — an olet is welded to its wall, not cut into it.'
      : flanged
        ? 'The pipe stops at the flange faces here: each side is its own piece, with its own flange, weld and cut length. Drag the joint along the line to move it.'
      : `Drag from this point on the drawing to route a new run. ${
          (info?.degree ?? 0) >= 2 ? 'Routing from a point that already has two runs creates a tee.' : ''
        }`
  }</p>
  <div class="btn-row">
    <button class="btn-line solid" data-a="draw-from">Draw from here</button>
    <button class="btn-line danger" data-a="delete-node">Delete point and its runs</button>
  </div>
</div>`;
}

function componentProperties(host: Host, compId: string): string {
  const { drawing } = host.state;
  const run = drawing.runs.find((r) => r.inline.some((c) => c.id === compId));
  const comp = run?.inline.find((c) => c.id === compId);
  if (!run || !comp) return '';
  const total = runLength(drawing, run);
  const isReducer = comp.kind === 'RED_CONC' || comp.kind === 'RED_ECC';
  // A mark on the line has no size or ends of its own: it is where it is.
  const mark = isMark(comp.kind);

  return `
<div class="section" data-editor="component" data-id="${comp.id}">
  <h3>${esc(COMPONENT_LABEL[comp.kind] ?? comp.kind)}</h3>
  <div class="row"><label>Type</label><select data-f="kind">${options(COMPONENT_KINDS, comp.kind, COMPONENT_LABEL)}</select></div>
  <div class="row"><label>From start</label><input type="number" data-f="offset" step="1" min="0" max="${Math.round(total)}" value="${Math.round(comp.offset)}" /></div>
  <div class="row"><label>To end</label><input type="number" data-f="toend" step="1" min="0" max="${Math.round(total)}" value="${Math.round(total - comp.offset)}" /></div>
  ${mark ? '' : `<div class="row"><label>Size</label><select data-f="dn">${options(DN_LIST, comp.dn ?? run.dn, SIZE_LABELS)}</select></div>`}
  ${isReducer ? `<div class="row"><label>Reduces to</label><select data-f="dn2">${options(DN_LIST, comp.dn2 ?? run.dn, SIZE_LABELS)}</select></div>` : ''}
  ${
    comp.kind === 'TRANSITION'
      ? `<div class="row"><label>Steel side</label><select data-f="flip">${options(['end', 'start'], comp.flip ? 'start' : 'end', { end: 'Towards the end of the run', start: 'Towards the start of the run' })}</select></div>`
      : comp.kind === 'GROUND'
        ? `<div class="row"><label>AG side</label><select data-f="flip">${options(['end', 'start'], comp.flip ? 'start' : 'end', { end: 'As drawn (up a riser, else towards the end)', start: 'The other way' })}</select></div>`
        : ''
  }
  ${mark ? '' : `<div class="row"><label>Ends</label><select data-f="ends">${options(['auto', ...END_TYPES], comp.ends ?? 'auto', {
    auto: isValve(comp.kind)
      ? `By size (${defaultValveEnds(comp.dn ?? run.dn) === 'FLG' ? 'flanged' : 'threaded'})`
      : `Drawing default (${host.state.drawing.options.joint})`,
    FLG: 'Flanged',
    BW: 'Butt weld',
    SW: 'Socket weld',
    THD: 'Threaded',
    PLAIN: 'Plain',
  })}</select></div>`}
  ${
    comp.kind === 'GROUND'
      ? ''
      : `<div class="row"><label>${isSupport(comp.kind) ? 'Number' : 'Tag'}</label><input type="text" data-f="tag" value="${esc(comp.tag ?? '')}" placeholder="${isSupport(comp.kind) ? 'numbered along the line; or e.g. A' : 'e.g. HV-101'}" /></div>` +
        (isSupport(comp.kind)
          ? `<div class="row"><label>Detail</label><input type="text" data-f="note" value="${esc(comp.note ?? (comp.kind === 'SUPPORT_L' ? 'L50' : ''))}" placeholder="e.g. L50 — typed on the drawing too" /></div>`
          : '')
  }
  <p class="empty-note">Measured ${mm(comp.offset)} mm from the start of a ${mm(total)} mm run.${
    isValve(comp.kind)
      ? ` Valves come flanged over 1" and threaded at 1" and under; this one is ${
          resolveEnds(comp.kind, comp.dn ?? run.dn, comp.ends, host.state.drawing.options.joint) === 'FLG'
            ? 'flanged, so it is drawn and counted with a pair of weld neck flanges'
            : 'threaded, so it takes no welds'
        }.`
      : ''
  }</p>
  <div class="btn-row">
    <button class="btn-line danger" data-a="delete-component">Remove</button>
  </div>
</div>`;
}

function runList(host: Host): string {
  const { drawing, analysis, selection } = host.state;
  if (drawing.runs.length === 0) {
    return `<div class="section"><h3>Runs</h3><p class="empty-note">No runs yet. Click the drawing to place the first point, then drag along one of the six isometric directions.</p></div>`;
  }
  const rows = drawing.runs
    .map((run, i) => {
      const lengths = analysis.runLengths.get(run.id);
      const selected = selection?.kind === 'run' && selection.id === run.id;
      return `<tr class="clickable${selected ? ' is-selected' : ''}" data-run-row="${run.id}">
  <td class="num">${i + 1}</td>
  <td>${runDirection(host, run.id)}</td>
  <td>${esc(sizeLabel(run.dn))}</td>
  <td class="len num"><input type="number" step="1" min="1" data-run-len="${run.id}" value="${Math.round(lengths?.centre ?? 0)}" /></td>
  <td class="num">${mm(lengths?.cut ?? 0)}</td>
</tr>`;
    })
    .join('');

  const total = [...analysis.runLengths.values()].reduce((sum, r) => sum + r.centre, 0);
  return `
<div class="section">
  <h3>Runs</h3>
  <table class="run-list">
    <thead><tr><th class="num">#</th><th>Dir</th><th>Size</th><th class="num">C/C mm</th><th class="num">Cut mm</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals"><span>Developed length <strong>${(total / 1000).toFixed(2)} m</strong></span><span>Welds <strong>${analysis.welds.length}</strong></span></div>
</div>`;
}

function routeTab(host: Host): string {
  const sel = host.state.selection;
  let props = '';
  if (sel?.kind === 'run') props = runProperties(host, sel.id);
  else if (sel?.kind === 'node') props = nodeProperties(host, sel.id);
  else if (sel?.kind === 'component') props = componentProperties(host, sel.id);
  else if (sel?.kind === 'weld') props = weldProperties(host, sel.key);
  else
    props = `<div class="section"><h3>Nothing selected</h3><p class="empty-note">Click a run, a point or a component on the drawing to edit it.</p></div>`;
  return props + runList(host);
}

/* ---------------------------------------------------------------- command */

function commandTab(host: Host): string {
  const errors = host.state.commandErrors;
  return `
<div class="section">
  <h3>Route by typing</h3>
  <textarea class="command" id="command-text" spellcheck="false" placeholder="DN80\nSTD\nN 1500\nUP 800\n+GATE\nE 2400\nEND FLG">${esc(host.state.commandText)}</textarea>
  <div class="btn-row">
    <button class="btn-line solid" data-a="run-commands">Apply</button>
    <button class="btn-line" data-a="clear-commands">Clear</button>
  </div>
  ${
    errors.length > 0
      ? `<ul class="errors">${errors
          .map((e) => `<li><code>line ${e.line}: ${esc(e.text)}</code><br/>${esc(e.message)}</li>`)
          .join('')}</ul>`
      : ''
  }
</div>
<div class="section">
  <h3>Syntax</h3>
  <pre class="help">${esc(COMMAND_HELP)}</pre>
</div>`;
}

/* ------------------------------------------------------------------ items */

function itemsTab(host: Host): string {
  const { bom } = host.state.analysis;
  if (bom.length === 0) {
    return `<div class="section"><h3>Bill of materials</h3><p class="empty-note">The take-off builds itself as you draw.</p></div>`;
  }
  const rows = bom
    .map(
      (line, i) => `<tr>
  <td class="num">${i + 1}</td>
  <td>${esc(line.description)}</td>
  <td>${esc(sizeLabel(line.dn))}</td>
  <td>${esc(line.schedule)}</td>
  <td class="num">${line.unit === 'm' ? line.quantity.toFixed(2) : Math.round(line.quantity)}</td>
  <td>${line.unit}</td>
</tr>`,
    )
    .join('');
  const pipe = bom.filter((l) => l.category === 'PIPE').reduce((sum, l) => sum + l.quantity, 0);
  const items = bom.filter((l) => l.unit === 'off').reduce((sum, l) => sum + l.quantity, 0);
  return `
<div class="section">
  <h3>Bill of materials</h3>
  <table>
    <thead><tr><th class="num">#</th><th>Description</th><th>Size</th><th>Thk</th><th class="num">Qty</th><th>Unit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <span>Pipe <strong>${pipe.toFixed(2)} m</strong></span>
    <span>Items <strong>${Math.round(items)}</strong></span>
  </div>
  <div class="btn-row"><button class="btn-line" data-a="copy-bom">Copy list</button></div>
</div>`;
}

/* ------------------------------------------------------------------ welds */

/** One weld, picked on the drawing: its number is typed here. */
function weldProperties(host: Host, key: string): string {
  const weld = host.state.analysis.joints.find((j) => j.key === key);
  if (!weld) return '';
  const override = host.state.drawing.weldOverrides[key]?.number;
  return `
<div class="section" data-editor="weld" data-key="${esc(key)}">
  <h3>Weld ${esc(weld.number)}</h3>
  <div class="row"><label>Number</label><input type="text" data-f="number" value="${esc(weld.number)}" placeholder="e.g. W12" /></div>
  <div class="row"><label>Size</label><span>${esc(sizeLabel(weld.dn))} ${esc(weld.schedule)}</span></div>
  <div class="row"><label>Joins</label><span>${esc(weld.joins)}</span></div>
  <p class="empty-note">${
    override
      ? 'Numbered by hand. Clear the number to go back to numbering along the route.'
      : 'Numbered along the route. Type a number of your own to keep it whatever else changes.'
  }</p>
</div>`;
}

function weldsTab(host: Host): string {
  const { welds } = host.state.analysis;
  if (welds.length === 0) {
    return `<div class="section"><h3>Weld schedule</h3><p class="empty-note">Welds are generated from the route — every fitting, valve and flange adds its own.</p></div>`;
  }
  const sel = host.state.selection;
  const rows = welds
    .map(
      (w) => `<tr class="clickable${sel?.kind === 'weld' && sel.key === w.key ? ' is-selected' : ''}" data-weld-row="${esc(w.key)}">
  <td><input class="cell" type="text" data-weld-no="${esc(w.key)}" value="${esc(w.number)}" /></td>
  <td>${esc(sizeLabel(w.dn))}</td>
  <td>${esc(w.joint)}</td>
  <td>${esc(w.joins)}</td>
</tr>`,
    )
    .join('');
  const byPrep = welds.reduce<Record<string, number>>((acc, w) => {
    acc[w.joint] = (acc[w.joint] ?? 0) + 1;
    return acc;
  }, {});
  return `
<div class="section">
  <h3>Weld list</h3>
  <p class="empty-note">Numbered along the route; type over any number to set it by hand. Threaded joints are marked on the drawing but are not welds.</p>
  <table>
    <thead><tr><th>No.</th><th>Size</th><th>Prep</th><th>Joins</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    ${Object.entries(byPrep)
      .map(([prep, n]) => `<span>${esc(prep)} <strong>${n}</strong></span>`)
      .join('')}
    <span>Total <strong>${welds.length}</strong></span>
  </div>
  <div class="btn-row">
    <button class="btn-line" data-a="copy-welds">Copy list</button>
  </div>
</div>`;
}

/* ------------------------------------------------------------------ title */

const META_FIELDS: { key: keyof import('../model/types').Meta; label: string; placeholder?: string }[] = [
  { key: 'project', label: 'Project' },
  { key: 'lineNumber', label: 'Line number', placeholder: '6"-P-1201' },
  { key: 'drawingNo', label: 'Drawing no.' },
  { key: 'sheet', label: 'Sheet' },
  { key: 'revision', label: 'Revision' },
  { key: 'date', label: 'Date' },
  { key: 'drawnBy', label: 'Drawn by' },
];

function titleTab(host: Host): string {
  const meta = host.state.drawing.meta;
  return `
<div class="section" data-editor="meta">
  <h3>Title block</h3>
  ${META_FIELDS.map(
    (f) =>
      `<div class="row"><label>${esc(f.label)}</label><input type="text" data-meta="${f.key}" value="${esc(String(meta[f.key] ?? ''))}" placeholder="${esc(f.placeholder ?? '')}" /></div>`,
  ).join('')}
</div>
<div class="section" data-editor="line">
  <h3>Pipe and fittings</h3>
  <div class="row"><label>Pipe schedule</label><select data-f="pipesch">${options(schedulesFor(host.state.currentDn), host.state.drawing.options.pipeSchedule)}</select></div>
  <div class="row"><label>Fitting thk</label><select data-f="fitthk">${options(schedulesFor(host.state.currentDn), host.state.drawing.options.fittingThickness)}</select></div>
  <p class="empty-note">Pipe schedule applies to every run on the drawing. Fittings are taken off at their own thickness — normally standard weight even where the pipe is heavier.</p>
</div>
<div class="section">
  <h3>Logo</h3>
  ${
    meta.logo
      ? `<div class="logo-preview"><img src="${esc(meta.logo)}" alt="Company logo" /></div>`
      : '<p class="empty-note">Add your logo and it prints in the corner of every sheet.</p>'
  }
  <p class="empty-note">${
    meta.logo === DEFAULT_LOGO
      ? 'This is a stand-in. Load your own artwork — a PNG or SVG — and it prints instead.'
      : 'Saved with the drawing, so it travels with the file.'
  }</p>
  <div class="btn-row">
    <button class="btn-line" data-a="pick-logo">${meta.logo ? 'Replace logo' : 'Add logo'}</button>
    ${meta.logo && meta.logo !== DEFAULT_LOGO ? '<button class="btn-line" data-a="clear-logo">Back to default</button>' : ''}
  </div>
</div>`;
}

/* ------------------------------------------------------------------- wire */

export function renderPanel(body: HTMLElement, host: Host): void {
  const { tab } = host.state;
  body.innerHTML =
    tab === 'route'
      ? routeTab(host)
      : tab === 'command'
        ? commandTab(host)
        : tab === 'items'
          ? itemsTab(host)
          : tab === 'welds'
            ? weldsTab(host)
            : tab === 'projects'
              ? projectsTab(host)
              : titleTab(host);

  wire(body, host);
}

/* -------------------------------------------------------------- projects */

const RECENT_PROJECTS = 5;

/**
 * The drawings kept on this device, by project. A job with more than one
 * isometric is picked up sheet by sheet from here, and its next sheet is
 * started from here with the title block carried over.
 */
function projectsTab(host: Host): string {
  const { drawing, selection, showAllProjects } = host.state;
  const projects = projectsOf(host.library());
  const shown = showAllProjects ? projects : projects.slice(0, RECENT_PROJECTS);
  const name = drawing.meta.project || '';
  const pickedEnd =
    selection?.kind === 'node' && host.state.analysis.nodeInfo.get(selection.id)?.degree === 1 ? selection.id : null;
  const when = (t: number) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const sheetRow = (entry: (typeof projects)[number]['sheets'][number]) => {
    const m = entry.drawing.meta;
    const current = entry.id === drawing.id;
    const what = [m.lineNumber, m.drawingNo].filter(Boolean).join(' · ');
    return `<div class="sheet-row${current ? ' current' : ''}" data-open-sheet="${esc(entry.id)}">
      <div class="sheet-main"><strong>Sheet ${esc(m.sheet || '1 of 1')}</strong>${what ? ` · ${esc(what)}` : ''}${current ? ' <span class="sheet-here">on screen</span>' : ''}</div>
      <div class="sheet-sub">${entry.drawing.runs.length} run${entry.drawing.runs.length === 1 ? '' : 's'} · ${when(entry.savedAt)}</div>
      <button class="sheet-remove" data-remove-sheet="${esc(entry.id)}" type="button" title="Remove from this device">×</button>
    </div>`;
  };
  return `
<div class="section">
  <h3>This project</h3>
  <p class="empty-note"><strong>${esc(name || 'No project name yet')}</strong>${
    name ? ` — sheet ${esc(drawing.meta.sheet || '1 of 1')} is on screen.` : ' — name it in the Title tab and its sheets are kept together here.'
  }</p>
  <div class="btn-row">
    <button class="btn-line solid" data-a="new-sheet">New sheet in this project</button>
  </div>
  <p class="empty-note">${
    pickedEnd
      ? 'The picked end will be marked as continuing on the new sheet, and the new sheet starts from it.'
      : 'Pick the open end the line continues from first, and the new sheet carries on from there — or just start a fresh sheet.'
  } The title block, logo and pipe settings carry over; every sheet is kept on this device as you draw.</p>
</div>
<div class="section">
  <h3>${showAllProjects ? 'All projects' : 'Recent projects'}</h3>
  ${
    shown.length === 0
      ? '<p class="empty-note">Nothing kept yet. Drawings are kept here as you draw them, by project name.</p>'
      : shown
          .map(
            (p) => `<div class="project">
      <div class="project-name">${esc(p.name || '(no project name)')} <span class="project-count">${p.sheets.length} sheet${p.sheets.length === 1 ? '' : 's'}</span></div>
      ${p.sheets.map(sheetRow).join('')}
    </div>`,
          )
          .join('')
  }
  ${
    projects.length > RECENT_PROJECTS
      ? `<div class="btn-row"><button class="btn-line" data-a="toggle-projects">${showAllProjects ? `Show the ${RECENT_PROJECTS} most recent` : `Show all ${projects.length} projects`}</button></div>`
      : ''
  }
</div>`;
}

function wire(body: HTMLElement, host: Host): void {
  const { drawing } = host.state;

  // Projects.
  body.querySelector('[data-a="new-sheet"]')?.addEventListener('click', () => host.newSheetInProject());
  body.querySelector('[data-a="toggle-projects"]')?.addEventListener('click', () => {
    host.state.showAllProjects = !host.state.showAllProjects;
    host.touch();
  });
  body.querySelectorAll<HTMLElement>('[data-open-sheet]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('[data-remove-sheet]')) return;
      const id = row.dataset.openSheet!;
      if (id !== drawing.id) host.openFromLibrary(id);
    });
  });
  body.querySelectorAll<HTMLElement>('[data-remove-sheet]').forEach((button) => {
    button.addEventListener('click', () => host.removeFromLibrary(button.dataset.removeSheet!));
  });

  // Selecting a run from the list.
  body.querySelectorAll<HTMLElement>('[data-run-row]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).tagName === 'INPUT') return;
      host.select({ kind: 'run', id: row.dataset.runRow! });
    });
  });

  body.querySelectorAll<HTMLInputElement>('[data-run-len]').forEach((input) => {
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value <= 0) return;
      host.edit('Change length', (d) => setRunLength(d, input.dataset.runLen!, value));
    });
  });

  // Run editor.
  const runEditor = body.querySelector<HTMLElement>('[data-editor="run"]');
  if (runEditor) {
    const id = runEditor.dataset.id!;
    const field = (name: string) => runEditor.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-f="${name}"]`);
    field('length')?.addEventListener('change', (e) => {
      const value = Number((e.target as HTMLInputElement).value);
      if (value > 0) host.edit('Change length', (d) => setRunLength(d, id, value));
    });
    field('dn')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value;
      host.edit('Change size', (d) => {
        const run = d.runs.find((r) => r.id === id);
        if (!run) return;
        run.dn = value;
        if (!schedulesFor(value).includes(run.schedule)) run.schedule = schedulesFor(value)[0] ?? 'STD';
      });
    });
    field('schedule')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value;
      host.edit('Change schedule', (d) => {
        const run = d.runs.find((r) => r.id === id);
        if (run) run.schedule = value;
      });
    });
    field('note')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLInputElement).value;
      host.edit('Edit note', (d) => {
        const run = d.runs.find((r) => r.id === id);
        if (run) run.note = value || undefined;
      }, { keepPanel: true });
    });
    field('nodim')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value;
      host.edit('Toggle dimension', (d) => {
        const run = d.runs.find((r) => r.id === id);
        if (run) run.noDim = value === 'hide' ? true : undefined;
      });
    });
    runEditor.querySelector('[data-a="split"]')?.addEventListener('click', () => {
      const run = drawing.runs.find((r) => r.id === id);
      if (!run) return;
      const half = runLength(drawing, run) / 2;
      host.edit('Split run', (d) => {
        splitRun(d, id, half);
      });
    });
    runEditor.querySelector('[data-a="delete-run"]')?.addEventListener('click', () => {
      host.edit('Delete run', (d) => deleteRun(d, id));
      host.select(null);
    });
  }

  // Node editor.
  const nodeEditor = body.querySelector<HTMLElement>('[data-editor="node"]');
  if (nodeEditor) {
    const id = nodeEditor.dataset.id!;
    const field = (name: string) => nodeEditor.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-f="${name}"]`);
    for (const axis of ['e', 'n', 'u'] as const) {
      field(axis)?.addEventListener('change', (event) => {
        const value = Number((event.target as HTMLInputElement).value);
        if (!Number.isFinite(value)) return;
        host.edit('Move point', (d) => {
          const node = d.nodes.find((n) => n.id === id);
          if (node) node.pos = { ...node.pos, [axis]: value };
        });
      });
    }
    field('label')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLInputElement).value;
      host.edit('Label point', (d) => {
        const node = d.nodes.find((n) => n.id === id);
        if (node) node.label = value || undefined;
      }, { keepPanel: true });
    });
    field('terminal')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value as TerminalKind;
      host.edit('Set end type', (d) => {
        const node = d.nodes.find((n) => n.id === id);
        if (node) node.terminal = { kind: value, note: node.terminal?.note };
      });
    });
    field('termnote')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLInputElement).value;
      host.edit('Edit end note', (d) => {
        const node = d.nodes.find((n) => n.id === id);
        if (node) node.terminal = { kind: node.terminal?.kind ?? 'OPEN', note: value || undefined };
      }, { keepPanel: true });
    });
    field('joint')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value;
      host.edit('Set joint type', (d) => {
        const node = d.nodes.find((n) => n.id === id);
        if (node) node.joint = value === 'auto' ? undefined : (value as JointType);
      });
    });
    field('flange')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value;
      host.edit('Set flanged joint', (d) => {
        const node = d.nodes.find((n) => n.id === id);
        if (node) node.flange = value === 'none' ? undefined : (value as FlangeKind);
      });
    });
    field('fitting')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value;
      host.edit('Set fitting', (d) => {
        const node = d.nodes.find((n) => n.id === id);
        if (node) node.fittingOverride = value === 'auto' ? undefined : (value as FittingKind);
      });
    });
    nodeEditor.querySelectorAll<HTMLInputElement>('[data-slide]').forEach((input) => {
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (!Number.isFinite(value) || value <= 0) return;
        host.edit('Place point', (d) => {
          if (!setRunLength(d, input.dataset.slide!, value)) return;
        });
      });
    });
    // Double tapping a point works with a mouse, but is awkward with a pencil,
    // so picking the route back up is a button too.
    nodeEditor.querySelector('[data-a="draw-from"]')?.addEventListener('click', () => {
      host.continueFrom(id);
    });
    nodeEditor.querySelector('[data-a="delete-node"]')?.addEventListener('click', () => {
      host.edit('Delete point', (d) => deleteNode(d, id));
      host.select(null);
    });
  }

  // Component editor.
  const compEditor = body.querySelector<HTMLElement>('[data-editor="component"]');
  if (compEditor) {
    const id = compEditor.dataset.id!;
    const withComponent = (
      label: string,
      fn: (c: import('../model/types').InlineComponent) => void,
      options?: { keepPanel?: boolean },
    ) => {
      host.edit(label, (d) => {
        for (const run of d.runs) {
          const comp = run.inline.find((c) => c.id === id);
          if (comp) {
            fn(comp);
            run.inline.sort((a, b) => a.offset - b.offset);
            return;
          }
        }
      }, options);
    };
    const field = (name: string) => compEditor.querySelector<HTMLInputElement & HTMLSelectElement>(`[data-f="${name}"]`);
    field('kind')?.addEventListener('change', (e) =>
      withComponent('Change component', (c) => {
        c.kind = (e.target as HTMLSelectElement).value as ComponentKind;
      }),
    );
    // Placed by either distance: set one and the other follows, the run itself
    // never changes length.
    field('offset')?.addEventListener('change', (e) => {
      const value = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(value)) withComponent('Move component', (c) => { c.offset = Math.max(0, value); });
    });
    field('toend')?.addEventListener('change', (e) => {
      const value = Number((e.target as HTMLInputElement).value);
      const run = drawing.runs.find((r) => r.inline.some((c) => c.id === id));
      if (!run || !Number.isFinite(value)) return;
      const total = runLength(drawing, run);
      withComponent('Move component', (c) => { c.offset = Math.max(0, Math.min(total, total - value)); });
    });
    field('dn')?.addEventListener('change', (e) =>
      withComponent('Change component size', (c) => {
        c.dn = (e.target as HTMLSelectElement).value;
      }),
    );
    field('dn2')?.addEventListener('change', (e) =>
      withComponent('Change reduced size', (c) => {
        c.dn2 = (e.target as HTMLSelectElement).value;
      }),
    );
    field('flip')?.addEventListener('change', (e) =>
      withComponent('Turn item round', (c) => {
        c.flip = (e.target as HTMLSelectElement).value === 'start' ? true : undefined;
      }),
    );
    field('ends')?.addEventListener('change', (e) =>
      withComponent('Change end preparation', (c) => {
        const value = (e.target as HTMLSelectElement).value;
        c.ends = value === 'auto' ? undefined : (value as EndType);
      }),
    );
    field('tag')?.addEventListener('change', (e) =>
      withComponent('Tag component', (c) => {
        c.tag = (e.target as HTMLInputElement).value || undefined;
      }, { keepPanel: true }),
    );
    field('note')?.addEventListener('change', (e) =>
      withComponent('Describe support', (c) => {
        const detail = (e.target as HTMLInputElement).value.trim();
        c.note = detail || (c.kind === 'SUPPORT_L' ? '' : undefined);
      }, { keepPanel: true }),
    );
    compEditor.querySelector('[data-a="delete-component"]')?.addEventListener('click', () => {
      host.edit('Remove component', (d) => removeComponent(d, id));
      host.select(null);
    });
  }

  // Commands.
  body.querySelector('[data-a="run-commands"]')?.addEventListener('click', () => {
    const text = body.querySelector<HTMLTextAreaElement>('#command-text')?.value ?? '';
    host.applyCommands(text);
  });
  body.querySelector('[data-a="clear-commands"]')?.addEventListener('click', () => {
    const area = body.querySelector<HTMLTextAreaElement>('#command-text');
    if (area) area.value = '';
    host.state.commandText = '';
    host.state.commandErrors = [];
    host.touch();
  });
  body.querySelector<HTMLTextAreaElement>('#command-text')?.addEventListener('input', (e) => {
    host.state.commandText = (e.target as HTMLTextAreaElement).value;
  });

  // Exports.
  const bomCsv = () => {
    const rows = [['Item', 'Description', 'Size', 'Schedule', 'Quantity', 'Unit']];
    host.state.analysis.bom.forEach((line, i) => {
      rows.push([
        String(i + 1),
        line.description,
        sizeLabel(line.dn),
        line.schedule,
        line.unit === 'm' ? line.quantity.toFixed(2) : String(Math.round(line.quantity)),
        line.unit,
      ]);
    });
    return toCsv(rows);
  };
  const weldCsv = () => {
    const rows = [['Weld', 'Size', 'Preparation', 'Joins']];
    for (const w of host.state.analysis.welds) {
      rows.push([w.number, sizeLabel(w.dn), w.joint, w.joins]);
    }
    return toCsv(rows);
  };

  body.querySelector('[data-a="copy-bom"]')?.addEventListener('click', () => {
    host.copy('Bill of materials', bomCsv());
  });
  // Weld numbers, typed either on the list or against the picked weld.
  const renumber = (key: string, value: string) => {
    host.edit('Renumber weld', (d) => {
      const number = value.trim();
      if (number) d.weldOverrides[key] = { ...d.weldOverrides[key], number };
      else delete d.weldOverrides[key];
    }, { keepPanel: true });
  };
  body.querySelectorAll<HTMLInputElement>('[data-weld-no]').forEach((input) => {
    input.addEventListener('change', () => renumber(input.dataset.weldNo!, input.value));
  });
  body.querySelectorAll<HTMLElement>('[data-weld-row]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).tagName === 'INPUT') return;
      host.select({ kind: 'weld', key: row.dataset.weldRow! });
    });
  });
  const weldEditor = body.querySelector<HTMLElement>('[data-editor="weld"]');
  if (weldEditor) {
    weldEditor.querySelector<HTMLInputElement>('[data-f="number"]')?.addEventListener('change', (e) => {
      renumber(weldEditor.dataset.key!, (e.target as HTMLInputElement).value);
    });
  }
  body.querySelector('[data-a="copy-welds"]')?.addEventListener('click', () => {
    host.copy('Weld schedule', weldCsv());
  });

  // Pipe and fitting thickness.
  const lineEditor = body.querySelector<HTMLElement>('[data-editor="line"]');
  if (lineEditor) {
    lineEditor.querySelector<HTMLSelectElement>('[data-f="pipesch"]')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value;
      host.edit('Set pipe schedule', (d) => {
        d.options.pipeSchedule = value;
        // The schedule is a property of the line, so it carries to every run.
        for (const run of d.runs) {
          if (schedulesFor(run.dn).includes(value)) run.schedule = value;
        }
      });
    });
    lineEditor.querySelector<HTMLSelectElement>('[data-f="fitthk"]')?.addEventListener('change', (e) => {
      const value = (e.target as HTMLSelectElement).value;
      host.edit('Set fitting thickness', (d) => {
        d.options.fittingThickness = value;
      });
    });
  }

  // Logo.
  body.querySelector('[data-a="pick-logo"]')?.addEventListener('click', () => host.pickLogo());
  body.querySelector('[data-a="clear-logo"]')?.addEventListener('click', () => {
    host.edit('Restore default logo', (d) => {
      d.meta.logo = DEFAULT_LOGO;
    });
  });

  // Title block.
  body.querySelectorAll<HTMLInputElement>('[data-meta]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.meta as keyof import('../model/types').Meta;
      host.edit('Edit title block', (d) => {
        d.meta[key] = input.value;
      }, { keepPanel: true });
    });
  });
}

export function fileStem(host: Host): string {
  const meta = host.state.drawing.meta;
  const base = meta.lineNumber || meta.drawingNo || meta.project || 'isometric';
  return base.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'isometric';
}

export function toCsv(rows: string[][]): string {
  return rows
    .map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','))
    .join('\n');
}

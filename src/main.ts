import './styles.css';
import type { Drawing, Vec3 } from './model/types';
import type { Preview, Selection } from './render/renderer';
import type { AppState, Host } from './ui/types';
import { analyse, emptyDrawing } from './model/drawing';
import { initialCommandState, runCommands } from './model/commands';
import { deleteNode, deleteRun, ensureNode, removeComponent, route } from './model/edit';
import { DN_LIST, schedulesFor } from './model/pipe-data';
import { northArrow } from './render/renderer';
import { renderSheet, type SheetSize } from './render/sheet';
import { Canvas } from './ui/canvas';
import { fileStem, renderPanel, renderTabs } from './ui/panels';
import { renderTools } from './ui/tools';

const STORAGE_KEY = 'iso-draw.drawing.v1';
const UNDO_LIMIT = 100;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const svg = $<HTMLElement>('canvas') as unknown as SVGSVGElement;
const toolsEl = $('tools');
const tabsEl = $('tabs');
const tabBodyEl = $('tab-body');
const hudEl = $('hud');
const compassEl = $('compass');
const emptyHintEl = $('empty-hint');
const fileInput = $<HTMLInputElement>('file-input');

/* ------------------------------------------------------------------ state */

const drawing = loadStored() ?? emptyDrawing();

const state: AppState = {
  drawing,
  analysis: analyse(drawing),
  selection: null,
  preview: null,
  commandState: initialCommandState(),
  commandText: '',
  commandErrors: [],
  tab: 'route',
  currentDn: 'DN80',
  currentSchedule: 'STD',
  view: { x: -400, y: -300, w: 800, h: 600 },
};

const undoStack: string[] = [];
const redoStack: string[] = [];
let toast: { message: string; until: number } | null = null;

function snapshot(): string {
  return JSON.stringify(state.drawing);
}

function recompute(): void {
  state.analysis = analyse(state.drawing);
}

const host: Host = {
  state,
  edit(_label, mutator, options) {
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    mutator(state.drawing);
    recompute();
    persist();
    if (options?.keepPanel) renderCanvasOnly();
    else render();
  },
  touch() {
    render();
  },
  select(selection) {
    state.selection = selection;
    syncSizeFromSelection();
    render();
  },
  setTab(tab) {
    state.tab = tab;
    render();
  },
  applyCommands(text) {
    undoStack.push(snapshot());
    redoStack.length = 0;
    state.commandText = text;
    const result = runCommands(state.drawing, text, state.commandState);
    state.commandState = result.state;
    state.commandErrors = result.errors;
    if (result.applied === 0) undoStack.pop();
    recompute();
    persist();
    if (result.applied > 0) fitView();
    host.notify(
      result.errors.length > 0
        ? `${result.applied} applied, ${result.errors.length} could not be read`
        : `${result.applied} command${result.applied === 1 ? '' : 's'} applied`,
    );
  },
  download(filename, content, mime) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    triggerDownload(blob, filename);
  },
  notify(message) {
    toast = { message, until: Date.now() + 3200 };
    render();
    setTimeout(render, 3400);
  },
};

/* ----------------------------------------------------------------- canvas */

const canvas = new Canvas(svg, {
  onSelect(selection: Selection) {
    host.select(selection);
  },
  onRoute(fromId, axis, length) {
    let newNode: string | null = null;
    host.edit('Route', (d) => {
      const result = route(d, fromId, axis, length, state.currentDn, state.currentSchedule);
      newNode = result?.nodeId ?? null;
    });
    if (newNode) {
      state.selection = { kind: 'node', id: newNode };
      state.commandState.currentNode = newNode;
      render();
    }
  },
  onStart() {
    host.edit('Start route', (d) => {
      const id = ensureNode(d, { e: 0, n: 0, u: 0 } as Vec3);
      state.selection = { kind: 'node', id };
      state.commandState.currentNode = id;
    });
    fitView();
  },
  onPreview(preview: Preview | null) {
    state.preview = preview;
    canvas.setState(state.drawing, state.analysis, state.selection, state.preview);
  },
  onHover(message) {
    hoverMessage = message;
    renderHud();
  },
});

let hoverMessage: string | null = null;

/* ----------------------------------------------------------------- render */

/** Pushes the current state to the canvas and zooms to fit in one step. */
function fitView(): void {
  canvas.setState(state.drawing, state.analysis, state.selection, state.preview);
  canvas.fit();
}

/** Redraws the sheet without rebuilding the side panel, so focus is preserved. */
function renderCanvasOnly(): void {
  canvas.setState(state.drawing, state.analysis, state.selection, state.preview);
  compassEl.innerHTML = northArrow(state.drawing);
  emptyHintEl.classList.toggle('hidden', state.drawing.nodes.length > 0);
  renderHud();
  $<HTMLButtonElement>('undo').disabled = undoStack.length === 0;
  $<HTMLButtonElement>('redo').disabled = redoStack.length === 0;
}

function render(): void {
  canvas.setState(state.drawing, state.analysis, state.selection, state.preview);
  renderTabs(tabsEl, host);
  renderPanel(tabBodyEl, host);
  renderTools(toolsEl, host);
  compassEl.innerHTML = northArrow(state.drawing);
  emptyHintEl.classList.toggle('hidden', state.drawing.nodes.length > 0);
  renderHud();
  $<HTMLButtonElement>('undo').disabled = undoStack.length === 0;
  $<HTMLButtonElement>('redo').disabled = redoStack.length === 0;
}

function renderHud(): void {
  const parts: string[] = [];
  if (hoverMessage) parts.push(`<span>${hoverMessage}</span>`);
  parts.push(`<span>snap ${state.drawing.options.snap} mm</span>`);
  if (state.drawing.options.schematic) parts.push('<span>not to scale</span>');
  for (const warning of state.analysis.warnings.slice(0, 2)) {
    parts.push(`<span class="warn">${warning}</span>`);
  }
  if (toast && toast.until > Date.now()) parts.push(`<span>${toast.message}</span>`);
  hudEl.innerHTML = parts.join('');
}

function syncSizeFromSelection(): void {
  const sel = state.selection;
  if (sel?.kind === 'run') {
    const run = state.drawing.runs.find((r) => r.id === sel.id);
    if (run) {
      state.currentDn = run.dn;
      state.currentSchedule = run.schedule;
      refreshSizeSelects();
    }
  }
}

/* ---------------------------------------------------------------- toolbar */

const dnSelect = $<HTMLSelectElement>('dn');
const scheduleSelect = $<HTMLSelectElement>('schedule');
const snapSelect = $<HTMLSelectElement>('snap');

function refreshSizeSelects(): void {
  dnSelect.innerHTML = DN_LIST.map(
    (dn) => `<option value="${dn}"${dn === state.currentDn ? ' selected' : ''}>${dn}</option>`,
  ).join('');
  const schedules = schedulesFor(state.currentDn);
  if (!schedules.includes(state.currentSchedule)) state.currentSchedule = schedules[0] ?? 'STD';
  scheduleSelect.innerHTML = schedules
    .map((s) => `<option value="${s}"${s === state.currentSchedule ? ' selected' : ''}>${s}</option>`)
    .join('');
}

dnSelect.addEventListener('change', () => {
  state.currentDn = dnSelect.value;
  refreshSizeSelects();
  applyToSelectedRun();
});
scheduleSelect.addEventListener('change', () => {
  state.currentSchedule = scheduleSelect.value;
  applyToSelectedRun();
});

/** Changing the toolbar size also retags the run you have selected. */
function applyToSelectedRun(): void {
  const sel = state.selection;
  if (sel?.kind !== 'run') return;
  host.edit('Change size', (d) => {
    const run = d.runs.find((r) => r.id === sel.id);
    if (!run) return;
    run.dn = state.currentDn;
    run.schedule = state.currentSchedule;
  });
}

snapSelect.addEventListener('change', () => {
  state.drawing.options.snap = Number(snapSelect.value) || 50;
  persist();
  render();
});

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('fit').addEventListener('click', () => fitView());
$('rotate').addEventListener('click', () => {
  state.drawing.options.northRotation = (((state.drawing.options.northRotation + 1) % 4) as 0 | 1 | 2 | 3);
  persist();
  render();
  fitView();
});

for (const [id, key] of [
  ['opt-dims', 'showDimensions'],
  ['opt-welds', 'showWelds'],
  ['opt-grid', 'showGrid'],
  ['opt-schematic', 'schematic'],
] as const) {
  const input = $<HTMLInputElement>(id);
  input.checked = Boolean(state.drawing.options[key]);
  input.addEventListener('change', () => {
    (state.drawing.options[key] as boolean) = input.checked;
    persist();
    render();
    if (key === 'schematic') fitView();
  });
}

$('new').addEventListener('click', () => {
  if (state.drawing.runs.length > 0 && !confirm('Start a new drawing? The current one will be cleared.')) return;
  undoStack.push(snapshot());
  redoStack.length = 0;
  Object.assign(state.drawing, emptyDrawing());
  state.selection = null;
  state.commandState = initialCommandState();
  recompute();
  persist();
  render();
  fitView();
});

$('save').addEventListener('click', () => {
  host.download(`${fileStem(host)}.iso.json`, JSON.stringify(state.drawing, null, 2), 'application/json');
});

$('open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text()) as Drawing;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.runs)) {
      throw new Error('Not an isometric file.');
    }
    undoStack.push(snapshot());
    Object.assign(state.drawing, { ...emptyDrawing(), ...parsed });
    state.selection = null;
    state.commandState = initialCommandState();
    recompute();
    persist();
    render();
    fitView();
    host.notify(`Opened ${file.name}`);
  } catch (error) {
    host.notify(error instanceof Error ? error.message : 'Could not open that file.');
  }
  fileInput.value = '';
});

$('export').addEventListener('click', openExportDialog);

/* -------------------------------------------------------------- undo/redo */

function undo(): void {
  const previous = undoStack.pop();
  if (!previous) return;
  redoStack.push(snapshot());
  Object.assign(state.drawing, JSON.parse(previous) as Drawing);
  state.selection = null;
  recompute();
  persist();
  render();
}

function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(snapshot());
  Object.assign(state.drawing, JSON.parse(next) as Drawing);
  state.selection = null;
  recompute();
  persist();
  render();
}

/* ---------------------------------------------------------------- exports */

function openExportDialog(): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'dialog-backdrop';
  backdrop.innerHTML = `
<div class="dialog" role="dialog" aria-label="Export">
  <h3>Export</h3>
  <p>The sheet carries the drawing, the bill of materials, the weld summary and the title block.</p>
  <div class="row"><label>Sheet size</label><select id="sheet-size">
    <option value="A4">A4 landscape</option>
    <option value="A3" selected>A3 landscape</option>
    <option value="A2">A2 landscape</option>
  </select></div>
  <div class="btn-row">
    <button class="btn-line solid" data-x="svg">SVG</button>
    <button class="btn-line" data-x="png">PNG</button>
    <button class="btn-line" data-x="print">Print / PDF</button>
    <button class="btn-line" data-x="json">Drawing file</button>
    <button class="btn-line" data-x="close">Cancel</button>
  </div>
</div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });

  const sheetSize = () => (backdrop.querySelector<HTMLSelectElement>('#sheet-size')?.value ?? 'A3') as SheetSize;

  backdrop.querySelectorAll<HTMLButtonElement>('[data-x]').forEach((button) => {
    button.addEventListener('click', async () => {
      const what = button.dataset.x;
      if (what === 'close') return close();
      const sheet = renderSheet(state.drawing, state.analysis, sheetSize());
      if (what === 'svg') {
        host.download(`${fileStem(host)}.svg`, sheet, 'image/svg+xml');
      } else if (what === 'png') {
        try {
          await exportPng(sheet, sheetSize());
        } catch {
          host.notify('Could not build the PNG — try the SVG instead.');
        }
      } else if (what === 'print') {
        printSheet(sheet);
      } else if (what === 'json') {
        host.download(`${fileStem(host)}.iso.json`, JSON.stringify(state.drawing, null, 2), 'application/json');
      }
      close();
    });
  });
}

const SHEET_MM: Record<SheetSize, { w: number; h: number }> = {
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
  A2: { w: 594, h: 420 },
};

async function exportPng(sheet: string, size: SheetSize): Promise<void> {
  const dpi = 200;
  const { w, h } = SHEET_MM[size];
  const pxW = Math.round((w / 25.4) * dpi);
  const pxH = Math.round((h / 25.4) * dpi);

  const url = URL.createObjectURL(new Blob([sheet], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('render failed'));
      image.src = url;
    });
    const target = document.createElement('canvas');
    target.width = pxW;
    target.height = pxH;
    const ctx = target.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pxW, pxH);
    ctx.drawImage(image, 0, 0, pxW, pxH);
    const blob = await new Promise<Blob | null>((resolve) => target.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('no blob');
    triggerDownload(blob, `${fileStem(host)}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function printSheet(sheet: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    host.notify('Printing is not available here — export the SVG instead.');
    return;
  }
  doc.open();
  doc.write(
    `<!doctype html><html><head><title>${fileStem(host)}</title><style>@page{size:auto;margin:0}html,body{margin:0;padding:0}svg{display:block;width:100%;height:auto}</style></head><body>${sheet}</body></html>`,
  );
  doc.close();
  const run = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  };
  if (doc.readyState === 'complete') setTimeout(run, 60);
  else frame.addEventListener('load', () => setTimeout(run, 60));
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* -------------------------------------------------------------- storage */

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.drawing));
  } catch {
    // Storage can be unavailable or full; the drawing is still exportable.
  }
}

function loadStored(): Drawing | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Drawing;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.runs)) return null;
    return { ...emptyDrawing(), ...parsed };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- shortcuts */

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (typing) return;

  if (event.key === 'Escape') {
    host.select(null);
  } else if (event.key === 'f' || event.key === 'F') {
    fitView();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    const sel = state.selection;
    if (!sel) return;
    event.preventDefault();
    host.edit('Delete', (d) => {
      if (sel.kind === 'run') deleteRun(d, sel.id);
      else if (sel.kind === 'node') deleteNode(d, sel.id);
      else removeComponent(d, sel.id);
    });
    host.select(null);
  }
});

/* --------------------------------------------------------------- sample */

const SAMPLE = `DN80
STD
ORIGIN 0 0 0
LABEL N1
END FLG
E 2400
+GATE 600
N 1800
MARK tee
U 1200
E 1500
END FLG
GOTO tee
E 1200
+CHECK 50%
END CONT`;

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.dataset.a === 'load-sample') {
    host.applyCommands(SAMPLE);
    state.tab = 'route';
    render();
  }
});

/* ----------------------------------------------------------------- start */

snapSelect.value = String(state.drawing.options.snap);
refreshSizeSelects();
render();
fitView();

import './styles.css';
import type { Drawing, Vec3 } from './model/types';
import type { Preview, Selection } from './render/renderer';
import type { AppState, Host } from './ui/types';
import { analyse, emptyDrawing } from './model/drawing';
import { initialCommandState, runCommands } from './model/commands';
import { deleteNode, deleteRun, ensureNode, removeComponent, route } from './model/edit';
import { DN_LIST, schedulesFor, sizeLabel } from './model/pipe-data';
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
  currentSchedule: drawing.options.pipeSchedule ?? 'SCH40',
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
    if (result.applied > 0) {
      canvas.setAnchor(state.commandState.currentNode);
      fitView();
    }
    host.notify(
      result.errors.length > 0
        ? `${result.applied} applied, ${result.errors.length} could not be read`
        : `${result.applied} command${result.applied === 1 ? '' : 's'} applied`,
    );
  },
  download(filename, content, mime) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    void saveFile(blob, filename);
  },
  copy(label, content) {
    void copyText(content, label);
  },
  pickLogo() {
    logoInput.click();
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
      // Carry on from the end of what was just drawn.
      canvas.setAnchor(newNode);
      state.preview = null;
      render();
    }
  },
  onStart() {
    let started: string | null = null;
    host.edit('Start route', (d) => {
      const id = ensureNode(d, { e: 0, n: 0, u: 0 } as Vec3);
      started = id;
      state.selection = { kind: 'node', id };
      state.commandState.currentNode = id;
    });
    if (started) canvas.setAnchor(started);
    fitView();
    host.notify('Point placed — now click where the pipe goes.');
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
  else if (canvas.drawingFrom) parts.push('<span>drawing — click to place, Esc to stop</span>');
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
    (dn) => `<option value="${dn}"${dn === state.currentDn ? ' selected' : ''}>${sizeLabel(dn)}</option>`,
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

/**
 * Drawing options feed the analysis — the joint type decides every mark and
 * which joints are welds, and not-to-scale mode changes the layout — so an
 * option change has to recompute, not just redraw.
 */
function updateOptions(mutate: (options: typeof state.drawing.options) => void): void {
  mutate(state.drawing.options);
  recompute();
  persist();
  render();
}

const jointSelect = $<HTMLSelectElement>('joint');
jointSelect.addEventListener('change', () => {
  updateOptions((o) => {
    o.joint = jointSelect.value as 'BW' | 'SW' | 'THD';
  });
});

scheduleSelect.addEventListener('change', () => {
  // Kept in step so the Line section and the toolbar never disagree.
  state.drawing.options.pipeSchedule = state.currentSchedule;
});

snapSelect.addEventListener('change', () => {
  updateOptions((o) => {
    o.snap = Number(snapSelect.value) || 50;
  });
});

/* --------------------------------------------------------------- layout */

/**
 * The drawing is the point of the app, so both side panels fold away. The
 * canvas resizes itself, so the view only needs re-fitting, not rebuilding.
 */
const appEl = $('app');
const LAYOUT_KEY = 'iso-draw.layout.v1';

function setLayout(cls: 'panel-hidden' | 'wide', on: boolean): void {
  appEl.classList.toggle(cls, on);
  if (cls === 'wide' && on) appEl.classList.remove('panel-hidden');
  try {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ panelHidden: appEl.classList.contains('panel-hidden'), wide: appEl.classList.contains('wide') }),
    );
  } catch {
    // Remembering the layout is a convenience, not a requirement.
  }
  $<HTMLButtonElement>('wide').textContent = appEl.classList.contains('wide') ? 'Panels' : 'Wide';
  requestAnimationFrame(() => canvas.render());
}

$('panel-toggle').addEventListener('click', () => {
  setLayout('panel-hidden', !appEl.classList.contains('panel-hidden'));
});
$('wide').addEventListener('click', () => {
  setLayout('wide', !appEl.classList.contains('wide'));
});

try {
  const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as {
    panelHidden?: boolean;
    wide?: boolean;
  };
  if (saved.wide) setLayout('wide', true);
  else if (saved.panelHidden) setLayout('panel-hidden', true);
} catch {
  // No remembered layout; the default is fine.
}

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('fit').addEventListener('click', () => fitView());
$('rotate').addEventListener('click', () => {
  updateOptions((o) => {
    o.northRotation = ((o.northRotation + 1) % 4) as 0 | 1 | 2 | 3;
  });
  fitView();
});

for (const [id, key] of [
  ['opt-dims', 'showDimensions'],
  ['opt-items', 'showItems'],
  ['opt-welds', 'showWelds'],
  ['opt-grid', 'showGrid'],
  ['opt-schematic', 'schematic'],
] as const) {
  const input = $<HTMLInputElement>(id);
  input.checked = Boolean(state.drawing.options[key]);
  input.addEventListener('change', () => {
    updateOptions((o) => {
      (o[key] as boolean) = input.checked;
    });
    if (key === 'schematic') fitView();
  });
}

$('new').addEventListener('click', () => {
  if (state.drawing.runs.length > 0 && !confirm('Start a new drawing? The current one will be cleared.')) return;
  undoStack.push(snapshot());
  redoStack.length = 0;
  Object.assign(state.drawing, emptyDrawing());
  state.selection = null;
  state.preview = null;
  canvas.setAnchor(null);
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

$('print').addEventListener('click', openPrintDialog);

/* ------------------------------------------------------------------- logo */

const logoInput = $<HTMLInputElement>('logo-input');
const MAX_LOGO_BYTES = 600_000;

logoInput.addEventListener('change', async () => {
  const file = logoInput.files?.[0];
  logoInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    host.notify('That is not an image file.');
    return;
  }
  if (file.size > MAX_LOGO_BYTES) {
    host.notify('That image is too large — use one under 600 KB.');
    return;
  }
  try {
    const dataUri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(file);
    });
    host.edit('Add logo', (d) => {
      d.meta.logo = dataUri;
    });
    host.notify('Logo added');
  } catch {
    host.notify('That image could not be read.');
  }
});

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

/** True when the app is embedded, where page-initiated downloads are inert. */
const embedded = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

/**
 * Printing is the whole of export: the sheet goes to the printer dialog, where
 * "Save as PDF" puts it on the machine. Everything else a fabrication drawing
 * needs is on that sheet.
 */
function openPrintDialog(): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'dialog-backdrop';
  backdrop.innerHTML = `
<div class="dialog" role="dialog" aria-label="Print">
  <h3>Print</h3>
  <p>The sheet carries the drawing, the material list, the weld list and the title block. Choose <strong>Save as PDF</strong> in the printer dialog to keep a copy on this device.</p>
  <div class="row"><label>Sheet size</label><select id="sheet-size">
    <option value="A4">A4 landscape</option>
    <option value="A3" selected>A3 landscape</option>
    <option value="A2">A2 landscape</option>
  </select></div>
  <div class="btn-row">
    <button class="btn-line solid" data-x="print">Print / Save as PDF</button>
    <button class="btn-line" data-x="preview">View sheet first</button>
    <button class="btn-line" data-x="close">Cancel</button>
  </div>
  ${
    embedded
      ? '<p class="empty-note" style="margin-top:12px">Running inside a viewer, printing can be blocked. Installed as an app it prints straight to your printer dialog.</p>'
      : ''
  }
</div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });

  const sheetSize = () => (backdrop.querySelector<HTMLSelectElement>('#sheet-size')?.value ?? 'A3') as SheetSize;

  backdrop.querySelectorAll<HTMLButtonElement>('[data-x]').forEach((button) => {
    button.addEventListener('click', () => {
      const what = button.dataset.x;
      if (what === 'close') return close();
      const sheet = renderSheet(state.drawing, state.analysis, sheetSize());
      if (what === 'preview') {
        openOverlay(
          'Sheet preview',
          `<div class="sheet-preview">${sheet}</div>`,
          true,
        );
      } else {
        printSheet(sheet, sheetSize());
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

function printSheet(sheet: string, size: SheetSize): void {
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
  const { w, h } = SHEET_MM[size];
  doc.write(
    `<!doctype html><html><head><title>${fileStem(host)}</title>` +
      `<style>@page{size:${w}mm ${h}mm;margin:0}html,body{margin:0;padding:0}` +
      `svg{display:block;width:${w}mm;height:${h}mm}</style></head><body>${sheet}</body></html>`,
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

/** Full-screen overlay used to show something the page cannot hand over as a file. */
function openOverlay(title: string, body: string, wide = false): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'dialog-backdrop';
  backdrop.innerHTML = `<div class="dialog${wide ? ' wide' : ''}" role="dialog" aria-label="${title}">
  <h3>${title}</h3>
  ${body}
  <div class="btn-row"><button class="btn-line" data-close>Close</button></div>
</div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop || (event.target as HTMLElement).hasAttribute('data-close')) close();
  });
  return backdrop;
}

/**
 * Copies text to the clipboard. Where the clipboard is unavailable — some
 * embedded viewers withhold it — the text is shown ready to select instead, so
 * there is always a way to get the drawing out.
 */
async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    host.notify(`${label} copied to the clipboard`);
    return;
  } catch {
    const overlay = openOverlay(
      label,
      `<p>Your browser would not let the page reach the clipboard. Select all of this and copy it.</p>
       <textarea class="command" readonly style="min-height:240px"></textarea>`,
      true,
    );
    const area = overlay.querySelector('textarea');
    if (area) {
      area.value = text;
      area.focus();
      area.select();
    }
  }
}

/**
 * The claude.ai artifact viewer refuses downloads a page starts for itself and
 * offers a mediated `downloads` capability instead. It is absent everywhere
 * else, including when the file is opened straight from disk, so the ordinary
 * anchor download stays as the fallback.
 */
interface SaveCapability {
  save(request: { filename: string; data: Blob }): Promise<{ status: string }>;
}

let savePromise: Promise<SaveCapability | null> | null = null;

function saveCapability(): Promise<SaveCapability | null> {
  if (!savePromise) {
    const claude = (window as unknown as { claude?: { use?(name: string): Promise<unknown> } }).claude;
    savePromise = claude?.use
      ? claude.use('downloads').then((c) => (c as SaveCapability | null) ?? null, () => null)
      : Promise.resolve(null);
  }
  return savePromise;
}

async function saveFile(blob: Blob, filename: string): Promise<void> {
  const downloads = await saveCapability();
  if (downloads) {
    try {
      await downloads.save({ filename, data: blob });
      return;
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      // The viewer simply said no; nothing failed and nothing needs saying.
      if (code === 'declined') return;
      if (code === 'rate_limited') {
        host.notify('A save is already waiting for you — finish that one first.');
        return;
      }
      host.notify('That file could not be saved here. Use View sheet or the copy buttons instead.');
      return;
    }
  }
  triggerDownload(blob, filename);
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
    canvas.setAnchor(null);
    state.preview = null;
    hoverMessage = null;
    host.select(null);
  } else if (event.key === 'f' || event.key === 'F') {
    fitView();
  } else if (event.key === 'w' || event.key === 'W') {
    setLayout('wide', !appEl.classList.contains('wide'));
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    const sel = state.selection;
    if (!sel) return;
    event.preventDefault();
    host.edit('Delete', (d) => {
      if (sel.kind === 'run') deleteRun(d, sel.id);
      else if (sel.kind === 'node') deleteNode(d, sel.id);
      else removeComponent(d, sel.id);
    });
    if (sel.kind === 'node') canvas.setAnchor(null);
    state.preview = null;
    host.select(null);
  }
});

/* --------------------------------------------------------------- sample */

const SAMPLE = `3"
STD
ORIGIN 0 0 0
LABEL N1
END FLG
E 2400
+BALL 600
N 1800
MARK tee
U 1200
E 1500
END FLG
GOTO tee
E 1200
+BALLAIR 50%
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
jointSelect.value = state.drawing.options.joint ?? 'BW';
refreshSizeSelects();
render();
fitView();

import './styles.css';
import type { Drawing, Run, Vec3 } from './model/types';
import type { Preview, Selection } from './render/renderer';
import type { AppState, Host } from './ui/types';
import { analyse, dimensionStops, emptyDrawing } from './model/drawing';
import { add, length3, scale3, sub } from './model/iso';
import { initialCommandState, runCommands } from './model/commands';
import { applyDimension, deleteNode, deleteRun, ensureNode, removeComponent, route, stretchRun } from './model/edit';
import { DN_LIST, schedulesFor, sizeLabel } from './model/pipe-data';
import { northArrow, paperOf, toPaper } from './render/renderer';
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
    // Typed commands set the size as they go; drawing on carries it.
    state.currentDn = result.state.dn;
    state.currentSchedule = result.state.schedule;
    refreshSizeSelects();
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
  continueFrom(nodeId) {
    canvas.setAnchor(nodeId);
    state.selection = { kind: 'node', id: nodeId };
    state.commandState.currentNode = nodeId;
    syncSizeFromSelection();
    render();
    host.notify('Carry on clicking to continue the line.');
  },
  notify(message) {
    toast = { message, until: Date.now() + 3200 };
    render();
    setTimeout(render, 3400);
  },
  stopDrawing() {
    stopDrawing();
  },
  editDimension(runId, index) {
    // The figure has to be on the sheet to be typed over: find its target.
    render();
    const target = svg.querySelector<SVGCircleElement>(`[data-dim="${runId}:${index}"]`);
    if (!target) {
      host.notify('Turn dimensions on to type one.');
      return;
    }
    const box = target.getBoundingClientRect();
    openDimensionEditor(runId, index, box.left + box.width / 2, box.top + box.height / 2);
  },
};

/* ------------------------------------------------- typing a dimension */

let dimensionEditor: HTMLInputElement | null = null;

/**
 * A box over the figure on the drawing, to type the length of that piece.
 * Up to a valve it moves the valve; on the last piece it moves the end. The
 * other side of whatever moved takes up the difference.
 */
function openDimensionEditor(runId: string, index: number, clientX: number, clientY: number): void {
  const run = state.drawing.runs.find((r) => r.id === runId);
  if (!run) return;
  const stops = dimensionStops(state.drawing, run);
  if (index + 1 >= stops.length) return;
  const current = Math.round(stops[index + 1] - stops[index]);
  openInlineEditor(String(current), 'numeric', clientX, clientY, (text) => {
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0 || Math.round(value) === current) return;
    let refused: string | null = null;
    host.edit('Set dimension', (d) => {
      refused = applyDimension(d, runId, index, Math.round(value));
    });
    if (refused) {
      undoStack.pop();
      host.notify(refused);
    }
  });
}

/** A weld number, typed over right on the drawing. */
function openWeldEditor(key: string, clientX: number, clientY: number): void {
  const weld = state.analysis.joints.find((j) => j.key === key);
  if (!weld) return;
  openInlineEditor(weld.number, 'text', clientX, clientY, (text) => {
    const number = text.trim();
    if (number === weld.number) return;
    host.edit('Renumber weld', (d) => {
      if (number) d.weldOverrides[key] = { ...d.weldOverrides[key], number };
      else if (d.weldOverrides[key]) delete d.weldOverrides[key].number;
    });
  });
}

/**
 * A box over the drawing to type into, opened on the tap itself so the
 * keyboard comes up with it. Enter or tapping away keeps the value, Esc drops it.
 */
function openInlineEditor(
  value: string,
  mode: 'numeric' | 'text',
  clientX: number,
  clientY: number,
  onCommit: (text: string) => void,
): void {
  closeDimensionEditor();
  const wrap = svg.parentElement as HTMLElement;
  const rect = wrap.getBoundingClientRect();
  const input = document.createElement('input');
  input.type = mode === 'numeric' ? 'number' : 'text';
  input.inputMode = mode;
  input.autocapitalize = 'characters';
  input.className = 'dim-editor';
  input.value = value;
  input.setAttribute('aria-label', mode === 'numeric' ? 'Dimension in millimetres' : 'Weld number');
  input.style.left = `${Math.max(8, Math.min(rect.width - 96, clientX - rect.left - 44))}px`;
  input.style.top = `${Math.max(8, Math.min(rect.height - 40, clientY - rect.top - 16))}px`;
  wrap.appendChild(input);
  dimensionEditor = input;

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const text = input.value;
    closeDimensionEditor();
    onCommit(text);
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      done = true;
      closeDimensionEditor();
    }
    event.stopPropagation();
  });
  input.addEventListener('blur', commit);
  input.focus();
  input.select();
}

function closeDimensionEditor(): void {
  dimensionEditor?.remove();
  dimensionEditor = null;
}

/* ----------------------------------------------------------------- canvas */

const canvas = new Canvas(svg, {
  onSelect(selection: Selection) {
    // Something picked on the drawing is edited in the Route tab, so that is
    // where the panel goes — unless the weld list is open, which edits welds too.
    if (selection && state.tab !== 'route' && !(selection.kind === 'weld' && state.tab === 'welds')) {
      state.tab = 'route';
    }
    host.select(selection);
  },
  onRoute(fromId, axis, length) {
    let newNode: string | null = null;
    let refused: string | null = null;
    host.edit('Route', (d) => {
      const result = route(d, fromId, axis, length, state.currentDn, state.currentSchedule, 0, length);
      refused = result?.refused ?? null;
      newNode = refused ? null : (result?.nodeId ?? null);
    });
    if (refused) {
      // Nothing changed, so the edit just recorded is not worth an undo step.
      undoStack.pop();
      state.preview = null;
      host.notify(refused);
      render();
      return;
    }
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

  /**
   * Slides a component along the run it sits in. The drag is live but only the
   * drop is recorded, so one move is one undo rather than a hundred.
   */
  onSlideComponent(componentId, paper, commit) {
    const run = state.drawing.runs.find((r) => r.inline.some((c) => c.id === componentId));
    const comp = run?.inline.find((c) => c.id === componentId);
    if (!run || !comp) return;
    const offset = offsetFromPaper(run, paper);
    if (offset === null) return;

    // The drag is shown live by moving the real thing, so the position before
    // it started is kept and put back before the edit is recorded. Otherwise
    // undo would restore the drawing to half way through the drag.
    if (!slideFrom || slideFrom.id !== componentId) {
      slideFrom = { id: componentId, offset: comp.offset };
    }

    if (commit) {
      comp.offset = slideFrom.offset;
      slideFrom = null;
      host.edit('Move component', (d) => {
        const target = d.runs.flatMap((r) => r.inline).find((c) => c.id === componentId);
        if (target) target.offset = offset;
      });
      return;
    }
    comp.offset = offset;
    recompute();
    renderCanvasOnly();
    hoverMessage = `${Math.round(offset)} mm along the run`;
    renderHud();
  },

  onEditDimension(runId, index, clientX, clientY) {
    openDimensionEditor(runId, index, clientX, clientY);
  },
  onEditWeld(key, clientX, clientY) {
    openWeldEditor(key, clientX, clientY);
  },

  /**
   * Drags an end of a run along the run's own line. To scale, that is the
   * run's true length; not to scale, it is only how long the run is drawn,
   * and the true length is what is typed on the dimension.
   */
  onStretchRun(runId, end, paper, commit) {
    const run = state.drawing.runs.find((r) => r.id === runId);
    if (!run) return;
    const length = stretchLengthTo(run, end, paper);
    if (length === null) return;
    const schematic = !!state.drawing.options.schematic;

    if (!stretchFrom || stretchFrom.id !== runId) {
      stretchFrom = { id: runId, visual: run.visual, snapshot: snapshot() };
    }
    if (commit) {
      const before = stretchFrom;
      stretchFrom = null;
      // Put the drawing back as it was before the drag, then record the move
      // as one edit so undo returns there rather than to half way through.
      Object.assign(state.drawing, JSON.parse(before.snapshot) as Drawing);
      host.edit('Stretch run', (d) => {
        const target = d.runs.find((r) => r.id === runId);
        if (!target) return;
        if (schematic) target.visual = length;
        else stretchRun(d, runId, length, end);
      });
      return;
    }
    if (schematic) run.visual = length;
    else stretchRun(state.drawing, runId, length, end);
    recompute();
    renderCanvasOnly();
    hoverMessage = schematic ? 'drawn length — type the dimension for the real one' : `${Math.round(length)} mm`;
    renderHud();
  },

  /** Moves a weld number tag; the leader stays on the weld. */
  onSlideTag(key, offset, commit) {
    const apply = (d: Drawing) => {
      d.weldOverrides[key] = { ...d.weldOverrides[key], tag: { dx: offset.dx, dy: offset.dy } };
    };
    if (commit) {
      if (tagFrom) {
        Object.assign(state.drawing, JSON.parse(tagFrom) as Drawing);
        tagFrom = null;
      }
      host.edit('Move weld tag', apply);
      return;
    }
    if (!tagFrom) tagFrom = snapshot();
    apply(state.drawing);
    recompute();
    renderCanvasOnly();
  },

  /** Slides a branch point along the line that runs through it. */
  onSlideNode(nodeId, paper, commit) {
    const node = state.drawing.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    // Not to scale, sliding a point moves it on the drawing only: the drawn
    // lengths either side change, the typed ones stay.
    const schematic = !!state.drawing.options.schematic;
    const drawn = schematic ? slideDrawnTo(nodeId, paper) : null;
    const moved = schematic ? null : slideNodeTo(nodeId, paper);
    if (!moved && !drawn) return;

    if (!slideNodeFrom || slideNodeFrom.id !== nodeId) {
      slideNodeFrom = { id: nodeId, snapshot: snapshot() };
    }
    const apply = (d: Drawing) => {
      if (drawn) {
        for (const [runId, visual] of drawn) {
          const target = d.runs.find((r) => r.id === runId);
          if (target) target.visual = visual;
        }
      } else if (moved) {
        const target = d.nodes.find((n) => n.id === nodeId);
        if (target) target.pos = { ...moved };
      }
    };

    if (commit) {
      Object.assign(state.drawing, JSON.parse(slideNodeFrom.snapshot) as Drawing);
      slideNodeFrom = null;
      host.edit('Move point', apply);
      return;
    }
    apply(state.drawing);
    recompute();
    renderCanvasOnly();
    hoverMessage = 'sliding along the line';
    renderHud();
  },
});

/** What a slide started from, so undo returns there and not to mid-drag. */
let slideFrom: { id: string; offset: number } | null = null;
let slideNodeFrom: { id: string; snapshot: string } | null = null;
let stretchFrom: { id: string; visual: number | undefined; snapshot: string } | null = null;
let tagFrom: string | null = null;

/**
 * The length a run would have with one end dragged to a point: the point is
 * measured along the run's own line from the end that stays, so the run only
 * ever gets longer or shorter, never turns.
 */
function stretchLengthTo(run: Run, end: 'from' | 'to', paper: { x: number; y: number }): number | null {
  const fixedId = end === 'to' ? run.from : run.to;
  const movingId = end === 'to' ? run.to : run.from;
  const fixed = state.analysis.nodeById.get(fixedId);
  const moving = state.analysis.nodeById.get(movingId);
  if (!fixed || !moving) return null;
  const pf = paperOf(state.analysis, state.drawing, fixedId);
  const pm = paperOf(state.analysis, state.drawing, movingId);
  if (!pf || !pm) return null;
  const vx = pm.x - pf.x;
  const vy = pm.y - pf.y;
  const drawn = Math.hypot(vx, vy);
  if (drawn < 0.01) return null;
  const along = ((paper.x - pf.x) * vx + (paper.y - pf.y) * vy) / drawn;
  // Paper units per mm along this run, however it is currently drawn.
  const shown = state.drawing.options.schematic
    ? (run.visual ?? state.drawing.options.schematicLength)
    : length3(sub(moving.pos, fixed.pos));
  const perMm = shown > 0 ? drawn / shown : 0;
  if (perMm <= 0) return null;
  const snap = dragSnap();
  return Math.max(snap, Math.round(along / perMm / snap) * snap);
}

/** Where along a run a paper point falls, snapped, or null if it cannot be read. */
function offsetFromPaper(run: Run, paper: { x: number; y: number }): number | null {
  const a = state.analysis.nodeById.get(run.from);
  const b = state.analysis.nodeById.get(run.to);
  if (!a || !b) return null;
  const pa = toPaper(a.pos, state.drawing);
  const pb = toPaper(b.pos, state.drawing);
  const vx = pb.x - pa.x;
  const vy = pb.y - pa.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1) return null;
  const t = Math.max(0, Math.min(1, ((paper.x - pa.x) * vx + (paper.y - pa.y) * vy) / lenSq));
  const total = length3(sub(b.pos, a.pos));
  const snap = dragSnap();
  return Math.max(0, Math.min(total, Math.round((t * total) / snap) * snap));
}

/** The two runs that make the straight line through a point, if there is one. */
function lineThrough(nodeId: string): [Run, Run] | null {
  const info = state.analysis.nodeInfo.get(nodeId);
  if (!info) return null;
  for (let i = 0; i < info.legs.length; i += 1) {
    for (let j = i + 1; j < info.legs.length; j += 1) {
      const a = info.legs[i];
      const b = info.legs[j];
      if (a.e * b.e + a.n * b.n + a.u * b.u < -0.999) return [info.runs[i], info.runs[j]];
    }
  }
  return null;
}

/**
 * Not to scale: the drawn lengths either side of a point, with the point
 * dragged along the drawn line between its neighbours. Their sum stays.
 */
function slideDrawnTo(nodeId: string, paper: { x: number; y: number }): [string, number][] | null {
  const through = lineThrough(nodeId);
  if (!through) return null;
  const farOf = (run: Run) => (run.from === nodeId ? run.to : run.from);
  const pa = paperOf(state.analysis, state.drawing, farOf(through[0]));
  const pb = paperOf(state.analysis, state.drawing, farOf(through[1]));
  if (!pa || !pb) return null;
  const vx = pb.x - pa.x;
  const vy = pb.y - pa.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1) return null;
  const drawnOf = (run: Run) => run.visual ?? state.drawing.options.schematicLength;
  const total = drawnOf(through[0]) + drawnOf(through[1]);
  const t = Math.max(0.05, Math.min(0.95, ((paper.x - pa.x) * vx + (paper.y - pa.y) * vy) / lenSq));
  const snap = dragSnap();
  const first = Math.max(snap, Math.round((t * total) / snap) * snap);
  return [
    [through[0].id, first],
    [through[1].id, Math.max(snap, total - first)],
  ];
}

/**
 * The position a branch point would slide to: along the line that runs through
 * it, never off either end of the runs it joins.
 */
function slideNodeTo(nodeId: string, paper: { x: number; y: number }): Vec3 | null {
  const info = state.analysis.nodeInfo.get(nodeId);
  if (!info) return null;

  // The line through the point is the pair of legs that face each other.
  let through: [Run, Run] | null = null;
  for (let i = 0; i < info.legs.length && !through; i += 1) {
    for (let j = i + 1; j < info.legs.length; j += 1) {
      const a = info.legs[i];
      const b = info.legs[j];
      if (a.e * b.e + a.n * b.n + a.u * b.u < -0.999) {
        through = [info.runs[i], info.runs[j]];
        break;
      }
    }
  }
  if (!through) return null;

  const node = state.drawing.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const farOf = (run: Run) => {
    const id = run.from === nodeId ? run.to : run.from;
    return state.analysis.nodeById.get(id);
  };
  const back = farOf(through[0]);
  const forward = farOf(through[1]);
  if (!back || !forward) return null;

  // Slide between the two ends, leaving a little pipe either side.
  const span = sub(forward.pos, back.pos);
  const spanLen = length3(span);
  if (spanLen < 1) return null;
  const pa = toPaper(back.pos, state.drawing);
  const pb = toPaper(forward.pos, state.drawing);
  const vx = pb.x - pa.x;
  const vy = pb.y - pa.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1) return null;
  const snap = dragSnap();
  const raw = (((paper.x - pa.x) * vx + (paper.y - pa.y) * vy) / lenSq) * spanLen;
  const at = Math.max(snap, Math.min(spanLen - snap, Math.round(raw / snap) * snap));
  return add(back.pos, scale3(span, at / spanLen));
}

/**
 * Dragging snaps finer than tapping does: a 50 mm snap is right for laying
 * out a route, but makes a drag leap in steps on a short run.
 */
function dragSnap(): number {
  return Math.max(1, Math.min(10, state.drawing.options.snap));
}

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
  else if (canvas.drawingFrom) parts.push('<span>drawing — tap where the pipe goes</span>');
  // No keyboard on a tablet, so stopping the line is a button as well as Esc,
  // and so is deleting what is selected.
  if (canvas.drawingFrom) parts.push('<button class="hud-stop" id="hud-stop" type="button">Stop drawing</button>');
  const sel = state.selection;
  if (sel && sel.kind !== 'weld') {
    const what = sel.kind === 'run' ? 'run' : sel.kind === 'node' ? 'point' : 'item';
    parts.push(`<button class="hud-stop hud-delete" id="hud-delete" type="button">Delete ${what}</button>`);
  }
  parts.push(`<span>snap ${state.drawing.options.snap} mm</span>`);
  if (state.drawing.options.schematic) parts.push('<span>not to scale</span>');
  for (const warning of state.analysis.warnings.slice(0, 2)) {
    parts.push(`<span class="warn">${warning}</span>`);
  }
  if (toast && toast.until > Date.now()) parts.push(`<span>${toast.message}</span>`);
  hudEl.innerHTML = parts.join('');
  hudEl.querySelector('#hud-stop')?.addEventListener('click', stopDrawing);
  hudEl.querySelector('#hud-delete')?.addEventListener('click', deleteSelection);
}

/** Puts the pencil down: the route stays as drawn, nothing more is armed. */
function stopDrawing(): void {
  canvas.setAnchor(null);
  state.preview = null;
  hoverMessage = null;
  host.select(null);
}

/**
 * The size in the toolbar follows what is selected, so a line carried on from
 * a point keeps the size of the pipe already there rather than whatever was
 * last picked. Changing the size afterwards still applies to what comes next.
 */
function syncSizeFromSelection(): void {
  const sel = state.selection;
  let run: Run | undefined;
  if (sel?.kind === 'run') run = state.drawing.runs.find((r) => r.id === sel.id);
  else if (sel?.kind === 'node') run = state.drawing.runs.find((r) => r.from === sel.id || r.to === sel.id);
  else if (sel?.kind === 'component') run = state.drawing.runs.find((r) => r.inline.some((c) => c.id === sel.id));
  if (run) {
    state.currentDn = run.dn;
    state.currentSchedule = run.schedule;
    refreshSizeSelects();
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

// On a narrow screen the view switches live behind a button, so that Print
// and the rest stay on screen. Tapping anywhere else puts them away again.
const viewMenuEl = $('view-menu');
$('view-menu-button').addEventListener('click', (event) => {
  event.stopPropagation();
  const open = viewMenuEl.classList.toggle('open');
  $('view-menu-button').setAttribute('aria-expanded', String(open));
});
document.addEventListener('pointerdown', (event) => {
  if (!viewMenuEl.contains(event.target as Node)) {
    viewMenuEl.classList.remove('open');
    $('view-menu-button').setAttribute('aria-expanded', 'false');
  }
});

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

$('new').addEventListener('click', async () => {
  if (state.drawing.runs.length > 0) {
    const ok = await confirmDialog(
      'Start a new drawing',
      'The route on this drawing will be cleared. Your logo, project and pipe settings are kept.',
      'Start new drawing',
    );
    if (!ok) return;
  }
  undoStack.push(snapshot());
  redoStack.length = 0;

  // A new sheet on the same job: the route goes, but the company mark, the
  // project and the way the pipe is specified carry over, because retyping
  // them for every isometric is the opposite of useful.
  const fresh = emptyDrawing();
  const kept = state.drawing;
  Object.assign(state.drawing, {
    ...fresh,
    options: { ...kept.options },
    meta: {
      ...fresh.meta,
      logo: kept.meta.logo,
      project: kept.meta.project,
      drawnBy: kept.meta.drawnBy,
    },
  });

  state.selection = null;
  state.preview = null;
  hoverMessage = null;
  canvas.setAnchor(null);
  state.commandState = initialCommandState(state.currentDn, state.currentSchedule);
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

/**
 * Asks the viewer to confirm something destructive.
 *
 * Deliberately not `confirm()`: embedded viewers run the page sandboxed without
 * modals, where the browser ignores the call and it returns false — which
 * silently turned New into a button that did nothing at all.
 */
function confirmDialog(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    backdrop.innerHTML = `
<div class="dialog" role="dialog" aria-label="${title}">
  <h3>${title}</h3>
  <p>${message}</p>
  <div class="btn-row">
    <button class="btn-line solid" data-confirm>${confirmLabel}</button>
    <button class="btn-line" data-cancel>Cancel</button>
  </div>
</div>`;
    document.body.appendChild(backdrop);
    const close = (answer: boolean) => {
      backdrop.remove();
      resolve(answer);
    };
    backdrop.querySelector('[data-confirm]')?.addEventListener('click', () => close(true));
    backdrop.querySelector('[data-cancel]')?.addEventListener('click', () => close(false));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(false);
    });
    backdrop.querySelector<HTMLButtonElement>('[data-confirm]')?.focus();
  });
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
    viewMenuEl.classList.remove('open');
    canvas.setAnchor(null);
    state.preview = null;
    hoverMessage = null;
    host.select(null);
  } else if (event.key === 'f' || event.key === 'F') {
    fitView();
  } else if (event.key === 'w' || event.key === 'W') {
    setLayout('wide', !appEl.classList.contains('wide'));
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    if (!state.selection) return;
    event.preventDefault();
    deleteSelection();
  }
});

/** Removes whatever is selected: a run, a point and its runs, or an item. */
function deleteSelection(): void {
  const sel = state.selection;
  if (!sel || sel.kind === 'weld') return;
  host.edit('Delete', (d) => {
    if (sel.kind === 'run') deleteRun(d, sel.id);
    else if (sel.kind === 'node') deleteNode(d, sel.id);
    else removeComponent(d, sel.id);
  });
  if (sel.kind === 'node') canvas.setAnchor(null);
  state.preview = null;
  host.select(null);
}

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

import './styles.css';
import type { Axis, Drawing, InlineComponent, Run, Vec3 } from './model/types';
import type { Preview, Selection } from './render/renderer';
import type { AppState, Host, OletAsk, OletChoice, ReducerAsk, ReducerChoice } from './ui/types';
import { reducerPreview } from './ui/reducer-preview';
import { tidyLayout, type LayoutSpecs } from './render/tidy';
import { analyse, chainStops, dimensionStops, drawnLength, drawnStations, runDrawnFloor, trueAtShare, type DrawnStations, isMark, isReducer, itemAtEnd, itemHalf, runGroupIds, emptyDrawing, oletLegs, oletMarks, uid } from './model/drawing';
import { loadLibrary, removeDrawing, renumberProject, sheetNumber, upsertDrawing, worthKeeping } from './model/library';
import { beginDriveSignIn, driveSignOut, driveStatus, finishDriveSignIn, noteRemovedFromLibrary, setDriveClientId, syncDrive } from './model/drive';
import { AXES, AXIS_VECTOR, add, length3, scale3, sub } from './model/iso';
import { initialCommandState, runCommands } from './model/commands';
import { addMeasure, applyMeasureToOlet, DASHED_NOTE, deleteRunGroup, measureTypeable, applyChainDimension, applyDimension, connectNodes, removeMeasure, deletePoint, ensureNode, isPlainPoint, removeComponent, removeEquipment, removeFlangeJoint, removeOlet, route, runLength, setLineSize, setRunDashed, setRunDirect, startFromEquipment, straightenBranches, stretchRun, syncEquipment, uncoverPoints } from './model/edit';
import { DN_LIST, schedulesFor, sizeLabel, sizeOf } from './model/pipe-data';
import { northArrow, paperOf, renderDrawing, symbolSizeFor } from './render/renderer';
import { SHEET_STAMPS, renderSheet, sheetStamp, sheetSymbolSize, type SheetSize } from './render/sheet';
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

// A pinch zooms the drawing, never the page: iOS zooms the whole page on a
// pinch that starts off the drawing (its bars and panels too) unless its
// gesture events are refused, whatever the viewport says.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}
document.addEventListener(
  'touchmove',
  (event) => {
    if (event.touches.length > 1 && !(event.target instanceof Element && event.target.closest('#canvas'))) event.preventDefault();
  },
  { passive: false },
);

const drawing = loadStored() ?? emptyDrawing();
if (!drawing.id) drawing.id = uid('d');
const asLoaded = JSON.stringify(drawing);
straightenBranches(drawing);
syncEquipment(drawing);
uncoverPoints(drawing);
// A sheet put right on opening (a box back on its line, a reducer's sizes
// in order) is kept so, not only shown so.
if (JSON.stringify(drawing) !== asLoaded) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drawing));
  } catch {
    // Storage unavailable: the next edit keeps it.
  }
}

const state: AppState = {
  drawing,
  analysis: analyse(drawing),
  selection: null,
  measureFrom: null,
  joinFrom: null,
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
    // Equipment keeps with its point, and the line beyond it with the box.
    syncEquipment(state.drawing);
    uncoverPoints(state.drawing);
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
    // Drawing from an olet lays its branch, at the branch size.
    const info = state.analysis.nodeInfo.get(nodeId);
    const pending = info?.fitting === 'OLET' ? oletLegs(info)?.pending[0] : undefined;
    if (pending) {
      state.currentDn = pending.dn;
      refreshSizeSelects();
    }
    render();
    host.notify(pending ? `Tap where the branch goes: ${sizeLabel(pending.dn)} from the olet, ${AXIS_NAMES[pending.dir].toLowerCase()}.` : 'Carry on clicking to continue the line.');
  },
  startFromEquipment(id) {
    let started: string | null = null;
    host.edit('Start from equipment', (d) => {
      started = startFromEquipment(d, id);
    });
    if (!started) return;
    host.continueFrom(started);
    host.notify('A point on the far side of the equipment — tap where the pipe goes from it.');
  },
  notify(message) {
    toast = { message, until: Date.now() + 3200 };
    render();
    // Only the status line changes when the notice goes: redrawing the whole
    // panel then threw away whatever was half typed in one of its fields.
    setTimeout(renderHud, 3400);
  },
  stopDrawing() {
    stopDrawing();
  },
  library() {
    return loadLibrary();
  },
  openFromLibrary(id) {
    const entry = loadLibrary().find((e) => e.id === id);
    if (!entry) {
      host.notify('That sheet is no longer on this device.');
      return;
    }
    keepNow();
    undoStack.push(snapshot());
    redoStack.length = 0;
    takeUp(entry.drawing);
    host.notify(`Opened ${entry.drawing.meta.project || 'the drawing'}, sheet ${entry.drawing.meta.sheet || '1 of 1'}.`);
  },
  removeFromLibrary(id) {
    const entry = loadLibrary().find((e) => e.id === id);
    if (!entry) return;
    void confirmDialog(
      'Remove this sheet',
      `Sheet ${entry.drawing.meta.sheet || '1 of 1'} of ${entry.drawing.meta.project || 'the unnamed project'} will be forgotten on this device. A file you saved of it is untouched.`,
      'Remove',
    ).then((ok) => {
      if (!ok) return;
      removeDrawing(id);
      noteRemovedFromLibrary(id);
      if (id === state.drawing.id) state.drawing.id = uid('d');
      render();
    });
  },
  newSheetInProject() {
    newSheetInProject();
  },
  driveStatus() {
    return driveStatus();
  },
  driveConnect(clientId) {
    setDriveClientId(clientId);
    if (!driveStatus().clientId) {
      host.notify('Paste the OAuth client ID from Google Cloud first.');
      return;
    }
    keepNow();
    beginDriveSignIn();
  },
  driveSync() {
    void runDriveSync();
  },
  reducerDialog(ask) {
    return reducerDialog(ask);
  },
  oletDialog(ask) {
    return oletDialog(ask);
  },
  measureFrom(nodeId) {
    state.measureFrom = nodeId;
    state.selection = { kind: 'node', id: nodeId };
    render();
    host.notify('Tap the other point of the dimension.');
  },
  joinFrom(nodeId) {
    state.joinFrom = nodeId;
    state.measureFrom = null;
    state.selection = { kind: 'node', id: nodeId };
    canvas.setAnchor(null);
    render();
    host.notify('Tap the open end to join this one to — on this line or another.');
  },
  setCurrentSize(dn) {
    state.currentDn = dn;
    if (!schedulesFor(dn).includes(state.currentSchedule)) state.currentSchedule = schedulesFor(dn)[0] ?? state.currentSchedule;
    refreshSizeSelects();
  },
  driveSignOut() {
    driveSignOut();
    host.notify('Signed out of Google Drive on this device. The sheets stay here.');
    render();
  },
  editDimension(key) {
    // The figure has to be on the sheet to be typed over: find its target.
    render();
    const target = svg.querySelector<SVGCircleElement>(`[data-dim="${key}"]`);
    if (!target) {
      host.notify('Turn dimensions on to type one.');
      return;
    }
    const box = target.getBoundingClientRect();
    openDimensionEditor(key, box.left + box.width / 2, box.top + box.height / 2);
  },
};

/* ------------------------------------------------- typing a dimension */

let dimensionEditor: HTMLInputElement | null = null;

/**
 * A box over the figure on the drawing, to type the length of that piece.
 * Up to a valve it moves the valve; on the last piece it moves the end. The
 * other side of whatever moved takes up the difference.
 */
function openDimensionEditor(key: string, clientX: number, clientY: number): void {
  // A header chain's pieces and its olets' distances have keys of their own.
  const chained = key.startsWith('hdr:') || key.startsWith('chain:') || key.startsWith('olet:');
  const measured = key.startsWith('meas:');
  let current: number;
  if (measured) {
    const measure = state.drawing.measures?.find((m) => m.id === key.slice(5));
    const na = measure ? state.analysis.nodeById.get(measure.a) : undefined;
    const nb = measure ? state.analysis.nodeById.get(measure.b) : undefined;
    if (!na || !nb) return;
    current = Math.round(Math.hypot(nb.pos.e - na.pos.e, nb.pos.n - na.pos.n, nb.pos.u - na.pos.u));
  } else if (chained) {
    const olet = key.match(/^olet:(.+)$/);
    const piece = key.match(/^(?:hdr|chain):(.+):(\d+|all)$/);
    const chain = olet
      ? state.analysis.chains.find((c) => c.olets.some((o) => o.nodeId === olet[1]))
      : state.analysis.chains.find((c) => c.id === piece?.[1]);
    if (!chain) return;
    if (olet) current = Math.round(chain.olets.find((o) => o.nodeId === olet[1])!.along);
    else if (piece![2] === 'all') current = Math.round(chain.total);
    else {
      const stops = chainStops(state.drawing, chain);
      const index = Number(piece![2]);
      if (index + 1 >= stops.length) return;
      current = Math.round(stops[index + 1] - stops[index]);
    }
  } else {
    const [runId, indexText] = key.split(':');
    const index = Number(indexText);
    const run = state.drawing.runs.find((r) => r.id === runId);
    if (!run) return;
    const stops = dimensionStops(state.drawing, run);
    if (index + 1 >= stops.length) return;
    current = Math.round(stops[index + 1] - stops[index]);
  }
  openInlineEditor(
    String(current),
    'numeric',
    clientX,
    clientY,
    (text) => {
      const value = Number(text);
      if (!Number.isFinite(value) || value <= 0 || Math.round(value) === current) return;
      let refused: string | null = null;
      if (measured && !measureTypeable(state.drawing, state.analysis, key.slice(5))) {
        host.notify('A dimension between two points: move a point to change it.');
        return;
      }
      host.edit('Set dimension', (d) => {
        if (measured) refused = applyMeasureToOlet(d, state.analysis, key.slice(5), Math.round(value));
        else if (chained) refused = applyChainDimension(d, state.analysis, key, Math.round(value));
        else {
          const [runId, indexText] = key.split(':');
          refused = applyDimension(d, runId, Number(indexText), Math.round(value));
        }
      });
      if (refused) {
        undoStack.pop();
        host.notify(refused);
      }
    },
    measured
      ? [
          {
            label: 'Remove this dimension',
            act: () => {
              host.edit('Remove dimension', (d) => removeMeasure(d, key.slice(5)));
            },
          },
        ]
      : [
          {
            label: 'Delete this dimension',
            act: () => {
              host.edit('Delete dimension', (d) => {
                d.dimOverrides = { ...d.dimOverrides, [key]: { ...d.dimOverrides?.[key], hidden: true } };
              });
              host.notify('Dimension deleted: off the drawing and the sheet. Undo, or the run\'s panel (Dimension: show), brings it back.');
            },
          },
        ],
  );
}

/** A weld number, typed over right on the drawing. */
function openWeldEditor(key: string, clientX: number, clientY: number): void {
  const weld = state.analysis.joints.find((j) => j.key === key);
  if (!weld) return;
  openInlineEditor(
    weld.number,
    'text',
    clientX,
    clientY,
    (text) => {
      const number = text.trim();
      if (number === weld.number) return;
      host.edit('Renumber weld', (d) => {
        // A number typed on a joint marked as not welded makes it a weld again.
        if (number) d.weldOverrides[key] = { ...d.weldOverrides[key], number, skip: undefined };
        else if (d.weldOverrides[key]) delete d.weldOverrides[key].number;
      });
    },
    weld.skipped
      ? [
          {
            label: 'Weld here after all',
            act: () => {
              host.edit('Weld here', (d) => {
                if (d.weldOverrides[key]) delete d.weldOverrides[key].skip;
              });
            },
          },
        ]
      : [
          {
            label: 'No weld here',
            act: () => {
              host.edit('No weld', (d) => {
                d.weldOverrides[key] = { ...d.weldOverrides[key], number: undefined, skip: true };
              });
              host.notify('Marked as not welded: no number, not on the list. Tap it again to weld it after all.');
            },
          },
        ],
  );
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
  extras: { label: string; act: () => void }[] = [],
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
  dimensionEditor = input;

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const text = input.value;
    closeDimensionEditor();
    onCommit(text);
  };

  // A keypad beside the box: on a tablet the pencil never brings the keyboard
  // up on its own, and a number is quicker to tap in anyway. Its keys keep
  // the box focused, so the keyboard, if there is one, stays too.
  // The first key typed replaces the old value, as typing over a selection would.
  let fresh = true;
  const keypad = document.createElement('div');
  keypad.className = `dim-keypad ${mode}`;
  const keys = mode === 'numeric' ? ['7', '8', '9', '4', '5', '6', '1', '2', '3', '⌫', '0', 'OK'] : ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'W', 'F', 'S', 'T', 'A', 'B', '-', '/', '⌫', 'OK'];
  keypad.innerHTML =
    keys.map((k) => `<button type="button" data-key="${k}"${k === 'OK' ? ' class="ok"' : ''}>${k}</button>`).join('') +
    // What else can be done to the thing being typed over, across the bottom.
    extras.map((x, i) => `<button type="button" class="wide" data-extra="${i}">${x.label}</button>`).join('');
  // The box sits at the top of the keypad, so what is typed is always in
  // sight: set apart, a keypad taller than reckoned (a Delete row under it)
  // covered the box, and the figure typed could not be seen (2026-09-26).
  keypad.prepend(input);
  keypad.addEventListener('pointerdown', (event) => {
    if (event.target === input) return;
    event.preventDefault();
    const extra = (event.target as HTMLElement).closest<HTMLElement>('[data-extra]')?.dataset.extra;
    if (extra !== undefined) {
      done = true;
      closeDimensionEditor();
      extras[Number(extra)]?.act();
      return;
    }
    const key = (event.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key;
    if (!key) return;
    if (key === 'OK') {
      commit();
      return;
    }
    if (key === '⌫') input.value = input.value.slice(0, -1);
    else if (fresh) input.value = key;
    else input.value += key;
    fresh = false;
    input.focus();
  });
  input.addEventListener('input', () => {
    fresh = false;
  });
  wrap.appendChild(keypad);
  keypadEl = keypad;
  // Above the touch, not under it: the pencil hand covers what is below the
  // tip, and a pad that opened under the tip would take the lift itself.
  // Placed by its own height, measured now it is in.
  const padW = keypad.offsetWidth;
  const padH = keypad.offsetHeight;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const left = Math.max(8, Math.min(rect.width - padW - 8, x - padW / 2));
  const top = y - 24 - padH >= 8 ? y - 24 - padH : Math.max(8, Math.min(rect.height - padH - 8, y + 24));
  keypad.style.left = `${left}px`;
  keypad.style.top = `${top}px`;
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

let keypadEl: HTMLElement | null = null;

function closeDimensionEditor(): void {
  // Taking the box out blurs it, and the blur commits and closes again: the
  // references go first so that second close finds nothing left to do.
  const input = dimensionEditor;
  const keypad = keypadEl;
  dimensionEditor = null;
  keypadEl = null;
  keypad?.remove();
  try {
    input?.remove();
  } catch {
    // Already on its way out.
  }
}

/**
 * Ends a dimension by hand on what was tapped: a point; a pipe, at its end
 * nearest the point it starts from; a weld mark or tag, at its point. The
 * point under an elbow's or tee's welds and tags was hard to hit, and a tap
 * on the pipe or a weld let the dimension go ("I can't put a dimension from
 * the centre of the elbow to the pipe", 2026-09-26).
 */
let measureDoneAt = 0;
function finishMeasure(selection: Selection): void {
  const from = state.measureFrom;
  state.measureFrom = null;
  if (!from) return;
  measureDoneAt = Date.now();
  const d = state.drawing;
  const start = d.nodes.find((n) => n.id === from);
  const nearestEnd = (runId: string): string | null => {
    const run = d.runs.find((r) => r.id === runId);
    if (!run || !start) return null;
    const ends = [run.from, run.to].filter((id) => id !== from);
    const dist = (id: string) => {
      const n = d.nodes.find((x) => x.id === id);
      return n ? length3(sub(n.pos, start.pos)) : Infinity;
    };
    return ends.sort((a, b) => dist(a) - dist(b))[0] ?? null;
  };
  let to: string | null = null;
  if (selection?.kind === 'node') to = selection.id;
  else if (selection?.kind === 'run') to = nearestEnd(selection.id);
  else if (selection?.kind === 'weld') {
    const key = selection.key;
    if (key.startsWith('n:')) to = key.split(':')[1] ?? null;
    else if (key.startsWith('d:')) to = nearestEnd(key.slice(2));
  }
  if (to && to !== from && d.nodes.some((n) => n.id === to)) {
    const target = to;
    host.edit('Add dimension', (dr) => addMeasure(dr, from, target));
    host.notify('Dimension added. Tap its figure to take it off.');
    return;
  }
  host.notify('Dimension not added.');
  render();
}

/* ----------------------------------------------------------------- canvas */

const canvas = new Canvas(svg, {
  onSelect(selection: Selection) {
    // A dimension by hand under way: the point tapped ends it.
    if (state.measureFrom) {
      finishMeasure(selection);
      return;
    }
    // Joining one open end to another: the end tapped next is the other.
    if (state.joinFrom) {
      const from = state.joinFrom;
      state.joinFrom = null;
      if (selection?.kind === 'node') {
        const to = selection.id === from ? endInSamePlace(from) : selection.id;
        if (to && to !== from) {
          const run = state.drawing.runs.find((r) => r.from === from || r.to === from);
          joinPoints(from, to, run?.dn ?? state.currentDn, run?.schedule ?? state.currentSchedule, false);
          return;
        }
      }
      host.notify('Not joined.');
    }
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
  onConnect(fromId, toId) {
    joinPoints(fromId, toId, state.currentDn, state.currentSchedule);
  },
  onStart() {
    let started: string | null = null;
    host.edit('Start route', (d) => {
      // A point already down with no pipe (the picked one, else the last)
      // is where it starts; else the first point at the origin.
      const picked = state.selection?.kind === 'node' ? state.selection.id : null;
      const lone = d.nodes.filter((n) => !d.runs.some((r) => r.from === n.id || r.to === n.id));
      const id = (lone.find((n) => n.id === picked) ?? lone[lone.length - 1])?.id ?? ensureNode(d, { e: 0, n: 0, u: 0 } as Vec3);
      started = id;
      state.selection = { kind: 'node', id };
      state.commandState.currentNode = id;
    });
    if (started) canvas.setAnchor(started);
    syncSizeFromSelection();
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
    // A reducer in a run of its own moves as one piece with its two face
    // points, the pipe either side giving and taking.
    if (slideBlockFrom?.id === componentId || blockOf(componentId)) {
      slideBlock(componentId, paper, commit);
      return;
    }
    const run = state.drawing.runs.find((r) => r.inline.some((c) => c.id === componentId));
    const comp = run?.inline.find((c) => c.id === componentId);
    if (!run || !comp) return;

    // The drag is shown live by moving the real thing, so the position before
    // it started is kept and put back before the edit is recorded. Otherwise
    // undo would restore the drawing to half way through the drag.
    if (!slideFrom || slideFrom.id !== componentId) {
      // Not to scale, where the pen is read along the run is fixed for the
      // whole drag and laid out without the item itself: read through the
      // layout it changes as it moves, a valve flicked between two places
      // (his complaint, 2026-09-24: "something blocks it, it only jumps
      // between two points").
      const now = state.analysis.stations.get(run.id);
      const stations = now
        ? drawnStations(state.drawing, { ...run, inline: run.inline.filter((c) => c.id !== componentId) }, runLength(state.drawing, run), now.length)
        : undefined;
      // The run's ends as drawn when the drag began, too: not to scale the
      // run grows and shrinks as a piece of pipe opens or closes beside it.
      const pa = paperOf(state.analysis, state.drawing, run.from);
      const pb = paperOf(state.analysis, state.drawing, run.to);
      slideFrom = { id: componentId, offset: comp.offset, stations, ends: pa && pb ? [pa, pb] : undefined };
    }
    const read = offsetFromPaper(run, paper, slideFrom.stations, slideFrom.ends, false);
    if (read === null) return;
    // Where the pen took hold stays under it: the item moves by as much as
    // the pen does, from where it stood, and never jumps on being touched.
    if (slideFrom.grab === undefined) slideFrom.grab = read;
    const snap = dragSnap();
    const raw = Math.max(0, Math.min(runLength(state.drawing, run), Math.round((slideFrom.offset + read - slideFrom.grab) / snap) * snap));
    // It moves along its own run and stops at what stands either side of
    // it — the run's ends, another item — so the run keeps its length and
    // nothing is passed through (his complaint, 2026-09-24).
    const offset = slideLimits(run, comp, slideFrom.offset, raw);

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

  onEditDimension(key, clientX, clientY) {
    openDimensionEditor(key, clientX, clientY);
  },
  /**
   * What a support is — "L50" — typed over right on the drawing. The number
   * stays; it is the detail after it that is typed.
   */
  onEditSupport(componentId, clientX, clientY) {
    const comp = state.drawing.runs.flatMap((r) => r.inline).find((c) => c.id === componentId);
    if (!comp) return;
    const current = comp.note ?? (comp.kind === 'SUPPORT_L' ? 'L50' : '');
    openInlineEditor(current, 'text', clientX, clientY, (text) => {
      const detail = text.trim();
      if (detail === current) return;
      host.edit('Describe support', (d) => {
        const target = d.runs.flatMap((r) => r.inline).find((c) => c.id === componentId);
        if (target) target.note = detail || (target.kind === 'SUPPORT_L' ? '' : undefined);
      });
    });
  },
  onEditRunNote(runId, clientX, clientY) {
    const run = state.drawing.runs.find((r) => r.id === runId);
    if (!run) return;
    const current = run.note ?? '';
    openInlineEditor(
      current,
      'text',
      clientX,
      clientY,
      (text) => {
        const note = text.trim().toUpperCase();
        if (note === current) return;
        host.edit('Edit note', (d) => {
          const target = d.runs.find((r) => r.id === runId);
          if (target) target.note = note || undefined;
        });
      },
      [
        {
          label: 'Remove this text',
          act: () => {
            host.edit('Remove note', (d) => {
              const target = d.runs.find((r) => r.id === runId);
              if (target) target.note = undefined;
              if (d.itemOverrides) delete d.itemOverrides[`rn:${runId}`];
            });
            host.notify('Text removed. The run\'s panel can write it again.');
          },
        },
      ],
    );
  },
  onStopDrawing() {
    stopDrawing();
  },
  onEditWeld(key, clientX, clientY) {
    // A weld at the point a dimension by hand goes to: that point, no keypad.
    if (state.measureFrom) {
      finishMeasure({ kind: 'weld', key });
      return;
    }
    if (Date.now() - measureDoneAt < 800) return;
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
      replaceDrawing(JSON.parse(before.snapshot) as Drawing);
      host.edit('Stretch run', (d) => {
        const target = d.runs.find((r) => r.id === runId);
        if (!target) return;
        if (schematic) target.visual = Math.max(length, runDrawnFloor(d, target));
        else stretchRun(d, runId, length, end);
      });
      return;
    }
    if (schematic) run.visual = Math.max(length, runDrawnFloor(state.drawing, run));
    else stretchRun(state.drawing, runId, length, end);
    recompute();
    renderCanvasOnly();
    hoverMessage = schematic ? 'drawn length — type the dimension for the real one' : `${Math.round(length)} mm`;
    renderHud();
  },

  /**
   * Moves a dimension: out from the pipe or across to its other side, and
   * along the line, from where its figure was dragged. The box that opened
   * on the touch goes as soon as the drag is under way.
   */
  onSlideDim(key, delta, frame, commit) {
    closeDimensionEditor();
    const offset = frame.off + delta.dx * frame.nx + delta.dy * frame.ny;
    const along = Math.max(0.08, Math.min(0.92, frame.along + (delta.dx * frame.ux + delta.dy * frame.uy) / Math.max(frame.len, 1)));
    const apply = (d: Drawing) => {
      d.dimOverrides = { ...d.dimOverrides, [key]: { ...d.dimOverrides?.[key], offset, along } };
    };
    if (commit) {
      if (tagFrom) {
        replaceDrawing(JSON.parse(tagFrom) as Drawing);
        tagFrom = null;
      }
      host.edit('Move dimension', apply);
      return;
    }
    if (!tagFrom) tagFrom = snapshot();
    apply(state.drawing);
    recompute();
    renderCanvasOnly();
  },

  /** Moves a weld number tag or an item balloon; the leader stays on what it points at. */
  onSlideTag(key, offset, commit) {
    const balloon = key.startsWith('item:') ? key.slice(5) : null;
    // A support's name opened for typing on the touch; a drag means it was
    // being moved, not typed, so the box goes away.
    if (balloon?.startsWith('sup:') || balloon?.startsWith('rn:')) closeDimensionEditor();
    const apply = (d: Drawing) => {
      if (balloon) {
        d.itemOverrides = { ...d.itemOverrides, [balloon]: { dx: offset.dx, dy: offset.dy } };
        // An item balloon dragged stays on the place it was dragged from,
        // rather than moving to wherever has most room later.
        const inst = state.analysis.items.find((i) => i.key === balloon);
        if (inst) d.balloons = { ...d.balloons, [inst.line]: { ...d.balloons?.[inst.line], at: balloon, hidden: undefined } };
        return;
      }
      d.weldOverrides[key] = { ...d.weldOverrides[key], tag: { dx: offset.dx, dy: offset.dy } };
    };
    if (commit) {
      if (tagFrom) {
        replaceDrawing(JSON.parse(tagFrom) as Drawing);
        tagFrom = null;
      }
      host.edit(balloon ? 'Move balloon' : 'Move weld tag', apply);
      return;
    }
    if (!tagFrom) tagFrom = snapshot();
    apply(state.drawing);
    recompute();
    renderCanvasOnly();
  },

  /**
   * Slides a point that a line runs straight through — an olet, a tee, a
   * flanged joint, a weld — along that line. The line keeps its length:
   * what one side gains the other gives (his complaint, 2026-09-24: moving
   * an olet stretched the header). Every step is worked out from where the
   * drag began, so the steps cannot add up.
   */
  onSlideNode(nodeId, paper, commit) {
    // A face point of a reducer standing in a run of its own: the reducer
    // moves, both its faces with it.
    const face = slideBlockFrom?.face === nodeId ? slideBlockFrom.id : blockAt(nodeId);
    if (face) {
      slideBlock(face, paper, commit, nodeId);
      return;
    }
    if (!state.drawing.nodes.some((n) => n.id === nodeId)) return;
    if (!slideNodeFrom || slideNodeFrom.id !== nodeId) {
      slideNodeFrom = { id: nodeId, snapshot: snapshot() };
    }
    // Back to where the drag began, then on to where the pointer is now.
    replaceDrawing(JSON.parse(slideNodeFrom.snapshot) as Drawing);
    recompute();
    // Not to scale, sliding a point moves it on the drawing only: the drawn
    // lengths either side change, the typed ones stay.
    const apply = state.drawing.options.schematic ? slideDrawnTo(nodeId, paper) : slideNodeTo(nodeId, paper);

    if (commit) {
      slideNodeFrom = null;
      if (apply) host.edit('Move point', apply);
      else render();
      return;
    }
    if (apply) {
      apply(state.drawing);
      recompute();
    }
    renderCanvasOnly();
    hoverMessage = 'sliding along the line — its length stays';
    renderHud();
  },
});

/**
 * Joins two points with pipe (closing a gap, or joining two open ends of
 * one line); the new pipe is the given size.
 */
function joinPoints(fromId: string, toId: string, dn: string, schedule: string, arm = true): void {
  let path: string[] = [];
  let refused: string | null = null;
  host.edit('Join points', (d) => {
    const result = connectNodes(d, fromId, toId, dn, schedule);
    refused = result.refused ?? null;
    path = result.path;
  });
  if (refused) {
    undoStack.pop();
    state.preview = null;
    host.notify(refused);
    render();
    return;
  }
  // The point tapped may be gone: joined straight on, the pipe runs
  // through and there is nothing left to draw on from.
  const still = state.drawing.nodes.some((n) => n.id === toId);
  state.selection = still ? { kind: 'node', id: toId } : null;
  state.commandState.currentNode = still ? toId : null;
  // Drawing, the pencil carries on from the end joined to; joined by hand,
  // there is nothing more to draw.
  canvas.setAnchor(still && arm ? toId : null);
  state.preview = null;
  const elbows = path.filter((id) => state.analysis.nodeInfo.get(id)?.fitting === 'ELBOW_90').length;
  host.notify(elbows === 0 ? 'Joined: the pipe runs straight through.' : elbows === 1 ? 'Joined, with an elbow at the turn.' : `Joined, with ${elbows} elbows.`);
  render();
}

/** Another open end lying where this one does, if there is one. */
function endInSamePlace(nodeId: string): string | null {
  const node = state.drawing.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const other = state.drawing.nodes.find(
    (n) =>
      n.id !== nodeId &&
      length3(sub(n.pos, node.pos)) < 1 &&
      state.drawing.runs.filter((r) => r.from === n.id || r.to === n.id).length === 1,
  );
  return other?.id ?? null;
}

/** What a slide started from, so undo returns there and not to mid-drag. */
let slideFrom: { id: string; offset: number; stations?: DrawnStations; ends?: [{ x: number; y: number }, { x: number; y: number }]; grab?: number } | null = null;
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
    ? drawnLength(state.drawing, run, length3(sub(moving.pos, fixed.pos)))
    : length3(sub(moving.pos, fixed.pos));
  const perMm = shown > 0 ? drawn / shown : 0;
  if (perMm <= 0) return null;
  const snap = dragSnap();
  return Math.max(snap, Math.round(along / perMm / snap) * snap);
}

/**
 * An item's offset along its run kept between what stands either side of
 * where it began: the run's ends and the items before and after it (marks
 * such as supports are notes and are passed freely).
 */
function slideLimits(run: Run, comp: Run['inline'][number], from: number, offset: number): number {
  const total = runLength(state.drawing, run);
  const half = itemHalf(state.drawing, run, comp);
  let lo = half;
  let hi = total - half;
  if (!isMark(comp.kind)) {
    for (const other of run.inline) {
      if (other.id === comp.id || isMark(other.kind)) continue;
      const reach = itemHalf(state.drawing, run, other) + half;
      if (other.offset <= from) lo = Math.max(lo, other.offset + reach);
      else hi = Math.min(hi, other.offset - reach);
    }
  }
  // Where it stands now is always allowed (a valve on an open end without
  // its last flange sits nearer the end than its flanged half).
  lo = Math.min(lo, from);
  hi = Math.max(hi, from);
  return Math.max(lo, Math.min(hi, offset));
}

/** Where along a run a paper point falls, snapped, or null if it cannot be read. */
function offsetFromPaper(run: Run, paper: { x: number; y: number }, stations = state.analysis.stations.get(run.id), ends?: [{ x: number; y: number }, { x: number; y: number }], snapped = true): number | null {
  const a = state.analysis.nodeById.get(run.from);
  const b = state.analysis.nodeById.get(run.to);
  if (!a || !b) return null;
  // Where the run is drawn: not to scale that is not where it is.
  const pa = ends?.[0] ?? paperOf(state.analysis, state.drawing, run.from);
  const pb = ends?.[1] ?? paperOf(state.analysis, state.drawing, run.to);
  if (!pa || !pb) return null;
  const vx = pb.x - pa.x;
  const vy = pb.y - pa.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1) return null;
  const t = Math.max(0, Math.min(1, ((paper.x - pa.x) * vx + (paper.y - pa.y) * vy) / lenSq));
  const total = length3(sub(b.pos, a.pos));
  const snap = dragSnap();
  const mm = trueAtShare(stations, t, total);
  if (!snapped) return mm;
  return Math.max(0, Math.min(total, Math.round(mm / snap) * snap));
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
 * A reducer standing in a run of its own (its faces are points), with a
 * straight run on each side: what is dragged as one piece, like a tee
 * slides along its line (his ask, 2026-09-25: "does a reducer behave like
 * a tee — put in a line, dragged, the pipe split in two").
 */
function blockOf(compId: string): { run: Run; comp: InlineComponent; before: Run; after: Run } | null {
  const run = state.drawing.runs.find((r) => r.inline.some((c) => c.id === compId));
  const comp = run?.inline.find((c) => c.id === compId);
  if (!run || !comp || !isReducer(comp.kind)) return null;
  if (run.inline.some((c) => c.id !== compId && !isMark(c.kind))) return null;
  // Its faces on its run's two points, or against a flange welded straight
  // to it there: the whole run is the reducer (and those flanges).
  if (itemAtEnd(state.drawing, run, true)?.comp.id !== compId || itemAtEnd(state.drawing, run, false)?.comp.id !== compId) return null;
  const other = (nodeId: string) => lineThrough(nodeId)?.find((r) => r.id !== run.id);
  const before = other(run.from);
  const after = other(run.to);
  if (!before || !after) return null;
  return { run, comp, before, after };
}

/** The reducer whose face this point is, when it can be slid as one piece. */
function blockAt(nodeId: string): string | null {
  for (const run of state.drawing.runs) {
    if (run.from !== nodeId && run.to !== nodeId) continue;
    const comp = run.inline.find((c) => isReducer(c.kind));
    if (comp && blockOf(comp.id)) return comp.id;
  }
  return null;
}

let slideBlockFrom: { id: string; face?: string; snapshot: string; grab?: number } | null = null;

/**
 * Slides a reducer and its two face points along their line together. To
 * scale the points move and the runs either side change length, what
 * stands on them keeping its place, no nearer the far ends than their
 * take-outs and items; not to scale the two sides share their drawn total.
 * Taken hold of where the pen went down, like any item.
 */
function slideBlock(compId: string, paper: { x: number; y: number }, commit: boolean, face?: string): void {
  if (!slideBlockFrom || slideBlockFrom.id !== compId) slideBlockFrom = { id: compId, face, snapshot: snapshot() };
  const from = slideBlockFrom;
  replaceDrawing(JSON.parse(from.snapshot) as Drawing);
  recompute();
  const block = blockOf(compId);
  const apply = block ? (state.drawing.options.schematic ? slideBlockDrawn(block, paper, from) : slideBlockTrue(block, paper, from)) : null;
  if (commit) {
    slideBlockFrom = null;
    if (apply) host.edit('Move reducer', apply);
    else render();
    return;
  }
  if (apply) {
    apply(state.drawing);
    recompute();
  }
  renderCanvasOnly();
  hoverMessage = 'sliding the reducer along its line — the line keeps its length';
  renderHud();
}

type Block = { run: Run; comp: InlineComponent; before: Run; after: Run };

function slideBlockTrue(b: Block, paper: { x: number; y: number }, from: { grab?: number }): ((d: Drawing) => void) | null {
  const near = state.analysis.nodeById.get(b.run.from);
  const farNear = state.analysis.nodeById.get(b.run.to);
  const backId = b.before.from === b.run.from ? b.before.to : b.before.from;
  const forwardId = b.after.from === b.run.to ? b.after.to : b.after.from;
  const back = state.analysis.nodeById.get(backId);
  const forward = state.analysis.nodeById.get(forwardId);
  if (!near || !farNear || !back || !forward) return null;
  const span = sub(forward.pos, back.pos);
  const spanLen = length3(span);
  if (spanLen < 1) return null;
  const size = length3(sub(farNear.pos, near.pos));
  const now = length3(sub(near.pos, back.pos));
  const snap = dragSnap();
  const lo = Math.max(snap, roomOn(b.before, backId));
  const hi = spanLen - size - Math.max(snap, roomOn(b.after, forwardId));
  if (lo > hi) return null;
  const pa = paperOf(state.analysis, state.drawing, backId);
  const pb = paperOf(state.analysis, state.drawing, forwardId);
  if (!pa || !pb) return null;
  const vx = pb.x - pa.x;
  const vy = pb.y - pa.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1) return null;
  const read = (((paper.x - pa.x) * vx + (paper.y - pa.y) * vy) / lenSq) * spanLen;
  if (from.grab === undefined) from.grab = read - now;
  const at = Math.max(lo, Math.min(hi, Math.round((read - from.grab) / snap) * snap));
  const shift = at - now;
  const nearPos = add(back.pos, scale3(span, at / spanLen));
  const farPos = add(back.pos, scale3(span, (at + size) / spanLen));
  return (d) => {
    const n1 = d.nodes.find((n) => n.id === b.run.from);
    const n2 = d.nodes.find((n) => n.id === b.run.to);
    if (!n1 || !n2) return;
    n1.pos = { ...nearPos };
    n2.pos = { ...farPos };
    // Offsets are from a run's start: on a run starting at a moved face
    // they change by the move, so what stands on it stays where it is.
    const before = d.runs.find((r) => r.id === b.before.id);
    const after = d.runs.find((r) => r.id === b.after.id);
    if (before && before.from === b.run.from) for (const c of before.inline) c.offset += shift;
    if (after && after.from === b.run.to) for (const c of after.inline) c.offset -= shift;
  };
}

function slideBlockDrawn(b: Block, paper: { x: number; y: number }, from: { grab?: number }): ((d: Drawing) => void) | null {
  const backId = b.before.from === b.run.from ? b.before.to : b.before.from;
  const forwardId = b.after.from === b.run.to ? b.after.to : b.after.from;
  const pa = paperOf(state.analysis, state.drawing, backId);
  const pb = paperOf(state.analysis, state.drawing, forwardId);
  if (!pa || !pb) return null;
  const vx = pb.x - pa.x;
  const vy = pb.y - pa.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1) return null;
  const drawnOf = (run: Run) => drawnLength(state.drawing, run, runLength(state.drawing, run));
  const d0 = drawnOf(b.before);
  const d1 = drawnOf(b.after);
  const whole = d0 + drawnOf(b.run) + d1;
  const floor0 = runDrawnFloor(state.drawing, b.before);
  const floor1 = runDrawnFloor(state.drawing, b.after);
  if (d0 + d1 < floor0 + floor1) return null;
  const read = (((paper.x - pa.x) * vx + (paper.y - pa.y) * vy) / lenSq) * whole;
  if (from.grab === undefined) from.grab = read - d0;
  const snap = dragSnap();
  const tenth = (v: number) => Math.round(v * 10) / 10;
  const first = tenth(Math.max(floor0, Math.min(d0 + d1 - floor1, Math.round((read - from.grab) / snap) * snap)));
  return (d) => {
    const before = d.runs.find((r) => r.id === b.before.id);
    const after = d.runs.find((r) => r.id === b.after.id);
    if (before) before.visual = first;
    if (after) after.visual = tenth(d0 + d1 - first);
  };
}

/** How near a point may come to the far end of a run: its take-outs and what stands on it. */
function roomOn(run: Run, farNode: string): number {
  const len = runLength(state.drawing, run);
  const cut = state.analysis.runLengths.get(run.id)?.cut ?? len;
  let need = len - cut;
  for (const comp of run.inline) {
    const fromFar = run.from === farNode ? comp.offset : len - comp.offset;
    need = Math.max(need, fromFar + itemHalf(state.drawing, run, comp));
  }
  return need;
}

/**
 * Not to scale: the drawn lengths either side of a point, with the point
 * dragged along the drawn line between its neighbours. Their sum stays,
 * and neither side is drawn under the floor (one that was would be drawn
 * at its own length, and the line would grow).
 */
function slideDrawnTo(nodeId: string, paper: { x: number; y: number }): ((d: Drawing) => void) | null {
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
  const drawnOf = (run: Run) => drawnLength(state.drawing, run, runLength(state.drawing, run));
  const total = drawnOf(through[0]) + drawnOf(through[1]);
  // Each side at least what its own items need drawn (`runDrawnFloor`).
  const floor0 = runDrawnFloor(state.drawing, through[0]);
  const floor1 = runDrawnFloor(state.drawing, through[1]);
  if (total < floor0 + floor1) return null;
  const t = ((paper.x - pa.x) * vx + (paper.y - pa.y) * vy) / lenSq;
  const snap = dragSnap();
  // Kept to a tenth of a millimetre, so the two always add up to the total.
  const tenth = (v: number) => Math.round(v * 10) / 10;
  const first = tenth(Math.max(floor0, Math.min(total - floor1, Math.round((t * total) / snap) * snap)));
  const lengths: [string, number][] = [
    [through[0].id, first],
    [through[1].id, tenth(total - first)],
  ];
  return (d) => {
    for (const [runId, visual] of lengths) {
      const target = d.runs.find((r) => r.id === runId);
      if (target) target.visual = visual;
    }
  };
}

/**
 * To scale: the point moved along the line between its neighbours, the
 * ends staying where they are. What stands along either side — a valve,
 * a support — keeps its place in space, and the point cannot pass it or
 * leave less pipe than the fittings take.
 */
function slideNodeTo(nodeId: string, paper: { x: number; y: number }): ((d: Drawing) => void) | null {
  const through = lineThrough(nodeId);
  if (!through) return null;
  const node = state.analysis.nodeById.get(nodeId);
  const farId = (run: Run) => (run.from === nodeId ? run.to : run.from);
  const back = state.analysis.nodeById.get(farId(through[0]));
  const forward = state.analysis.nodeById.get(farId(through[1]));
  if (!node || !back || !forward) return null;

  const span = sub(forward.pos, back.pos);
  const spanLen = length3(span);
  if (spanLen < 1) return null;
  const now = length3(sub(node.pos, back.pos));
  // How near the point may come to each end: the side's own take-outs
  // (its cut cannot go under nothing) and the items standing on it.
  const room = (run: Run, farNode: string): number => {
    const len = runLength(state.drawing, run);
    const cut = state.analysis.runLengths.get(run.id)?.cut ?? len;
    let need = len - cut;
    for (const comp of run.inline) {
      const fromFar = run.from === farNode ? comp.offset : len - comp.offset;
      need = Math.max(need, fromFar + itemHalf(state.drawing, run, comp));
    }
    return need;
  };
  const snap = dragSnap();
  const lo = Math.max(snap, room(through[0], back.id));
  const hi = Math.min(spanLen - snap, spanLen - room(through[1], forward.id));
  if (lo > hi) return null;

  const pa = paperOf(state.analysis, state.drawing, back.id);
  const pb = paperOf(state.analysis, state.drawing, forward.id);
  if (!pa || !pb) return null;
  const vx = pb.x - pa.x;
  const vy = pb.y - pa.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1) return null;
  const raw = (((paper.x - pa.x) * vx + (paper.y - pa.y) * vy) / lenSq) * spanLen;
  const at = Math.max(lo, Math.min(hi, Math.round(raw / snap) * snap));
  const shift = at - now;
  const pos = add(back.pos, scale3(span, at / spanLen));
  const [backRun, forwardRun] = through;
  return (d) => {
    const target = d.nodes.find((n) => n.id === nodeId);
    if (!target) return;
    target.pos = { ...pos };
    // Offsets are from a run's start: on a run that starts at this point
    // they change by the move, so its items stay where they are.
    for (const run of d.runs) {
      if (run.id !== backRun.id && run.id !== forwardRun.id) continue;
      if (run.from !== nodeId) continue;
      const sign = run.id === forwardRun.id ? -1 : 1;
      for (const comp of run.inline) comp.offset += sign * shift;
    }
  };
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
  emptyHintEl.classList.toggle('hidden', state.drawing.runs.length > 0 || canvas.drawingFrom !== null);
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
  const northSelect = document.getElementById('opt-north-arrow') as HTMLSelectElement | null;
  if (northSelect) northSelect.value = String(state.drawing.options.northArrow ?? 0);
  syncSymbolSelect();
  emptyHintEl.classList.toggle('hidden', state.drawing.runs.length > 0 || canvas.drawingFrom !== null);
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
  // Installed, the app fetches a new version in the background; this says so,
  // so nobody keeps working on an old one without knowing.
  if (updateReady) parts.push('<button class="hud-stop hud-update" id="hud-update" type="button">New version ready — tap to reload</button>');
  const sel = state.selection;
  // Drawing on from a picked point is a button here as well as in the panel,
  // which may be folded away on a tablet.
  if (sel?.kind === 'node' && canvas.drawingFrom !== sel.id) {
    parts.push('<button class="hud-stop" id="hud-draw-from" type="button">Draw from here</button>');
  }
  if (state.joinFrom) parts.push('<span>join — tap the other open end</span>');
  else if (sel?.kind === 'node' && state.analysis.nodeInfo.get(sel.id)?.degree === 1) parts.push('<button class="hud-stop" id="hud-join" type="button">Join to another end</button>');
  if (state.measureFrom) parts.push('<span>dimension — tap the other point</span>');
  else if (sel?.kind === 'node') parts.push('<button class="hud-stop" id="hud-measure" type="button">Dimension from here</button>');
  if (sel?.kind === 'equipment') parts.push('<button class="hud-stop" id="hud-equip-draw" type="button">Draw on from the far side</button>');
  if (sel?.kind === 'run') {
    // Fitting welded straight to fitting, no pipe between: the run stays as
    // their centre-to-centre, but there is nothing to cut and one weld.
    const run = state.drawing.runs.find((r) => r.id === sel.id);
    // A header through olets is one pipe: its fittings never touch.
    const header = runGroupIds(state.analysis, sel.id).length > 1;
    if (run && !header) parts.push(`<button class="hud-stop" id="hud-direct" type="button">${run.direct ? 'Pipe here after all' : 'No pipe — fittings touch'}</button>`);
    if (run) parts.push(`<button class="hud-stop" id="hud-dashed" type="button">${run.dashed ? 'Solid line' : 'Dashed — next sheet'}</button>`);
  }
  if (sel && sel.kind !== 'weld') {
    const flanged = sel.kind === 'node' && !!state.drawing.nodes.find((n) => n.id === sel.id)?.flange;
    const olet = sel.kind === 'node' && oletAlone(sel.id);
    const plain = sel.kind === 'node' && isPlainPoint(state.drawing, sel.id);
    const what = sel.kind === 'run' ? 'pipe' : sel.kind === 'node' ? (flanged ? 'flanges' : 'point') : sel.kind === 'equipment' ? 'equipment' : 'item';
    parts.push(`<button class="hud-stop hud-delete" id="hud-delete" type="button">${flanged ? 'Remove flanges' : olet ? 'Remove olet' : plain ? 'Remove point' : `Delete ${what}`}</button>`);
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
  hudEl.querySelector('#hud-direct')?.addEventListener('click', () => {
    if (state.selection?.kind !== 'run') return;
    const id = state.selection.id;
    const on = !state.drawing.runs.find((r) => r.id === id)?.direct;
    let onFace: string | null = null;
    host.edit(on ? 'Fittings touch' : 'Pipe between fittings', (d) => {
      onFace = setRunDirect(d, state.analysis, id, on);
    });
    if (onFace) {
      host.select({ kind: 'node', id: onFace });
      host.notify('The end piece sits straight on the fitting: the pipe between them is gone.');
    } else if (on && state.drawing.runs.find((r) => r.id === id)?.inline.some((c) => isReducer(c.kind))) {
      host.notify('The ends close up on the reducer: welded straight to it, no pipe between.');
    } else host.notify(on ? 'The fittings are joined directly: one weld, no pipe to cut.' : 'A pipe between the fittings again.');
  });
  hudEl.querySelector('#hud-dashed')?.addEventListener('click', () => {
    if (state.selection?.kind !== 'run') return;
    const id = state.selection.id;
    const on = !state.drawing.runs.find((r) => r.id === id)?.dashed;
    const group = runGroupIds(state.analysis, id);
    host.edit(on ? 'Dashed run' : 'Solid run', (d) => {
      for (const runId of group) setRunDashed(d, runId, on);
      if (on) for (const run of d.runs.filter((r) => group.includes(r.id) && r.id !== id && r.note === DASHED_NOTE)) run.note = undefined;
    });
    host.notify(on ? 'Drawn dashed, carried on to the next sheet: not on this sheet\'s list. Tap the note beside it to type it over, or drag it.' : 'A solid line again.');
  });
  hudEl.querySelector('#hud-update')?.addEventListener('click', () => location.reload());
  hudEl.querySelector('#hud-join')?.addEventListener('click', () => {
    if (state.selection?.kind === 'node') host.joinFrom(state.selection.id);
  });
  hudEl.querySelector('#hud-measure')?.addEventListener('click', () => {
    if (state.selection?.kind === 'node') host.measureFrom(state.selection.id);
  });
  hudEl.querySelector('#hud-equip-draw')?.addEventListener('click', () => {
    if (state.selection?.kind === 'equipment') host.startFromEquipment(state.selection.id);
  });
  hudEl.querySelector('#hud-draw-from')?.addEventListener('click', () => {
    if (state.selection?.kind === 'node') host.continueFrom(state.selection.id);
  });
}

/* ------------------------------------------------------------- updates */

let updateReady = false;

/**
 * Watches the service worker the built page registers. A new version takes
 * over as soon as it has downloaded; the page it took over from is told, and
 * offers a reload. The very first install is not an update, and says nothing.
 * The worker is also asked to check for a new version every hour, since an
 * app left open on a tablet for days would otherwise never look.
 */
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    updateReady = true;
    renderHud();
  });
  navigator.serviceWorker.ready
    .then((registration) => {
      const look = () => void registration.update().catch(() => {});
      // Now, every hour, and whenever the app is brought back to the front:
      // a tablet keeps the app alive in the background, so coming back to it
      // is not a fresh start, and this is when a new version would be missed.
      look();
      setInterval(look, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') look();
      });
    })
    .catch(() => {});
}

/** The build this page is, stamped in by the app build; 'dev' when run from source. */
const APP_VERSION = document.querySelector('meta[name="app-version"]')?.getAttribute('content') ?? 'dev';

/** Asks the worker for a new version now, and says what came of it. */
async function checkForUpdate(): Promise<void> {
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
  if (!registration) {
    host.notify(`Version ${APP_VERSION}. Not installed as an app here — reload the page to get the latest.`);
    return;
  }
  host.notify('Looking for a new version…');
  try {
    await registration.update();
  } catch {
    host.notify('Could not reach the update server — try again when online.');
    return;
  }
  if (registration.installing || registration.waiting) {
    host.notify('A new version is on its way: the bar below will offer to reload.');
    return;
  }
  host.notify(`This is the latest version (${APP_VERSION}).`);
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
  // A sheet's start carried on from the sheet before: the size it left at.
  const carried = sel?.kind === 'node' && !run ? state.drawing.nodes.find((n) => n.id === sel.id)?.terminal : undefined;
  if (run) {
    state.currentDn = run.dn;
    state.currentSchedule = run.schedule;
    refreshSizeSelects();
  } else if (carried?.dn) {
    state.currentDn = carried.dn;
    if (carried.schedule) state.currentSchedule = carried.schedule;
    refreshSizeSelects();
  }
  // The joint in the toolbar shows the picked point's own joint, since that
  // is what changing it would set; otherwise the drawing's default.
  const node = sel?.kind === 'node' ? state.drawing.nodes.find((n) => n.id === sel.id) : undefined;
  jointSelect.value = (node ? state.analysis.nodeJoint.get(node.id) : undefined) ?? node?.joint ?? state.drawing.options.joint ?? 'BW';
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
  host.edit('Change size', (d) => setLineSize(d, runGroupIds(state.analysis, sel.id), state.currentDn, state.currentSchedule));
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
  const joint = jointSelect.value as 'BW' | 'SW' | 'THD';
  const sel = state.selection;
  // With a corner or tee picked, the choice is for that point; otherwise it
  // is the drawing's default for everything not set on its own.
  const info = sel?.kind === 'node' ? state.analysis.nodeInfo.get(sel.id) : undefined;
  if (sel?.kind === 'node' && info && info.degree >= 2 && info.fitting !== 'OLET') {
    const id = sel.id;
    host.edit('Set joint on point', (d) => {
      const node = d.nodes.find((n) => n.id === id);
      if (node) node.joint = joint;
    });
    host.notify(`This ${info.fitting === 'NONE' ? 'joint' : 'fitting'} is now ${joint === 'BW' ? 'butt welded' : joint === 'SW' ? 'socket weld' : 'threaded'}.`);
    return;
  }
  updateOptions((o) => {
    o.joint = joint;
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
$('tidy').addEventListener('click', () => tidyDrawing());

/**
 * Lays out every dimension, weld tag, balloon and pipe letter so none sits
 * on another or on the pipe, each as close to what it belongs to as it can
 * be, and keeps the result as though each had been dragged there: one
 * undo step, and every one can still be moved by hand. Laid out for the
 * bigger of the screen's symbols and the sheet's, so the PDF reads as well.
 */
function tidyDrawing(): void {
  if (state.drawing.runs.length === 0) return;
  const size = Math.max(symbolSizeFor(state.drawing, state.analysis), sheetSymbolSize(state.drawing, state.analysis));
  const specs: LayoutSpecs = { size, centroid: { x: 0, y: 0 }, pipes: [], points: [], texts: [], dims: [], tags: [], balloons: [], letters: [], notes: [] };
  renderDrawing({ drawing: state.drawing, analysis: state.analysis, view: { x: 0, y: 0, w: 1, h: 1 }, selection: null, symbol: size, collect: specs });
  const result = tidyLayout(specs);
  host.edit('Tidy', (d) => {
    const dims = { ...d.dimOverrides };
    for (const [key, place] of Object.entries(result.dims)) dims[key] = { ...dims[key], offset: place.offset, along: place.along };
    d.dimOverrides = dims;
    for (const [key, tag] of Object.entries(result.tags)) d.weldOverrides[key] = { ...d.weldOverrides[key], tag };
    const items = { ...d.itemOverrides };
    const balloons = { ...d.balloons };
    for (const [key, b] of Object.entries(result.balloons)) {
      items[key] = { dx: b.dx, dy: b.dy };
      balloons[b.line] = { ...balloons[b.line], at: key, hidden: undefined };
    }
    // Letters that sit well where they are anyway lose any old drag.
    for (const letter of specs.letters) {
      const moved = result.letters[letter.key];
      if (moved) items[letter.key] = moved;
      else delete items[letter.key];
    }
    // Line-end notes: moved, or back where they sit anyway.
    for (const note of specs.notes) {
      const moved = result.notes[note.key];
      if (moved) items[note.key] = moved;
      else delete items[note.key];
    }
    d.itemOverrides = items;
    d.balloons = balloons;
  });
  host.notify('Tidied: dimensions, weld numbers, balloons and letters laid out clear of each other. Undo puts them back.');
}
$('rotate').addEventListener('click', () => {
  updateOptions((o) => {
    o.northRotation = ((o.northRotation + 1) % 4) as 0 | 1 | 2 | 3;
  });
  fitView();
});
// The north arrow turns on its own, a tap at a time or from the View menu,
// for a sheet whose north lies off the isometric axes; Rotate still turns
// the whole drawing.
const turnNorthArrow = (turn: number) => {
  updateOptions((o) => {
    o.northArrow = ((turn % 360) + 360) % 360 || undefined;
  });
  const select = document.getElementById('opt-north-arrow') as HTMLSelectElement | null;
  if (select) select.value = String(state.drawing.options.northArrow ?? 0);
};
// Symbols against the pipe: the drawing's sheetScale (1:15 is 100%), the
// same the print dialog sets. A bigger share makes the pipe read shorter
// against its fittings, on screen and on the sheet alike.
function syncSymbolSelect(): void {
  const select = document.getElementById('opt-symbols') as HTMLSelectElement | null;
  if (!select) return;
  const r = state.drawing.options.sheetScale ?? 15;
  if (![...select.options].some((o) => Number(o.value) === r)) {
    const option = document.createElement('option');
    option.value = String(r);
    option.textContent = r === 0 ? 'Fit' : `${Math.round((r / 15) * 100)}%`;
    select.appendChild(option);
  }
  select.value = String(r);
}
document.getElementById('opt-symbols')?.addEventListener('change', (event) => {
  const value = Number((event.target as HTMLSelectElement).value);
  host.edit('Symbol size', (d) => {
    d.options.sheetScale = value;
  });
});
compassEl.addEventListener('click', () => turnNorthArrow((state.drawing.options.northArrow ?? 0) + 45));
document.getElementById('opt-north-arrow')?.addEventListener('change', (event) => turnNorthArrow(Number((event.target as HTMLSelectElement).value)));

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

/**
 * Replaces the drawing on screen with another state. Object.assign alone
 * left optional parts behind — equipment, measures, balloons, notes — when
 * the new state had none (New kept the last sheet's equipment; undoing the
 * first box did not take it away).
 */
function replaceDrawing(next: Drawing): void {
  for (const key of Object.keys(state.drawing)) delete (state.drawing as unknown as Record<string, unknown>)[key];
  Object.assign(state.drawing, next);
  // An older sheet may have a valve lying across a point: joined through;
  // a box that lost the point it stood on is put back on its line; a
  // branch left askew off its tee is squared up.
  straightenBranches(state.drawing);
  syncEquipment(state.drawing);
  uncoverPoints(state.drawing);
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
  keepNow();
  const fresh = emptyDrawing();
  fresh.id = uid('d');
  const kept = state.drawing;
  replaceDrawing({
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

// Save: into the Drive folder once Drive is set up, so the other device
// has it; a file on this device only where Drive is not in use.
$('save').addEventListener('click', () => {
  const drive = driveStatus();
  if (drive.clientId) {
    keepNow();
    if (drive.connected) {
      void runDriveSync().then(() => host.notify('Saved to Google Drive.'));
    } else {
      beginDriveSignIn();
    }
    return;
  }
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
    keepNow();
    undoStack.push(snapshot());
    takeUp(parsed);
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
  replaceDrawing(JSON.parse(previous) as Drawing);
  state.selection = null;
  recompute();
  persist();
  render();
}

function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(snapshot());
  replaceDrawing(JSON.parse(next) as Drawing);
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
  <div class="row"><label>Stamp</label><select id="sheet-stamp">
    ${SHEET_STAMPS.map((label) => `<option value="${label}"${sheetStamp(state.drawing) === label ? ' selected' : ''}>${label}</option>`).join('')}
  </select></div>
  <div class="row"><label>Paper</label><select id="sheet-paper">
    <option value="landscape"${tabletPrinter ? '' : ' selected'}>Landscape, as the sheet is</option>
    <option value="upright"${tabletPrinter ? ' selected' : ''}>Upright — the sheet is turned to fill it</option>
  </select></div>
  <p class="empty-note">A tablet prints on upright paper unless told otherwise, so the sheet is turned to lie along it; a printer fed landscape paper takes the sheet as it is.</p>
  <div class="row"><label>Symbols against the pipe</label><select id="sheet-scale">
    ${[...new Set([8, 10, 12, 15, 18, 22, 27, 33, state.drawing.options.sheetScale ?? 15])]
      .sort((a, b) => a - b)
      .map((r) => `<option value="${r}"${(state.drawing.options.sheetScale ?? 15) === r ? ' selected' : ''}>${r === 0 ? 'Fit to the sheet' : `${Math.round((r / 15) * 100)}%`}</option>`)
      .join('')}
  </select></div>
  <p class="empty-note">The sheet fits the whole drawing to the page, with the pipe and the symbols in the proportions you see on screen (View → Symbols sets them too); lettering is never printed smaller than the standard size.</p>
  <div class="btn-row">
    <button class="btn-line${tabletPrinter ? ' solid' : ''}" data-x="pdf">PDF sheet</button>
    <button class="btn-line${tabletPrinter ? '' : ' solid'}" data-x="print">Print / Save as PDF</button>
    <button class="btn-line" data-x="preview">View sheet first</button>
    <button class="btn-line" data-x="close">Cancel</button>
  </div>
  <p class="empty-note">PDF sheet makes the sheet itself as a PDF, at its own size with its own 5 mm margins and nothing added, and hands it to the share sheet — print it from there, or save it. Print goes through the browser's printer dialog, which on a tablet adds margins and a footer of its own.</p>
  <p class="empty-note" style="margin-top:12px">App version ${APP_VERSION} · <button class="btn-line" data-x="update" type="button">Check for a new version</button></p>
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
  const upright = () => backdrop.querySelector<HTMLSelectElement>('#sheet-paper')?.value === 'upright';
  // What the sheet is stamped: kept with the drawing, as in the Title tab.
  backdrop.querySelector<HTMLSelectElement>('#sheet-stamp')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    host.edit('Set stamp', (d) => {
      d.meta.stamp = value === 'AS MADE' ? undefined : value;
    });
  });
  // The scale is the drawing's own, kept with it, and sizes the symbols on screen too.
  backdrop.querySelector<HTMLSelectElement>('#sheet-scale')?.addEventListener('change', (event) => {
    const value = Number((event.target as HTMLSelectElement).value);
    host.edit('Set drawing scale', (d) => {
      d.options.sheetScale = value;
    });
  });

  backdrop.querySelectorAll<HTMLButtonElement>('[data-x]').forEach((button) => {
    button.addEventListener('click', () => {
      const what = button.dataset.x;
      if (what === 'close') return close();
      if (what === 'update') {
        close();
        void checkForUpdate();
        return;
      }
      const sheet = renderSheet(state.drawing, state.analysis, sheetSize());
      if (what === 'pdf') {
        close();
        void makePdfSheet(sheet, sheetSize());
        return;
      }
      if (what === 'preview') {
        openOverlay(
          'Sheet preview',
          `<div class="sheet-preview">${sheet}</div>`,
          true,
        );
      } else {
        printSheet(sheet, sheetSize(), upright());
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

/**
 * The sheet is printed from this page itself: it goes into a root that only
 * shows in print, where it is the only thing on the page, at the sheet's size.
 *
 * It used to be printed from a hidden frame, which an iPad prints as a blank
 * page — the frame has no size on screen, and that is the size it prints at.
 */
/* ------------------------------------------------------------ pdf sheet */

/**
 * The sheet as a PDF made here, not by the browser's printer: the page is
 * the sheet's own size, its frame 5 mm from the paper edge, and nothing is
 * added — a tablet's printer dialog puts margins and a footer of its own
 * round anything it prints and cannot be told not to. The sheet is drawn
 * onto a canvas at print resolution and put in the PDF as one image, which
 * the share sheet then prints, saves or sends.
 */
async function makePdfSheet(sheet: string, size: SheetSize): Promise<void> {
  const name = `${fileStem(host)}.pdf`;
  host.notify('Making the PDF sheet…');
  let blob: Blob;
  try {
    blob = await sheetToPdf(sheet, size);
  } catch (error) {
    host.notify(`The PDF could not be made here (${(error as Error)?.message ?? 'unknown'}) — use Print instead.`);
    return;
  }
  const file = new File([blob], name, { type: 'application/pdf' });
  const share = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (typeof share.share === 'function' && typeof share.canShare === 'function' && share.canShare({ files: [file] })) {
    try {
      // The file alone: a title given as well comes out of a tablet's share
      // sheet as a second, text file beside the PDF.
      await share.share({ files: [file] });
      return;
    } catch (error) {
      // Closing the share sheet is not an error worth a word.
      if ((error as Error)?.name === 'AbortError') return;
    }
  }
  await saveFile(blob, name);
}

async function sheetToPdf(sheet: string, size: SheetSize): Promise<Blob> {
  const { w, h } = SHEET_MM[size];
  // Print resolution, within what a tablet lets one canvas hold.
  const budget = 11e6;
  const dpi = Math.min(240, Math.floor(Math.sqrt(budget / ((w / 25.4) * (h / 25.4)))));
  const pxW = Math.round((w / 25.4) * dpi);
  const pxH = Math.round((h / 25.4) * dpi);

  const image = new Image();
  const url = URL.createObjectURL(new Blob([sheet], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('the sheet could not be drawn'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pxW, pxH);
    ctx.drawImage(image, 0, 0, pxW, pxH);

    // Lossless where the browser can deflate; otherwise a fine JPEG.
    let data: Uint8Array;
    let filter: string;
    if (typeof CompressionStream === 'function') {
      const rgba = ctx.getImageData(0, 0, pxW, pxH).data;
      const rgb = new Uint8Array(pxW * pxH * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
        rgb[j] = rgba[i];
        rgb[j + 1] = rgba[i + 1];
        rgb[j + 2] = rgba[i + 2];
      }
      const packed = await new Response(new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
      data = new Uint8Array(packed);
      filter = '/FlateDecode';
    } else {
      const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!jpeg) throw new Error('no image');
      data = new Uint8Array(await jpeg.arrayBuffer());
      filter = '/DCTDecode';
    }
    return assemblePdf(data, filter, pxW, pxH, (w / 25.4) * 72, (h / 25.4) * 72);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One page, one image filling it: the smallest PDF there is. */
function assemblePdf(image: Uint8Array, filter: string, pxW: number, pxH: number, wPt: number, hPt: number): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const put = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = length;
    put(`${n} 0 obj\n${body}\n`);
    if (stream) {
      put('stream\n');
      put(stream);
      put('\nendstream\n');
    }
    put('endobj\n');
  };
  const content = enc.encode(`q ${wPt.toFixed(3)} 0 0 ${hPt.toFixed(3)} 0 0 cm /Im0 Do Q`);
  put('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(3)} ${hPt.toFixed(3)}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
  );
  object(4, `<< /Length ${content.length} >>`, content);
  object(
    5,
    `<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter} /Length ${image.length} >>`,
    image,
  );
  const xref = length;
  put(`xref\n0 6\n0000000000 65535 f \n`);
  for (let n = 1; n <= 5; n += 1) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}

/** A tablet's printer gives upright paper unless told otherwise. */
const tabletPrinter = /iPad|iPhone|Android/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

function printSheet(sheet: string, size: SheetSize, upright = false): void {
  const { w, h } = SHEET_MM[size];
  let root = document.getElementById('print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'print-root';
    root.setAttribute('aria-hidden', 'true');
    document.body.appendChild(root);
  }
  let page = document.getElementById('print-page') as HTMLStyleElement | null;
  if (!page) {
    page = document.createElement('style');
    page.id = 'print-page';
    document.head.appendChild(page);
  }
  // Where the browser honours it, the paper is the sheet itself; elsewhere
  // the sheet is fitted to the paper by the print stylesheet.
  // Where the browser honours it the paper is the sheet's own; a tablet takes
  // no notice, keeps its own margins and footers, and gives upright paper
  // unless told otherwise. So on upright paper the sheet itself is turned to
  // lie along the page, and either way it is fitted to the printable area.
  const orient = upright ? 'portrait' : 'landscape';
  const named = size === 'A4' ? `A4 ${orient}` : size === 'A3' ? `A3 ${orient}` : upright ? `${h}mm ${w}mm` : `${w}mm ${h}mm`;
  page.textContent = `@page { size: ${named}; margin: 0; }`;
  const turned = sheet
    .replace(/<svg([^>]*)viewBox="0 0 ([\d.]+) ([\d.]+)"([^>]*)width="[^"]*" height="[^"]*"/, (_m, a, sw, sh, b) =>
      `<svg${a}viewBox="0 0 ${sh} ${sw}"${b}width="${sh}mm" height="${sw}mm"><g transform="translate(${sh} 0) rotate(90)">`)
    .replace(/<\/svg>\s*$/, '</g></svg>');
  // A tablet prints nothing that is pinned to the page, so there the sheet
  // is laid out in the flow instead, at a width whose height is sure to fit
  // inside the margins and footer the tablet keeps for itself.
  // A tablet's printer decides the paper's orientation in its own dialog,
  // taking no notice of ours, so the tablet gets both sheets and the print
  // stylesheet shows the one that lies along the paper it actually got; the
  // choice here only says which to expect. Elsewhere the page is the sheet.
  root.className = tabletPrinter ? `tablet ${upright ? 'want-upright' : 'want-landscape'}` : '';
  root.innerHTML = tabletPrinter ? `<div class="sheet-land">${sheet}</div><div class="sheet-port">${turned}</div>` : upright ? turned : sheet;

  // The page title is what "Save as PDF" names the file.
  const title = document.title;
  document.title = fileStem(host);
  const restore = () => {
    document.title = title;
  };
  window.addEventListener('afterprint', restore, { once: true });
  setTimeout(restore, 4000);
  try {
    window.print();
  } catch {
    host.notify('Printing is not available here — install the app to print.');
  }
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

/**
 * The box that opens when a reducer is picked: its large and small ends,
 * which way round it goes, and whether to carry on drawing from it. What it
 * says is what the item is called on the list: CON RED 4" X 2".
 */
function reducerDialog(ask: ReducerAsk): Promise<ReducerChoice | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    const sizeOptions = (picked: string) => DN_LIST.map((dn) => `<option value="${dn}"${dn === picked ? ' selected' : ''}>${sizeLabel(dn)}</option>`).join('');
    const name = (large: string, small: string) => `${ask.kind === 'RED_ECC' ? 'ECC RED' : 'CON RED'} ${sizeLabel(large)} X ${sizeLabel(small)}`;
    // The picture reads left to right: the line as drawn so far, then the
    // reducer, then the open end (or the flange it sits against); along a
    // run, the run's start then its end.
    const leftSide = ask.atEnd ? 'LINE' : 'RUN START';
    const rightSide = ask.atEnd ? ask.against ?? 'OPEN END' : 'RUN END';
    let largeOutward = false;
    backdrop.innerHTML = `
<div class="dialog" role="dialog" aria-label="Reducer" data-editor="reducer">
  <h3 data-red-name>${name(ask.large, ask.small)}</h3>
  <div class="row"><label>Large end</label><select data-f="red-large">${sizeOptions(ask.large)}</select></div>
  <div class="row"><label>Small end</label><select data-f="red-small">${sizeOptions(ask.small)}</select></div>
  <div class="row red-row"><div data-red-preview></div><button class="btn-line" type="button" data-a="red-flip">Flip</button></div>
  ${ask.drawOn ? '<div class="row"><label>Then</label><label class="check"><input type="checkbox" data-f="red-drawon" checked /> Carry on drawing from its far end, at that size</label></div>' : ''}
  <p class="empty-note">${ask.against ? `Welded straight to the ${ask.against.toLowerCase()} on the end. ` : ''}The pipe either side takes the size of the end it meets; both ends are points the line can be picked up at.</p>
  <div class="btn-row">
    <button class="btn-line solid" data-confirm>Place reducer</button>
    <button class="btn-line" data-cancel>Cancel</button>
  </div>
</div>`;
    document.body.appendChild(backdrop);
    const field = <T extends HTMLElement>(key: string) => backdrop.querySelector<T>(`[data-f="${key}"]`);
    const large = field<HTMLSelectElement>('red-large')!;
    const small = field<HTMLSelectElement>('red-small')!;
    const redraw = () => {
      const heading = backdrop.querySelector('[data-red-name]');
      if (heading) heading.textContent = name(large.value, small.value);
      const preview = backdrop.querySelector('[data-red-preview]');
      if (preview) preview.innerHTML = reducerPreview(ask.kind, large.value, small.value, !largeOutward, leftSide, rightSide);
    };
    redraw();
    large.addEventListener('change', redraw);
    small.addEventListener('change', redraw);
    backdrop.querySelector('[data-a="red-flip"]')?.addEventListener('click', () => {
      largeOutward = !largeOutward;
      redraw();
    });
    const close = (answer: ReducerChoice | null) => {
      backdrop.remove();
      resolve(answer);
    };
    backdrop.querySelector('[data-confirm]')?.addEventListener('click', () =>
      // Large and small picked the other way round: the same reducer turned about.
      close({
        ...(sizeOf(large.value).od < sizeOf(small.value).od
          ? { large: small.value, small: large.value, largeOutward: !largeOutward }
          : { large: large.value, small: small.value, largeOutward }),
        drawOn: ask.drawOn && (field<HTMLInputElement>('red-drawon')?.checked ?? false),
      }),
    );
    backdrop.querySelector('[data-cancel]')?.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(null);
    });
  });
}

const AXIS_NAMES: Record<Axis, string> = { N: 'North', S: 'South', E: 'East', W: 'West', U: 'Up', D: 'Down' };

/** Which way an olet's branch will go, and its size; the olet then waits on the line for it. */
function oletDialog(ask: OletAsk): Promise<OletChoice | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';
    const same = (a: Axis, b: Axis | null) => b !== null && (a === b || AXIS_VECTOR[a].e === -AXIS_VECTOR[b].e && AXIS_VECTOR[a].n === -AXIS_VECTOR[b].n && AXIS_VECTOR[a].u === -AXIS_VECTOR[b].u);
    const dirs = AXES.filter((axis) => !same(axis, ask.along) && !(ask.taken ?? []).includes(axis));
    const pick = dirs.includes('U') ? 'U' : dirs[0];
    const at = DN_LIST.indexOf(ask.header);
    const tee = ask.kind === 'tee';
    // A tee is equal unless a smaller branch is picked; an olet's branch is
    // a size down unless said otherwise.
    const small = tee ? ask.header : DN_LIST[Math.max(0, at - 1)] ?? ask.header;
    const name = tee ? 'Tee' : ask.joint === 'SW' ? 'Sockolet' : ask.joint === 'THD' ? 'Threadolet' : 'Weldolet';
    const sizes = tee ? DN_LIST.filter((dn) => DN_LIST.indexOf(dn) <= at) : DN_LIST;
    backdrop.innerHTML = `
<div class="dialog" role="dialog" aria-label="${tee ? 'Tee' : 'Olet'}" data-editor="${tee ? 'tee' : 'olet'}">
  <h3>${name} on ${sizeLabel(ask.header)}</h3>
  <div class="row"><label>Branch size</label><select data-f="olet-dn">${sizes.map((dn) => `<option value="${dn}"${dn === small ? ' selected' : ''}>${sizeLabel(dn)}${tee ? (dn === ask.header ? ' — equal tee' : ' — reducing tee') : ''}</option>`).join('')}</select></div>
  ${tee ? '' : `<div class="row"><label>Branch goes</label><select data-f="olet-dir">${dirs.map((axis) => `<option value="${axis}"${axis === pick ? ' selected' : ''}>${AXIS_NAMES[axis]}</option>`).join('')}</select></div>`}
  <p class="empty-note">${
    tee
      ? 'An equal tee at the header\'s size, or a reducing tee with a smaller branch. Then tap where the branch goes; it is drawn at that size.'
      : 'The olet rides on the header, which keeps its full length. Type the dimension up to it to place it; draw the branch from it whenever you like, at the branch size.'
  }</p>
  <div class="btn-row">
    <button class="btn-line solid" data-confirm>${tee ? 'Place tee' : 'Place olet'}</button>
    <button class="btn-line" data-cancel>Cancel</button>
  </div>
</div>`;
    document.body.appendChild(backdrop);
    const close = (answer: OletChoice | null) => {
      backdrop.remove();
      resolve(answer);
    };
    backdrop.querySelector('[data-confirm]')?.addEventListener('click', () =>
      close({
        dn: backdrop.querySelector<HTMLSelectElement>('[data-f="olet-dn"]')!.value,
        dir: (backdrop.querySelector<HTMLSelectElement>('[data-f="olet-dir"]')?.value as Axis | undefined) ?? pick,
      }),
    );
    backdrop.querySelector('[data-cancel]')?.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(null);
    });
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

/* ---------------------------------------------------------------- drive */

let driveBusy = false;

/** Syncs the library with Google Drive and says what moved. */
async function runDriveSync(): Promise<void> {
  if (driveBusy) return;
  if (!driveStatus().connected) {
    host.notify('Sign in to Google Drive first.');
    render();
    return;
  }
  driveBusy = true;
  keepNow();
  hoverMessage = 'syncing with Google Drive…';
  renderHud();
  try {
    const result = await syncDrive();
    const parts = [
      result.up ? `${result.up} up` : '',
      result.down ? `${result.down} down` : '',
      result.removed ? `${result.removed} removed` : '',
    ].filter(Boolean);
    host.notify(parts.length ? `Drive: ${parts.join(', ')}.` : 'Drive: everything was already the same.');
    // The sheet on screen came back newer from Drive: show that one.
    if (state.drawing.id && result.downloaded.includes(state.drawing.id)) {
      const entry = loadLibrary().find((e) => e.id === state.drawing.id);
      if (entry) {
        undoStack.push(snapshot());
        redoStack.length = 0;
        takeUp(entry.drawing);
      }
    }
  } catch (err) {
    host.notify(err instanceof Error ? err.message : 'Google Drive could not be reached.');
  } finally {
    driveBusy = false;
    hoverMessage = null;
    render();
  }
}

/* -------------------------------------------------------------- storage */

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.drawing));
  } catch {
    // Storage can be unavailable or full; the drawing is still exportable.
  }
  // The library follows a moment later, so a run of quick edits writes it once.
  if (keepTimer) clearTimeout(keepTimer);
  keepTimer = setTimeout(keepNow, 800);
}

let keepTimer: ReturnType<typeof setTimeout> | null = null;

/** Puts the drawing on screen in the library now, if it is worth keeping. */
function keepNow(): void {
  if (keepTimer) clearTimeout(keepTimer);
  keepTimer = null;
  if (!state.drawing.id) state.drawing.id = uid('d');
  if (worthKeeping(state.drawing)) upsertDrawing(state.drawing);
}

/** Puts a drawing on screen in place of the one there. */
function takeUp(drawing: Drawing): void {
  replaceDrawing({ ...emptyDrawing(), ...drawing });
  if (!state.drawing.id) state.drawing.id = uid('d');
  state.selection = null;
  state.preview = null;
  hoverMessage = null;
  canvas.setAnchor(null);
  state.commandState = initialCommandState(state.currentDn, state.currentSchedule);
  recompute();
  persist();
  render();
  fitView();
}

/**
 * The next sheet of the project on screen. The title block, logo and pipe
 * settings carry over and the sheet count moves on across every sheet of
 * the project. Picked on an open end, that end is marked "CONT. ON SH.n"
 * and the new sheet starts from a point marked "CONT. FROM SH.k", the way
 * the sheets say where a line goes on.
 */
function newSheetInProject(): void {
  const prev = state.drawing;
  const project = prev.meta.project || '';
  const prevNo = sheetNumber(prev.meta.sheet);
  const picked = state.selection?.kind === 'node' ? state.selection.id : null;
  const pickedEnd = picked && state.analysis.nodeInfo.get(picked)?.degree === 1 ? picked : null;
  // The line goes on at the size it leaves this sheet at (his complaint,
  // 2026-09-26: the next sheet started at the toolbar's size instead).
  const leaving = pickedEnd ? prev.runs.find((r) => r.from === pickedEnd || r.to === pickedEnd) : undefined;

  // This sheet first: kept, with the continuation marked on it.
  keepNow();
  const siblings = loadLibrary().filter((e) => (e.drawing.meta.project || '') === project);
  const total = Math.max(siblings.length, prevNo) + 1;
  const nextNo = total;
  if (pickedEnd) {
    host.edit('Mark continuation', (d) => {
      const node = d.nodes.find((n) => n.id === pickedEnd);
      if (node) node.terminal = { kind: 'CONTINUATION', note: `CONT. ON SH.${nextNo}` };
    });
  }
  keepNow();
  renumberProject(project, total);

  undoStack.push(snapshot());
  redoStack.length = 0;
  const fresh = emptyDrawing();
  fresh.id = uid('d');
  fresh.options = { ...prev.options };
  fresh.meta = {
    ...fresh.meta,
    logo: prev.meta.logo,
    project: prev.meta.project,
    lineNumber: prev.meta.lineNumber,
    drawingNo: prev.meta.drawingNo,
    drawnBy: prev.meta.drawnBy,
    revision: prev.meta.revision,
    sheet: `${nextNo} of ${total}`,
  };
  // The point the line comes in at, marked as continuing from the sheet before.
  const startId = uid('n');
  fresh.nodes.push({
    id: startId,
    pos: { e: 0, n: 0, u: 0 },
    terminal: { kind: 'CONTINUATION', note: `CONT. FROM SH.${prevNo}`, ...(leaving ? { dn: leaving.dn, schedule: leaving.schedule } : {}) },
  });
  if (leaving) {
    state.currentDn = leaving.dn;
    state.currentSchedule = leaving.schedule;
  }
  takeUp(fresh);
  refreshSizeSelects();
  canvas.setAnchor(startId);
  state.selection = { kind: 'node', id: startId };
  state.commandState.currentNode = startId;
  render();
  host.notify(`Sheet ${nextNo} of ${total} — tap where the line goes on.`);
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
  const typing = target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (typing) return;

  if (event.key === 'Escape') {
    state.measureFrom = null;
    state.joinFrom = null;
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
/** An olet point with no branch drawn yet: only the olet is there to remove. */
function oletAlone(nodeId: string): boolean {
  const node = state.drawing.nodes.find((n) => n.id === nodeId);
  return !!node && oletMarks(node).length > 0 && state.analysis.nodeInfo.get(nodeId)?.degree === 2;
}

function deleteSelection(): void {
  const sel = state.selection;
  if (!sel || sel.kind === 'weld') return;
  // A flanged joint: the pair of flanges goes and the pipe is joined
  // straight through, rather than the point and its runs.
  const flanged = sel.kind === 'node' && !!state.drawing.nodes.find((n) => n.id === sel.id)?.flange;
  // An olet with no branch: only the olet goes, and the header runs on whole.
  const olet = sel.kind === 'node' && oletAlone(sel.id);
  // A plain point along a line just goes, and the pipe runs on through.
  const plain = sel.kind === 'node' && isPlainPoint(state.drawing, sel.id);
  host.edit(flanged ? 'Remove flanges' : olet ? 'Remove olet' : plain ? 'Remove point' : 'Delete', (d) => {
    if (sel.kind === 'run') deleteRunGroup(d, state.analysis, sel.id);
    else if (sel.kind === 'equipment') removeEquipment(d, sel.id);
    else if (sel.kind === 'node' && flanged) removeFlangeJoint(d, sel.id);
    else if (sel.kind === 'node' && olet) removeOlet(d, sel.id);
    else if (sel.kind === 'node') deletePoint(d, sel.id);
    else removeComponent(d, sel.id);
  });
  if (flanged) host.notify('Flanges removed; the pipe runs straight through.');
  if (olet) host.notify('Olet removed; the header runs on whole.');
  if (plain) host.notify('Point removed; the pipe runs straight through.');
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
// Back from Google's sign-in page: the token is in the address, so take
// it and sync straight away, in the Projects tab where it was asked for.
const signedIn = finishDriveSignIn();
if (signedIn) state.tab = 'projects';
render();
fitView();
if (signedIn || driveStatus().connected) void runDriveSync();

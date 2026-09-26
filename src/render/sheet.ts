import { pipeNetAt, type Analysis, type BomLine } from '../model/drawing';
import type { Drawing } from '../model/types';
import { SYMBOL_MM, contentBounds, escapeText, renderDrawing, symbolSizeFor, type Bounds } from './renderer';
import { sizeLabel } from '../model/pipe-data';
import { northArrowDir } from '../model/iso';
import { contentCss } from './style';

export type SheetSize = 'A4' | 'A3' | 'A2';

const SHEETS: Record<SheetSize, { w: number; h: number }> = {
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
  A2: { w: 594, h: 420 },
};

// Tight: the frame sits 5 mm in from the paper edge, which is as close as
// most printers will put ink.
const MARGIN = 5;

/** Symbol half-size on the printed sheet, in mm, at the least: a third up on the screen's, as he asked. */
const SHEET_SYMBOL_MM = SYMBOL_MM * 1.35;
/** And at the most, so a small drawing does not print with huge lettering. */
const SHEET_SYMBOL_MAX_MM = SHEET_SYMBOL_MM * 1.7;

/**
 * The symbol half-size, in drawing paper units, for a sheet at k sheet mm
 * per paper unit: the screen's own, so the sheet has the proportions he
 * sees on screen (his complaint, 2026-09-24: "on screen the drawing looks
 * good, printed the pipe comes out stretched"), but never under
 * SHEET_SYMBOL_MM on the paper (a long line once printed with tiny
 * symbols) nor over SHEET_SYMBOL_MAX_MM.
 */
function sheetSymbolAt(drawing: Drawing, analysis: Analysis, k: number): number {
  const screen = symbolSizeFor(drawing, analysis);
  return Math.min(Math.max(screen, SHEET_SYMBOL_MM / k), SHEET_SYMBOL_MAX_MM / k);
}

/** The sheet's drawing area, in mm. */
function drawingArea(size: SheetSize): { x: number; y: number; w: number; h: number; dividerX: number; col: number } {
  const { w: W, h: H } = SHEETS[size];
  const col = Math.min(112, W * 0.26);
  const dividerX = W - MARGIN - col;
  return { x: MARGIN, y: MARGIN, w: dividerX - MARGIN - 5, h: H - MARGIN * 2, dividerX, col };
}

/**
 * The drawn extent of the drawing's SVG, in its own paper units, labels
 * and dimensions included (the touch targets left out); null where there
 * is no page to measure in.
 */
function measureContent(content: string, css: string): Bounds | null {
  if (typeof document === 'undefined' || !document.body) return null;
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  host.setAttribute('width', '10');
  host.setAttribute('height', '10');
  host.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none';
  host.innerHTML = `<style>${css}</style><g>${content}</g>`;
  host.querySelectorAll('.hits').forEach((e) => e.remove());
  document.body.appendChild(host);
  try {
    const g = host.querySelector('g') as SVGGElement | null;
    const box = g?.getBBox();
    if (!box || !(box.width > 0) || !(box.height > 0)) return null;
    return { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height };
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

interface SheetFit {
  k: number;
  symbol: number;
  tx: number;
  ty: number;
  content: string;
}

/**
 * Fits the drawing to the sheet's area, all of it — pipe, dimensions,
 * tags, balloons — so that bigger lettering never runs off the frame. A
 * first guess from the points, then measured and fitted again.
 */
function fitSheet(drawing: Drawing, analysis: Analysis, size: SheetSize): SheetFit {
  const area = drawingArea(size);
  const nodes = contentBounds(drawing, analysis);
  const sheetDrawing = { ...drawing, options: { ...drawing.options, showGrid: false } };
  const draw = (k: number, bounds: Bounds) => {
    const symbol = sheetSymbolAt(drawing, analysis, k);
    const tx = area.x + area.w / 2 - ((bounds.minX + bounds.maxX) / 2) * k;
    const ty = area.y + area.h / 2 - ((bounds.minY + bounds.maxY) / 2) * k;
    const view = { x: (area.x - tx) / k, y: (area.y - ty) / k, w: area.w / k, h: area.h / k };
    const content = renderDrawing({ drawing: sheetDrawing, analysis, view, selection: null, symbol });
    return { k, symbol, tx, ty, content };
  };
  const fitTo = (b: Bounds, pad: number) =>
    Math.min((area.w - pad * 2) / Math.max(b.maxX - b.minX, 1), (area.h - pad * 2) / Math.max(b.maxY - b.minY, 1));
  let fit = draw(fitTo(nodes, 18), nodes);
  for (let pass = 0; pass < 3; pass += 1) {
    const drawn = measureContent(fit.content, contentCss({ k: fit.k, u: 0.24, symbol: fit.symbol }));
    if (!drawn) break;
    const all: Bounds = {
      minX: Math.min(drawn.minX, nodes.minX),
      minY: Math.min(drawn.minY, nodes.minY),
      maxX: Math.max(drawn.maxX, nodes.maxX),
      maxY: Math.max(drawn.maxY, nodes.maxY),
    };
    const k = fitTo(all, 4);
    // Within a percent is close enough: draw it once more where it sits and stop.
    if (Math.abs(k - fit.k) / fit.k < 0.01) {
      fit = draw(fit.k, all);
      break;
    }
    fit = draw(k, all);
  }
  return fit;
}

/**
 * The symbol half-size, in drawing paper units, that the printed sheet
 * will use. Tidy lays out for whichever of this and the screen's is bigger.
 */
export function sheetSymbolSize(drawing: Drawing, analysis: Analysis, size: SheetSize = 'A3'): number {
  const area = drawingArea(size);
  const bounds = contentBounds(drawing, analysis);
  const k = Math.min((area.w - 36) / Math.max(bounds.maxX - bounds.minX, 1), (area.h - 36) / Math.max(bounds.maxY - bounds.minY, 1));
  return sheetSymbolAt(drawing, analysis, k);
}

function text(
  x: number,
  y: number,
  value: string,
  cls: string,
  anchor: 'start' | 'middle' | 'end' = 'start',
): string {
  return `<text class="${cls}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${anchor}">${escapeText(value)}</text>`;
}

function rect(x: number, y: number, w: number, h: number, cls: string): string {
  return `<rect class="${cls}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"/>`;
}

function hline(x1: number, x2: number, y: number, cls = 'rule'): string {
  return `<line class="${cls}" x1="${x1.toFixed(2)}" y1="${y.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y.toFixed(2)}"/>`;
}

function vline(x: number, y1: number, y2: number, cls = 'rule'): string {
  return `<line class="${cls}" x1="${x.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function quantityText(line: BomLine): string {
  return line.unit === 'm' ? `${line.quantity.toFixed(2)} m` : `${Math.round(line.quantity)}`;
}

/**
 * The title block. A fabrication sheet needs to say which line it is, which
 * revision, and who drew it — with the company's mark on it and somewhere to
 * stamp the drawing once the line is actually built.
 */
/**
 * What the sheet is stamped: as built, sent for approval, or approved to
 * build from (his ask, 2026-09-24). AS MADE is the default.
 */
export const SHEET_STAMPS = ['AS MADE', 'FOR APPROVAL', 'APPROVED FOR CONSTRUCTION'] as const;

export function sheetStamp(drawing: Drawing): string {
  const stamp = drawing.meta.stamp;
  return stamp && (SHEET_STAMPS as readonly string[]).includes(stamp) ? stamp : 'AS MADE';
}

/**
 * The stamp, kept as its own box so it reads at a glance and can be signed
 * over. A long one is set smaller so it keeps inside the box on an A4.
 */
function stampBox(x: number, y: number, w: number, h: number, label: string): string {
  // About 0.74 of the font size per letter, spacing included, and a margin.
  const size = Math.min(3.6, (w - 12) / (label.length * 0.74));
  return (
    rect(x, y, w, h, 'block') +
    rect(x + 2.5, y + 2.5, w - 5, h - 5, 'stamp') +
    `<text x="${(x + w / 2).toFixed(2)}" y="${(y + h / 2 + size * 0.39).toFixed(2)}" class="stamp-text" text-anchor="middle" style="font-size:${size.toFixed(2)}px">${escapeText(label)}</text>`
  );
}

/**
 * The title block. The side column is a quarter of the sheet, so the fields
 * stack down it rather than across it — nothing is squeezed into a cell too
 * narrow to read.
 */
function titleBlock(drawing: Drawing, x: number, y: number, w: number, h: number): string {
  const m = drawing.meta;
  let out = rect(x, y, w, h, 'block');

  const logoH = h * 0.46;
  const rowH = (h - logoH) / 3;

  // The company mark sits left in the top band with the job name beside it,
  // so a tall mark does not leave the band mostly empty.
  out += hline(x, x + w, y + logoH);
  const pad = 2.2;
  const markW = w * 0.44;
  if (m.logo) {
    out +=
      `<image href="${escapeText(m.logo)}" x="${(x + pad).toFixed(2)}" y="${(y + pad).toFixed(2)}" ` +
      `width="${(markW - pad).toFixed(2)}" height="${(logoH - pad * 2).toFixed(2)}" ` +
      `preserveAspectRatio="xMidYMid meet"/>`;
  }
  // The mark and the title each in a cell of their own.
  if (m.logo) out += vline(x + markW, y, y + logoH, 'block');
  const nameX = m.logo ? x + markW + (w - markW) / 2 : x + w / 2;
  out += text(nameX, y + logoH / 2 + 1.1, clip(m.project || 'PIPING ISOMETRIC', 26), 'tb-title', 'middle');

  const cell = (col: number, row: number, cols: number, label: string, value: string) => {
    const cw = w / cols;
    const cx = x + cw * col;
    const cy = y + logoH + rowH * row;
    let out2 = col > 0 ? vline(cx, cy, cy + rowH) : '';
    if (row > 0) out2 += hline(x, x + w, cy);
    out2 += text(cx + 1.4, cy + rowH * 0.4, label, 'tb-label');
    out2 += text(cx + 1.4, cy + rowH * 0.85, clip(value || '—', Math.floor(cw / 1.3)), 'tb-value');
    return out2;
  };

  out += cell(0, 0, 1, 'LINE NUMBER', m.lineNumber);
  out += cell(0, 1, 3, 'DWG No.', m.drawingNo);
  out += cell(1, 1, 3, 'SHEET', m.sheet);
  out += cell(2, 1, 3, 'REV', m.revision);
  out += cell(0, 2, 2, 'DRAWN', m.drawnBy);
  out += cell(1, 2, 2, 'DATE', m.date);
  return out;
}

function bomTable(bom: BomLine[], x: number, y: number, w: number, maxRows: number): { svg: string; height: number } {
  const rowH = 4.2;
  const headH = 5;
  const shown = bom.slice(0, maxRows);
  const h = headH + rowH * Math.max(shown.length, 1);

  let out = rect(x, y, w, h, 'block');
  out += hline(x, x + w, y + headH, 'rule-strong');

  const cols = [0.07, 0.5, 0.18, 0.13, 0.12];
  const xs: number[] = [];
  let acc = x;
  for (const c of cols) {
    xs.push(acc);
    acc += w * c;
  }
  for (let i = 1; i < xs.length; i += 1) out += vline(xs[i], y, y + h);

  out += text(xs[0] + 1.2, y + headH * 0.72, 'ITEM', 'tb-head');
  out += text(xs[1] + 1.2, y + headH * 0.72, 'DESCRIPTION', 'tb-head');
  out += text(xs[2] + 1.2, y + headH * 0.72, 'SIZE', 'tb-head');
  out += text(xs[3] + 1.2, y + headH * 0.72, 'THK', 'tb-head');
  out += text(xs[4] + 1.2, y + headH * 0.72, 'QTY', 'tb-head');

  shown.forEach((line, i) => {
    const ry = y + headH + rowH * i;
    if (i > 0) out += hline(x, x + w, ry, 'rule-faint');
    const ty = ry + rowH * 0.7;
    out += text(xs[0] + 1.2, ty, String(i + 1), 'tb-cell');
    out += text(xs[1] + 1.2, ty, clip(line.description, Math.floor((w * cols[1]) / 1.35)), 'tb-cell');
    out += text(xs[2] + 1.2, ty, sizeLabel(line.dn), 'tb-cell');
    out += text(xs[3] + 1.2, ty, line.schedule, 'tb-cell');
    out += text(xs[4] + 1.2, ty, quantityText(line), 'tb-cell');
  });

  if (shown.length === 0) {
    out += text(xs[1] + 1.2, y + headH + rowH * 0.7, 'No items', 'tb-cell');
  }
  return { svg: out, height: h };
}

function weldTable(analysis: Analysis, x: number, y: number, w: number): { svg: string; height: number } {
  // Grouped by size and preparation, which is what anyone checking the line
  // against the drawing counts.
  const groups = new Map<string, { dn: string; joint: string; count: number }>();
  for (const weld of analysis.welds) {
    const key = `${weld.dn}|${weld.joint}`;
    const g = groups.get(key) ?? { dn: weld.dn, joint: weld.joint, count: 0 };
    g.count += 1;
    groups.set(key, g);
  }
  const rows = [...groups.values()];
  const rowH = 4.2;
  const headH = 5;
  const h = headH * 2 + rowH * Math.max(rows.length, 1);

  let out = rect(x, y, w, h, 'block');
  out += text(x + 1.2, y + headH * 0.72, 'WELDS', 'tb-head');
  out += hline(x, x + w, y + headH, 'rule-strong');
  out += hline(x, x + w, y + headH * 2, 'rule');

  const cols = [0.42, 0.3, 0.28];
  const xs: number[] = [];
  let acc = x;
  for (const c of cols) {
    xs.push(acc);
    acc += w * c;
  }
  for (let i = 1; i < xs.length; i += 1) out += vline(xs[i], y + headH, y + h);

  const hy = y + headH * 1.72;
  out += text(xs[0] + 1.2, hy, 'SIZE', 'tb-head');
  out += text(xs[1] + 1.2, hy, 'PREP', 'tb-head');
  out += text(xs[2] + 1.2, hy, 'QTY', 'tb-head');

  rows.forEach((row, i) => {
    const ry = y + headH * 2 + rowH * i;
    if (i > 0) out += hline(x, x + w, ry, 'rule-faint');
    const ty = ry + rowH * 0.7;
    out += text(xs[0] + 1.2, ty, sizeLabel(row.dn), 'tb-cell');
    out += text(xs[1] + 1.2, ty, row.joint, 'tb-cell');
    out += text(xs[2] + 1.2, ty, String(row.count), 'tb-cell');
  });
  if (rows.length === 0) out += text(xs[0] + 1.2, y + headH * 2 + rowH * 0.7, 'None', 'tb-cell');

  return { svg: out, height: h };
}

/**
 * Every weld by number: what it joins, and the pipe at it as cut — the
 * take-outs and root gaps off — which is what is marked on the pipe before
 * anything is welded. As many rows as the column has room for.
 */
const LIST_ROW = 3.4;

function weldList(analysis: Analysis, x: number, y: number, w: number, maxRows: number): { svg: string; height: number } {
  const welds = analysis.welds;
  if (welds.length === 0 || maxRows < 1) return { svg: '', height: 0 };
  // Tight rows: this is the long table on the sheet, and every row that
  // fits is one less to look up in the app.
  const rowH = LIST_ROW;
  const headH = 4.2;
  const shown = welds.length > maxRows ? welds.slice(0, Math.max(0, maxRows - 1)) : welds;
  const more = welds.length - shown.length;
  const rows = shown.length + (more > 0 ? 1 : 0);
  const h = headH * 2 + rowH * rows;

  let out = rect(x, y, w, h, 'block');
  out += text(x + 1.2, y + headH * 0.72, 'WELD LIST — PIPE CUT', 'tb-head');
  out += hline(x, x + w, y + headH, 'rule-strong');
  out += hline(x, x + w, y + headH * 2, 'rule');

  const cols = [0.12, 0.13, 0.5, 0.25];
  const xs: number[] = [];
  let acc = x;
  for (const c of cols) {
    xs.push(acc);
    acc += w * c;
  }
  // The "and more" line runs across the whole width, under the columns.
  const colsBottom = more > 0 ? y + h - rowH : y + h;
  for (let i = 1; i < xs.length; i += 1) out += vline(xs[i], y + headH, colsBottom);

  const hy = y + headH * 1.72;
  out += text(xs[0] + 1.2, hy, 'NO.', 'tb-head');
  out += text(xs[1] + 1.2, hy, 'SIZE', 'tb-head');
  out += text(xs[2] + 1.2, hy, 'JOINS', 'tb-head');
  out += text(x + w - 1.2, hy, 'PIPE NET', 'tb-head', 'end');

  shown.forEach((weld, i) => {
    const ry = y + headH * 2 + rowH * i;
    if (i > 0) out += hline(x, x + w, ry, 'rule-faint');
    const ty = ry + rowH * 0.7;
    out += text(xs[0] + 1.2, ty, weld.number, 'tb-small');
    out += text(xs[1] + 1.2, ty, sizeLabel(weld.dn), 'tb-small');
    out += text(xs[2] + 1.2, ty, clip(weld.joins, Math.floor((w * cols[2]) / 1.0)), 'tb-small');
    out += text(x + w - 1.2, ty, pipeNetAt(analysis, weld.key), 'tb-small', 'end');
  });
  if (more > 0) {
    const ry = y + headH * 2 + rowH * shown.length;
    out += hline(x, x + w, ry, 'rule-faint');
    out += text(xs[0] + 1.2, ry + rowH * 0.7, `AND ${more} MORE — SEE THE WELD LIST IN THE APP`, 'tb-small');
  }
  return { svg: out, height: h };
}

function compass(drawing: Drawing, cx: number, cy: number, r: number): string {
  const dir = northArrowDir(drawing.options.northRotation, drawing.options.northArrow ?? 0);
  const tipX = cx + dir.x * r;
  const tipY = cy + dir.y * r;
  const tailX = cx - dir.x * r * 0.55;
  const tailY = cy - dir.y * r * 0.55;
  const px = -dir.y * r * 0.24;
  const py = dir.x * r * 0.24;
  return (
    `<circle class="compass-ring" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${(r * 1.5).toFixed(2)}"/>` +
    `<polygon class="compass-needle" points="${tipX.toFixed(2)},${tipY.toFixed(2)} ${(tailX + px).toFixed(2)},${(tailY + py).toFixed(2)} ${(tailX - px).toFixed(2)},${(tailY - py).toFixed(2)}"/>` +
    text(cx + dir.x * r * 2.1, cy + dir.y * r * 2.1 + 1, 'N', 'compass-label', 'middle')
  );
}

/** Most lines of his own notes the sheet gives room to; the weld list gives way to them. */
const OWN_NOTE_LINES = 10;

/** His notes, a line each, wrapped at `width` characters, in capitals. */
export function sheetNotes(notes: string | undefined, width: number): string[] {
  const out: string[] = [];
  for (const raw of (notes ?? '').split(/\r?\n/)) {
    const words = raw.trim().toUpperCase().split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = '';
      }
      line = line ? `${line} ${word}` : word.slice(0, width);
    }
    if (line) out.push(line);
  }
  return out.slice(0, OWN_NOTE_LINES);
}

/** Renders a complete, standalone drawing sheet. Units are millimetres. */
export function renderSheet(drawing: Drawing, analysis: Analysis, size: SheetSize = 'A3'): string {
  const { w: W, h: H } = SHEETS[size];
  const col = Math.min(112, W * 0.26);
  const dividerX = W - MARGIN - col;
  const areaX = MARGIN;
  const areaY = MARGIN;

  // The drawing fills the sheet's drawing area, whatever its scale on
  // screen — the way his own sheets are drawn — with the pipe and the
  // symbols in the proportions he sees on screen. The scale is worked out
  // from the fit and noted.
  const { k, tx, ty, content, symbol } = fitSheet(drawing, analysis, size);
  const scaleR = Math.round(1 / drawing.options.scale / k);

  // Right hand column: bill of materials, weld summary, title block.
  const tbH = 50;
  const stampH = 13;
  const tbY = H - MARGIN - tbH;
  const stampY = tbY - stampH - 3;
  const bom = bomTable(analysis.bom, dividerX, MARGIN, col, Math.floor((stampY - MARGIN - 34) / 4.2));
  // The tables stack with no gap: a blank strip reads as an empty row.
  const welds = weldTable(analysis, dividerX, MARGIN + bom.height, col);

  // His own notes first, as typed (in capitals, like the rest of the
  // sheet), each wrapped to the column; then the sheet's own.
  const noteWidth = Math.floor((col - 2.4) / (1.95 * 0.56));
  const own = sheetNotes(drawing.meta.notes, noteWidth);
  const notes = [
    ...own,
    'ALL DIMENSIONS IN MILLIMETRES.',
    drawing.options.schematic ? 'DRAWING NOT TO SCALE.' : `SCALE 1:${scaleR} (FITTED TO SHEET), DIMENSIONS GOVERN.`,
    'DIMENSIONS ARE CENTRE TO CENTRE UNLESS NOTED.',
  ];

  const noteY = stampY - 4 - notes.length * 3.2;
  // The weld list takes what is left between the weld summary and the notes.
  const listY = MARGIN + bom.height + welds.height;
  const listRoom = noteY - 5 - listY;
  const list = weldList(analysis, dividerX, listY, col, Math.floor((listRoom - 8.4) / LIST_ROW));
  let notesSvg = '';
  notes.forEach((n, i) => {
    // Clear of the column's rule (it sat on it and lost its first letter).
    notesSvg += text(dividerX + 1.2, noteY + i * 3.2, n, 'note-text');
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm">
<style>
text { font-family: "Helvetica Neue", Arial, sans-serif; }
.sheet-bg { fill: #ffffff; }
.frame { fill: none; stroke: #12161c; stroke-width: 0.5; }
.block { fill: none; stroke: #12161c; stroke-width: 0.35; }
.rule { stroke: #12161c; stroke-width: 0.25; }
.rule-strong { stroke: #12161c; stroke-width: 0.4; }
.rule-faint { stroke: #9aa5b4; stroke-width: 0.15; }
.tb-title { font-size: 3px; font-weight: 700; letter-spacing: 0.04em; }
.stamp { fill: none; stroke: #12161c; stroke-width: 0.5; }
.stamp-text { font-size: 3.6px; font-weight: 700; letter-spacing: 0.12em; }
.tb-label { font-size: 1.7px; fill: #5b6675; letter-spacing: 0.06em; }
.tb-value { font-size: 2.4px; fill: #12161c; }
.tb-head { font-size: 1.9px; font-weight: 700; letter-spacing: 0.05em; }
.tb-cell { font-size: 2.05px; }
.tb-small { font-size: 1.8px; }
.note-text { font-size: 1.95px; fill: #3d4756; }
.compass-ring { fill: none; stroke: #12161c; stroke-width: 0.25; }
.compass-needle { fill: #12161c; }
.compass-label { font-size: 3px; font-weight: 700; }
${contentCss({ k, u: 0.24, symbol })}
</style>
<rect class="sheet-bg" x="0" y="0" width="${W}" height="${H}"/>
${rect(MARGIN, MARGIN, W - MARGIN * 2, H - MARGIN * 2, 'frame')}
${vline(dividerX, MARGIN, H - MARGIN, 'frame')}
<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${k.toFixed(6)})">${content}</g>
${compass(drawing, areaX + 16, areaY + 16, 5)}
${bom.svg}
${welds.svg}
${list.svg}
${notesSvg}
${stampBox(dividerX, stampY, col, stampH, sheetStamp(drawing))}
${titleBlock(drawing, dividerX, tbY, col, tbH)}
</svg>`;
}

import type { Analysis, BomLine } from '../model/drawing';
import type { Drawing } from '../model/types';
import { contentBounds, escapeText, renderDrawing } from './renderer';
import { axisScreenDir } from '../model/iso';
import { contentCss } from './style';

export type SheetSize = 'A4' | 'A3' | 'A2';

const SHEETS: Record<SheetSize, { w: number; h: number }> = {
  A4: { w: 297, h: 210 },
  A3: { w: 420, h: 297 },
  A2: { w: 594, h: 420 },
};

const MARGIN = 10;

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

function titleBlock(drawing: Drawing, x: number, y: number, w: number, h: number): string {
  const m = drawing.meta;
  let out = rect(x, y, w, h, 'block');
  const rows = 7;
  const rowH = h / rows;
  for (let i = 1; i < rows; i += 1) out += hline(x, x + w, y + rowH * i);

  const cell = (col: number, row: number, cols: number, label: string, value: string) => {
    const cw = w / cols;
    const cx = x + cw * col;
    const cy = y + rowH * row;
    let s = col > 0 ? vline(cx, cy, cy + rowH) : '';
    s += text(cx + 1.6, cy + rowH * 0.4, label, 'tb-label');
    s += text(cx + 1.6, cy + rowH * 0.85, clip(value || '—', Math.floor(cw / 1.5)), 'tb-value');
    return s;
  };

  out += text(x + 1.6, y + rowH * 0.62, clip(m.project || 'PIPING ISOMETRIC', Math.floor(w / 1.8)), 'tb-title');
  out += cell(0, 1, 2, 'CLIENT', m.client);
  out += cell(1, 1, 2, 'SERVICE', m.service);
  out += cell(0, 2, 1, 'LINE NUMBER', m.lineNumber);
  out += cell(0, 3, 2, 'PIPING SPEC', m.spec);
  out += cell(1, 3, 2, 'MATERIAL', m.material);
  out += cell(0, 4, 3, 'INSULATION', m.insulation);
  out += cell(1, 4, 3, 'PWHT', m.pwht);
  out += cell(2, 4, 3, 'NDT', m.ndt);
  out += cell(0, 5, 3, 'DESIGN PRESS.', m.designPressure);
  out += cell(1, 5, 3, 'DESIGN TEMP.', m.designTemp);
  out += cell(2, 5, 3, 'TEST PRESS.', m.testPressure);
  out += cell(0, 6, 5, 'DRAWN', m.drawnBy);
  out += cell(1, 6, 5, 'CHECKED', m.checkedBy);
  out += cell(2, 6, 5, 'DATE', m.date);
  out += cell(3, 6, 5, 'DWG No.', m.drawingNo);
  out += cell(4, 6, 5, 'SH / REV', `${m.sheet} / ${m.revision}`);
  return out;
}

function bomTable(bom: BomLine[], x: number, y: number, w: number, maxRows: number): { svg: string; height: number } {
  const rowH = 4.6;
  const headH = 5.4;
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
  out += text(xs[3] + 1.2, y + headH * 0.72, 'SCH', 'tb-head');
  out += text(xs[4] + 1.2, y + headH * 0.72, 'QTY', 'tb-head');

  shown.forEach((line, i) => {
    const ry = y + headH + rowH * i;
    if (i > 0) out += hline(x, x + w, ry, 'rule-faint');
    const ty = ry + rowH * 0.7;
    out += text(xs[0] + 1.2, ty, String(i + 1), 'tb-cell');
    out += text(xs[1] + 1.2, ty, clip(line.description, Math.floor((w * cols[1]) / 1.35)), 'tb-cell');
    out += text(xs[2] + 1.2, ty, line.dn, 'tb-cell');
    out += text(xs[3] + 1.2, ty, line.category === 'PIPE' ? line.schedule : '—', 'tb-cell');
    out += text(xs[4] + 1.2, ty, quantityText(line), 'tb-cell');
  });

  if (shown.length === 0) {
    out += text(xs[1] + 1.2, y + headH + rowH * 0.7, 'No items', 'tb-cell');
  }
  return { svg: out, height: h };
}

function weldTable(analysis: Analysis, x: number, y: number, w: number): { svg: string; height: number } {
  const groups = new Map<string, { dn: string; shop: number; field: number }>();
  for (const weld of analysis.welds) {
    const g = groups.get(weld.dn) ?? { dn: weld.dn, shop: 0, field: 0 };
    if (weld.type === 'FIELD') g.field += 1;
    else g.shop += 1;
    groups.set(weld.dn, g);
  }
  const rows = [...groups.values()];
  const rowH = 4.6;
  const headH = 5.4;
  const h = headH * 2 + rowH * Math.max(rows.length, 1);

  let out = rect(x, y, w, h, 'block');
  out += text(x + 1.2, y + headH * 0.72, 'WELD SUMMARY', 'tb-head');
  out += hline(x, x + w, y + headH, 'rule-strong');
  out += hline(x, x + w, y + headH * 2, 'rule');

  const cols = [0.4, 0.2, 0.2, 0.2];
  const xs: number[] = [];
  let acc = x;
  for (const c of cols) {
    xs.push(acc);
    acc += w * c;
  }
  for (let i = 1; i < xs.length; i += 1) out += vline(xs[i], y + headH, y + h);

  const hy = y + headH * 1.72;
  out += text(xs[0] + 1.2, hy, 'SIZE', 'tb-head');
  out += text(xs[1] + 1.2, hy, 'SHOP', 'tb-head');
  out += text(xs[2] + 1.2, hy, 'FIELD', 'tb-head');
  out += text(xs[3] + 1.2, hy, 'TOTAL', 'tb-head');

  rows.forEach((row, i) => {
    const ry = y + headH * 2 + rowH * i;
    if (i > 0) out += hline(x, x + w, ry, 'rule-faint');
    const ty = ry + rowH * 0.7;
    out += text(xs[0] + 1.2, ty, row.dn, 'tb-cell');
    out += text(xs[1] + 1.2, ty, String(row.shop), 'tb-cell');
    out += text(xs[2] + 1.2, ty, String(row.field), 'tb-cell');
    out += text(xs[3] + 1.2, ty, String(row.shop + row.field), 'tb-cell');
  });
  if (rows.length === 0) out += text(xs[0] + 1.2, y + headH * 2 + rowH * 0.7, 'No welds', 'tb-cell');

  return { svg: out, height: h };
}

function compass(drawing: Drawing, cx: number, cy: number, r: number): string {
  const dir = axisScreenDir('N', drawing.options.northRotation);
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

/** Renders a complete, standalone drawing sheet. Units are millimetres. */
export function renderSheet(drawing: Drawing, analysis: Analysis, size: SheetSize = 'A3'): string {
  const { w: W, h: H } = SHEETS[size];
  const col = Math.min(190, W * 0.44);
  const dividerX = W - MARGIN - col;
  const areaX = MARGIN;
  const areaY = MARGIN;
  const areaW = dividerX - MARGIN - 5;
  const areaH = H - MARGIN * 2;

  // Fit the drawing into the available area.
  const bounds = contentBounds(drawing, analysis);
  const pad = 14;
  const contentW = Math.max(bounds.maxX - bounds.minX, 1);
  const contentH = Math.max(bounds.maxY - bounds.minY, 1);
  const k = Math.min((areaW - pad * 2) / contentW, (areaH - pad * 2) / contentH);
  const tx = areaX + areaW / 2 - ((bounds.minX + bounds.maxX) / 2) * k;
  const ty = areaY + areaH / 2 - ((bounds.minY + bounds.maxY) / 2) * k;

  const view = {
    x: (areaX - tx) / k,
    y: (areaY - ty) / k,
    w: areaW / k,
    h: areaH / k,
  };

  const content = renderDrawing({
    drawing: { ...drawing, options: { ...drawing.options, showGrid: false } },
    analysis,
    view,
    selection: null,
    symbolSize: 2.6 / k,
  });

  // Right hand column: bill of materials, weld summary, title block.
  const tbH = 56;
  const tbY = H - MARGIN - tbH;
  const bom = bomTable(analysis.bom, dividerX, MARGIN, col, Math.floor((tbY - MARGIN - 40) / 4.6));
  const welds = weldTable(analysis, dividerX, MARGIN + bom.height + 4, col);

  const notes = [
    'ALL DIMENSIONS IN MILLIMETRES.',
    drawing.options.schematic ? 'DRAWING NOT TO SCALE.' : 'DRAWING PROPORTIONAL, DIMENSIONS GOVERN.',
    'DIMENSIONS ARE CENTRE TO CENTRE UNLESS NOTED.',
  ];

  const noteY = tbY - 4 - notes.length * 3.6;
  let notesSvg = '';
  notes.forEach((n, i) => {
    notesSvg += text(dividerX, noteY + i * 3.6, n, 'note-text');
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
.tb-title { font-size: 4.2px; font-weight: 700; letter-spacing: 0.04em; }
.tb-label { font-size: 1.9px; fill: #5b6675; letter-spacing: 0.06em; }
.tb-value { font-size: 2.7px; fill: #12161c; }
.tb-head { font-size: 2.1px; font-weight: 700; letter-spacing: 0.05em; }
.tb-cell { font-size: 2.3px; }
.note-text { font-size: 2.2px; fill: #3d4756; }
.compass-ring { fill: none; stroke: #12161c; stroke-width: 0.25; }
.compass-needle { fill: #12161c; }
.compass-label { font-size: 3px; font-weight: 700; }
${contentCss({ k, u: 0.24 })}
</style>
<rect class="sheet-bg" x="0" y="0" width="${W}" height="${H}"/>
${rect(MARGIN, MARGIN, W - MARGIN * 2, H - MARGIN * 2, 'frame')}
${vline(dividerX, MARGIN, H - MARGIN, 'frame')}
<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${k.toFixed(6)})">${content}</g>
${compass(drawing, areaX + 16, areaY + 16, 5)}
${bom.svg}
${welds.svg}
${notesSvg}
${titleBlock(drawing, dividerX, tbY, col, tbH)}
</svg>`;
}

/**
 * Renders every symbol the app draws onto one reference sheet, straight from
 * the drawing code, so the sheet can never disagree with the drawing.
 *
 *   node scripts/symbol-sheet.mjs   ->  dist/symbols.svg
 */
import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/render/symbols.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/_symbols.mjs',
  logLevel: 'silent',
});
const { componentSymbol, terminalSymbol, weldSymbol } = await import('../dist/_symbols.mjs');

const COMPONENTS = [
  ['GATE', 'Gate valve'],
  ['GLOBE', 'Globe valve'],
  ['BALL', 'Ball valve'],
  ['CHECK', 'Check valve'],
  ['BUTTERFLY', 'Butterfly valve'],
  ['PLUG', 'Plug valve'],
  ['NEEDLE', 'Needle valve'],
  ['CONTROL', 'Control valve'],
  ['RELIEF', 'Relief valve'],
  ['FLG_WN', 'Weld neck flange pair'],
  ['FLG_SO', 'Slip-on flange pair'],
  ['FLG_BLIND', 'Blind flange'],
  ['SPECTACLE', 'Spectacle blind'],
  ['RED_CONC', 'Concentric reducer'],
  ['RED_ECC', 'Eccentric reducer'],
  ['UNION', 'Union'],
  ['STRAINER', 'Strainer'],
  ['INSTRUMENT', 'Instrument'],
  ['SUPPORT', 'Support'],
  ['ANCHOR', 'Anchor'],
  ['GUIDE', 'Guide'],
];

const TERMINALS = [
  ['FLG_WN', 'End: weld neck flange'],
  ['FLG_SO', 'End: slip-on flange'],
  ['FLG_BLIND', 'End: blind flange'],
  ['CAP', 'End: cap'],
  ['CONTINUATION', 'End: continuation'],
  ['EQUIPMENT', 'End: equipment'],
];

const CELL_W = 190;
const CELL_H = 150;
const COLS = 5;
const S = 15;

const frame = (cx, cy) => ({ cx, cy, dx: 1, dy: 0, nx: 0, ny: 1, s: S });

function cell(col, row, label, inner, pipe) {
  const x = col * CELL_W;
  const y = row * CELL_H;
  const cx = x + CELL_W / 2;
  const cy = y + CELL_H / 2 - 8;
  return `<g transform="translate(0 0)">
    <rect class="cell" x="${x + 6}" y="${y + 6}" width="${CELL_W - 12}" height="${CELL_H - 12}" rx="6"/>
    ${pipe(cx, cy)}
    ${inner(cx, cy)}
    <text class="cap" x="${cx}" y="${y + CELL_H - 20}">${label}</text>
  </g>`;
}

const fullPipe = (cx, cy) =>
  `<line class="pipe" x1="${cx - 62}" y1="${cy}" x2="${cx + 62}" y2="${cy}"/>`;
const halfPipe = (cx, cy) => `<line class="pipe" x1="${cx - 62}" y1="${cy}" x2="${cx}" y2="${cy}"/>`;

const cells = [];
let index = 0;
const push = (label, inner, pipe = fullPipe) => {
  cells.push(cell(index % COLS, Math.floor(index / COLS), label, inner, pipe));
  index += 1;
};

for (const [kind, label] of COMPONENTS) {
  push(label, (cx, cy) => componentSymbol(kind, frame(cx, cy)));
}
for (const [kind, label] of TERMINALS) {
  push(label, (cx, cy) => terminalSymbol(kind, frame(cx, cy)), halfPipe);
}
push('Shop weld', (cx, cy) => weldSymbol(frame(cx, cy), false));
push('Field weld', (cx, cy) => weldSymbol(frame(cx, cy), true));

// Fittings are drawn as the route's own geometry, not as a placed symbol.
const corner = (cx, cy, dx, dy) =>
  `<polyline class="pipe" points="${cx - 58},${cy + 24} ${cx},${cy + 24} ${cx + dx},${cy + dy}" fill="none"/>`;
push('90° elbow (route corner)', () => '', (cx, cy) => corner(cx, cy, 0, -46));
push('45° elbow (route corner)', () => '', (cx, cy) => corner(cx, cy, 42, -42));
push(
  'Equal tee (route branch)',
  () => '',
  (cx, cy) =>
    `<line class="pipe" x1="${cx - 58}" y1="${cy + 12}" x2="${cx + 58}" y2="${cy + 12}"/>` +
    `<line class="pipe" x1="${cx}" y1="${cy + 12}" x2="${cx}" y2="${cy - 34}"/>`,
);

const rows = Math.ceil(index / COLS);
const W = COLS * CELL_W;
const H = rows * CELL_H + 54;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<style>
text { font-family: "Helvetica Neue", Arial, sans-serif; }
.bg { fill: #ffffff; }
.cell { fill: #fbfcfe; stroke: #e2e7ef; stroke-width: 1; }
.cap { font-size: 12.5px; fill: #3d4756; text-anchor: middle; }
.head { font-size: 17px; font-weight: 700; fill: #12161c; }
.sub { font-size: 12.5px; fill: #5f6b7d; }
.pipe { stroke: #12161c; stroke-width: 3; stroke-linecap: round; fill: none; }
.sym-line { stroke: #12161c; stroke-width: 2.2; fill: none; stroke-linecap: round; }
.sym-heavy { stroke: #12161c; stroke-width: 4.4; fill: none; }
.sym-fill { fill: #ffffff; stroke: #12161c; stroke-width: 2.2; }
.sym-hollow { fill: none; stroke: #12161c; stroke-width: 2.2; }
.sym-solid { fill: #12161c; stroke: #12161c; stroke-width: 1.4; }
.weld-shop { fill: #ffffff; stroke: #12161c; stroke-width: 2; }
.weld-field { fill: #12161c; stroke: #12161c; stroke-width: 1.4; }
.weld-tick { stroke: #12161c; stroke-width: 2; }
</style>
<rect class="bg" x="0" y="0" width="${W}" height="${H}"/>
<text class="head" x="14" y="26">Symbol reference — as currently drawn</text>
<text class="sub" x="14" y="44">Flow is left to right. Mark up anything that does not match your practice.</text>
<g transform="translate(0 54)">${cells.join('')}</g>
</svg>`;

await writeFile('dist/symbols.svg', svg);
console.log(`dist/symbols.svg  ${rows} rows, ${index} symbols`);

/**
 * Renders every symbol the app draws onto one reference sheet, straight from
 * the drawing code, so the sheet can never disagree with the drawing.
 *
 * Fittings are laid out the way a fitting legend normally is: one row per
 * fitting, one column per joint type, because the joint is what changes the
 * mark at each end.
 *
 *   node scripts/symbol-sheet.mjs   ->  reference/symbols.svg
 */
import { build } from 'esbuild';
import { writeFile, mkdir, rm } from 'node:fs/promises';

// Kept out of dist/, which every build empties.
await mkdir('reference', { recursive: true });
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/render/symbols.ts'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/_symbols.mjs',
  logLevel: 'silent',
});
const { componentSymbol, terminalSymbol, jointMark, flangeSymbol, capSymbol } = await import(
  '../dist/_symbols.mjs'
);

const S = 13;
const T = 30; // take-out: how far the mark sits from the fitting centre
const JOINTS = ['BW', 'SW', 'THD'];
const JOINT_TITLE = { BW: 'Butt weld', SW: 'Socket weld', THD: 'Threaded' };

const frame = (x, y, dx, dy, s = S) => ({ cx: x, cy: y, dx, dy, nx: -dy, ny: dx, s });
const pipe = (x1, y1, x2, y2) =>
  `<line class="pipe" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;

/* --------------------------------------------------------------- fittings */

/** Each returns the drawing for one cell, centred on (cx, cy). */
const FITTINGS = [
  [
    'Elbow 90°',
    (cx, cy, j) => {
      const x = cx - 6;
      const y = cy + 26;
      return (
        pipe(x - 72, y, x, y) +
        pipe(x, y, x, y - 76) +
        jointMark(frame(x - T, y, 1, 0), j, false, 1) +
        jointMark(frame(x, y - T, 0, 1), j, false, 1)
      );
    },
  ],
  [
    'Elbow 45°',
    (cx, cy, j) => {
      const x = cx - 20;
      const y = cy + 26;
      const k = Math.SQRT1_2;
      return (
        pipe(x - 66, y, x, y) +
        pipe(x, y, x + 66 * k, y - 66 * k) +
        jointMark(frame(x - T, y, 1, 0), j, false, 1) +
        jointMark(frame(x + T * k, y - T * k, -k, k), j, false, 1)
      );
    },
  ],
  [
    'Tee equal',
    (cx, cy, j) => {
      const y = cy + 22;
      return (
        pipe(cx - 74, y, cx + 74, y) +
        pipe(cx, y, cx, y - 66) +
        jointMark(frame(cx - T, y, 1, 0), j, false, 1) +
        jointMark(frame(cx + T, y, -1, 0), j, false, 1) +
        jointMark(frame(cx, y - T, 0, 1), j, false, 1)
      );
    },
  ],
  [
    'Tee reducing',
    (cx, cy, j) => {
      const y = cy + 22;
      const tri =
        j === 'BW'
          ? `<polygon class="fitting-body" points="${cx - T},${y} ${cx + T},${y} ${cx},${y - T}"/>`
          : '';
      return (
        pipe(cx - 74, y, cx + 74, y) +
        pipe(cx, y, cx, y - 66) +
        tri +
        jointMark(frame(cx - T, y, 1, 0), j, false, 1) +
        jointMark(frame(cx + T, y, -1, 0), j, false, 1) +
        jointMark(frame(cx, y - T, 0, 1), j, false, 1)
      );
    },
  ],
  [
    'Cap',
    (cx, cy, j) => {
      const x = cx + 4;
      const body = j === 'BW' ? capSymbol(frame(x, cy, 1, 0), 1) : '';
      return pipe(x - 82, cy, x, cy) + body + jointMark(frame(x, cy, 1, 0), j, false, 1);
    },
  ],
  [
    'Reducer concentric',
    (cx, cy, j) => {
      const w = 26;
      return (
        pipe(cx - 82, cy, cx + 82, cy) +
        componentSymbol('RED_CONC', frame(cx, cy, 1, 0, 22)) +
        jointMark(frame(cx - w, cy, 1, 0), j, false, 1) +
        jointMark(frame(cx + w, cy, -1, 0), j, false, 1)
      );
    },
  ],
  [
    'Reducer eccentric',
    (cx, cy, j) => {
      const w = 26;
      return (
        pipe(cx - 82, cy, cx + 82, cy) +
        componentSymbol('RED_ECC', frame(cx, cy, 1, 0, 22)) +
        jointMark(frame(cx - w, cy, 1, 0), j, false, 1) +
        jointMark(frame(cx + w, cy, -1, 0), j, false, 1)
      );
    },
  ],
];

const FLANGES = [
  ['FLG_WN', 'Welding neck'],
  ['FLG_SO', 'Slip-on'],
  ['FLG_SW', 'Socket weld'],
  ['FLG_THD', 'Threaded'],
  ['FLG_LAP', 'Lap joint'],
  ['FLG_BLIND', 'Blind'],
];

const VALVES = [
  ['GATE', 'Gate valve'],
  ['GLOBE', 'Globe valve'],
  ['BALL', 'Ball valve'],
  ['CHECK', 'Check valve'],
  ['BUTTERFLY', 'Butterfly valve'],
  ['PLUG', 'Plug valve'],
  ['NEEDLE', 'Needle valve'],
  ['CONTROL', 'Control valve'],
  ['RELIEF', 'Relief valve'],
  ['STRAINER', 'Strainer'],
  ['SPECTACLE', 'Spectacle blind'],
  ['UNION', 'Union'],
  ['INSTRUMENT', 'Instrument'],
  ['SUPPORT', 'Support'],
  ['ANCHOR', 'Anchor'],
  ['GUIDE', 'Guide'],
];

const ENDS = [
  ['CONTINUATION', 'Continuation'],
  ['EQUIPMENT', 'Equipment nozzle'],
];

/* ----------------------------------------------------------------- layout */

const CELL_W = 210;
const CELL_H = 140;
const LABEL_W = 170;
const PAD = 16;

let y = 0;
const parts = [];

function sectionTitle(text, sub) {
  parts.push(`<text class="head" x="${PAD}" y="${y + 20}">${text}</text>`);
  if (sub) parts.push(`<text class="sub" x="${PAD}" y="${y + 38}">${sub}</text>`);
  y += sub ? 52 : 34;
}

function cellBox(x, top, w = CELL_W) {
  return `<rect class="cell" x="${x + 4}" y="${top + 4}" width="${w - 8}" height="${CELL_H - 8}" rx="6"/>`;
}

// Fittings: rows of fitting, columns of joint type.
sectionTitle('Fittings', 'One row per fitting, one column per joint. Butt weld is a filled dot.');
JOINTS.forEach((j, col) => {
  parts.push(
    `<text class="colhead" x="${PAD + LABEL_W + col * CELL_W + CELL_W / 2}" y="${y + 2}">${JOINT_TITLE[j]}</text>`,
  );
});
y += 14;
for (const [label, draw] of FITTINGS) {
  parts.push(`<text class="rowhead" x="${PAD}" y="${y + CELL_H / 2 + 5}">${label}</text>`);
  JOINTS.forEach((j, col) => {
    const x = PAD + LABEL_W + col * CELL_W;
    parts.push(cellBox(x, y) + draw(x + CELL_W / 2, y + CELL_H / 2, j));
  });
  y += CELL_H;
}
y += 18;

// A simple grid section.
function grid(title, sub, items, render, cols = 4) {
  sectionTitle(title, sub);
  items.forEach(([kind, label], i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = PAD + col * CELL_W;
    const top = y + row * CELL_H;
    parts.push(
      cellBox(x, top) +
        render(kind, x + CELL_W / 2, top + CELL_H / 2 - 8) +
        `<text class="cap" x="${x + CELL_W / 2}" y="${top + CELL_H - 18}">${label}</text>`,
    );
  });
  y += Math.ceil(items.length / cols) * CELL_H + 18;
}

grid(
  'Flanges',
  'Drawn as a single flange; a flanged joint in the drawing shows a mating pair.',
  FLANGES,
  (kind, cx, cy) =>
    pipe(cx - 76, cy, cx, cy) +
    flangeSymbol(frame(cx, cy, 1, 0), kind, 1) +
    (kind === 'FLG_WN' || kind === 'FLG_LAP'
      ? jointMark(frame(cx, cy, 1, 0), 'BW', false, 1)
      : ''),
);

grid('Valves and items', 'Unchanged from before.', VALVES, (kind, cx, cy) =>
  pipe(cx - 78, cy, cx + 78, cy) + componentSymbol(kind, frame(cx, cy, 1, 0)),
);

grid('Line ends', null, ENDS, (kind, cx, cy) =>
  pipe(cx - 76, cy, cx, cy) + terminalSymbol(kind, frame(cx, cy, 1, 0)),
);

grid(
  'Joint marks',
  'A field joint carries the weld flag; the mark itself still says how it is made.',
  [
    ['BW', 'Butt weld — shop'],
    ['BW_FIELD', 'Butt weld — field'],
    ['SW', 'Socket weld'],
    ['THD', 'Threaded (not a weld)'],
  ],
  (kind, cx, cy) =>
    pipe(cx - 78, cy, cx + 78, cy) +
    jointMark(frame(cx, cy, 1, 0), kind === 'BW_FIELD' ? 'BW' : kind, kind === 'BW_FIELD', 1),
);

// Wide enough for the fitting table and for the widest plain grid below it.
const W = Math.max(PAD * 2 + LABEL_W + CELL_W * JOINTS.length, PAD * 2 + CELL_W * 4);
const H = y + 10;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<style>
text { font-family: "Helvetica Neue", Arial, sans-serif; }
.bg { fill: #ffffff; }
.cell { fill: #fbfcfe; stroke: #e2e7ef; stroke-width: 1; }
.cap { font-size: 13px; fill: #3d4756; text-anchor: middle; }
.rowhead { font-size: 14px; font-weight: 600; fill: #12161c; }
.colhead { font-size: 12px; font-weight: 700; fill: #5f6b7d; text-anchor: middle; letter-spacing: 0.04em; }
.head { font-size: 19px; font-weight: 700; fill: #12161c; }
.sub { font-size: 13px; fill: #5f6b7d; }
.pipe { stroke: #12161c; stroke-width: 2.6; stroke-linecap: round; fill: none; }
.fitting-body { fill: none; stroke: #12161c; stroke-width: 2.4; }
.sym-line { stroke: #12161c; stroke-width: 2.2; fill: none; stroke-linecap: round; }
.sym-heavy { stroke: #12161c; stroke-width: 4.2; fill: none; }
.sym-face { stroke: #12161c; stroke-width: 3; fill: none; stroke-linecap: round; }
.sym-fill { fill: #ffffff; stroke: #12161c; stroke-width: 2.2; }
.sym-hollow { fill: none; stroke: #12161c; stroke-width: 2.2; }
.sym-solid { fill: #12161c; stroke: #12161c; stroke-width: 1.4; }
.joint-bw { fill: #12161c; stroke: #12161c; stroke-width: 1; }
</style>
<rect class="bg" x="0" y="0" width="${W}" height="${H}"/>
${parts.join('')}
</svg>`;

await writeFile('reference/symbols.svg', svg);
await rm('dist/_symbols.mjs', { force: true });
console.log(`reference/symbols.svg  ${W} x ${H}`);

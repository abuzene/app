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

const S = 12;
const T = 30; // take-out: how far the mark sits from the fitting centre
const JOINTS = ['BW', 'SW', 'THD'];
const JOINT_TITLE = { BW: 'Butt weld', SW: 'Socket weld', THD: 'Threaded' };

// The legend is drawn on real isometric axes, exactly as the drawing is, so a
// symbol here is the same symbol there.
const COS30 = Math.cos(Math.PI / 6);
const EAST = { x: COS30, y: 0.5 };
const NORTH = { x: COS30, y: -0.5 };
const UP = { x: 0, y: -1 };
const neg = (d) => ({ x: -d.x, y: -d.y });

/** A frame running along `dir`, drawn in the vertical plane through the pipe. */
const frame = (x, y, dir, s = S, across = NORTH, up = UP) => ({
  cx: x,
  cy: y,
  dx: dir.x,
  dy: dir.y,
  nx: across.x,
  ny: across.y,
  ux: up.x,
  uy: up.y,
  s,
});

const seg = (x, y, dir, from, to, cls = 'pipe') =>
  `<line class="${cls}" x1="${(x + dir.x * from).toFixed(1)}" y1="${(y + dir.y * from).toFixed(1)}" ` +
  `x2="${(x + dir.x * to).toFixed(1)}" y2="${(y + dir.y * to).toFixed(1)}"/>`;

/* --------------------------------------------------------------- fittings */

/** Each returns the drawing for one cell, centred on (cx, cy). */
const FITTINGS = [
  [
    'Elbow 90\u00b0',
    (cx, cy, j) => {
      const x = cx - 12;
      const y = cy + 22;
      return (
        seg(x, y, EAST, -76, 0) +
        seg(x, y, UP, 0, 70) +
        jointMark(frame(x - EAST.x * T, y - EAST.y * T, EAST), j, 1) +
        jointMark(frame(x + UP.x * T, y + UP.y * T, neg(UP)), j, 1)
      );
    },
  ],
  [
    'Elbow 45\u00b0',
    (cx, cy, j) => {
      const x = cx - 16;
      const y = cy + 20;
      const mid = { x: (EAST.x + UP.x) / Math.hypot(EAST.x + UP.x, EAST.y + UP.y), y: (EAST.y + UP.y) / Math.hypot(EAST.x + UP.x, EAST.y + UP.y) };
      return (
        seg(x, y, EAST, -70, 0) +
        seg(x, y, mid, 0, 66) +
        jointMark(frame(x - EAST.x * T, y - EAST.y * T, EAST), j, 1) +
        jointMark(frame(x + mid.x * T, y + mid.y * T, neg(mid)), j, 1)
      );
    },
  ],
  [
    'Tee equal',
    (cx, cy, j) => {
      const y = cy + 18;
      return (
        seg(cx, y, EAST, -72, 72) +
        seg(cx, y, UP, 0, 62) +
        jointMark(frame(cx - EAST.x * T, y - EAST.y * T, EAST), j, 1) +
        jointMark(frame(cx + EAST.x * T, y + EAST.y * T, neg(EAST)), j, 1) +
        jointMark(frame(cx + UP.x * T, y + UP.y * T, neg(UP)), j, 1)
      );
    },
  ],
  [
    'Tee reducing',
    (cx, cy, j) => {
      const y = cy + 18;
      return (
        seg(cx, y, EAST, -72, 72) +
        seg(cx, y, UP, 0, 62) +
        jointMark(frame(cx - EAST.x * T, y - EAST.y * T, EAST), j, 1) +
        jointMark(frame(cx + EAST.x * T, y + EAST.y * T, neg(EAST)), j, 1) +
        jointMark(frame(cx + UP.x * T, y + UP.y * T, neg(UP)), j, 1) +
        `<text class="note" x="${(cx + 12).toFixed(1)}" y="${(y - 44).toFixed(1)}">6"X3" NS</text>`
      );
    },
  ],
  [
    'Cap',
    (cx, cy, j) => {
      const x = cx + 18;
      const y = cy + 12;
      const body = j === 'BW' ? capSymbol(frame(x, y, EAST), 1) : '';
      return seg(x, y, EAST, -80, 0) + body + jointMark(frame(x, y, EAST), j, 1);
    },
  ],
  [
    'Reducer concentric',
    (cx, cy, j) => {
      const w = 26;
      return (
        seg(cx, cy, EAST, -80, 80) +
        componentSymbol('RED_CONC', frame(cx, cy, EAST, 20)) +
        jointMark(frame(cx - EAST.x * w, cy - EAST.y * w, EAST), j, 1) +
        jointMark(frame(cx + EAST.x * w, cy + EAST.y * w, neg(EAST)), j, 1)
      );
    },
  ],
  [
    'Reducer eccentric',
    (cx, cy, j) => {
      const w = 26;
      return (
        seg(cx, cy, EAST, -80, 80) +
        componentSymbol('RED_ECC', frame(cx, cy, EAST, 20)) +
        jointMark(frame(cx - EAST.x * w, cy - EAST.y * w, EAST), j, 1) +
        jointMark(frame(cx + EAST.x * w, cy + EAST.y * w, neg(EAST)), j, 1)
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
  ['SUPPORT_L', 'Support, L50 angle with clamp'],
  ['GROUND', 'AG/UG ground mark'],
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
    seg(cx, cy, EAST, -76, 0) +
    flangeSymbol(frame(cx, cy, EAST), kind, 1) +
    (kind === 'FLG_WN' || kind === 'FLG_LAP' ? jointMark(frame(cx, cy, EAST), 'BW', 1) : ''),
);

grid('Valves and items', 'Drawn on the pipe, as they are on the sheet.', VALVES, (kind, cx, cy) =>
  seg(cx, cy, EAST, -78, 78) + componentSymbol(kind, frame(cx, cy, EAST)),
);

grid('Line ends', null, ENDS, (kind, cx, cy) =>
  seg(cx, cy, EAST, -76, 0) + terminalSymbol(kind, frame(cx, cy, EAST)),
);

grid(
  'Joint marks',
  'The mark says how the joint is made. A threaded joint is marked but is not a weld.',
  [
    ['BW', 'Butt weld'],
    ['SW', 'Socket weld'],
    ['THD', 'Threaded (not a weld)'],
  ],
  (kind, cx, cy) => seg(cx, cy, EAST, -78, 78) + jointMark(frame(cx, cy, EAST), kind, 1),
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
.note { fill: #12161c; font-size: 12px; }
</style>
<rect class="bg" x="0" y="0" width="${W}" height="${H}"/>
${parts.join('')}
</svg>`;

await writeFile('reference/symbols.svg', svg);
await rm('dist/_symbols.mjs', { force: true });
console.log(`reference/symbols.svg  ${W} x ${H}`);

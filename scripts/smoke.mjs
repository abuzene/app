/**
 * Smoke test: drives the built app in a real browser and checks that routing,
 * editing, the take-off tables and export all still work.
 *
 * Run `npm run build` first, then `npm run smoke`.
 */
import { chromium } from 'playwright';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeDrive } from './fake-drive.mjs';

const APP = `file://${process.cwd()}/dist/index.html`;
const out = await mkdtemp(join(tmpdir(), 'iso-smoke-'));

const failures = [];
const check = (label, actual, predicate, expectation) => {
  const ok = predicate(actual);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : `  (expected ${expectation})`}`);
  if (!ok) failures.push(label);
};

// The environment ships its own Chromium; fall back to it when the bundled
// build is not the one Playwright expects.
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOptions = existsSync(executablePath) ? { executablePath } : {};
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });

const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(APP);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForTimeout(400);

/** Clears the drawing, answering the in-page confirmation if it appears. */
async function startNewDrawing() {
  await page.click('#new');
  await page.waitForTimeout(250);
  const confirmButton = page.locator('.dialog-backdrop [data-confirm]');
  if (await confirmButton.count()) {
    await confirmButton.click();
  }
  await page.waitForTimeout(400);
}

check('empty hint shown on a blank drawing', await page.locator('#empty-hint').isVisible(), (v) => v === true, 'true');

// Route the example line through the command language.
await page.click('[data-a="load-sample"]');
await page.waitForTimeout(500);

const drawn = await page.evaluate(() => ({
  pipes: document.querySelectorAll('#canvas line.pipe').length,
  joints: document.querySelectorAll('#canvas .joint-bw').length,
  dims: document.querySelectorAll('#canvas .dim').length,
  components: document.querySelectorAll('#canvas .component').length,
}));
check('example line draws pipe runs', drawn.pipes, (v) => v === 5, '5');
check('joint marks are drawn', drawn.joints, (v) => v > 10, 'more than 10');
// Five runs, and the flanged valve breaks its run into three: pipe, valve, pipe.
check('dimensions are drawn', drawn.dims, (v) => v === 9, '9');
check('inline components are drawn', drawn.components, (v) => v === 2, '2');
await page.screenshot({ path: join(out, '01-sample.png') });

// Bill of materials.
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(200);
check('bill of materials has lines', await page.locator('#tab-body tbody tr').count(), (v) => v >= 5, 'at least 5');
const bom = await page.locator('#tab-body').innerText();
check('take-off lists pipe', bom, (v) => /PIPE, SMLS/.test(v), 'a seamless pipe line');
check('sizes are written in inches', bom, (v) => /3"/.test(v) && !/DN80/.test(v), '3" and no DN80');
check('take-off lists elbows', bom, (v) => /90 ELBOW LR/.test(v), 'a 90 degree elbow line');
check('take-off lists the tee', bom, (v) => /EQUAL TEE/.test(v), 'an equal tee line');
check('take-off lists the ball valve', bom, (v) => /BALL VALVE/.test(v), 'a ball valve line');

// Weld schedule.
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(200);
const weldRows = await page.locator('#tab-body tbody tr').count();
check('weld schedule is populated', weldRows, (v) => v > 10, 'more than 10');
const weldNumbers = await page.locator('#tab-body [data-weld-no]').evaluateAll((els) => els.map((e) => e.value));
check('welds are numbered plainly', weldNumbers[0], (v) => v === 'W1', 'W1');
check('no shop or field column', await page.locator('#tab-body').innerText(), (v) => !/SHOP|FIELD/.test(v), 'neither word');

// Draw a run with the mouse.
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(200);
const before = await page.locator('#tab-body .run-list tbody tr').count();
// Pick a point that sits well inside the canvas so the drag has room.
const canvasBox = await page.locator('#canvas').boundingBox();
const handles = await page.locator('#canvas circle.hit-dot[data-node]').all();
// Dragging an end or a point along a line moves it; only a corner routes
// when dragged. So find an elbow, well inside the canvas, and drag from that.
let node = null;
for (const handle of handles) {
  const box = await handle.boundingBox();
  if (!box) continue;
  if (!(box.x > canvasBox.x + 40 && box.x + 220 < canvasBox.x + canvasBox.width && box.y + 160 < canvasBox.y + canvasBox.height)) continue;
  await handle.click({ force: true });
  await page.waitForTimeout(150);
  if (/ELBOW/.test(await page.locator('#tab-body').innerText())) {
    node = box;
    break;
  }
}
if (!node) throw new Error('no elbow available inside the canvas to drag from');
await page.click('#tab-body [data-a="draw-from"]');
await page.waitForTimeout(250);
await page.mouse.move(node.x + node.width / 2, node.y + node.height / 2);
await page.mouse.down();
await page.mouse.move(node.x + 170, node.y + 100, { steps: 14 });
await page.waitForTimeout(150);
const hud = (await page.locator('#hud').innerText()).replace(/\n/g, ' ');
await page.mouse.up();
await page.waitForTimeout(350);
check('drag preview reports a direction and length', hud, (v) => /^[NSEWUD] [\d,]+ mm/.test(v), 'e.g. "E 1,500 mm"');
check('dragging adds a run', await page.locator('#tab-body .run-list tbody tr').count(), (v) => v === before + 1, `${before + 1}`);
await page.screenshot({ path: join(out, '02-drawn.png') });

// Edit a dimension.
const lengthInput = page.locator('#tab-body .run-list input[data-run-len]').first();
await lengthInput.fill('3350');
await lengthInput.press('Enter');
await page.waitForTimeout(300);
check('a length can be typed', await page.locator('#tab-body .run-list input[data-run-len]').first().inputValue(), (v) => v === '3350', '3350');

// Palette.
await page.locator('#tab-body .run-list tbody tr').first().click();
await page.waitForTimeout(200);
check('the palette carries the fittings, ball valves, tee, olets, marks and a weld', await page.locator('.tool').count(), (v) => v === 18, '18');
check('and no slip-on or lap joint flange, which are not used here', await page.locator('.tool[data-kind="FLG_SO"], .tool[data-kind="FLG_LAP"]').count(), (v) => v === 0, '0');
check('a tee can be placed on a header', await page.locator('.tool[data-branch="TEE"]').count(), (v) => v === 1, '1');
check('the actuated ball valve is there', await page.locator('.tool[data-kind="BALL_ACT"]').count(), (v) => v === 1, '1');
await page.locator('.tool[data-kind="BALL"]').click();
await page.waitForTimeout(300);
const withBall = await page.locator('#canvas .component').count();
check('palette adds a component', withBall, (v) => v === 3, '3');

await page.click('#undo');
await page.waitForTimeout(250);
check('undo removes it', await page.locator('#canvas .component').count(), (v) => v === 2, '2');
await page.click('#redo');
await page.waitForTimeout(250);
check('redo restores it', await page.locator('#canvas .component').count(), (v) => v === 3, '3');

// Sheet orientation and not-to-scale mode.
await page.click('#rotate');
await page.check('#opt-schematic');
await page.waitForTimeout(350);
check('not-to-scale mode still draws', await page.locator('#canvas line.pipe').count(), (v) => v === 6, '6');
await page.screenshot({ path: join(out, '03-rotated-schematic.png') });
await page.uncheck('#opt-schematic');
for (let i = 0; i < 3; i += 1) await page.click('#rotate');
await page.waitForTimeout(300);

// Title block.
await page.click('#tabs button:has-text("Title")');
await page.waitForTimeout(200);
// Filling several fields in a row must not lose what was already typed.
await page.fill('[data-meta="lineNumber"]', '80-P-1201-A1A');
await page.fill('[data-meta="project"]', 'Smoke Test Plant');
await page.fill('[data-meta="drawnBy"]', 'AB');
await page.locator('[data-meta="drawnBy"]').blur();
await page.waitForTimeout(250);
check('title fields survive editing each other', await page.inputValue('[data-meta="lineNumber"]'), (v) => v === '80-P-1201-A1A', 'the line number');
check('a second title field is kept', await page.inputValue('[data-meta="project"]'), (v) => v === 'Smoke Test Plant', 'the project name');

// Print: the sheet is inspected through its preview, since the only output now
// is the printer dialog.
await page.click('#print');
await page.waitForTimeout(250);
await page.click('[data-x="preview"]');
await page.waitForTimeout(600);
const svg = await page.locator('.sheet-preview').innerHTML();
check('sheet is A3 landscape', svg, (v) => /viewBox="0 0 420 297"/.test(v), 'a 420x297 viewBox');
check('sheet carries the title block', svg, (v) => v.includes('Smoke Test Plant') && v.includes('80-P-1201-A1A'), 'the project name and line number');
check('sheet carries the AS MADE stamp', svg, (v) => v.includes('AS MADE'), 'an AS MADE stamp');
check('sheet carries the material list', svg, (v) => v.includes('DESCRIPTION'), 'a material list header');
check('sheet carries the weld list', svg, (v) => v.includes('WELDS'), 'a weld summary');
check('and under it every weld with the pipe at it as cut', svg, (v) => v.includes('WELD LIST') && v.includes('PIPE NET') && />W1<\/text>/.test(v) && /PIPE \/ WELD NECK FLANGE/.test(v), 'a WELD LIST — PIPE CUT table with W1');
check('the side column is a quarter of the sheet', svg, (v) => {
  const divider = Number(v.match(/<line class="frame" x1="([\d.]+)"/)?.[1] ?? 0);
  return divider >= 420 * 0.7;
}, 'a divider at or past 70% of the width');
check('sheet carries the company mark', svg, (v) => v.includes('PLATINUM') || v.includes('image'), 'a logo');
check('sheet states the units', svg, (v) => v.includes('ALL DIMENSIONS IN MILLIMETRES'), 'the millimetre note');
check('sheet has no design data on it', svg, (v) => !/DESIGN PRESS|PWHT|INSULATION/.test(v), 'none of the specification fields');
await page.click('[data-close]');
await page.waitForTimeout(250);

// Reload to prove the drawing persists.
await page.reload();
await page.waitForTimeout(500);
check('drawing survives a reload', await page.locator('#canvas line.pipe').count(), (v) => v === 6, '6');

// Routing back along an axis that already carries a run must reuse it rather
// than laying a second pipe on top of the first.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', 'DN50\nSTD\nORIGIN 0 0 0\nMARK o\nE 2000\nGOTO o\nE 800');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(400);
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(250);
const overlapRuns = await page.locator('#tab-body .run-list tbody tr').count();
check('re-routing along an existing run splits it instead of duplicating', overlapRuns, (v) => v === 2, '2');
const overlapLengths = await page.locator('#tab-body .run-list input[data-run-len]').evaluateAll((els) => els.map((e) => e.value));
check('the split lands at the right dimensions', overlapLengths.sort(), (v) => v.join('/') === '1200/800', '800 and 1200');
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(250);
const overlapBom = await page.locator('#tab-body').innerText();
check('no phantom bend is taken off', overlapBom, (v) => !/BEND/.test(v), 'no BEND line');

// Joint type drives every mark on the drawing and decides what counts as a weld.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', 'DN80\nSTD\nORIGIN 0 0 0\nE 2000\nN 1500\nEND CAP');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');

const dots = () => page.locator('#canvas .joint-bw').count();
const buttWeldDots = await dots();
check('butt welds are drawn as filled dots', buttWeldDots, (v) => v === 3, '3 — two elbow legs and one at the cap');
check('a butt welded cap shows its body', await page.locator('#canvas .node path.sym-fill').count(), (v) => v >= 1, 'at least 1');

await page.selectOption('#joint', 'SW');
await page.waitForTimeout(500);
check('switching to socket weld replaces every dot', await dots(), (v) => v === 0, '0');

await page.selectOption('#joint', 'THD');
await page.waitForTimeout(500);
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(300);
const threadedWelds = await page.locator('#tab-body').innerText();
check('threaded joints are not welds', threadedWelds, (v) => /Welds are generated/.test(v), 'an empty weld schedule');

await page.selectOption('#joint', 'BW');
await page.waitForTimeout(400);
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(300);
check('switching back restores the weld schedule', await page.locator('#tab-body tbody tr').count(), (v) => v === buttWeldDots, `${buttWeldDots}`);

// A branch of a different size is a reducing tee, drawn and taken off as one.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', 'DN80\nSTD\nORIGIN 0 0 0\nE 2000\nMARK t\nE 2000\nGOTO t\nDN50\nN 1500');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
check(
  'a reducing tee is called out by its sizes',
  await page.locator('#canvas .branch-note').evaluateAll((els) => els.map((e) => e.textContent)),
  (v) => v.some((t) => /3"X2" NS/.test(t ?? '')),
  '3"X2" NS beside the branch',
);
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(300);
check('the reducing tee is taken off with its branch size', await page.locator('#tab-body').innerText(), (v) => /REDUCING TEE 3" x 2"/.test(v), 'REDUCING TEE 3" x 2"');

// A flange picked against the end of a line terminates it; it must not land
// half way along the last run.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '3"\nSTD\nORIGIN 0 0 0\nE 2000');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');

// Select the far end of the line, then pick a weld neck flange.
const ends = await page.locator('#canvas circle.hit-dot[data-node]').all();
const endBoxes = [];
for (const h of ends) endBoxes.push({ h, box: await h.boundingBox() });
endBoxes.sort((a, b) => b.box.x - a.box.x);
await endBoxes[0].h.click();
await page.waitForTimeout(300);
await page.locator('.tool[data-kind="FLG_WN"]').click();
await page.waitForTimeout(400);
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(300);
const flangeBom = await page.locator('#tab-body').innerText();
check('a flange on the line end is taken off once', flangeBom, (v) => /WELD NECK FLANGE/.test(v), 'a weld neck flange');
// A flange leaves the route ready to carry on, so stop drawing before poking
// at the drawing again.
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(300);
const endHandles = await page.locator('#canvas circle.hit-dot[data-node]').all();
let farthest = null;
for (const handle of endHandles) {
  const box = await handle.boundingBox();
  if (box && (!farthest || box.x > farthest.box.x)) farthest = { handle, box };
}
await farthest.handle.click({ force: true });
await page.waitForTimeout(300);
check(
  'the flange became the end of the line, not a mid-run item',
  await page.locator('#tab-body [data-f="terminal"]').inputValue(),
  (v) => v === 'FLG_WN',
  'FLG_WN as the end type',
);

// Both panels fold away so the drawing can fill the screen.
const panelWidth = async () => (await page.locator('.panel').boundingBox()).width;
const beforeFold = await panelWidth();
await page.click('#wide');
await page.waitForTimeout(400);
check('wide mode gives the drawing the whole width', await panelWidth(), (v) => v < beforeFold, `less than ${Math.round(beforeFold)}`);
await page.click('#wide');
await page.waitForTimeout(400);

// An olet is welded to the header wall, so the header keeps its full length
// and the branch pays for the fitting.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '6"\nSTD\nORIGIN 0 0 0\nE 4000');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(300);

const headerCut = async () => {
  const cells = await page.locator('#tab-body .run-list tbody tr').all();
  let total = 0;
  for (const row of cells) {
    const size = await row.locator('td').nth(2).innerText();
    if (size !== '6"') continue;
    total += Number((await row.locator('td.num').last().innerText()).replace(/,/g, ''));
  }
  return total;
};
const cutBefore = await headerCut();
check('header starts at its full length', cutBefore, (v) => v === 4000, '4000');

await page.locator('#tab-body .run-list tbody tr').first().click();
await page.waitForTimeout(250);
await page.locator('.tool[data-olet="BW"]').click();
await page.waitForTimeout(500);
check('the header is still whole before the branch is drawn', await headerCut(), (v) => v === 4000, '4000');

// Route a 1" branch off the olet by clicking where it goes.
const oletHandle = await page.locator('#canvas .node.selected circle.hit-dot').boundingBox();
await page.selectOption('#dn', 'DN25');
await page.waitForTimeout(250);
await page.mouse.move(oletHandle.x + 130, oletHandle.y - 95, { steps: 10 });
await page.waitForTimeout(200);
await page.mouse.click(oletHandle.x + 130, oletHandle.y - 95);
await page.waitForTimeout(600);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

check('the olet saddle is drawn on the header', await page.locator('#canvas .olet').count(), (v) => v === 1, '1');
check('the header loses no length to the olet', await headerCut(), (v) => v === 4000, '4000');

await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(300);
const oletBom = await page.locator('#tab-body').innerText();
check('the olet is taken off with both sizes', oletBom, (v) => /WELDOLET 6" x 1"/.test(v), 'WELDOLET 6" x 1"');
check('no tee is taken off for the branch', oletBom, (v) => !/TEE/.test(v), 'no tee');

await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(300);
const oletWelds = await page.locator('#tab-body tbody tr').allInnerTexts();
check('a weldolet has two welds: header and branch', oletWelds.length, (v) => v === 2, '2');
check('one of them joins the header', oletWelds.join(' '), (v) => /HEADER \/ WELDOLET/.test(v), 'a header weld');
check('the other joins the branch', oletWelds.join(' '), (v) => /BRANCH \/ WELDOLET/.test(v), 'a branch weld');
check('the header weld shows the header whole: nothing off for the olet', oletWelds.find((r) => /HEADER/.test(r)) ?? '', (v) => /\t[A-Z]+ 4000$/.test(v), 'HEADER … A 4000');

// Switching the olet type changes the branch connection, not the header.
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(250);

// Find the olet by asking each point what it is, rather than by position.
// Selecting redraws the canvas, so each handle is looked up afresh.
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
let oletFound = false;
const pointCount = await page.locator('#canvas circle.hit-dot[data-node]').count();
for (let i = 0; i < pointCount; i += 1) {
  // Touched through the events themselves: a selection redraws the canvas
  // under a click, and the handle it was aimed at can be gone by the time
  // the click lands.
  const handle = page.locator('#canvas circle.hit-dot[data-node]').nth(i);
  const at = { bubbles: true, pointerId: 5, pointerType: 'mouse', button: 0, isPrimary: true };
  await handle.dispatchEvent('pointerdown', at);
  await page.waitForTimeout(60);
  await handle.dispatchEvent('pointerup', at);
  await page.waitForTimeout(250);
  const heading = await page.locator('#tab-body h3').first().innerText();
  if (/OLET/.test(heading)) {
    oletFound = true;
    break;
  }
}
check('the olet names itself in the point editor', oletFound, (v) => v === true, 'a point reading WELDOLET');

if (oletFound) {
  await page.locator('#tab-body [data-f="joint"]').selectOption('THD');
  await page.waitForTimeout(500);
  await page.click('#tabs button:has-text("Items")');
  await page.waitForTimeout(300);
  check('switching it makes it a threadolet', await page.locator('#tab-body').innerText(), (v) => /THREADOLET 6" x 1"/.test(v), 'THREADOLET 6" x 1"');
  await page.click('#tabs button:has-text("Welds")');
  await page.waitForTimeout(300);
  check(
    'a threadolet welds to the header only',
    await page.locator('#tab-body tbody tr').count(),
    (v) => v === 1,
    '1 — the threaded branch is not a weld',
  );
}

// A tee placed on a header, then branched, is taken off as a tee.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '6"\nSCH40\nORIGIN 0 0 0\nE 4000');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(300);
await page.locator('#tab-body .run-list tbody tr').first().click();
await page.waitForTimeout(250);
await page.locator('.tool[data-branch="TEE"]').click();
await page.waitForTimeout(450);
const teeHandle = await page.locator('#canvas .node.selected circle.hit-dot').boundingBox();
await page.selectOption('#dn', 'DN80');
await page.waitForTimeout(250);
await page.mouse.move(teeHandle.x + 130, teeHandle.y - 95, { steps: 10 });
await page.waitForTimeout(200);
await page.mouse.click(teeHandle.x + 130, teeHandle.y - 95);
await page.waitForTimeout(600);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(300);
const teeBom = await page.locator('#tab-body').innerText();
check('the tee is taken off with its branch size', teeBom, (v) => /REDUCING TEE 6" x 3"/.test(v), 'REDUCING TEE 6" x 3"');

// Pipe schedule and fitting thickness are recorded separately.
check('pipe carries its schedule', teeBom, (v) => /PIPE, SMLS, 6" x SCH40/.test(v), 'SCH40 pipe');
check('fittings carry their own thickness', teeBom, (v) => /REDUCING TEE[^\n]*STD/.test(v), 'STD fittings');

await page.click('#tabs button:has-text("Title")');
await page.waitForTimeout(300);
await page.locator('[data-f="pipesch"]').selectOption('SCH80');
await page.waitForTimeout(450);
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(300);
const schBom = await page.locator('#tab-body').innerText();
check('changing the pipe schedule carries to every run', schBom, (v) => /PIPE, SMLS, 6" x SCH80/.test(v), 'SCH80 pipe');
check('the fittings stay at their own thickness', schBom, (v) => /REDUCING TEE[^\n]*STD/.test(v), 'STD fittings');

// Valves come flanged over an inch and threaded under, without being asked.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '3"\nSCH40\nORIGIN 0 0 0\nE 3000\n+BALL');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(300);
const bigValve = (await page.locator('#tab-body').innerText()).replace(/\t/g, ' ');
check('a 3-inch valve is flanged', bigValve, (v) => /BALL VALVE/.test(v) && /WELD NECK FLANGE/.test(v), 'a valve and its flanges');
check('it brings a pair of flanges', bigValve, (v) => /WELD NECK FLANGE[^\n]* 2 /.test(v), '2 flanges');
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(300);
check('a flanged valve is welded in through its flanges', await page.locator('#tab-body tbody tr').count(), (v) => v === 2, '2');

await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '1"\nSCH40\nORIGIN 0 0 0\nE 3000\n+BALL');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(300);
const smallValve = await page.locator('#tab-body').innerText();
check('a 1-inch valve is threaded', smallValve, (v) => /BALL VALVE/.test(v) && !/FLANGE/.test(v), 'a valve and no flanges');
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(300);
check('a threaded valve takes no welds', await page.locator('#tab-body tbody tr').count(), (v) => v === 0, '0');

// Drawing is a continuous tool: touch once to put a point down, then keep
// clicking where the pipe goes.
await startNewDrawing();
const canvasArea = await page.locator('#canvas').boundingBox();
await page.mouse.click(canvasArea.x + canvasArea.width * 0.35, canvasArea.y + canvasArea.height * 0.5);
await page.waitForTimeout(500);
check('the first touch puts a point down', await page.locator('#canvas circle.hit-dot[data-node]').count(), (v) => v === 1, '1');
check('and the app says it is drawing', await page.locator('#hud').innerText(), (v) => /click where the pipe goes|drawing/.test(v), 'a drawing prompt');

for (const [dx, dy] of [[210, 120], [0, -150], [190, 110]]) {
  const anchor = await page.locator('#canvas .node.selected circle.hit-dot').boundingBox();
  const tx = anchor.x + anchor.width / 2 + dx;
  const ty = anchor.y + anchor.height / 2 + dy;
  await page.mouse.move(tx, ty, { steps: 6 });
  await page.waitForTimeout(160);
  await page.mouse.click(tx, ty);
  await page.waitForTimeout(400);
}
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(250);
check('each click after that adds a run', await page.locator('#tab-body .run-list tbody tr').count(), (v) => v === 3, '3');

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Escape stops drawing', await page.locator('#hud').innerText(), (v) => !/click to place|drawing/.test(v), 'no drawing prompt');

// With drawing stopped, clicking a point only selects it.
const runsBeforeLook = await page.locator('#tab-body .run-list tbody tr').count();
await page.locator('#canvas circle.hit-dot[data-node]').first().click({ force: true });
await page.waitForTimeout(300);
await page.mouse.click(canvasArea.x + canvasArea.width * 0.8, canvasArea.y + canvasArea.height * 0.25);
await page.waitForTimeout(350);
check(
  'looking at a point does not start laying pipe',
  await page.locator('#tab-body .run-list tbody tr').count(),
  (v) => v === runsBeforeLook,
  `${runsBeforeLook}`,
);

// Items are ballooned to the material list; welds are dots, not numbers.
check('items are ballooned', await page.locator('#canvas .balloon').count(), (v) => v > 0, 'at least one');
check('weld numbers are shown', await page.locator('#canvas .weld-no').count(), (v) => v > 0, 'at least one');
// SVG text has no innerText, so read it as text content.
const balloonNumbers = await page
  .locator('#canvas .balloon-no')
  .evaluateAll((els) => els.map((e) => Number(e.textContent)));
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(300);
const listRows = await page.locator('#tab-body tbody tr').count();
check(
  'every balloon points at a line in the material list',
  balloonNumbers.length > 0 && balloonNumbers.every((n) => n >= 1 && n <= listRows),
  (v) => v === true,
  'all within the list',
);
check(
  'each item number is ballooned once',
  balloonNumbers.length === new Set(balloonNumbers).size,
  (v) => v === true,
  'no number twice',
);

// New must actually clear the drawing, and must keep the job details.
await page.click('#tabs button:has-text("Title")');
await page.waitForTimeout(250);
await page.fill('[data-meta="project"]', 'Carried Over');
await page.fill('[data-meta="lineNumber"]', '6"-P-9999');
await page.locator('[data-meta="lineNumber"]').blur();
await page.waitForTimeout(300);
await startNewDrawing();
check('New clears the route', await page.locator('#canvas line.pipe').count(), (v) => v === 0, '0');
await page.click('#tabs button:has-text("Title")');
await page.waitForTimeout(250);
check('New keeps the project', await page.inputValue('[data-meta="project"]'), (v) => v === 'Carried Over', 'Carried Over');
check('New clears the line number', await page.inputValue('[data-meta="lineNumber"]'), (v) => v === '', 'empty');

// Things that sit in the line are dragged to where they belong, not left in
// the middle of the run they were dropped on.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '6"\nSCH40\nORIGIN 0 0 0\nE 4000\n+BALL');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(250);

const valveHandle = await page.locator('#canvas circle.hit-dot[data-component]').first().boundingBox();
await page.locator('#canvas circle.hit-dot[data-component]').first().click({ force: true });
await page.waitForTimeout(300);
const offsetOf = async () => Number(await page.locator('#tab-body [data-f="offset"]').inputValue());
const middle = await offsetOf();
check('a valve lands in the middle to begin with', middle, (v) => v === 2000, '2000');

// Drag it back along the pipe towards the start.
await page.mouse.move(valveHandle.x + valveHandle.width / 2, valveHandle.y + valveHandle.height / 2);
await page.mouse.down();
await page.mouse.move(valveHandle.x - 150, valveHandle.y - 87, { steps: 14 });
await page.waitForTimeout(200);
await page.mouse.up();
await page.waitForTimeout(500);
const dragged = await offsetOf();
check('dragging slides it along the pipe', dragged, (v) => v < middle - 200, `well under ${middle}`);
check('and it stays on the pipe', dragged, (v) => v >= 0 && v <= 4000, 'within the run');

await page.click('#undo');
await page.waitForTimeout(400);
await page.locator('#canvas circle.hit-dot[data-component]').first().click({ force: true });
await page.waitForTimeout(300);
check('undo puts it back where it was', await offsetOf(), (v) => v === middle, `${middle}`);

// A flange is a break in the line. The line carries on past one only by
// bolting another flange to it, straight on; the flange itself stays.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '6"\nSCH40\nORIGIN 0 0 0\nE 2000\nEND FLG');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(250);
const runsBeforeFlange = await page.locator('#tab-body .run-list tbody tr').count();
// Typed commands leave the route armed at the end they finished on; find that
// end by position, since nothing is selected.
let flangedEnd = null;
for (const handle of await page.locator('#canvas circle.hit-dot[data-node]').all()) {
  const box = await handle.boundingBox();
  if (box && (!flangedEnd || box.x > flangedEnd.x)) flangedEnd = box;
}
const fx = flangedEnd.x + flangedEnd.width / 2;
const fy = flangedEnd.y + flangedEnd.height / 2;
// Turning north straight off the flange is refused: nothing bolts to a bend.
await page.mouse.move(fx + 140, fy - 82, { steps: 10 });
await page.waitForTimeout(200);
await page.mouse.click(fx + 140, fy - 82);
await page.waitForTimeout(500);
check(
  'a bend straight off a flanged end is refused',
  await page.locator('#tab-body .run-list tbody tr').count(),
  (v) => v === runsBeforeFlange,
  `${runsBeforeFlange}`,
);
check('and it says why', await page.locator('#hud').innerText(), (v) => /straight on/.test(v), 'a message about continuing straight');
// Carrying straight on (east) bolts a second flange to the first.
await page.mouse.move(fx + 140, fy + 82, { steps: 10 });
await page.waitForTimeout(200);
await page.mouse.click(fx + 140, fy + 82);
await page.waitForTimeout(500);
check(
  'the line carries on past a flange',
  await page.locator('#tab-body .run-list tbody tr').count(),
  (v) => v === runsBeforeFlange + 1,
  `${runsBeforeFlange + 1}`,
);
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(300);
check(
  'and the joint is a pair of flanges',
  await page.locator('#tab-body').innerText(),
  (v) => /WELD NECK FLANGE\t6"\tSTD\t2/.test(v),
  'two weld neck flanges',
);
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(300);
check(
  'each welded to its own pipe',
  (await page.locator('#tab-body').innerText().then((t) => t.match(/PIPE \/ WELD NECK FLANGE/g) ?? [])).length,
  (v) => v === 2,
  '2',
);
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(200);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.mouse.click(fx, fy);
await page.waitForTimeout(300);
check(
  'the point reads as a flanged joint',
  await page.locator('#tab-body').innerText(),
  (v) => /FLANGED JOINT/.test(v),
  'a flanged joint heading',
);

// A flange picked from the palette breaks the run it is put on, and slides.
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.locator('#canvas [data-run]').first().click({ force: true });
await page.waitForTimeout(300);
const runsBeforeSplit = await page.locator('#tab-body .run-list tbody tr').count();
await page.click('.tool[data-kind="FLG_WN"]');
await page.waitForTimeout(400);
check(
  'a flange from the palette breaks the run in two',
  await page.locator('#tab-body .run-list tbody tr').count(),
  (v) => v === runsBeforeSplit + 1,
  `${runsBeforeSplit + 1}`,
);
const jointBox = await page.locator('#canvas .node.selected circle.hit-dot').first().boundingBox();
check('and the joint is selected, ready to drag', jointBox !== null, (v) => v === true, 'true');
const eastOf = async () => Number(await page.locator('#tab-body [data-f="e"]').inputValue());
const jointEastBefore = await eastOf();
await page.mouse.move(jointBox.x + jointBox.width / 2, jointBox.y + jointBox.height / 2);
await page.mouse.down();
await page.mouse.move(jointBox.x + jointBox.width / 2 - 70, jointBox.y + jointBox.height / 2 - 40, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(400);
await page.locator('#canvas .node.selected circle.hit-dot').first().click({ force: true }).catch(() => {});
await page.waitForTimeout(200);
check('dragging slides the flanged joint along the line', await eastOf(), (v) => v < jointEastBefore, `less than ${jointEastBefore}`);
check('elbows are drawn round', await page.locator('#canvas path.pipe').count(), (v) => v === 0, '0 — no elbows on a straight line');

// The valve's run is dimensioned to its faces, and the valve face to face.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '3"\nSCH40\nORIGIN 0 0 0\nE 1000\n+BALL 500\nN 800');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
const dimTexts = await page.evaluate(() => [...document.querySelectorAll('#canvas .dim-text')].map((t) => t.textContent));
check('a valve breaks the dimension at its faces', dimTexts.sort().join(' '), (v) => v === '203 399 399 800', '203 399 399 800');
check('and the elbow between the runs is round', await page.locator('#canvas path.pipe').count(), (v) => v === 1, '1');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

/* ------------------------------------------------------- pencil and finger */

// An iPad pencil reports pointerType "pen" and, on most iPads, never hovers:
// the first the app hears of it is the contact. Fingers report "touch" and
// must never lay pipe, or a resting palm would draw. Playwright's mouse always
// says "mouse", so these go through the devtools protocol instead.
const cdp = await page.context().newCDPSession(page);
const pen = (type, x, y) =>
  cdp.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: type === 'mouseMoved' ? 0 : 1,
    pointerType: 'pen',
    force: 0.5,
  });
/** Touch and lift, with no hover beforehand — what a pencil actually does. */
const penTap = async (x, y) => {
  await pen('mousePressed', x, y);
  await page.waitForTimeout(120);
  await pen('mouseReleased', x, y);
  await page.waitForTimeout(400);
};
const finger = (type, x, y) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, force: 1 }],
  });

await startNewDrawing();
const penBox = await page.locator('#canvas').boundingBox();
const penX = penBox.x + penBox.width * 0.4;
const penY = penBox.y + penBox.height * 0.55;

await penTap(penX, penY);
check(
  'a pencil puts the first point down on contact',
  await page.locator('#canvas circle.hit-dot[data-node]').count(),
  (v) => v === 1,
  '1',
);

// No hover in between: straight from lifting the pencil to the next contact.
await penTap(penX + 150, penY - 88);
check('and draws the run on the next tap, with no hover', await page.locator('#canvas line.pipe').count(), (v) => v === 1, '1');

await penTap(penX + 300, penY - 176);
check('and keeps going tap by tap', await page.locator('#canvas line.pipe').count(), (v) => v === 2, '2');

// A finger is for moving the sheet, never for drawing.
const viewBefore = await page.locator('#canvas').getAttribute('viewBox');
await finger('touchStart', penX + 420, penY - 240);
await page.waitForTimeout(80);
await finger('touchMove', penX + 320, penY - 180);
await page.waitForTimeout(80);
await finger('touchEnd', penX + 320, penY - 180);
await page.waitForTimeout(400);
check('a finger drag pans instead of drawing', await page.locator('#canvas line.pipe').count(), (v) => v === 2, 'still 2');
check(
  'and it actually moves the sheet',
  await page.locator('#canvas').getAttribute('viewBox'),
  (v) => v !== viewBefore,
  'a different viewBox',
);

// A palm or a stray finger tap must not put pipe down either.
await finger('touchStart', penX + 460, penY - 260);
await page.waitForTimeout(80);
await finger('touchEnd', penX + 460, penY - 260);
await page.waitForTimeout(400);
check('and a stray finger tap lays nothing', await page.locator('#canvas line.pipe').count(), (v) => v === 2, 'still 2');

// Picking the route back up needs no double tap.
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(200);
await page.locator('#canvas circle.hit-dot[data-node]').first().click({ force: true });
await page.waitForTimeout(300);
check(
  'a point offers a button to carry on from it',
  await page.locator('#tab-body [data-a="draw-from"]').count(),
  (v) => v === 1,
  '1',
);
await page.click('#tab-body [data-a="draw-from"]');
await page.waitForTimeout(300);
const firstNode = await page.locator('#canvas circle.hit-dot[data-node]').first().boundingBox();
await penTap(firstNode.x + firstNode.width / 2, firstNode.y + firstNode.height / 2 - 150);
check('and drawing carries on from there', await page.locator('#canvas line.pipe').count(), (v) => v === 3, '3');

// No Esc key on a tablet: stopping is a button, and a finger tap on open sheet.
check('a Stop button shows while drawing', await page.locator('#hud-stop').count(), (v) => v === 1, '1');
await page.click('#hud-stop');
await page.waitForTimeout(250);
check('and pressing it puts the pencil down', await page.locator('#hud-stop').count(), (v) => v === 0, '0');
const pipesBeforeStop = await page.locator('#canvas line.pipe').count();
await penTap(penX + 260, penY + 120);
check('after which a tap draws nothing', await page.locator('#canvas line.pipe').count(), (v) => v === pipesBeforeStop, `${pipesBeforeStop}`);
await page.locator('#canvas circle.hit-dot[data-node]').first().click({ force: true });
await page.waitForTimeout(200);
await page.click('#tab-body [data-a="draw-from"]');
await page.waitForTimeout(250);
check('drawing again arms the pencil', await page.locator('#hud-stop').count(), (v) => v === 1, '1');
await finger('touchStart', penX + 300, penY + 160);
await page.waitForTimeout(80);
await finger('touchEnd', penX + 300, penY + 160);
await page.waitForTimeout(300);
check('and a finger tap on open sheet stops it', await page.locator('#hud-stop').count(), (v) => v === 0, '0');

await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// On a tablet the toolbar has to keep working: the view switches used to be
// hidden outright, and Print used to scroll off the end.
for (const [width, height, shape] of [
  [1194, 834, 'landscape'],
  [834, 1194, 'portrait'],
]) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(300);
  check(
    `Print stays on screen on an iPad in ${shape}`,
    await page.evaluate(() => {
      const r = document.querySelector('#print').getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth;
    }),
    (v) => v === true,
    'true',
  );
  check(
    `the view switches fold into a button in ${shape}`,
    await page.locator('#view-menu-button').isVisible(),
    (v) => v === true,
    'true',
  );
  await page.click('#view-menu-button');
  await page.waitForTimeout(250);
  check(
    `and opening it shows them in ${shape}`,
    await page.evaluate(() => {
      const r = document.querySelector('#opt-welds').getBoundingClientRect();
      return r.width > 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }),
    (v) => v === true,
    'true',
  );
  // They still do their job from in there.
  check(
    `there are weld numbers to hide in ${shape}`,
    await page.locator('#canvas .weld-no').count(),
    (v) => v > 0,
    'at least one',
  );
  await page.click('#opt-welds');
  await page.waitForTimeout(350);
  check(
    `turning weld numbers off from the menu works in ${shape}`,
    await page.locator('#canvas .weld-no').count(),
    (v) => v === 0,
    '0',
  );
  await page.click('#opt-welds');
  await page.waitForTimeout(350);
  await page.click('#canvas');
  await page.waitForTimeout(200);
  check(
    `and tapping away puts the menu back in ${shape}`,
    await page.locator('#view-menu.open').count(),
    (v) => v === 0,
    '0',
  );
}
await page.setViewportSize({ width: 1500, height: 940 });
await page.waitForTimeout(300);
check(
  'on a wide screen the switches sit in the toolbar',
  await page.locator('#opt-welds').isVisible(),
  (v) => v === true,
  'true',
);

/* --------------------------------------------- what the drawing is made of */

// Symbols, balloons and lettering belong to the drawing: they zoom with it and
// keep their size against the pipe, and every flange is drawn the same.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '3"\nSCH40\nORIGIN 0 0 0\nE 1500\n+FLG 700\nN 1200\n+BALL 500\nU 900\n+RED 450\nE 800\nEND FLG');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const measure = () =>
  page.evaluate(() => {
    const plates = [...document.querySelectorAll('#canvas .node polygon.sym-fill')].map((p) => p.getBBox());
    const text = document.querySelector('#canvas .dim-text');
    const balloon = document.querySelector('#canvas .balloon-ring');
    return {
      plateHeights: plates.map((b) => Math.round(Math.hypot(b.width, b.height) * 10) / 10),
      font: text ? getComputedStyle(text).fontSize : null,
      balloonR: balloon ? balloon.getAttribute('r') : null,
    };
  });
const before6 = await measure();
const anyBox = await page.locator('#canvas circle.hit-dot[data-component]').first().boundingBox();
for (let i = 0; i < 4; i += 1) {
  await page.mouse.move(anyBox.x + anyBox.width / 2, anyBox.y + anyBox.height / 2);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(60);
}
await page.waitForTimeout(250);
const after6 = await measure();
check('zooming in changes the view', await page.locator('#canvas').getAttribute('viewBox'), (v) => !/^-?\d+\.\d+ -?\d+\.\d+ 8\d\d/.test(v ?? ''), 'a narrower viewBox');
check('symbols keep their size against the pipe when zoomed', JSON.stringify(after6.plateHeights), (v) => v === JSON.stringify(before6.plateHeights), JSON.stringify(before6.plateHeights));
check('and so does the lettering', after6.font, (v) => v === before6.font, before6.font);
check('and so do the balloons', after6.balloonR, (v) => v === before6.balloonR, before6.balloonR);
// Each flange is a plate and a hub, so two sizes in all, whatever the flanges.
check('every flange is drawn the same', new Set(before6.plateHeights).size, (v) => v <= 2, 'at most 2 distinct sizes');
await page.click('#fit');
await page.waitForTimeout(250);

// A reducer is welded at both ends.
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(250);
const reducerWelds = (await page.locator('#tab-body').innerText().then((t) => t.match(/PIPE \/ CON RED/g) ?? [])).length;
check('a reducer has a weld at each end', reducerWelds, (v) => v === 2, '2');

// Weld numbers can be typed, on the list or against the weld on the drawing.
const firstNo = page.locator('#tab-body [data-weld-no]').first();
await firstNo.fill('W7A');
await firstNo.press('Enter');
await page.waitForTimeout(350);
check(
  'a weld number typed in the list shows on the drawing',
  await page.evaluate(() => [...document.querySelectorAll('#canvas .weld-no')].some((t) => t.textContent === 'W7A')),
  (v) => v === true,
  'true',
);
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(200);
const tags = await page.locator('#canvas [data-weld]').all();
await tags[tags.length - 1].click({ force: true });
await page.waitForTimeout(300);
check('tapping a weld number on the drawing opens it', await page.locator('#tab-body [data-editor="weld"]').count(), (v) => v === 1, '1');
await page.fill('#tab-body [data-f="number"]', 'W-END');
await page.press('#tab-body [data-f="number"]', 'Enter');
await page.waitForTimeout(350);
check(
  'and its number can be typed there',
  await page.evaluate(() => [...document.querySelectorAll('#canvas .weld-no')].some((t) => t.textContent === 'W-END')),
  (v) => v === true,
  'true',
);
check(
  'other welds keep their numbers along the route',
  await page.evaluate(() => [...document.querySelectorAll('#canvas .weld-no')].map((t) => t.textContent).filter((t) => /^W\d+$/.test(t)).length),
  (v) => v >= 10,
  'at least 10',
);

// Something put into a drawn line is placed by the length on either side of
// it, and the other side takes up the difference.
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
await page.locator('#canvas circle.hit-dot[data-component]').first().click({ force: true });
await page.waitForTimeout(250);
const fromStart = page.locator('#tab-body [data-f="offset"]');
const toEnd = page.locator('#tab-body [data-f="toend"]');
const total6 = Number(await fromStart.inputValue()) + Number(await toEnd.inputValue());
await toEnd.fill('300');
await toEnd.press('Enter');
await page.waitForTimeout(350);
check('setting the distance to the end moves the valve', Number(await page.locator('#tab-body [data-f="offset"]').inputValue()), (v) => v === total6 - 300, `${total6 - 300}`);
await page.locator('#canvas circle.hit-dot[data-component]').first().click({ force: true });
await page.waitForTimeout(250);
check('and the run keeps its length', Number(await page.locator('#tab-body [data-f="offset"]').inputValue()) + Number(await page.locator('#tab-body [data-f="toend"]').inputValue()), (v) => v === total6, `${total6}`);

// The same for a point in the line — here the flanged joint.
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
let jointHandle = null;
for (const handle of await page.locator('#canvas circle.hit-dot[data-node]').all()) {
  await handle.click({ force: true });
  await page.waitForTimeout(150);
  if (/FLANGED JOINT/.test(await page.locator('#tab-body').innerText())) {
    jointHandle = handle;
    break;
  }
}
check('the joint offers the length either side of it', await page.locator('#tab-body [data-slide]').count(), (v) => v === 2, '2');
const sides = page.locator('#tab-body [data-slide]');
const sideTotal = Number(await sides.nth(0).inputValue()) + Number(await sides.nth(1).inputValue());
await sides.nth(0).fill('400');
await sides.nth(0).press('Enter');
await page.waitForTimeout(350);
if (jointHandle) {
  await jointHandle.click({ force: true }).catch(() => {});
  await page.waitForTimeout(200);
}
const sidesAfter = page.locator('#tab-body [data-slide]');
check('setting one side slides the joint', Number(await sidesAfter.nth(0).inputValue()), (v) => v === 400, '400');
check('and the other side takes up the difference', Number(await sidesAfter.nth(1).inputValue()), (v) => v === sideTotal - 400, `${sideTotal - 400}`);

// An end is moved by dragging it, once it is not the one being drawn from.
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
let endBox = null;
for (const handle of await page.locator('#canvas circle.hit-dot[data-node]').all()) {
  const box = await handle.boundingBox();
  if (box && (!endBox || box.x > endBox.x)) endBox = box;
}
const runsBeforeEndDrag = await page.locator('#tab-body .run-list tbody tr').count();
const lastLenBefore = Number(await page.locator('#tab-body [data-run-len]').last().inputValue());
await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2);
await page.mouse.down();
await page.mouse.move(endBox.x + endBox.width / 2 + 70, endBox.y + endBox.height / 2 + 40, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(400);
check('dragging an end draws no new run', await page.locator('#tab-body .run-list tbody tr').count(), (v) => v === runsBeforeEndDrag, `${runsBeforeEndDrag}`);
check('it moves the end instead', Number(await page.locator('#tab-body [data-run-len]').last().inputValue()), (v) => v > lastLenBefore, `more than ${lastLenBefore}`);

// Deleting needs no keyboard either.
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
await page.locator('#canvas [data-run]').last().click({ force: true });
await page.waitForTimeout(250);
check('a Delete button shows for the selection', await page.locator('#hud-delete').innerText(), (v) => /Delete run/.test(v), 'Delete run');
await page.click('#hud-delete');
await page.waitForTimeout(350);
check('and it deletes', await page.locator('#tab-body .run-list tbody tr').count(), (v) => v === runsBeforeEndDrag - 1, `${runsBeforeEndDrag - 1}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

/* ------------------------------------------ placing by typing a dimension */

// A tap says how far as well as which way: a tap a little off the axis still
// reaches its distance rather than falling short of it.
await startNewDrawing();
const cb2 = await page.locator('#canvas').boundingBox();
await page.mouse.click(cb2.x + cb2.width * 0.4, cb2.y + cb2.height * 0.6);
await page.waitForTimeout(400);
const o2 = await page.locator('#canvas circle.hit-dot[data-node]').first().boundingBox();
const o2x = o2.x + o2.width / 2;
const o2y = o2.y + o2.height / 2;
// East lies 30° below the horizontal on the screen; tap 20° off it, 260px away.
const offAxis = ((30 + 20) * Math.PI) / 180;
await page.mouse.move(o2x + Math.cos(offAxis) * 260, o2y + Math.sin(offAxis) * 260, { steps: 6 });
await page.waitForTimeout(100);
await page.mouse.click(o2x + Math.cos(offAxis) * 260, o2y + Math.sin(offAxis) * 260);
await page.waitForTimeout(400);
const reached = await page.evaluate(() => {
  const svg = document.querySelector('#canvas');
  const [, , vw] = svg.getAttribute('viewBox').split(' ').map(Number);
  return { paperPerPx: vw / svg.getBoundingClientRect().width };
});
const expectedMm = Math.round((260 * reached.paperPerPx) / 0.06 / 50) * 50;
check('a tap off the axis still reaches its distance', Number(await page.locator('#tab-body [data-run-len]').first().inputValue()), (v) => Math.abs(v - expectedMm) <= 50, `about ${expectedMm}`);

// Inserting a valve opens the length up to it for typing; the rest follows.
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.locator('#canvas [data-run]').first().click({ force: true });
await page.waitForTimeout(200);
const runLen2 = Number(await page.locator('#tab-body [data-f="length"]').inputValue());
await page.click('.tool[data-kind="BALL"]');
await page.waitForTimeout(400);
check('a valve put in opens its dimension for typing', await page.locator('.dim-editor').count(), (v) => v === 1, '1');
await page.fill('.dim-editor', '250');
await page.press('.dim-editor', 'Enter');
await page.waitForTimeout(400);
const dims2 = await page.evaluate(() => [...document.querySelectorAll('#canvas .dim-text')].map((t) => Number(t.textContent)));
check('typing it places the valve', dims2[0], (v) => v === 250, '250');
check('and the far side takes the rest', dims2[0] + dims2[1] + dims2[2], (v) => v === runLen2, `${runLen2}`);

// Any figure on the drawing can be tapped and typed over.
const figures = await page.locator('#canvas [data-dim]').all();
await figures[figures.length - 1].click({ force: true });
await page.waitForTimeout(300);
check('tapping a figure opens it', await page.locator('.dim-editor').count(), (v) => v === 1, '1');
await page.fill('.dim-editor', '900');
await page.press('.dim-editor', 'Enter');
await page.waitForTimeout(400);
const dims3 = await page.evaluate(() => [...document.querySelectorAll('#canvas .dim-text')].map((t) => Number(t.textContent)));
check('typing the last piece moves the end, nothing else', dims3.join(','), (v) => v === `250,203,900`, '250,203,900');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// A tee put in opens the length up to it too.
await page.locator('#canvas [data-run]').last().click({ force: true });
await page.waitForTimeout(200);
await page.click('.tool[data-branch="TEE"]');
await page.waitForTimeout(400);
check('a tee put in opens its dimension for typing', await page.locator('.dim-editor').count(), (v) => v === 1, '1');
await page.fill('.dim-editor', '300');
await page.press('.dim-editor', 'Enter');
await page.waitForTimeout(400);
const dims4 = await page.evaluate(() => [...document.querySelectorAll('#canvas .dim-text')].map((t) => Number(t.textContent)));
check('and the tee sits where typed', dims4[dims4.length - 2], (v) => v === 300, '300');
check('the other side taking the rest', dims4.reduce((a, b) => a + b, 0), (v) => v === dims3.reduce((a, b) => a + b, 0), `${dims3.reduce((a, b) => a + b, 0)}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// Weld numbers sit in rounded boxes, each on a leader to its weld.
check('weld numbers are boxed', await page.locator('#canvas .weld-box').count(), (v) => v > 0, 'at least one');
check(
  'every box has a leader',
  (await page.locator('#canvas .weld-box').count()) === (await page.locator('#canvas .weld-leader').count()),
  (v) => v === true,
  'true',
);

// Nothing is ever drawn on top of a line already there.
await page.locator('#canvas circle.hit-dot[data-node]').first().click({ force: true });
await page.waitForTimeout(200);
await page.click('#tab-body [data-a="draw-from"]');
await page.waitForTimeout(200);
const runsBeforeOverlap = await page.locator('#tab-body .run-list tbody tr').count();
// Short of the valve, on bare pipe.
await page.mouse.move(o2x + Math.cos(Math.PI / 6) * 55, o2y + Math.sin(Math.PI / 6) * 55, { steps: 6 });
await page.waitForTimeout(100);
await page.mouse.click(o2x + Math.cos(Math.PI / 6) * 55, o2y + Math.sin(Math.PI / 6) * 55);
await page.waitForTimeout(400);
check(
  'drawing back along the line splits it rather than doubling it',
  await page.locator('#tab-body .run-list tbody tr').count(),
  (v) => v === runsBeforeOverlap + 1,
  `${runsBeforeOverlap + 1}`,
);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

/* --------------------------------------------- stretching, tags, flanges */

// A picked run shows a handle at each end; dragging one makes the run longer
// or shorter along its own line.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '3"\nSCH40\nORIGIN 0 0 0\nE 1000\nN 800');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(150);
await page.locator('#canvas [data-run]').first().click({ force: true });
await page.waitForTimeout(250);
check('a picked run shows handles at both ends', await page.locator('#canvas [data-run-end]').count(), (v) => v === 2, '2');
const toHandle = await page.locator('#canvas [data-run-end$=":to"]').first().boundingBox();
const lenBefore = Number(await page.locator('#tab-body [data-f="length"]').inputValue());
await page.mouse.move(toHandle.x + toHandle.width / 2, toHandle.y + toHandle.height / 2);
await page.mouse.down();
// Pull along east, and a little off it: the run must not turn.
await page.mouse.move(toHandle.x + toHandle.width / 2 + 90, toHandle.y + toHandle.height / 2 + 40, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(400);
await page.locator('#canvas [data-run]').first().click({ force: true });
await page.waitForTimeout(250);
check('dragging a handle lengthens the run', Number(await page.locator('#tab-body [data-f="length"]').inputValue()), (v) => v > lenBefore, `more than ${lenBefore}`);
check('and keeps its direction', await page.locator('#tab-body .run-list tbody tr').first().innerText(), (v) => /\tE\t/.test(v), 'still E');
check('and the rest of the route came along', Number(await page.locator('#tab-body [data-run-len]').nth(1).inputValue()), (v) => v === 800, 'the N run still 800');
await page.click('#undo');
await page.waitForTimeout(300);

// Not to scale, a run is drawn to where the pencil put it, and stays there
// when its true length is typed; dragging its end changes only the drawing.
await page.click('#view-menu-button').catch(() => {});
await page.click('#opt-schematic');
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
const nodesS = await page.locator('#canvas circle.hit-dot[data-node]').all();
let topS = null;
for (const h of nodesS) {
  const bb = await h.boundingBox();
  if (bb && (!topS || bb.y < topS.y)) topS = bb;
}
await page.mouse.click(topS.x + topS.width / 2, topS.y + topS.height / 2);
await page.waitForTimeout(200);
await page.click('#tab-body [data-a="draw-from"]');
await page.waitForTimeout(200);
const upX = topS.x + topS.width / 2;
const upY = topS.y + topS.height / 2 - 70;
await page.mouse.move(upX, upY, { steps: 6 });
await page.waitForTimeout(100);
await page.mouse.click(upX, upY);
await page.waitForTimeout(400);
let newEnd = null;
for (const h of await page.locator('#canvas circle.hit-dot[data-node]').all()) {
  const bb = await h.boundingBox();
  if (bb && (!newEnd || bb.y < newEnd.y)) newEnd = bb;
}
check('not to scale, the run ends where it was drawn to', Math.abs(newEnd.y + newEnd.height / 2 - upY), (v) => v < 6, 'within 6px');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
const figures5 = await page.locator('#canvas [data-dim]').all();
await figures5[figures5.length - 1].click({ force: true });
await page.waitForTimeout(300);
await page.fill('.dim-editor', '2500');
await page.press('.dim-editor', 'Enter');
await page.waitForTimeout(400);
let endAfterType = null;
for (const h of await page.locator('#canvas circle.hit-dot[data-node]').all()) {
  const bb = await h.boundingBox();
  if (bb && (!endAfterType || bb.y < endAfterType.y)) endAfterType = bb;
}
check('typing its true length does not move the drawn end', Math.abs(endAfterType.y - newEnd.y), (v) => v < 2, 'unchanged');
const arcBefore = await page.evaluate(() => document.querySelector('#canvas path.pipe')?.getAttribute('d'));
await page.mouse.move(endAfterType.x + endAfterType.width / 2, endAfterType.y + endAfterType.height / 2);
await page.mouse.down();
await page.mouse.move(endAfterType.x + endAfterType.width / 2, endAfterType.y + endAfterType.height / 2 - 50, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
let endAfterDrag = null;
for (const h of await page.locator('#canvas circle.hit-dot[data-node]').all()) {
  const bb = await h.boundingBox();
  if (bb && (!endAfterDrag || bb.y < endAfterDrag.y)) endAfterDrag = bb;
}
check('dragging the end moves it on the drawing', endAfterType.y - endAfterDrag.y, (v) => v > 30, 'up by more than 30px');
check('without touching the elbows', await page.evaluate(() => document.querySelector('#canvas path.pipe')?.getAttribute('d')), (v) => v === arcBefore, 'the same arc');
await page.locator('#canvas [data-run]').last().click({ force: true });
await page.waitForTimeout(250);
check('and without changing the true length', Number(await page.locator('#tab-body [data-f="length"]').inputValue()), (v) => v === 2500, '2500');
await page.click('#view-menu-button').catch(() => {});
await page.click('#opt-schematic');
await page.waitForTimeout(400);

// A weld number tag is dragged to where it reads best; its leader stays put.
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
const tag = await page.locator('#canvas [data-weld-tag]').first().boundingBox();
const leaderBefore = await page.evaluate(() => {
  const l = document.querySelector('#canvas .weld-leader');
  return l && [l.getAttribute('x1'), l.getAttribute('y1')].join(',');
});
await page.mouse.move(tag.x + tag.width / 2, tag.y + tag.height / 2);
await page.mouse.down();
await page.mouse.move(tag.x + tag.width / 2 + 80, tag.y + tag.height / 2 - 60, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
const tagAfter = await page.locator('#canvas [data-weld-tag]').first().boundingBox();
check('a weld tag can be dragged', Math.hypot(tagAfter.x - tag.x, tagAfter.y - tag.y), (v) => v > 50, 'moved more than 50px');
check(
  'and its leader stays on the weld',
  await page.evaluate(() => {
    const l = document.querySelector('#canvas .weld-leader');
    return l && [l.getAttribute('x1'), l.getAttribute('y1')].join(',');
  }),
  (v) => v === leaderBefore,
  leaderBefore,
);
// Tapped, it opens to be typed over, keyboard and all.
await page.mouse.click(tagAfter.x + tagAfter.width / 2, tagAfter.y + tagAfter.height / 2);
await page.waitForTimeout(300);
check('tapping a weld tag opens it for typing', await page.locator('.dim-editor').count(), (v) => v === 1, '1');
check('with the number in it', await page.locator('.dim-editor').inputValue(), (v) => /^W\d+$/.test(v), 'a weld number');
check('as text, so a name can be typed', await page.locator('.dim-editor').getAttribute('type'), (v) => v === 'text', 'text');
await page.fill('.dim-editor', 'TGU 3.2');
await page.press('.dim-editor', 'Enter');
await page.waitForTimeout(400);
check(
  'and the typed name shows',
  await page.evaluate(() => [...document.querySelectorAll('#canvas .weld-no')].some((t) => t.textContent === 'TGU 3.2')),
  (v) => v === true,
  'true',
);

// Ending with a flange ends the line: the next tap draws nothing from it.
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
let freeEnd = null;
for (const h of await page.locator('#canvas circle.hit-dot[data-node]').all()) {
  const bb = await h.boundingBox();
  if (bb && (!freeEnd || bb.y < freeEnd.y)) freeEnd = bb;
}
await page.mouse.click(freeEnd.x + freeEnd.width / 2, freeEnd.y + freeEnd.height / 2);
await page.waitForTimeout(200);
await page.click('#tab-body [data-a="draw-from"]');
await page.waitForTimeout(200);
await page.click('.tool[data-kind="FLG_WN"]');
await page.waitForTimeout(400);
check('a flange on the end puts the pencil down', await page.locator('#hud-stop').count(), (v) => v === 0, '0');
const runsAtFlange = await page.locator('#tab-body .run-list tbody tr').count();
await page.mouse.click(freeEnd.x + freeEnd.width / 2 + 120, freeEnd.y + freeEnd.height / 2 - 70);
await page.waitForTimeout(400);
check('so the next tap draws nothing from it', await page.locator('#tab-body .run-list tbody tr').count(), (v) => v === runsAtFlange, `${runsAtFlange}`);
check('and no mating flange is drawn', await page.locator('#canvas .node .sym-dashed').count(), (v) => v === 0, '0');

/* ------------------------------------------------------------- crossings */

// Where two lines cross on the paper without meeting, the one further from
// the eye is broken either side of the crossing.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '3"\nSCH40\nORIGIN 0 0 0\nE 2000\nORIGIN 1000 -500 400\nN 1000');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('the rear line is broken where a nearer one crosses it', await page.locator('#canvas line.pipe').count(), (v) => v === 3, '3 pieces for 2 runs');
const crossingPieces = await page.evaluate(() =>
  [...document.querySelectorAll('#canvas line.pipe')].map((l) => Math.hypot(l.x2.baseVal.value - l.x1.baseVal.value, l.y2.baseVal.value - l.y1.baseVal.value)),
);
// The two pieces of the broken run add up to nearly the whole run: the gap is small.
const drawnTotal = crossingPieces.reduce((a, b) => a + b, 0);
const longest = Math.max(...crossingPieces);
check('and the gap is small', drawnTotal > longest * 1.4, (v) => v === true, 'most of the broken run still drawn');

// Symbols are a set size on the printed sheet at the drawing's scale, so
// they do not change as the drawing grows — only when the scale is changed.
const tagBox = () => page.evaluate(() => Number(document.querySelector('#canvas .weld-box')?.getAttribute('height') ?? 0));
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '3"\nSCH40\nORIGIN 0 0 0\nE 2000\nN 1000');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
const smallSymbol = await tagBox();
check('a drawing has weld tags to measure', smallSymbol, (v) => v > 0, 'more than 0');
await page.click('#print');
await page.waitForTimeout(300);
check('the print dialog offers the drawing scale', await page.locator('#sheet-scale').count(), (v) => v === 1, '1');
check('the print dialog says which build this is', await page.locator('.dialog-backdrop').innerText(), (v) => /App version [0-9a-f]{12} · 20\d\d-/.test(v), 'App version <hash> · <date>');
check('and offers to look for a new one', await page.locator('.dialog-backdrop [data-x="update"]').count(), (v) => v === 1, '1');
// The sheet as a PDF made in the app: the page is the sheet's own size, one
// page, nothing added — what a tablet's printer dialog cannot give.
{
  const [madePdf] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.dialog-backdrop [data-x="pdf"]')]);
  const pdfPath = await madePdf.path();
  const bytes = await readFile(pdfPath);
  const head = bytes.subarray(0, 2000).toString('latin1');
  const pagesIn = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('the PDF sheet is a PDF of one page', pagesIn(bytes), (v) => v === 1, '1');
  check('at the sheet\'s own size', /MediaBox \[0 0 1190\.55\d* 841\.89\d*\]/.test(head), (v) => v === true, 'MediaBox 1190.55 x 841.89 pt (A3 landscape)');
  check('drawn losslessly', /\/FlateDecode/.test(head), (v) => v === true, 'FlateDecode');
  check('and it is named after the drawing', madePdf.suggestedFilename(), (v) => /\.pdf$/.test(v), '*.pdf');
  // Making the PDF closed the dialog; the checks that follow read it.
  await page.click('#print');
  await page.waitForTimeout(250);
}
check('at 1:15 to begin with', await page.locator('#sheet-scale').inputValue(), (v) => v === '15', '15');
await page.selectOption('#sheet-scale', '50');
await page.waitForTimeout(400);
const coarser = await tagBox();
check('a coarser scale makes the symbols bigger against the pipe', coarser / smallSymbol, (v) => Math.abs(v - 50 / 15) < 0.05, `${(50 / 15).toFixed(2)}x`);
await page.click('[data-x="preview"]');
await page.waitForTimeout(600);
check('while the sheet is fitted to the page whatever the on-screen scale', await page.locator('.sheet-preview').innerText(), (v) => /SCALE 1:\d+ \(FITTED TO SHEET\)/.test(v) && !/SCALE 1:50/.test(v), 'SCALE 1:n (FITTED TO SHEET), not 1:50');
await page.click('.dialog [data-close]');
await page.waitForTimeout(200);
await page.click('#print');
await page.waitForTimeout(300);
await page.selectOption('#sheet-scale', '15');
await page.waitForTimeout(300);
await page.click('[data-x="close"]');
await page.waitForTimeout(200);
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', 'N 9000\nE 12000');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
check('symbols keep their size as the drawing grows', await tagBox(), (v) => Math.abs(v - smallSymbol) < 0.01, `${smallSymbol}`);

// Weld marks are part of the fitting symbol: an elbow's welds sit a set
// distance from its corner whatever the pipe size, on the ends of its sweep.
const elbowReach = async () =>
  page.evaluate(() => {
    const corners = [...document.querySelectorAll('#canvas .node circle.hit-dot')].map((c) => ({ x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) }));
    const dots = [...document.querySelectorAll('#canvas .weld .joint-bw')].map((c) => ({ x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) }));
    const path = document.querySelector('#canvas path.pipe');
    const nearest = corners.map((c) => Math.min(...dots.map((d) => Math.hypot(d.x - c.x, d.y - c.y)))).filter((d) => d > 0.01);
    return { reach: Math.min(...nearest), arcStart: path ? path.getAttribute('d').split(' ').slice(1, 3).map(Number) : null, dots };
  });
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '3"\nSCH40\nORIGIN 0 0 0\nE 1500\nN 1500');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
const small3 = await elbowReach();
check('the elbow sweep starts on a weld mark', small3.dots.some((d) => Math.hypot(d.x - small3.arcStart[0], d.y - small3.arcStart[1]) < 0.05), (v) => v === true, 'true');
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '8"\nSCH40\nORIGIN 0 0 0\nE 1500\nN 1500');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
const big8 = await elbowReach();
check('and sits the same distance from the corner on an 8" line as on a 3" one', Math.abs(big8.reach - small3.reach), (v) => v < 0.01, 'the same');

// With the panel folded away, drawing on from a point is a button on the sheet.
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.locator('#canvas circle.hit-dot[data-node]').last().click({ force: true });
await page.waitForTimeout(250);
check('a picked point offers Draw from here on the sheet', await page.locator('#hud-draw-from').count(), (v) => v === 1, '1');
await page.click('#hud-draw-from');
await page.waitForTimeout(250);
check('and pressing it arms the pencil', await page.locator('#hud-stop').count(), (v) => v === 1, '1');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

/* ------------------------------------------- bends, transition, SW marks */

// How a corner is joined is picked from the palette, and the list names it.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '1"\nSCH40\nORIGIN 0 0 0\nE 1000\nN 800\nEND TRANS');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(150);
check('the palette carries the PE/CS transition', await page.locator('.tool[data-kind="TRANSITION"]').count(), (v) => v === 1, '1');
let cornerH = null;
for (const h of await page.locator('#canvas circle.hit-dot[data-node]').all()) {
  await h.click({ force: true });
  await page.waitForTimeout(150);
  if (/ELBOW/.test(await page.locator('#tab-body').innerText())) {
    cornerH = h;
    break;
  }
}
check('a corner can be picked', cornerH !== null, (v) => v === true, 'true');
// The joint in the toolbar sets the picked point.
await page.selectOption('#joint', 'SW');
await page.waitForTimeout(400);
check('the drawing default is untouched', await page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).options.joint), (v) => v === 'BW', 'BW');
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(250);
check('a socket weld elbow is named so in the list', await page.locator('#tab-body').innerText(), (v) => /90 ELBOW LR SW 3000#/.test(v), 'ELBOW ... SW 3000#');
check('and the transition joint is listed', await page.locator('#tab-body').innerText(), (v) => /TRANSITION JOINT PE\/CS/.test(v), 'TRANSITION JOINT PE/CS');
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(250);
check('the transition is welded on its steel side only', (await page.locator('#tab-body').innerText().then((t) => t.match(/PIPE \/ TRANSITION JOINT/g) ?? [])).length, (v) => v === 1, '1');
check('and the plastic goes on as six dashes', await page.evaluate(() => {
  const end = [...document.querySelectorAll('#canvas .node')].find((g) => g.querySelector('.sym-text'));
  return end ? end.querySelectorAll('line.sym-line').length : 0;
}), (v) => v === 7, '6 dashes and the seam');
check('the elbow welds are socket welds now', (await page.locator('#tab-body').innerText().then((t) => t.match(/\tSW\tPIPE \/ 90 ELBOW/g) ?? [])).length, (v) => v === 2, '2');

// A socket weld mark's lips reach back over the pipe, away from the fitting.
const swMark = await page.evaluate(() => {
  // The elbow's socket marks: three lines each. The bar sits across the pipe;
  // the two lips run along it. Which way they run is what is checked here.
  const groups = [...document.querySelectorAll('#canvas .weld')].filter((g) => g.querySelectorAll('line.sym-line').length === 3);
  const corner = [...document.querySelectorAll('#canvas .node circle.hit-dot')].map((c) => ({ x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) }))[1];
  return groups.map((g) => {
    const [bar, lipA] = [...g.querySelectorAll('line.sym-line')];
    const barMid = { x: (Number(bar.getAttribute('x1')) + Number(bar.getAttribute('x2'))) / 2, y: (Number(bar.getAttribute('y1')) + Number(bar.getAttribute('y2'))) / 2 };
    const lipEnd = { x: Number(lipA.getAttribute('x2')), y: Number(lipA.getAttribute('y2')) };
    const dBar = Math.hypot(barMid.x - corner.x, barMid.y - corner.y);
    const dLip = Math.hypot(lipEnd.x - corner.x, lipEnd.y - corner.y);
    return dLip > dBar;
  });
});
check('socket lips point away from the fitting, back over the pipe', swMark.length === 2 && swMark.every(Boolean), (v) => v === true, 'both marks');
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(200);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

/* ------------------------- marks, balloons, the keypad, printing in place */

// A support and the AG/UG mark are placed by hand and drawn as the sheets
// draw them; neither is material, so neither is on the list.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '3"\nSTD\nORIGIN 0 0 0\nEND FLG\nE 2400\n+SUPPORT 800\n+BALL 1600\nU 1500\n+AGUG 700\nEND CONT');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.keyboard.press('f');
await page.waitForTimeout(300);
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(150);
check('a support is drawn with its post and plate', await page.locator('#canvas .component polygon.sym-fill').count(), (v) => v >= 1, 'a base plate');
check('and called out by name', await page.locator('#canvas .callout-text', { hasText: 'SUPPORT' }).count(), (v) => v === 1, '1');
check('the AG/UG mark carries both labels', await page.locator('#canvas .component text.sym-text', { hasText: /^(AG|UG)$/ }).count(), (v) => v === 2, '2');
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(250);
check('neither mark takes a weld', await page.locator('#tab-body').innerText(), (v) => !/SUPPORT|AG\/UG/.test(v), 'no SUPPORT or AG/UG weld');
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(250);
check('neither mark is on the material list', await page.locator('#tab-body').innerText(), (v) => !/SUPPORT|AG\/UG/.test(v), 'no SUPPORT or AG/UG line');
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(150);
// The support is named in its panel.
await page.locator('#canvas circle.hit-dot[data-component]').first().click({ force: true });
await page.waitForTimeout(250);
await page.locator('#tab-body [data-f="tag"]').fill('B');
await page.locator('#tab-body [data-f="tag"]').dispatchEvent('change');
await page.waitForTimeout(300);
check('the support name is drawn beside it', await page.locator('#canvas .callout-text', { hasText: 'SUPPORT B' }).count(), (v) => v === 1, '1');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

// An item balloon is dragged to where it reads best, its leader staying put.
const balloon = await page.locator('#canvas [data-balloon]').first().boundingBox();
const balloonLeader = await page.evaluate(() => {
  const l = document.querySelector('#canvas .balloon-leader');
  return l && [l.getAttribute('x1'), l.getAttribute('y1')].join(',');
});
await page.mouse.move(balloon.x + balloon.width / 2, balloon.y + balloon.height / 2);
await page.mouse.down();
await page.mouse.move(balloon.x + balloon.width / 2 + 80, balloon.y + balloon.height / 2 - 60, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
const balloonAfter = await page.locator('#canvas [data-balloon]').first().boundingBox();
check('an item balloon can be dragged', Math.hypot(balloonAfter.x - balloon.x, balloonAfter.y - balloon.y), (v) => v > 50, 'moved more than 50px');
check(
  'and its leader stays on the item',
  await page.evaluate(() => {
    const l = document.querySelector('#canvas .balloon-leader');
    return l && [l.getAttribute('x1'), l.getAttribute('y1')].join(',');
  }),
  (v) => v === balloonLeader,
  balloonLeader,
);
check('the balloon place is kept with the drawing', await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).itemOverrides ?? {}).length), (v) => v === 1, '1');

// A dimension opens for typing on the pencil's touch itself, with a keypad
// beside it, and the keypad's keys type into it.
const figure = await page.locator('#canvas [data-dim]').first().boundingBox();
await pen('mousePressed', figure.x + figure.width / 2, figure.y + figure.height / 2);
await page.waitForTimeout(80);
check('the dimension box opens on the touch, not the lift', await page.locator('.dim-editor').count(), (v) => v === 1, '1');
check('and is focused', await page.evaluate(() => document.activeElement?.className), (v) => v === 'dim-editor', 'dim-editor');
check('with a number keypad beside it', await page.locator('.dim-keypad [data-key]').count(), (v) => v === 12, '12');
await pen('mouseReleased', figure.x + figure.width / 2, figure.y + figure.height / 2);
await page.waitForTimeout(150);
check('the box stays open when the pencil lifts', await page.locator('.dim-editor').count(), (v) => v === 1, '1');
for (const k of ['9', '0', '0']) await page.locator(`.dim-keypad [data-key="${k}"]`).dispatchEvent('pointerdown', { bubbles: true });
check('the keypad types over the old figure', await page.locator('.dim-editor').inputValue(), (v) => v === '900', '900');
await page.locator('.dim-keypad [data-key="OK"]').dispatchEvent('pointerdown', { bubbles: true });
await page.waitForTimeout(400);
check('and OK sets the dimension', await page.evaluate(() => [...document.querySelectorAll('#canvas .dim-text')].map((t) => t.textContent)), (v) => v.includes('900'), 'a 900 figure');
check('closing the box takes the keypad with it', await page.locator('.dim-keypad').count(), (v) => v === 0, '0');
// A weld number opens the same way, with letters on its keypad.
const markHit = await page.locator('#canvas [data-weld]:not([data-weld-tag])').first().boundingBox();
await penTap(markHit.x + markHit.width / 2, markHit.y + markHit.height / 2);
check('a weld number opens for typing on the touch', await page.locator('.dim-editor').count(), (v) => v === 1, '1');
check('with letters on its keypad', await page.locator('.dim-keypad [data-key="W"]').count(), (v) => v === 1, '1');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

// Printing happens from the page itself, at the sheet's size, with nothing
// else on the paper — a hidden frame prints blank on a tablet.
await page.evaluate(() => {
  window.__printed = 0;
  window.print = () => {
    window.__printed += 1;
  };
});
await page.click('#print');
await page.waitForTimeout(250);
await page.selectOption('#sheet-size', 'A4');
await page.click('[data-x="print"]');
await page.waitForTimeout(400);
check('Print prints the page', await page.evaluate(() => window.__printed), (v) => v === 1, '1');
check('the sheet is in the page, ready to print', await page.locator('#print-root svg').count(), (v) => v === 1, '1');
check('at the chosen sheet size', await page.evaluate(() => document.getElementById('print-page')?.textContent), (v) => /A4 landscape/.test(v), '@page size A4 landscape');
await page.emulateMedia({ media: 'print' });
check('on paper the app is hidden', await page.evaluate(() => getComputedStyle(document.getElementById('app')).display), (v) => v === 'none', 'none');
check('and the sheet is shown', await page.evaluate(() => getComputedStyle(document.getElementById('print-root')).display), (v) => v === 'block', 'block');
await page.emulateMedia({ media: 'screen' });
check('on screen the sheet stays out of the way', await page.evaluate(() => getComputedStyle(document.getElementById('print-root')).display), (v) => v === 'none', 'none');

/* ---------------- numbered supports, the L50 angle, a set-size valve, SW flanges */

await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '2"\nSTD\nORIGIN 0 0 0\nEND FLG\nE 3000\n+SUPPORT 600\n+BALL 1500\n+L50 2400\nN 2000\n+SUPPORT 1000\nEND CONT');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.keyboard.press('f');
await page.waitForTimeout(300);
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(150);
check(
  'supports are numbered along the line, the angle one saying so',
  await page.evaluate(() => [...document.querySelectorAll('#canvas .callout-text')].map((t) => t.textContent).join(' | ')),
  (v) => v === 'SUPPORT 1 | SUPPORT 2 L50 | SUPPORT 3',
  'SUPPORT 1 | SUPPORT 2 L50 | SUPPORT 3',
);
check('the palette carries the L50 support', await page.locator('.tool[data-kind="SUPPORT_L"]').count(), (v) => v === 1, '1');
// A valve is a set size, whatever its true length: at 2" a ball valve is
// 178 mm face to face, which to scale would be longer than the symbol.
const valveBox = await page.locator('#canvas g.component').nth(1).boundingBox();
const supportBox = await page.locator('#canvas g.component').nth(0).boundingBox();
check('a valve is drawn a set size, not stretched to its true length', valveBox.width / supportBox.width, (v) => v < 1.6, 'less than 1.6x a support wide');
// The support's name drags like a balloon.
const calloutHit = await page.locator('#canvas [data-balloon^="sup:"]').first().boundingBox();
const calloutBefore = Number(await page.evaluate(() => document.querySelector('#canvas .callout-text').getAttribute('x')));
await page.mouse.move(calloutHit.x + calloutHit.width / 2, calloutHit.y + calloutHit.height / 2);
await page.mouse.down();
await page.mouse.move(calloutHit.x + calloutHit.width / 2 - 70, calloutHit.y + calloutHit.height / 2 - 60, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
check('a support name can be dragged', Math.abs(Number(await page.evaluate(() => document.querySelector('#canvas .callout-text').getAttribute('x'))) - calloutBefore), (v) => v > 10, 'moved');
// In socket weld mode a flanged valve bolts between socket weld flanges.
await page.keyboard.press('Escape');
await page.selectOption('#joint', 'SW');
await page.waitForTimeout(400);
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(250);
check('a flanged valve on a socket welded line takes socket weld flanges', await page.locator('#tab-body').innerText(), (v) => /SOCKET WELD FLANGE\t2"\tSTD\t2/.test(v), 'SOCKET WELD FLANGE x 2');
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(250);
check('and they are socket welded to the pipe', (await page.locator('#tab-body').innerText().then((t) => t.match(/SW\tPIPE \/ SOCKET WELD FLANGE/g) ?? [])).length, (v) => v === 2, '2');
await page.selectOption('#joint', 'BW');
await page.waitForTimeout(300);

/* ------------------------------ a support name typed on the drawing; one page */

// Tapping a support's name opens it to be typed over, with the letter keypad.
const supHit = await page.locator('#canvas [data-balloon^="sup:"]').first().boundingBox();
await penTap(supHit.x + supHit.width / 2, supHit.y + supHit.height / 2);
check('a support callout opens for typing when tapped', await page.locator('.dim-editor').count(), (v) => v === 1, '1');
await page.locator('.dim-keypad [data-key="B"]').dispatchEvent('pointerdown', { bubbles: true });
await page.locator('.dim-keypad [data-key="OK"]').dispatchEvent('pointerdown', { bubbles: true });
await page.waitForTimeout(300);
check('and what is typed follows the number', await page.evaluate(() => document.querySelector('#canvas .callout-text').textContent), (v) => v === 'SUPPORT 1 B', 'SUPPORT 1 B');

// The printed sheet is one page whatever paper the printer has: an iPad
// ignores the @page size, and a 420 mm sheet once ran on to a second page.
await page.evaluate(() => {
  window.print = () => {};
});
await page.click('#print');
await page.waitForTimeout(200);
await page.click('[data-x="print"]');
await page.waitForTimeout(300);
const pdfPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
check('the sheet prints on one page at its own size', pdfPages(await page.pdf({ preferCSSPageSize: true })), (v) => v === 1, '1');
check('and on one page of A4 portrait', pdfPages(await page.pdf({ format: 'A4' })), (v) => v === 1, '1');
check('and on one page of Letter', pdfPages(await page.pdf({ format: 'Letter', landscape: true })), (v) => v === 1, '1');
// Told the paper is upright — a tablet's default — the sheet is turned to
// lie along the page, and the page asked for is upright too.
await page.click('#print');
await page.waitForTimeout(200);
await page.selectOption('#sheet-paper', 'upright');
await page.click('[data-x="print"]');
await page.waitForTimeout(300);
check('upright paper turns the sheet', await page.evaluate(() => document.querySelector('#print-root svg')?.getAttribute('viewBox')), (v) => v === '0 0 297 420', '0 0 297 420');
check('and asks for an upright page', await page.evaluate(() => document.getElementById('print-page')?.textContent), (v) => /A3 portrait/.test(v), 'A3 portrait');
const upright = await page.pdf({ format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' } });
check('and prints on one page of upright A4 with the printer\'s own margins', pdfPages(upright), (v) => v === 1, '1');

// A tablet prints nothing that is pinned to the page, so there the sheet
// is laid out in the flow, at a width that fits inside the tablet's own
// margins and footer. Seen as an iPad, the app prints that way.
{
  const tablet = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const tp = await tablet.newPage();
  await tp.goto(`file://${process.cwd()}/dist/index.html`);
  await tp.evaluate(() => localStorage.clear());
  await tp.reload();
  await tp.waitForTimeout(300);
  await tp.click('[data-a="load-sample"]');
  await tp.waitForTimeout(400);
  await tp.evaluate(() => {
    window.print = () => {};
  });
  await tp.click('#print');
  await tp.waitForTimeout(200);
  check('a tablet is offered upright paper first', await tp.locator('#sheet-paper').inputValue(), (v) => v === 'upright', 'upright');
  await tp.click('[data-x="print"]');
  await tp.waitForTimeout(300);
  check('and prints the sheet in the flow, not pinned', await tp.evaluate(() => document.getElementById('print-root').className), (v) => /^tablet\b/.test(v), 'tablet …');
  await tp.evaluate(() => {
    document.getElementById('print-page').textContent = '';
  });
  const tabletPdf = await tp.pdf({ format: 'A4', margin: { top: '17mm', bottom: '20mm', left: '10mm', right: '12mm' } });
  check('on one page inside the tablet\'s own margins', pdfPages(tabletPdf), (v) => v === 1, '1');
  // The tablet's printer decides the paper's orientation itself, so the
  // tablet gets the sheet both ways round and the paper picks: expecting
  // upright but given landscape paper once printed two pages.
  check('a tablet holds the sheet both ways round', await tp.locator('#print-root svg').count(), (v) => v === 2, '2');
  const acrossPdf = await tp.pdf({ width: '420mm', height: '297mm', margin: { top: '17mm', bottom: '18mm', left: '21mm', right: '21mm' } });
  check('and on landscape paper the sheet lies along it, on one page', pdfPages(acrossPdf), (v) => v === 1, '1');
  await tablet.close();
}

/* ---------------------------------------------- projects and their sheets */

// Every drawing is kept on the device by project; a job with more than one
// isometric goes on sheet by sheet, the title block carried over and the
// line marked where it continues.
await page.evaluate(() => localStorage.removeItem('iso-draw.library.v1'));
await startNewDrawing();
await page.click('#tabs button:has-text("Title")');
await page.fill('[data-meta="project"]', 'Alpha Job');
await page.locator('[data-meta="project"]').blur();
await page.waitForTimeout(300);
await page.click('#tabs button:has-text("Command")');
await page.fill('#command-text', '3"\nSTD\nORIGIN 0 0 0\nE 2000\nN 1500');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(1200);
await page.keyboard.press('Escape');
const libraryNow = () => page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.library.v1') || '[]').map((e) => `${e.drawing.meta.project}|${e.drawing.meta.sheet}|${e.drawing.runs.length}`));
check('a drawing is kept on the device as it is drawn', await libraryNow(), (v) => v.includes('Alpha Job|1 of 1|2'), 'Alpha Job|1 of 1|2 among them');
await page.click('#tabs button:has-text("Route")');
const libraryEnds = await page.locator('#canvas circle.hit-dot[data-node]').all();
await libraryEnds[libraryEnds.length - 1].click({ force: true });
await page.waitForTimeout(200);
await page.click('#tabs button:has-text("Projects")');
await page.waitForTimeout(200);
check('the Projects tab names the project on screen', await page.locator('#tab-body').innerText(), (v) => /Alpha Job — sheet 1 of 1 is on screen/.test(v), 'Alpha Job — sheet 1 of 1 is on screen');
await page.click('[data-a="new-sheet"]');
await page.waitForTimeout(1200);
check('a new sheet in the project is numbered on', await page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).meta.sheet), (v) => v === '2 of 2', '2 of 2');
check('and the first sheet is renumbered with it', await libraryNow(), (v) => v.includes('Alpha Job|1 of 2|2'), 'Alpha Job|1 of 2|2 kept');
check('the new sheet starts where the line comes in', await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).nodes[0]?.terminal)), (v) => v === '{"kind":"CONTINUATION","note":"CONT. FROM SH.1"}', 'CONT. FROM SH.1');
const contOrigin = await page.evaluate(() => { const r = document.querySelector('#canvas circle.hit-dot[data-node]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await penTap(contOrigin.x + 200, contOrigin.y + 115);
check('and the pencil draws on from it', await page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).runs.length), (v) => v === 1, '1');
check('with the continuation written at the start', await page.locator('#canvas text.note', { hasText: 'CONT. FROM SH.1' }).count(), (v) => v === 1, '1');
await page.click('#tabs button:has-text("Projects")');
await page.waitForTimeout(200);
await page.locator('[data-open-sheet]').first().click();
await page.waitForTimeout(500);
check('the first sheet opens again from the list', await page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).meta.sheet), (v) => v === '1 of 2', '1 of 2');
check('with its end marked as going on to sheet 2', await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).nodes.map((n) => n.terminal?.note).filter(Boolean))), (v) => v === '["CONT. ON SH.2"]', 'CONT. ON SH.2');
// Five projects are listed; the rest on request.
for (const name of ['Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']) {
  await startNewDrawing();
  await page.click('#tabs button:has-text("Title")');
  await page.fill('[data-meta="project"]', name);
  await page.locator('[data-meta="project"]').blur();
  await page.waitForTimeout(200);
  await page.click('#tabs button:has-text("Command")');
  await page.fill('#command-text', '2"\nSTD\nORIGIN 0 0 0\nE 1000');
  await page.click('[data-a="run-commands"]');
  await page.waitForTimeout(1000);
  await page.keyboard.press('Escape');
}
await page.click('#tabs button:has-text("Projects")');
await page.waitForTimeout(200);
check('the five most recent projects are listed', await page.locator('#tab-body .project').count(), (v) => v === 5, '5');
await page.click('[data-a="toggle-projects"]');
await page.waitForTimeout(200);
check('and all of them on request', await page.locator('#tab-body .project').count(), (v) => v >= 6, 'at least 6');
await page.evaluate(() => localStorage.removeItem('iso-draw.library.v1'));

/* ------------------- dimensions moved or hidden, fittings touching, no weld */

await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.fill('#command-text', '3"\nSTD\nORIGIN 0 0 0\nE 2000\nN 600\nU 1500');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.keyboard.press('f');
await page.waitForTimeout(300);
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(150);
const drawingNow = () => page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')));
// A dimension figure dragged with the pencil moves the whole dimension.
const figure2 = await page.evaluate(() => {
  const r = document.querySelector('#canvas [data-dim]').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
const dimLineBefore = await page.evaluate(() => document.querySelector('#canvas .dim-line').getAttribute('y1'));
await pen('mousePressed', figure2.x, figure2.y);
await page.waitForTimeout(60);
await pen('mouseMoved', figure2.x + 20, figure2.y + 30);
await pen('mouseMoved', figure2.x + 40, figure2.y + 60);
await page.waitForTimeout(60);
check('dragging a dimension figure closes the typing box', await page.locator('.dim-editor').count(), (v) => v === 0, '0');
await pen('mouseReleased', figure2.x + 40, figure2.y + 60);
await page.waitForTimeout(300);
check('and moves the dimension line', await page.evaluate(() => document.querySelector('#canvas .dim-line').getAttribute('y1')), (v) => v !== dimLineBefore, `not ${dimLineBefore}`);
check('keeping the place with the drawing', Object.keys((await drawingNow()).dimOverrides ?? {}).length, (v) => v === 1, '1');
// Tapped, the keypad offers to hide it; the run's panel shows it again.
const figure3 = await page.evaluate(() => {
  const r = document.querySelector('#canvas [data-dim]').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await penTap(figure3.x, figure3.y);
check('the dimension keypad offers to hide it', await page.locator('.dim-keypad [data-extra="0"]').innerText(), (v) => /Hide/.test(v), 'Hide this dimension');
await page.locator('.dim-keypad [data-extra="0"]').dispatchEvent('pointerdown', { bubbles: true });
await page.waitForTimeout(300);
check('and hidden it is gone', await page.locator('#canvas .dim').count(), (v) => v === 2, '2');
await page.locator('#tab-body .run-list tbody tr').first().click();
await page.waitForTimeout(200);
await page.selectOption('#tab-body [data-f="nodim"]', 'show');
await page.waitForTimeout(300);
check('the run panel brings it back', await page.locator('#canvas .dim').count(), (v) => v === 3, '3');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
// The run between two elbows: fittings joined directly, no pipe.
await page.locator('#tab-body .run-list tbody tr').nth(1).click();
await page.waitForTimeout(200);
check('a picked run offers to join its fittings directly', await page.locator('#hud-direct').innerText(), (v) => /fittings touch/.test(v), 'No pipe — fittings touch');
await page.click('#hud-direct');
await page.waitForTimeout(400);
const touching = await drawingNow();
const runN = touching.runs[1];
const nA = touching.nodes.find((n) => n.id === runN.from).pos;
const nB = touching.nodes.find((n) => n.id === runN.to).pos;
check('the run is pulled in to the two take-outs', Math.round(Math.hypot(nB.e - nA.e, nB.n - nA.n, nB.u - nA.u)), (v) => v === 228, '228 (two 3" LR elbows)');
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(200);
check('with one weld, fitting to fitting', await page.locator('#tab-body').innerText(), (v) => /90 ELBOW LR \/ 90 ELBOW LR/.test(v) && /Total 3/.test(v), 'ELBOW / ELBOW and a total of 3');
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(200);
check('and no pipe for it on the list', await page.locator('#tab-body').innerText(), (v) => /PIPE, SMLS, 3" x STD\t3"\tSTD\t3\.27/.test(v), '3.27 m — the two runs either side');
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(200);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
// A joint marked as not welded: hollow, unnumbered, off the list, and back again.
const noWeldHit = await page.evaluate(() => {
  const r = document.querySelector('#canvas [data-weld]:not([data-weld-tag])').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await penTap(noWeldHit.x, noWeldHit.y);
check('the weld keypad offers no weld here', await page.locator('.dim-keypad [data-extra="0"]').innerText(), (v) => /No weld/.test(v), 'No weld here');
await page.locator('.dim-keypad [data-extra="0"]').dispatchEvent('pointerdown', { bubbles: true });
await page.waitForTimeout(300);
check('the numbers run on past it', await page.evaluate(() => [...document.querySelectorAll('#canvas .weld-no')].map((t) => t.textContent).join(' ')), (v) => v === 'W1 W2', 'W1 W2');
check('and the joint is drawn hollow', await page.locator('#canvas .weld.no-weld').count(), (v) => v === 1, '1');
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(200);
check('the weld list counts it out', await page.locator('#tab-body').innerText(), (v) => /Total 2/.test(v), 'Total 2');
await page.click('[data-restore-weld]');
await page.waitForTimeout(300);
check('and welds it after all on request', await page.locator('#tab-body').innerText(), (v) => /Total 3/.test(v) && !/Not welded/.test(v), 'Total 3, nothing not welded');

/* --------------------------------------------- a butt weld put in the pipe */

// A weld from the palette cuts the picked run in two at a plain point,
// welded pipe to pipe, with the dimension up to it open for typing.
await startNewDrawing();
await page.click('#tabs button:has-text("Command")');
await page.fill('#command-text', '3"\nSTD\nORIGIN 0 0 0\nE 3000\nN 1500');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(150);
await page.locator('#tab-body .run-list tbody tr').first().click();
await page.waitForTimeout(200);
const weldsBeforeSplice = await page.evaluate(() => document.querySelectorAll('#canvas .weld .joint-bw').length);
await page.locator('.tool[data-weld="BW"]').click();
await page.waitForTimeout(400);
check('a weld from the palette cuts the run in two', await page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).runs.length), (v) => v === 3, '3');
check('and adds a pipe-to-pipe weld', await page.evaluate(() => document.querySelectorAll('#canvas .weld .joint-bw').length), (v) => v === weldsBeforeSplice + 1, `${weldsBeforeSplice + 1}`);
check('opening the dimension up to it for typing', await page.locator('.dim-editor').count(), (v) => v === 1, '1');
check('with the value of that side', await page.locator('.dim-editor').inputValue(), (v) => v === '1500', '1500');
for (const k of ['⌫', '⌫', '⌫', '⌫', '1', '0', '0', '0']) await page.locator(`.dim-keypad [data-key="${k}"]`).dispatchEvent('pointerdown', { bubbles: true });
await page.locator('.dim-keypad [data-key="OK"]').dispatchEvent('pointerdown', { bubbles: true });
await page.waitForTimeout(400);
check('typing one side moves the weld and the other side follows', await page.evaluate(() => [...document.querySelectorAll('#canvas .dim-text')].map((t) => t.textContent).join(' ')), (v) => /\b1000\b/.test(v) && /\b2000\b/.test(v), '1000 and 2000');
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(200);
check('the weld list has it as pipe to pipe', await page.locator('#tab-body').innerText(), (v) => /PIPE \/ PIPE/.test(v), 'PIPE / PIPE');
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(150);

/* ------------------------------------------------ a gap closed again */

// A length taken out of a line, or a corner deleted with its runs, leaves
// two open ends. Drawing from one and touching the other joins them: one
// run when they lie on a line, else round a corner, with the elbows the
// turns make — and the fewest turns of the ways round.
const nodesAt = () => page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).nodes.map((n) => [n.id, n.pos.e, n.pos.n]));
const runCount = () => page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).runs.length);
const tapNode = async (id) => {
  const el = page.locator(`#canvas circle.hit-dot[data-node="${id}"]`);
  const b = await el.boundingBox();
  const at = { bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, isPrimary: true };
  await el.dispatchEvent('pointerdown', at);
  await page.waitForTimeout(80);
  await el.dispatchEvent('pointerup', at);
  await page.waitForTimeout(300);
};
const penTapNode = async (id) => {
  const b = await page.locator(`#canvas circle.hit-dot[data-node="${id}"]`).boundingBox();
  await penTap(b.x + b.width / 2, b.y + b.height / 2);
};
const routeLine = async (commands) => {
  await startNewDrawing();
  await page.click('#tabs button:has-text("Command")');
  await page.fill('#command-text', commands);
  await page.click('[data-a="run-commands"]');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.click('#tabs button:has-text("Route")');
  await page.waitForTimeout(150);
};

await routeLine('3"\nSTD\nORIGIN 0 0 0\nE 3000\nN 2000\nE 3000');
await page.locator('#canvas [data-run]').nth(1).click({ force: true });
await page.waitForTimeout(250);
await page.click('#hud-delete');
await page.waitForTimeout(300);
check('taking the middle run out leaves two pieces', await runCount(), (v) => v === 2, '2');
let gapNodes = await nodesAt();
const gapB = gapNodes.find((p) => p[1] === 3000 && p[2] === 0)[0];
const gapC = gapNodes.find((p) => p[1] === 3000 && p[2] === 2000)[0];
await tapNode(gapB);
await page.click('#tab-body [data-a="draw-from"]');
await page.waitForTimeout(250);
await penTapNode(gapC);
check('touching the other open end while drawing joins them', await runCount(), (v) => v === 3, '3');
check('with no point added: the two lay on a line', (await nodesAt()).length, (v) => v === 4, '4');
check('and the elbows back at both ends', await page.locator('#tab-body').innerText(), (v) => /POINT — 90 ELBOW LR/.test(v), 'POINT — 90 ELBOW LR');
check('saying so', await page.locator('#hud').innerText(), (v) => /Joined, with 2 elbows/.test(v), 'Joined, with 2 elbows.');
await penTapNode(gapC);
check('touching it again draws nothing more', await runCount(), (v) => v === 3, '3');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

await routeLine('3"\nSTD\nORIGIN 0 0 0\nE 3000\nN 2000\nE 3000\nN 1500');
gapNodes = await nodesAt();
await tapNode(gapNodes.find((p) => p[1] === 3000 && p[2] === 2000)[0]);
await page.click('#hud-delete');
await page.waitForTimeout(300);
check('deleting a corner takes its two runs', await runCount(), (v) => v === 2, '2');
gapNodes = await nodesAt();
await tapNode(gapNodes.find((p) => p[1] === 3000 && p[2] === 0)[0]);
await page.click('#tab-body [data-a="draw-from"]');
await page.waitForTimeout(250);
await penTapNode(gapNodes.find((p) => p[1] === 6000 && p[2] === 2000)[0]);
check('ends not on a line are joined round a corner', await runCount(), (v) => v === 4, '4');
check('the corner where the fewest turns put it', (await nodesAt()).some((p) => p[1] === 6000 && p[2] === 0), (v) => v === true, 'a point at 6000, 0');
check('with the one elbow there', await page.locator('#hud').innerText(), (v) => /Joined, with an elbow at the turn/.test(v), 'Joined, with an elbow at the turn.');
check('the joined end welded straight through', await page.locator('#tab-body').innerText(), (v) => /POINT — JOINT/.test(v), 'POINT — JOINT');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

/* ------------------------------------------- the pipe at each weld, as cut */

// The weld list says how long the pipe at each weld is once it is cut: the
// take-outs off, and a 2.5 mm root gap off for every fitting butt-welded to
// it. Pipe to pipe leaves no gap, and an olet takes nothing off its header.
const pipeNets = async () => {
  await page.click('#tabs button:has-text("Welds")');
  await page.waitForTimeout(200);
  const rows = await page.locator('#tab-body table tbody tr').allInnerTexts();
  return rows.map((r) => r.split('\t').slice(-2).join(' = '));
};
await routeLine('3"\nSTD\nORIGIN 0 0 0\nE 3000\nN 2000\nEND CAP');
check('an elbow takes its take-out and a root gap off the pipe', await pipeNets(), (v) => v[0] === 'PIPE / 90 ELBOW LR = A 2883.5', 'A: 2886 less 2.5');
check('a pipe between an elbow and a cap loses a gap at each', await pipeNets(), (v) => v[1] === 'PIPE / 90 ELBOW LR = B 1881' && v[2] === 'PIPE / CAP = B 1881', 'B: 1886 less 5');
await routeLine('3"\nSTD\nORIGIN 0 0 0\nEND FLG\nE 3000\n+BALL 1500\nN 2000');
check('a valve cuts the run into two pieces, each with its gaps', await pipeNets(), (v) => v[0] === 'PIPE / WELD NECK FLANGE = A 1257.5' && v[2] === 'PIPE / WELD NECK FLANGE = B 1211.5', 'A flange to valve 1257.5, B valve to elbow 1211.5');
check("a flanged valve's welds are to its flanges, not the valve", await pipeNets(), (v) => !v.some((r) => /PIPE \/ BALL VALVE/.test(r)), 'no PIPE / BALL VALVE');
await routeLine('3"\nSTD\nORIGIN 0 0 0\nE 3000\nN 2000');
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(150);
await page.locator('#tab-body .run-list tbody tr').first().click();
await page.waitForTimeout(200);
await page.locator('.tool[data-weld="BW"]').click();
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check('pipe to pipe shows the pipe either side, the gap off one of them', await pipeNets(), (v) => v.some((r) => r === 'PIPE / PIPE = A 1497.5 / B 1383.5'), 'A 1497.5 / B 1383.5: the gap off the first, the second less the elbow and its gap');
check('the list copies with the net lengths', await page.evaluate(() => document.querySelector('[data-a="copy-welds"]') !== null), (v) => v === true, 'a Copy list button');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

/* ------------------------------- an elbow welded straight to a transition */

// His station sheet: the line turns down to a PE/CS transition with no pipe
// between the elbow and it. The one weld there is elbow to transition, and
// the run is pulled in to the elbow's take-out plus the transition's stub.
await routeLine('3"\nSTD\nORIGIN 0 0 0\nE 2000\nD 900\nE 400\nEND TRANSITION');
await page.locator('#tab-body .run-list tbody tr').nth(2).click();
await page.waitForTimeout(200);
await page.click('#hud-direct');
await page.waitForTimeout(400);
const toTransition = await page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')));
const tRun = toTransition.runs[2];
const tA = toTransition.nodes.find((n) => n.id === tRun.from).pos;
const tB = toTransition.nodes.find((n) => n.id === tRun.to).pos;
check('the run to a transition pulls in to the elbow and the stub', Math.round(Math.hypot(tB.e - tA.e, tB.n - tA.n, tB.u - tA.u)), (v) => v === 234, '234 (114 elbow + 120 stub)');
check('and its one weld is elbow to transition', await pipeNets(), (v) => v.some((r) => /^90 ELBOW LR \/ TRANSITION JOINT PE\/CS = $/.test(r)), '90 ELBOW LR / TRANSITION JOINT PE/CS, no pipe');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
// His station sheet again: the run drawn just long enough for the elbow and
// the stub, never marked as touching. One weld all the same, not two on one
// spot with one to strike off by hand.
await routeLine('3"\nSTD\nORIGIN 0 0 0\nE 2000\nD 900\nE 234\nEND TRANSITION');
check('a run with no pipe left in it has one weld, fitting to fitting', await pipeNets(), (v) => v.length === 4 && v.some((r) => /^90 ELBOW LR \/ TRANSITION JOINT PE\/CS = $/.test(r)), '4 welds, the last elbow to transition');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

/* ------------------------------------------------- sheets kept in Drive */

// The iPad and the office PC share one folder in Google Drive. Google's
// own pages are stood in for here: the sign-in page by a stub, and the
// Drive files API by a small fake, enough to see every sheet move each way.
const drive = fakeDrive(page);
await page.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/html' }, body: '<title>google-signin-stub</title>stub' }));
await routeLine('3"\nSTD\nORIGIN 0 0 0\nE 3000\nN 1000');
await page.click('#tabs button:has-text("Title")');
await page.fill('[data-meta="project"]', 'Drive Test');
await page.dispatchEvent('[data-meta="project"]', 'change');
await page.waitForTimeout(1200);
await page.click('#tabs button:has-text("Projects")');
await page.waitForTimeout(200);
check('the Projects tab offers Google Drive, asking for a client ID first', await page.locator('[data-editor="drive"] [data-f="drive-client"]').count(), (v) => v === 1, '1');
await page.fill('[data-f="drive-client"]', '123.apps.googleusercontent.com');
await page.click('[data-a="drive-connect"]');
await page.waitForURL(/accounts\.google\.com/, { timeout: 5000 });
const signIn = new URL(page.url());
check('signing in goes to Google for a token, back to this page', `${signIn.searchParams.get('client_id')} ${signIn.searchParams.get('response_type')} ${signIn.searchParams.get('scope')}`, (v) => v === '123.apps.googleusercontent.com token https://www.googleapis.com/auth/drive.file', 'client id, token, drive.file');
check('and sends it back to the page itself', signIn.searchParams.get('redirect_uri'), (v) => v === `file://${process.cwd()}/dist/`, 'the app page without index.html');
await page.goto(`${APP}#access_token=tok1&token_type=Bearer&expires_in=3600&state=${signIn.searchParams.get('state')}`);
await page.waitForTimeout(1500);
const keptCount = await page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.library.v1')).length);
check('back with a token, the address is tidied and every kept sheet goes up', `${page.url().includes('access_token')} ${[...drive.files.values()].filter((f) => f.mimeType === 'application/json').length}`, (v) => v === `false ${keptCount}`, `no token in the address, ${keptCount} files in Drive`);
check('in a folder of its own, named for the sheet', [...drive.files.values()].map((f) => f.name).join('|'), (v) => /Isometric Piping/.test(v) && /Drive Test - sheet 1 of 1 \[/.test(v), 'Isometric Piping, Drive Test - sheet 1 of 1 […]');
check('and the tab says so', await page.locator('[data-editor="drive"]').innerText(), (v) => /Signed in/.test(v) && new RegExp(`${keptCount} up, 0 down`).test(v), `Signed in … ${keptCount} up, 0 down`);
const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.library.v1')));
const fromPc = JSON.parse(JSON.stringify(kept[0].drawing));
fromPc.id = 'dother';
fromPc.meta.project = 'From PC';
drive.seed(fromPc, Date.now());
const edited = JSON.parse(JSON.stringify(kept[0].drawing));
edited.meta.lineNumber = 'PC-EDIT';
const myFile = [...drive.files.values()].find((f) => f.appProperties?.isoId === edited.id);
myFile.appProperties.savedAt = String(Date.now() + 10000);
myFile.content = JSON.stringify(edited);
await page.click('[data-a="drive-sync"]');
await page.waitForTimeout(1200);
check('a sync brings down a sheet the other device made, and a newer copy of this one', await page.locator('#hud').innerText(), (v) => /Drive: 2 down/.test(v), 'Drive: 2 down.');
check('the other sheet is in the projects list', await page.locator('#tab-body').innerText(), (v) => /From PC/.test(v), 'From PC');
await page.click('#tabs button:has-text("Title")');
check('and the sheet on screen took the newer copy', await page.inputValue('[data-meta="lineNumber"]'), (v) => v === 'PC-EDIT', 'PC-EDIT');
await page.click('#tabs button:has-text("Projects")');
await page.click('[data-remove-sheet="dother"]');
await page.waitForTimeout(200);
await page.click('.dialog-backdrop [data-confirm]');
await page.waitForTimeout(300);
await page.click('[data-a="drive-sync"]');
await page.waitForTimeout(1000);
check('a sheet forgotten here goes out of Drive, and nothing comes back down', `${[...drive.files.values()].some((f) => f.appProperties?.isoId === 'dother')} ${(await page.locator('#hud').innerText()).match(/Drive:[^\n]*/)?.[0]}`, (v) => v === 'false Drive: 1 removed.', 'dother gone, "Drive: 1 removed."');
// Save, with Drive set up, saves there rather than to a file on this device.
const uploadsBefore = drive.state.calls.filter((c) => /upload/.test(c)).length;
await page.click('#tabs button:has-text("Title")');
await page.fill('[data-meta="lineNumber"]', 'SAVED-1');
await page.dispatchEvent('[data-meta="lineNumber"]', 'change');
await page.waitForTimeout(200);
await page.click('#save');
await page.waitForTimeout(1200);
check('Save puts the sheet in Drive once Drive is set up', `${drive.state.calls.filter((c) => /upload/.test(c)).length > uploadsBefore} ${(await page.locator('#hud').innerText()).includes('Saved to Google Drive')}`, (v) => v === 'true true', 'an upload, and "Saved to Google Drive."');
check('and Drive has the edit', [...drive.files.values()].some((f) => /SAVED-1/.test(f.content ?? '')), (v) => v === true, 'SAVED-1 in a file');
await page.click('#tabs button:has-text("Projects")');
await page.waitForTimeout(200);
drive.state.deny401 = true;
await page.click('[data-a="drive-sync"]');
await page.waitForTimeout(800);
check('a sign-in that has run out is said so, and offered again', `${(await page.locator('#hud').innerText()).match(/Google Drive[^\n]*/)?.[0]} | ${(await page.locator('[data-editor="drive"] .btn-row').innerText()).replace(/\n/g, ' ')}`, (v) => /asks for a sign-in again/.test(v) && /Sign in and sync/.test(v), 'asks for a sign-in again; Sign in and sync');
drive.state.deny401 = false;
// The 401 was asked for: the browser's own note of it is not an error of ours.
for (let i = consoleErrors.length - 1; i >= 0; i -= 1) if (/401/.test(consoleErrors[i])) consoleErrors.splice(i, 1);
await page.unroute('https://www.googleapis.com/**');
await page.unroute('https://accounts.google.com/**');
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('iso-draw.drive.')) localStorage.removeItem(k); });

/* -------------------------- the sheet fits, symbols a set size on paper */

// The printed sheet fills its drawing area whatever the on-screen scale, and
// the symbols are the same size on paper for a short line and a long one.
const sheetSymbol = async () => {
  await page.click('#print');
  await page.waitForTimeout(250);
  await page.click('[data-x="preview"]');
  await page.waitForTimeout(600);
  const out = await page.evaluate(() => {
    const svg = document.querySelector('.sheet-preview svg');
    const g = [...svg.querySelectorAll('g[transform]')].find((el) => /scale\(/.test(el.getAttribute('transform')));
    const k = Number(g.getAttribute('transform').match(/scale\(([\d.]+)\)/)[1]);
    const dot = svg.querySelector('circle.joint-bw');
    const note = [...svg.querySelectorAll('text')].map((t) => t.textContent).find((t) => /SCALE/.test(t));
    return { k, r: Number(dot?.getAttribute('r') ?? 0), note };
  });
  await page.click('.dialog [data-close]');
  await page.waitForTimeout(300);
  return out;
};
await routeLine('3"\nSTD\nORIGIN 0 0 0\nE 600\nN 400');
const shortSheet = await sheetSymbol();
await routeLine('3"\nSTD\nORIGIN 0 0 0\nE 30000\nN 12000\nE 20000');
const longSheet = await sheetSymbol();
check('a long line is fitted to the sheet, and says so', longSheet.note, (v) => /FITTED TO SHEET/.test(v), 'SCALE 1:n (FITTED TO SHEET)');
check('and its weld dots are the same size on paper as a short line\'s', Math.abs(longSheet.r * longSheet.k - shortSheet.r * shortSheet.k) / (shortSheet.r * shortSheet.k), (v) => v < 0.02, 'within 2%');
check('though the drawings are at very different scales', shortSheet.k / longSheet.k, (v) => v > 10, 'more than 10×');

/* ----------------------------- a pair of flanges taken out of the line */

// Two flanges bolted in a straight line come out again as a pair, and the
// pipe runs straight through where they were: one run, no joint left.
await routeLine('3"\nSTD\nORIGIN 0 0 0\nE 3000\n+FLG 1200\nN 1000');
const flangedNode = await page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).nodes.find((n) => n.flange)?.id ?? '');
check('a flange put along a run makes a flanged joint', flangedNode !== '', (v) => v === true, 'a point with a flange');
await tapNode(flangedNode);
check('picked, the Delete button offers to remove the flanges', await page.locator('#hud-delete').innerText(), (v) => /Remove flanges/.test(v), 'Remove flanges');
check('and the panel too', await page.locator('#tab-body [data-a="remove-flanges"]').count(), (v) => v === 1, '1');
await page.click('#hud-delete');
await page.waitForTimeout(400);
const afterFlanges = await page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')));
check('the pipe runs straight through: two runs, three points, no flange', `${afterFlanges.runs.length} ${afterFlanges.nodes.length} ${afterFlanges.nodes.some((n) => n.flange)}`, (v) => v === '2 3 false', '2 3 false');
check('and the first run is its full length again', await page.locator('#tab-body .run-list input[data-run-len]').first().inputValue(), (v) => v === '3000', '3000');
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(200);
check('with no weld left where they were', await page.locator('#tab-body').innerText(), (v) => !/FLANGE/.test(v) && /Total 2/.test(v), 'no flange welds, Total 2 (the elbow)');
await page.click('#tabs button:has-text("Route")');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

/* ------------------------------------------ every pipe lettered A, B, C */

// Each length of pipe carries a letter in a box beside it, along the route,
// and the lists name the pipe by that letter.
await routeLine('3"\nSTD\nORIGIN 0 0 0\nEND FLG\nE 3000\n+BALL 1500\nN 2000');
check('every length of pipe has its letter on the drawing', await page.locator('#canvas .pipe-letter-text').evaluateAll((els) => els.map((e) => e.textContent)), (v) => v.join('') === 'ABC', 'A B C');
check('in a box hung beside the pipe, draggable like a balloon', await page.locator('#canvas [data-balloon^="pc:"]').count(), (v) => v === 3, '3');
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(200);
check('the weld list names the pipe at each weld by its letter', await page.locator('#tab-body').innerText(), (v) => /A 1257\.5/.test(v) && /B 1211\.5/.test(v) && /C 1883\.5/.test(v), 'A 1257.5, B 1211.5, C 1883.5');
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(200);
check('and the Items tab has a pipe cut list by letter', await page.locator('#tab-body').innerText(), (v) => /pipe cut list/i.test(v) && /\bA\t3"\t/.test(v) && /1257\.5/.test(v), 'Pipe cut list with A … 1257.5');
await page.click('#tabs button:has-text("Route")');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

/* ------------------------------------------- a reducer asked about first */

// A reducer picked opens a box: its two sizes, which way round, and whether
// to carry on drawing from it. Named by its sizes: CON RED 4" X 2". On an
// open end its far face sits on the end and the line carries on at the new
// size; along a run the run is cut at its far face and the pipe beyond is
// the new size, on through the elbows.
const sizesNow = () => page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).runs.map((r) => r.dn));
await routeLine('4"\nSTD\nORIGIN 0 0 0\nE 3000');
const openEnd = await page.evaluate(() => JSON.parse(localStorage.getItem('iso-draw.drawing.v1')).nodes.find((n) => n.pos.e === 3000).id);
await tapNode(openEnd);
await page.locator('.tool[data-kind="RED_CONC"]').click();
await page.waitForTimeout(300);
check('picking a reducer on an open end asks about it first', await page.locator('.dialog [data-f="red-small"]').count(), (v) => v === 1, '1');
check('offering to carry on drawing from it', await page.locator('.dialog [data-f="red-drawon"]').isChecked(), (v) => v === true, 'checked');
await page.selectOption('.dialog [data-f="red-small"]', 'DN50');
check('and naming it by its sizes as they are picked', await page.locator('.dialog [data-red-name]').innerText(), (v) => v === 'CON RED 4" X 2"', 'CON RED 4" X 2"');
await page.click('.dialog [data-confirm]');
await page.waitForTimeout(400);
check('placed, the next runs are drawn at the small size', await page.inputValue('#dn'), (v) => v === 'DN50', 'DN50');
const redEndBox = await page.locator(`#canvas circle.hit-dot[data-node="${openEnd}"]`).boundingBox();
await penTap(redEndBox.x + redEndBox.width / 2 + 180, redEndBox.y + redEndBox.height / 2 + 104);
check('and the line carries on from its far face, straight, at 2"', await sizesNow(), (v) => v.join(',') === 'DN100,DN50', 'DN100,DN50');
await page.click('#tabs button:has-text("Welds")');
await page.waitForTimeout(200);
const reducerList = await page.locator('#tab-body table tbody tr').allInnerTexts();
check('its two welds are named for it, each the size of its own end', reducerList.filter((r) => /CON RED 4" X 2"/.test(r)).map((r) => r.split('\t')[1]).join(','), (v) => v === '4",2"', '4",2"');
check('with no pipe-to-pipe weld on top of its face', reducerList.some((r) => /PIPE \/ PIPE/.test(r)), (v) => v === false, 'none');
check('and the pipe either side cut to it', reducerList.filter((r) => /CON RED/.test(r)).map((r) => r.split('\t').pop()).join(' | '), (v) => /^A [\d.]+ \| B [\d.]+$/.test(v), 'A … | B …');
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(200);
check('the list carries it by that name', await page.locator('#tab-body').innerText(), (v) => /CON RED 4" X 2"/.test(v), 'CON RED 4" X 2"');
await page.click('#tabs button:has-text("Route")');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
await routeLine('4"\nSTD\nORIGIN 0 0 0\nE 3000\nN 2000');
await page.locator('#canvas [data-run]').first().click({ force: true });
await page.waitForTimeout(200);
await page.locator('.tool[data-kind="RED_ECC"]').click();
await page.waitForTimeout(300);
await page.selectOption('.dialog [data-f="red-small"]', 'DN80');
await page.click('.dialog [data-confirm]');
await page.waitForTimeout(400);
check('along a run, the run is cut at its far face and the line beyond is the small size', await sizesNow(), (v) => v.join(',') === 'DN100,DN80,DN80', 'DN100,DN80,DN80');
const compEl = page.locator('#canvas [data-component]').first();
const compBox = await compEl.boundingBox();
await compEl.dispatchEvent('pointerdown', { bubbles: true, pointerId: 9, pointerType: 'mouse', button: 0, clientX: compBox.x + compBox.width / 2, clientY: compBox.y + compBox.height / 2, isPrimary: true });
await page.waitForTimeout(80);
await compEl.dispatchEvent('pointerup', { bubbles: true, pointerId: 9, pointerType: 'mouse', button: 0, isPrimary: true });
await page.waitForTimeout(300);
check('its panel is headed by its name and offers the two ends and the flow', `${await page.locator('#tab-body h3').first().innerText()} ${await page.locator('#tab-body [data-f="red-dir"]').count()}`, (v) => /ECC RED 4" X 3" 1/i.test(v), 'ECC RED 4" X 3", a flow select');
await page.selectOption('#tab-body [data-f="red-dir"]', 'expand');
await page.waitForTimeout(300);
check('turned round, the sizes either side swap', await sizesNow(), (v) => v.join(',') === 'DN80,DN100,DN100', 'DN80,DN100,DN100');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

check('no console errors', consoleErrors, (v) => v.length === 0, 'none');

await browser.close();

/* ------------------------------------------------------------- sandboxed */

// The app also runs embedded in a viewer that sandboxes it without modals.
// That is where a native confirm() is silently ignored, so the buttons that
// ask a question are exercised there too — running only the local file is
// what let a dead New button ship.
{
  const { writeFile, rm } = await import('node:fs/promises');
  const inner = await readFile('dist/artifact.html', 'utf8');
  await writeFile(
    'dist/_sandbox-page.html',
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{height:100%;margin:0}</style></head><body>${inner}</body></html>`,
  );
  await writeFile(
    'dist/_sandbox-host.html',
    '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style></head>' +
      '<body><iframe src="_sandbox-page.html" sandbox="allow-scripts allow-same-origin"></iframe></body></html>',
  );

  const sandboxBrowser = await chromium.launch(launchOptions);
  const host = await sandboxBrowser.newPage({ viewport: { width: 1400, height: 900 } });
  const ignored = [];
  host.on('console', (m) => {
    if (/Ignored call to/i.test(m.text())) ignored.push(m.text());
  });
  await host.goto(`file://${process.cwd()}/dist/_sandbox-host.html`);
  await host.waitForTimeout(800);
  const frame = host.frames()[1];

  await frame.click('[data-a="load-sample"]');
  await host.waitForTimeout(800);
  check('the app draws inside a sandboxed viewer', await frame.locator('#canvas line.pipe').count(), (v) => v === 5, '5');

  await frame.click('#new');
  await host.waitForTimeout(400);
  check('New asks in the page, not through a blocked dialog', await frame.locator('.dialog-backdrop [data-confirm]').count(), (v) => v === 1, '1');
  await frame.click('.dialog-backdrop [data-confirm]');
  await host.waitForTimeout(600);
  check('New works in a sandboxed viewer', await frame.locator('#canvas line.pipe').count(), (v) => v === 0, '0');
  check('nothing was silently ignored by the sandbox', ignored, (v) => v.length === 0, 'no ignored calls');

  await sandboxBrowser.close();
  await rm('dist/_sandbox-page.html', { force: true });
  await rm('dist/_sandbox-host.html', { force: true });
}

console.log(`\nscreenshots and sheet in ${out}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall checks passed');

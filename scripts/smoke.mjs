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
check('the palette carries the fittings, ball valves, tee, olets and marks', await page.locator('.tool').count(), (v) => v === 16, '16');
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
check('a butt welded cap shows its body', await page.locator('#canvas .node .sym-hollow').count(), (v) => v >= 1, 'at least 1');

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
  await page.locator('#canvas circle.hit-dot[data-node]').nth(i).click({ force: true });
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
const reducerWelds = (await page.locator('#tab-body').innerText().then((t) => t.match(/PIPE \/ CONCENTRIC REDUCER/g) ?? [])).length;
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
check('at 1:15 to begin with', await page.locator('#sheet-scale').inputValue(), (v) => v === '15', '15');
await page.selectOption('#sheet-scale', '50');
await page.waitForTimeout(400);
const coarser = await tagBox();
check('a coarser scale makes the symbols bigger against the pipe', coarser / smallSymbol, (v) => Math.abs(v - 50 / 15) < 0.05, `${(50 / 15).toFixed(2)}x`);
await page.click('[data-x="preview"]');
await page.waitForTimeout(600);
check('and the sheet says which scale it is at', await page.locator('.sheet-preview').innerText(), (v) => /SCALE 1:50/.test(v), 'SCALE 1:50');
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
check('and called out by name', await page.locator('#canvas .component text.sym-text', { hasText: 'SUPPORT' }).count(), (v) => v === 1, '1');
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
check('the support name is drawn beside it', await page.locator('#canvas .component text.sym-text', { hasText: 'SUPPORT B' }).count(), (v) => v === 1, '1');
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
check('with a number keypad beside it', await page.locator('.dim-keypad button').count(), (v) => v === 12, '12');
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
check('at the chosen sheet size', await page.evaluate(() => document.getElementById('print-page')?.textContent), (v) => /size: 297mm 210mm/.test(v), '@page size 297mm 210mm');
await page.emulateMedia({ media: 'print' });
check('on paper the app is hidden', await page.evaluate(() => getComputedStyle(document.getElementById('app')).display), (v) => v === 'none', 'none');
check('and the sheet is shown', await page.evaluate(() => getComputedStyle(document.getElementById('print-root')).display), (v) => v === 'block', 'block');
await page.emulateMedia({ media: 'screen' });
check('on screen the sheet stays out of the way', await page.evaluate(() => getComputedStyle(document.getElementById('print-root')).display), (v) => v === 'none', 'none');

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

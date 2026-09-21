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
  pipes: document.querySelectorAll('#canvas .pipe').length,
  joints: document.querySelectorAll('#canvas .joint-bw').length,
  dims: document.querySelectorAll('#canvas .dim').length,
  components: document.querySelectorAll('#canvas .component').length,
}));
check('example line draws pipe runs', drawn.pipes, (v) => v === 5, '5');
check('joint marks are drawn', drawn.joints, (v) => v > 10, 'more than 10');
check('dimensions are drawn', drawn.dims, (v) => v === 5, '5');
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
const weldTable = await page.locator('#tab-body').innerText();
check('welds are numbered plainly', weldTable, (v) => /\bW1\b/.test(v), 'W1');
check('no shop or field column', weldTable, (v) => !/SHOP|FIELD/.test(v), 'neither word');

// Draw a run with the mouse.
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(200);
const before = await page.locator('#tab-body .run-list tbody tr').count();
// Pick a point that sits well inside the canvas so the drag has room.
const canvasBox = await page.locator('#canvas').boundingBox();
const handles = await page.locator('#canvas circle.hit-dot[data-node]').all();
let node = null;
for (const handle of handles) {
  const box = await handle.boundingBox();
  if (!box) continue;
  if (box.x > canvasBox.x + 40 && box.x + 220 < canvasBox.x + canvasBox.width && box.y + 160 < canvasBox.y + canvasBox.height) {
    node = box;
    break;
  }
}
if (!node) throw new Error('no point available inside the canvas to drag from');
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
check('the palette carries the fittings, ball valves, tee and olets', await page.locator('.tool').count(), (v) => v === 15, '15');
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
check('not-to-scale mode still draws', await page.locator('#canvas .pipe').count(), (v) => v === 6, '6');
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
check('drawing survives a reload', await page.locator('#canvas .pipe').count(), (v) => v === 6, '6');

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

// New must actually clear the drawing, and must keep the job details.
await page.click('#tabs button:has-text("Title")');
await page.waitForTimeout(250);
await page.fill('[data-meta="project"]', 'Carried Over');
await page.fill('[data-meta="lineNumber"]', '6"-P-9999');
await page.locator('[data-meta="lineNumber"]').blur();
await page.waitForTimeout(300);
await startNewDrawing();
check('New clears the route', await page.locator('#canvas .pipe').count(), (v) => v === 0, '0');
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

// A flange on the end does not stop the line: it carries on through.
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
await page.mouse.move(flangedEnd.x + 140, flangedEnd.y - 82, { steps: 10 });
await page.waitForTimeout(200);
await page.mouse.click(flangedEnd.x + 140, flangedEnd.y - 82);
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
  'and the flange is no longer counted as an end',
  await page.locator('#tab-body').innerText(),
  (v) => !/WELD NECK FLANGE/.test(v),
  'no end flange',
);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

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
  check('the app draws inside a sandboxed viewer', await frame.locator('#canvas .pipe').count(), (v) => v === 5, '5');

  await frame.click('#new');
  await host.waitForTimeout(400);
  check('New asks in the page, not through a blocked dialog', await frame.locator('.dialog-backdrop [data-confirm]').count(), (v) => v === 1, '1');
  await frame.click('.dialog-backdrop [data-confirm]');
  await host.waitForTimeout(600);
  check('New works in a sandboxed viewer', await frame.locator('#canvas .pipe').count(), (v) => v === 0, '0');
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

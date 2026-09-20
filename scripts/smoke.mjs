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

check('empty hint shown on a blank drawing', await page.locator('#empty-hint').isVisible(), (v) => v === true, 'true');

// Route the example line through the command language.
await page.click('[data-a="load-sample"]');
await page.waitForTimeout(500);

const drawn = await page.evaluate(() => ({
  pipes: document.querySelectorAll('#canvas .pipe').length,
  welds: document.querySelectorAll('#canvas .weld').length,
  dims: document.querySelectorAll('#canvas .dim').length,
  components: document.querySelectorAll('#canvas .component').length,
}));
check('example line draws pipe runs', drawn.pipes, (v) => v === 5, '5');
check('welds are generated', drawn.welds, (v) => v > 10, 'more than 10');
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
await page.locator('#tab-body .pill').first().click();
await page.waitForTimeout(250);
check('a weld can be switched to field', await page.locator('#tab-body .pill.field').count(), (v) => v === 1, '1');

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
check('the palette is cut to the fittings and the ball valves', await page.locator('.tool').count(), (v) => v === 11, '11');
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
check('sheet carries the weld summary', svg, (v) => v.includes('WELD SUMMARY'), 'a weld summary');
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
page.once('dialog', (d) => d.accept());
await page.click('#new');
await page.waitForTimeout(400);
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
page.once('dialog', (d) => d.accept());
await page.click('#new');
await page.waitForTimeout(400);
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', 'DN80\nSTD\nORIGIN 0 0 0\nE 2000\n+GATE\nN 1500\nEND CAP');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);

const dots = () => page.locator('#canvas .joint-bw').count();
const buttWeldDots = await dots();
check('butt welds are drawn as filled dots', buttWeldDots, (v) => v === 5, '5 — two elbow legs, two at the valve, one at the cap');
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
page.once('dialog', (d) => d.accept());
await page.click('#new');
await page.waitForTimeout(400);
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', 'DN80\nSTD\nORIGIN 0 0 0\nE 2000\nMARK t\nE 2000\nGOTO t\nDN50\nN 1500');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);
check('a reducing tee is drawn as its triangle', await page.locator('#canvas .fitting-body').count(), (v) => v === 1, '1');
await page.click('#tabs button:has-text("Items")');
await page.waitForTimeout(300);
check('the reducing tee is taken off with its branch size', await page.locator('#tab-body').innerText(), (v) => /REDUCING TEE 3" x 2"/.test(v), 'REDUCING TEE 3" x 2"');

// A flange picked against the end of a line terminates it; it must not land
// half way along the last run.
page.once('dialog', (d) => d.accept());
await page.click('#new');
await page.waitForTimeout(400);
await page.click('#tabs button:has-text("Command")');
await page.waitForTimeout(200);
await page.fill('#command-text', '3"\nSTD\nORIGIN 0 0 0\nE 2000');
await page.click('[data-a="run-commands"]');
await page.waitForTimeout(500);

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
await page.click('#tabs button:has-text("Route")');
await page.waitForTimeout(300);
await endBoxes[0].h.click();
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

check('no console errors', consoleErrors, (v) => v.length === 0, 'none');

await browser.close();
console.log(`\nscreenshots and sheet in ${out}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall checks passed');

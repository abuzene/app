# Isometric Piping — working notes for the next session

Read this before changing anything. It records who the app is for, how it
ships, and the decisions already taken, so they are not re-litigated.

## Who uses it, and how

- One user: Abu Zene, a fabricator doing welding and NDT work. He writes in
  Hebrew; answer in Hebrew, keep code and commits in English.
- He draws on an **iPad with an Apple Pencil**, in the installed app. Fingers
  pan and pinch; the pencil draws, taps and drags. A finger never lays pipe.
- Reference drawings are his own sheets (`Binder1.pdf`, uploaded during the
  first sessions; crops of pages 1, 16, 25, 33, 39 were used). Every symbol is
  expected to look like those sheets, not like a textbook. When in doubt, crop
  the sheet with pymupdf and compare side by side before changing a symbol.
- Sizes are in **inches**, dimensions in **mm**, weld numbers matter most.
  The sheet carries the PLATINUM logo and an **AS MADE** stamp. Output is
  **print to PDF only** (no SVG/PNG export).

## How it ships

- `npm run app` = typecheck + vite build + `scripts/artifact.mjs` +
  `scripts/pwa.mjs` → `dist/index.html` (installable PWA), `dist/artifact.html`
  (for the claude.ai artifact viewer), `sw.js`, manifest, icons.
- **GitHub Pages** publishes `dist/` from `main` only
  (`.github/workflows/pages.yml`); the `github-pages` environment rejects
  other branches. Live address: https://abuzene.github.io/app/. The installed
  app shows "New version ready — tap to reload" when a new build lands.
- Work happens on a `claude/...` branch. To update the installed app,
  fast-forward `main` to the branch head (`git push origin HEAD:main`); ask
  the user first unless he asked for the app to be updated.
- The claude.ai artifact https://claude.ai/artifact/JynwwYBpekzacDactAHym2
  is republished from `dist/artifact.html` after every change (use `url`).
- Drawings are stored in the browser's localStorage under
  `iso-draw.drawing.v1` (autosave of the current drawing) and exported with
  Save as `<name>.iso.json`; Open reads them back. Nothing is on a server.
  Every drawing worth keeping (a route or a name) also goes into the
  **library** (`iso-draw.library.v1`, `src/model/library.ts`, up to 80
  entries, keyed by `drawing.id`), grouped by `meta.project` in the
  **Projects** tab: five most recent projects, "show all", open/remove a
  sheet, and **New sheet in this project** (`newSheetInProject` in main.ts:
  title block carried over, sheets renumbered "k of n", the picked open end
  marked `CONT. ON SH.n`, the new sheet starting from a point marked
  `CONT. FROM SH.k`).

## Before every push

- `npm run app`, then `npm run smoke` (Playwright, ~5 min, ~236 checks). Run
  it in the background with a **fresh log name per run** and wait for its
  final line ("all checks passed" or "check(s) failed"); a shared log name
  once mixed two runs. Never `pkill -f` (it kills the shell), and do not
  wait with `pgrep -f smoke.mjs` (it matches the waiting shell itself). It
  needs `dist/artifact.html`, so build with `npm run app`, not
  `npm run build`, before it.
- Reproduce every complaint with a Playwright screenshot (a script in
  `scripts/_shot.mjs`, deleted before commit; `deviceScaleFactor` + `clip`
  for close-ups; pen via CDP `Input.dispatchMouseEvent` with
  `pointerType: 'pen'`, fingers via `Input.dispatchTouchEvent`).
- Test at an iPad viewport (1180×820 / 1366×1024) as well as desktop.

## Decisions already taken (do not undo)

- Symbols, tags, balloons and lettering are a **set size on the sheet**
  (`sheetScale` option, default 1:15; `symbolSizeFor`, `SYMBOL_MM`). They do
  not scale with pipe length or zoom. Valves too (`faceReach` is capped).
- Fitting reach is fixed (`FITTING_REACH`); weld marks sit on the symbol's
  end and are part of it — no line between dot and symbol.
- A flange **breaks the line** (`node.flange`, flanged joint). Continuing
  past a flange goes straight only. Ending a run with a flange draws that
  flange alone; a dashed mating flange appears only for a blind/equipment.
- **One balloon per item number**; balloons and weld tags (rounded boxes)
  are on thin leaders and are **draggable** (`itemOverrides`,
  `weldOverrides[key].tag`). Support callouts drag the same way
  (`itemOverrides['sup:<id>']`).
- Weld numbers are editable (typed on the drawing or in the Welds tab). A
  joint can be marked **not welded** (`weldOverrides[key].skip`: hollow
  mark, no number, numbering runs on, off the list; "No weld here" on the
  weld keypad, "Weld after all" in the Welds tab).
- **Dimensions** are moved by dragging their figure (`dimOverrides[key]`
  `offset`/`along`, the figure's hit carries the frame) and hidden with the
  keypad's "Hide this dimension"; the run panel's Dimension: show clears it.
- A run can be **fittings joined directly** (`run.direct`, HUD "No pipe —
  fittings touch", panel Pipe select, `setRunDirect`): pulled in to the sum
  of the take-outs, one weld mid-run "ELBOW / OLET", cut 0, no pipe on the
  list.
- Dimensions are typed on the drawing: tap the figure. The editor opens on
  **pointerdown** (iOS only shows a keyboard inside the touch gesture) with a
  **keypad** beside it, above the tap, and the canvas captures the pointer so
  the lift is not lost (a lost lift once turned every later tap into a
  pinch — `onPointerGone` in canvas.ts guards this).
- Not-to-scale mode draws each run at its tapped length (`run.visual`);
  handles on a picked run stretch it without turning it.
- Lines never overlap (`overlapsExisting`); crossings gap the rear line.
- Toolbar Joint select (BW/SW/THD) sets the picked point's joint, else the
  drawing default. SW marks' lips point back over the pipe. In SW/THD mode
  a flanged valve gets SW/THD flanges (`valveFlangeKind`).
- PE/CS transition: weld on the CS side, six dashes on the PE side; it ends
  the steel.
- Palette (`src/ui/tools.ts`): Flanges WN/SW/Thd/Blind (SO and Lap removed
  on request), Fittings, Valves (Ball, Ball air), Branch (tee, olets), Marks
  (Support, L50 support, AG/UG), Joints (a BW weld: `placeWeld` splits the
  run at a plain point, welded pipe to pipe, dimension opened). Two columns
  on tablets so all fit.
- **Closing a gap**: drawing from an open end and tapping an open end of
  **another piece** (`samePiece`) joins them (`connectNodes` in edit.ts, `onConnect`): one run when they lie
  on a line, else legs round a corner, the way with the fewest turns
  (straight out of / into the ends where possible), refused if it would lie
  along a line already drawn. Elbows come from the turns as usual. Tapping
  any other point while drawing still just moves the pencil there.
- **Pipe net** (Welds tab column, `Analysis.pieces`, `PipePiece`, `ROOT_GAP`
  = 2.5 mm): every length of pipe between its welds as cut: take-outs off
  and a 2.5 mm root gap off at each BW weld to a fitting/valve/flange/cap.
  Pipe-to-pipe welds take no gap (his spec: "from every fitting"), the
  header takes nothing at an olet and runs through it as one piece (merged
  in `analyse`; the header weld shows that whole length). Copy list carries
  the column.
- Supports and the AG/UG mark are **notes, not material**: no BOM line, no
  welds. Supports are numbered along the line unless named.
- Printing happens from the page itself (`#print-root`, `@page` size); a
  hidden iframe printed blank on iPad. On desktop the sheet is **pinned**
  (`position: fixed`, 100%/100%) to the page box. On a tablet
  (`tabletPrinter`, `#print-root.tablet`) it is laid out **in the flow at
  95% width, height auto** (from his PDFs: iOS keeps ~5% side margins and
  a ~6% footer strip, and honours `@page size` since Safari 17). iOS prints
  nothing that is pinned (blank page),
  keeps its own margins and footer, ignores `@page`, and its vh is not the
  printable height (a 100vh sheet spilled on to a second page). The print
  dialog has a **Paper** choice (landscape / upright, upright by default on
  a tablet); upright turns the sheet itself (a rotated `<g>` in a portrait
  viewBox). A tablet gets **both** sheets (`.sheet-land`/`.sheet-port`),
  shows the expected one, and the print `orientation` media query (scoped
  to `.tablet`) overrides it with the paper's real orientation, since iOS
  ignores `@page size` and its own dialog decides the paper. Never use that
  query for desktop: Chromium evaluates it before applying `@page size`.
- **PDF sheet** (`makePdfSheet`/`sheetToPdf`/`assemblePdf` in main.ts): the
  sheet drawn onto a canvas at up to 240 dpi and written by hand into a
  one-page, one-image PDF (Flate, JPEG fallback) at the sheet's own size,
  handed to the share sheet (`navigator.share` with files) or downloaded.
  This is the way to a printout with the sheet's own 5 mm margins on iPad:
  its printer dialog always adds ~13 mm margins and a URL footer. It is the
  primary button on tablets; browser Print stays for desktop.
- The toolbar pads for the iPad status bar (`env(safe-area-inset-top)`).

## Where things live

- `src/model/` — types, `drawing.ts` (analysis: joints, BOM, items, layout),
  `edit.ts` (route/split/stretch/flange joints), `commands.ts` (text
  commands, aliases), `pipe-data.ts` (sizes, take-outs, valve face-to-face).
- `src/render/` — `symbols.ts` (every symbol, in a 3-axis `Frame`),
  `renderer.ts` (the drawing SVG and hit targets), `sheet.ts` (printed
  sheet), `style.ts` (shared CSS in paper units).
- `src/ui/` — `canvas.ts` (pointer handling), `tools.ts` (palette),
  `panels.ts` (side panel tabs), `src/main.ts` (host, editors, print, PWA).
- `scripts/smoke.mjs` — the regression suite; add a check for every fix.
- `reference/symbols.svg` — legend generated by `npm run symbols`.

## Ideas not yet done

- Own domain for the app (CNAME on GitHub Pages) or hosting on Hostinger.
- Saving drawings somewhere other than the device (Drive, email via n8n).
- Slopes/skewed runs are not supported; runs are orthogonal.

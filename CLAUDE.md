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
  (`sheetScale` option, default 1:15; `symbolSizeFor`, `SYMBOL_MM` = 2.4 mm
  half-size). They do not scale with pipe length or zoom. Valves too
  (`faceReach` is capped). The **printed sheet always fits** the drawing to
  its area (`renderSheet`: `k` from the fit, `symbol = SHEET_SYMBOL_MM / k`
  passed as `RenderState.symbol`; `SHEET_SYMBOL_MM` = 1.35 × `SYMBOL_MM`,
  ≈3.2 mm, since he asked for bigger fittings on the PDF), so symbols are the same size on paper for a
  short line and a long one, and the note reads "SCALE 1:R (FITTED TO
  SHEET)". The dialog's scale ("On-screen scale") sizes symbols against
  the pipe on screen only. He asked for this after a long line printed
  with tiny symbols. Dimension figures (`.dim-text` 1.15 × symbol) and
  weld numbers (`.weld-no` 1.0 ×, bold, in a box 1.55 × tall) are set
  large on his request; balloons stay at 0.72 ×.
- Fitting reach is fixed (`FITTING_REACH`); weld marks sit on the symbol's
  end and are part of it — no line between dot and symbol.
- A flange **breaks the line** (`node.flange`, flanged joint). Continuing
  past a flange goes straight only. Ending a run with a flange draws that
  flange alone; a dashed mating flange appears only for a blind/equipment.
  A flanged joint picked shows **Remove flanges** on the HUD Delete button
  and in the panel: `removeFlangeJoint` in edit.ts takes the pair out and
  merges the two collinear runs into one (inline items re-offset, visual
  lengths summed), leaving no joint; on a turn only the flanges go.
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
  list. A run with **no pipe left** in it (take-outs, including a terminal
  flange/transition, use it all; no inline items) counts as touching
  automatically (`touching` set in `analyse`): one weld named for both ends,
  never two welds on one spot.
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
  A pipe-to-pipe BW weld takes its 2.5 mm off one of the two pieces (the
  first in route order; he said "one of them, whichever"), the header
  takes nothing at an olet and runs through it as one piece (merged
  in `analyse`; the header weld shows that whole length). Copy list carries
  the column. The printed sheet has the same as a **WELD LIST — PIPE CUT**
  table under the weld summary (`weldList` in sheet.ts), as many rows as the
  column has room for, then "AND n MORE".
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

## How he actually draws (learned from his sheets)

- His **Station_test** sheet (3" SCH40): a WN flange at the start, two
  flanged ball valves (one air actuated) in a straight run with a
  threadolet branch between them, two L-supports, then an elbow down
  (with the AG/UG mark on the vertical) to an elbow and a PE/CS transition
  with **no pipe between** them. Printed from the **PDF sheet** button,
  A3 landscape. Expect lines like this: short, real, every joint matters.
- He draws with the pen, then edits by typing dimensions on the drawing.
  A run "just long enough" for its fittings is normal for him (elbow
  straight onto a transition, elbow onto an olet); the app must treat it
  as one weld, never two on a spot.
- He reads the **weld list** as a cut list: weld number, what it joins,
  and the pipe's net length. Wrong names there ("PIPE / BALL VALVE" at a
  flanged valve) are bugs to him, not cosmetics.
- His feedback comes as a PDF with weld numbers named ("W2, W3 should be
  …"). Render it with pymupdf at 200 dpi for the column and **900 dpi**
  round the weld in question: a hollow circle beside a dot is a joint he
  struck off by hand, which usually means the app put two welds on one
  spot.

## Welds: how they are made and named (`analyse` in drawing.ts)

- Every place pipe meets something is a joint with a stable key:
  `n:<node>:<run>` a fitting leg (elbow/tee), `n:<node>` pipe to pipe,
  `n:<node>:term` a line end (flange, cap, transition), `n:<node>:flg:<run>`
  a flanged joint, `n:<node>:header` / `n:<node>:branch` an olet,
  `c:<comp>:0|1` the two sides of an inline item, `d:<run>` the one weld
  of a run whose fittings touch. `weldOverrides` (number, skip, tag) hang
  off these keys, so keys must not change shape.
- Names are "what the pipe meets": `PIPE / 90 ELBOW LR`, `PIPE / WELD NECK
  FLANGE` at a flanged valve (never the valve), `HEADER / THREADOLET`,
  `BRANCH / WELDOLET`, `PIPE / TRANSITION JOINT PE/CS`; a touching run
  names both ends, `90 ELBOW LR / TRANSITION JOINT PE/CS`.
- Numbered W1… along the route (run order, then distance); THD joints and
  skipped ones are marked but unnumbered. A transition is welded on its
  CS side only.
- Take-outs: `fittingTakeout` (elbow/tee by size), `componentTakeout`
  (valves face-to-face/2 + flange length when flanged, WN flange length,
  transition stub 120), `oletTakeout` (branch only; header loses nothing).

## Reproducing a sheet quickly (Command tab, used by the smoke)

```
3"            size (also DN80, 1 1/2")      STD | SCH40 | XS  schedule
E 3000        route (N S E W U D)           ORIGIN 0 0 0
+BALL 1500    valve at 1500 (+BALLAIR, +FLG 200, +RED, +ECC)
MARK t / GOTO t   a tee at t                END FLG | CAP | BLIND | TRANS | CONT
```
Olets and the touching flag are palette/HUD only: `.tool[data-olet="BW"]`
with a run selected, then route the branch; `#hud-direct` with a run
selected. Welds tab rows: `#tab-body table tbody tr` (No. is an input, so
innerText starts with a tab). In scripts select points by dispatching
`pointerdown`/`pointerup` on `circle.hit-dot[data-node]`; a plain click
can land on a weld tag or on a handle a redraw replaced.

## Where things live

- `src/model/` — types, `drawing.ts` (analysis: joints, BOM, items, layout),
  `edit.ts` (route/split/stretch/flange joints), `commands.ts` (text
  commands, aliases), `pipe-data.ts` (sizes, take-outs, valve face-to-face).
- `src/render/` — `symbols.ts` (every symbol, in a 3-axis `Frame`),
  `renderer.ts` (the drawing SVG and hit targets), `sheet.ts` (printed
  sheet), `style.ts` (shared CSS in paper units).
- `src/ui/` — `canvas.ts` (pointer handling), `tools.ts` (palette),
  `panels.ts` (side panel tabs), `src/main.ts` (host, editors, print, PWA).
- `scripts/smoke.mjs` — the regression suite (~304 checks); add a check
  for every fix, in a section named for the complaint.
- `reference/symbols.svg` — legend generated by `npm run symbols`.

- **Google Drive sync** (`src/model/drive.ts`, Projects tab "Google Drive"
  section): OAuth **implicit flow by full-page redirect** (no popup, no
  server, no secret; `response_type=token`, scope `drive.file`), token in
  localStorage (`iso-draw.drive.*`, ~1 h; a 401 signs out and offers "Sign
  in and sync"). Needs his own OAuth **Web application** client ID from
  Google Cloud, pasted once in the tab (origin `https://abuzene.github.io`,
  redirect URI `https://abuzene.github.io/app/`, `driveRedirectUri()` strips
  `index.html`). One folder "Isometric Piping", one file per sheet named
  `<project> - <line> - sheet k of n [<id>].iso.json`, `appProperties`
  `{isoId, savedAt}`. `syncDrive` merges by `savedAt` exactly (stamps are
  carried across verbatim, so equal means the same copy; a slack once
  swallowed a save made within 2 s of a sync): newer copy each way, missing goes over, a sheet removed here (tombstones
  `iso-draw.drive.removed`) is deleted there. `upsertDrawing` keeps the old
  stamp when the content is unchanged, so a copy taken from Drive is not
  bounced back, and stamps an edit at least 1 ms past the copy it was made
  from, so a device whose clock runs behind still wins with its edit. Syncs at start when the token is still good and on "Sync
  now"; the on-screen sheet is replaced if a newer copy came down. The
  smoke stands in for Google with `scripts/fake-drive.mjs` (page.route on
  googleapis.com) and a stub for accounts.google.com. **Save** goes to
  Drive once a client ID is set (connected: sync + "Saved to Google
  Drive."; expired: the sign-in page); a `.iso.json` download only where
  Drive is not set up. He set his own Google Cloud project up on
  2026-09-22 and is signed in on the PC.

## Ideas not yet done

- Own domain for the app (CNAME on GitHub Pages) or hosting on Hostinger.
- Sending drawings by email (n8n); Drive is done.
- Slopes/skewed runs are not supported; runs are orthogonal.
- Selling it: no runtime dependencies (vanilla TS, MIT-style dev tools
  only), the PLATINUM logo is his company's; per-user Drive needs the
  OAuth consent screen published (drive.file is non-sensitive, no
  verification), a domain, and some way to hand out the client ID.

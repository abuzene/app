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
  The sheet carries the PLATINUM logo and a **stamp**: AS MADE, FOR
  APPROVAL or APPROVED FOR CONSTRUCTION (`meta.stamp`, unset = AS MADE;
  `SHEET_STAMPS`/`sheetStamp`/`stampBox` in sheet.ts, a long label set
  smaller to fit an A4 box), picked in the Title tab (`[data-meta="stamp"]`)
  or the print dialog (`#sheet-stamp`); his ask, 2026-09-24. Output is
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

- Symbols, tags, balloons and lettering are a **set size against the
  pipe** (`sheetScale` option, default 15 = "100%"; `symbolSizeFor`,
  `SYMBOL_MM` = 2.4 mm half-size). They do not scale with pipe length or
  zoom. Valves too (`faceReach` is capped). **View → Symbols**
  (`#opt-symbols`, 53%…220% = sheetScale 8…33, `syncSymbolSelect` in
  main.ts) and the print dialog's "Symbols against the pipe" set it.
  The **printed sheet keeps the screen's proportions** (his complaint,
  2026-09-24: "on screen it looks good, printed the pipe comes out
  stretched"): `renderSheet` → `fitSheet` in sheet.ts uses the screen's
  symbol size (`sheetSymbolAt`), clamped on the paper to at least
  `SHEET_SYMBOL_MM` (1.35 × `SYMBOL_MM`, ≈3.2 mm; a long line once
  printed with tiny symbols) and at most `SHEET_SYMBOL_MAX_MM` (1.7 ×
  that). It fits **everything drawn** to the area — labels, dimensions,
  balloons — by measuring the rendered content with `getBBox` in a
  hidden SVG (`measureContent`, the `.hits` groups removed) and fitting
  again (up to three passes), so bigger lettering never runs off the
  frame. The note reads "SCALE 1:R (FITTED TO SHEET)". Dimension figures
  (`.dim-text` 1.15 × symbol) and weld numbers (`.weld-no` 1.0 ×, bold)
  are set large on his request; balloons stay at 0.72 ×. The weld
  number's box is **as tight as it reads** (`weldTagSize` in tidy.ts,
  used by the renderer and Tidy alike: width from the characters, a dot
  or space narrow, W wide, plus 0.55 symbol; 1.3 tall; his ask,
  2026-09-26: "the rectangle as small as it can be").
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
  `weldOverrides[key].tag`). `analysis.items` holds **every** place an item
  is (`ItemInstance.line` = list line key); the renderer picks one per
  line: `drawing.balloons[line]` `{ at: instanceKey }` or `{ hidden }`,
  else the place whose balloon lands farthest from figures, weld tags and
  balloons already put down (capped at six radii, so the first place wins
  when all have room). Dragging a balloon pins it to that place. Items tab:
  a per-line select (`[data-balloon-at]`: room / each place "E N U" / none);
  point and item panels: "Balloon n here" / "No balloon n" buttons
  (`[data-a="balloon-here"]`, `[data-a="balloon-off"]`). Support callouts drag the same way
  (`itemOverrides['sup:<id>']`).
- Weld numbers are editable (typed on the drawing or in the Welds tab). A
  joint can be marked **not welded** (`weldOverrides[key].skip`: hollow
  mark, no number, numbering runs on, off the list; "No weld here" on the
  weld keypad, "Weld after all" in the Welds tab).
- **Dimensions** are moved by dragging their figure (`dimOverrides[key]`
  `offset`/`along`, the figure's hit carries the frame) and taken off with
  the keypad's "Delete this dimension" (his word, 2026-09-23; still
  `hidden: true`, so off the drawing and the sheet; the run panel's
  Dimension: show brings it back).
- **Tidy** (toolbar `#tidy`, `tidyDrawing` in main.ts, `tidyLayout` in
  `src/render/tidy.ts`; his ask, 2026-09-23): lays out every dimension,
  weld tag, balloon and pipe letter so nothing clashes, close to the pipe,
  in one undo step, written as ordinary overrides (`dimOverrides`,
  `weldOverrides[k].tag`, `itemOverrides` + `balloons[line].at` pinned,
  `pc:` letters, cleared when the default spot is free) so all can still
  be dragged. The renderer hands over what is drawn through
  `RenderState.collect` (`LayoutSpecs`: pipes, symbol/weld points, fixed
  texts such as equipment names and run notes, dims, tags, balloons,
  letters); every shape is a capsule. Dimensions go first in **rows**:
  collinear, non-overlapping pieces (a run broken at valves) share one
  offset, a chain total or olet location its own row further out; nearest
  free row, away from the drawing's middle if it can. Then labels on
  leaders: 16 directions at growing reach, square off the pipe preferred,
  leaders kept off pipes and each other. Laid out at the larger of the
  on-screen and printed symbol size (`sheetSymbolSize` in sheet.ts), so it
  holds on the PDF too. A to-scale sheet with a 19 m pipe still crowds
  its fittings into a corner: nothing tidy can do but spread them.
  **Lines kept from crossing** (his ask, 2026-09-26, HILLEL sheet 4: "see
  how lines cross and lie on each other"): each leader is judged as it is
  drawn — a pipe's balloon or letter from the nearest point of its pipe
  (`feet`, the run's drawn segments, from the renderer), a tag from its
  weld; dimensions carry their whole line past the end ticks and their
  extension lines (`labelsOnly`, obstacles for labels, not for other
  dimensions); against a pipe only a real crossing counts, and symbols
  right by a leader's own point are ignored (at a tee every spot was
  "hit" and real crossings slipped through). Clashes are **weighted** by
  what they fall on (`UNDER_BOX`, `ACROSS`): lettering, labels and pipes
  worst, a dimension line next, another leader, a dashed extension line
  least. 24 directions, reaches out to 12 symbols, then three passes
  placing each label again against all the rest. Dimension rows start 3
  symbols off the pipe so the **pipe letter** fits between, and a letter
  may sit anywhere along its pipe, close beside it with no leader
  (`besideAlong`; the renderer draws no leader within `LETTER_BESIDE`).
  **Line-end notes** ("CONT. FROM SH.1", `node.terminal.note`) are
  dragged with the pen like a balloon (`itemOverrides['en:<node>']`, the
  text centred there, a leader back to the end once moved; his ask,
  2026-09-26) and placed by Tidy as a label (`LayoutSpecs.notes`, left at
  home when that is clear). A reducing tee's note is a fixed text for it; the tee's note is set along the header off the tee, clear
  of the extension lines that leave the tee.
  A tag or balloon dragged over a figure sits above its target and once
  made the figure untappable ("the 468 won't let me edit it",
  2026-09-23): `buriedFigure` in canvas.ts looks through the element
  stack under the pointer and gives a tap within ~16 px of a figure's
  centre to the figure — and only when the tap is nearer the figure's
  centre than the tag's own (zoomed out, a dashed run's note sat within
  16 px of the run's figure and every tap on it went to the figure).
  Do not put `dimHits` on top of the tag layer
  instead: its radius grows with the view, and zoomed out it swallowed
  taps on the pipe.
- A run can be **fittings joined directly** (`run.direct`, HUD "No pipe —
  fittings touch", panel Pipe select, `setRunDirect`): pulled in to the sum
  of the take-outs, one weld mid-run "ELBOW / OLET", cut 0, no pipe on the
  list. A run with **no pipe left** in it (take-outs, including a terminal
  flange/transition, use it all; no inline items) counts as touching
  automatically (`touching` set in `analyse`): one weld named for both ends,
  never two welds on one spot.
- Dimensions are typed on the drawing: tap the figure. The editor opens on
  **pointerdown** (iOS only shows a keyboard inside the touch gesture) with a
  **keypad** above the tap (the box itself is the keypad's top row, so
  what is typed is always in sight: a keypad taller than the 168 px it was
  placed by — its Delete row — once covered the box, "I type the dimension
  and cannot see it", 2026-09-26; placed by its measured height, clear of
  the figure), and the canvas captures the pointer so
  the lift is not lost (a lost lift once turned every later tap into a
  pinch — `onPointerGone` in canvas.ts guards this).
- Not-to-scale mode draws each run at its tapped length (`run.visual`);
  handles on a picked run stretch it without turning it. **Drawn length**
  (`drawnLength`/`minDrawnLength` in drawing.ts, used by `layout`, the
  stretch maths and `slideDrawnTo`): `visual` if set and at least the
  floor, else the true length capped at `schematicLength` (1500); never
  under the floor of six symbols (`SYMBOL_MM × sheetScale × 6`, now
  defined in drawing.ts and re-exported by the renderer). A `visual` under
  the floor is a leftover (`splitRun` shares it in proportion, so a
  reducer's run got 5 mm; a 19 m header once carried 35) and is ignored;
  a drag clamps to the floor. His complaint (HILLEL YAFEH, 2026-09-23):
  the 19 m pipe drawn as a stub, and shortening it "changed the
  dimension" — his sheet was in fact **to scale** (`schematic: false`),
  where a handle drag is the true length by design. Not to scale, each
  piece is laid out from its first node's true position (was the origin,
  so two pieces overlapped), and an equipment box stands on the drawn
  position of the node at its `at`.
- **Items along a run not to scale** (his complaint, 2026-09-24: "spool 8
  is drawn squashed and I can't change its length; the print is fine",
  then "piece C, the same"): with big symbols, two valves on a short
  drawn run lay over each other and the spool between vanished.
  `drawnStations` in drawing.ts (kept per run in `analysis.stations`,
  schematic only) maps true distance along a run to drawn distance
  piecewise: each item (valve/reducer/transition…, not marks) takes its
  symbol's width (1.2 symbols + flange hub each side, none on a bare or
  last-flange-off side), each pipe piece at least 2.5 symbols (+1.4 at an
  end with a fitting/terminal; none where item faces touch, a hub against
  an end flange), the rest shared by true length. `runDrawnFloor` is the
  run's floor (at least `minDrawnLength`); `drawnLength` uses it, as do
  the stretch handles and `slideDrawnTo`. The renderer places items,
  dimension ends, chain dimensions and weld/letter/balloon points through
  `drawnShare`; `offsetFromPaper` in main.ts goes back with `trueAtShare`.
  To scale nothing changes. Lengthening the run (handles) gives the room
  to the pipe pieces. **Dragging an item** reads the pen through the
  stations and run ends as they were when the drag began, laid out
  without the item itself (`slideFrom.stations`/`ends` in main.ts):
  read through the live layout, which changes as the item moves (a gap
  opening adds its minimum), a valve flicked between two places ("it only
  jumps between two points", 2026-09-24). It is **taken hold of where the
  pen went down** (canvas.ts sends that point first, `drag.grabbed`;
  `slideFrom.grab`): it moves by as much as the pen moves, from where it
  stood, so it never jumps on being touched (the layout without it put
  the pen 40 mm off on an iPad-sized screen — "fixed for our case only,
  the other branch still does it").
- **A valve across a point** (his complaint, 2026-09-24, Strauss sheet: "a
  dimension to the centre of the valve"; "I can't pick pipe A between the
  two valves to put an olet"): valves put on an end once sat centred on it
  and the line was drawn on from that point. `uncoverPoints` in edit.ts
  (run on load, in `replaceDrawing` and after every `host.edit`) moves such
  a plain point out to the item's face, flange included, with everything
  beyond (`stretchRun(..., moveEnd)`), so the pipe after it keeps its cut
  length, then joins it through (`joinThrough`) and drops hand dimensions
  to it. `stretchRun` now refuses to make a run shorter than its items
  reach from the end that stays (the clamp left a valve across the end).
  A run whose items leave no pipe is still dimensioned unless all its
  items are reducers (`allItem`). **An olet goes into the pipe tapped**:
  a run selection carries the paper point tapped (`Selection` run `at`,
  set in canvas.ts), and `oletSpot` in tools.ts splits the run in the
  middle of the length of pipe between items that contains it
  (`runOffsetAtPaper` in the renderer), else of the longest one, never
  inside a valve; none left, it says so.
- **A valve's own dimension is typeable** (his ask, 2026-09-24: "dimensions
  from the fittings' centres, but a valve to its flange and the valve on
  its own, never to its centre; and the valve's dimension editable"). A
  run or header is dimensioned node/fitting centre to valve face, the
  valve face to face, and on (`dimensionStops`/`chainStops`, unchanged).
  Typing the valve's figure sets `comp.ff` (its face-to-face, read by
  `componentTakeout(kind, dn, flanged, ff)` everywhere the item is at
  hand) through `setValveFaceToFace` in edit.ts: the face on the run's
  start side (the chain's start side on a header) stays, the far face and
  flange move, refused if it would leave its run or reach an item beside.
- **Moving an item keeps the line's length** (his complaint, 2026-09-24:
  "moving the olet stretched the header; any item in a line or on its end
  must move without the pipe's length changing"). `onSlideNode` in
  main.ts restores the drag-start snapshot on every step and applies the
  absolute target (steps used to add up: not to scale each step grew the
  drawn line). To scale, `slideNodeTo` moves the point between the far
  ends, no nearer either end than that side's take-outs (`len - cut`) or
  the items on it (`itemHalf` in drawing.ts), and shifts the offsets of a
  run starting at the point so its items stay in space. Not to scale,
  `slideDrawnTo` shares the two sides' drawn total, each at least the
  floor. `slideLimits` keeps a dragged valve between its run's ends and
  its neighbours (marks pass freely; where it stands is always allowed).
  `splitRun` gives the halves the parent's **drawn** length in proportion
  when not to scale (each at least the floor), so an olet or valve put in
  a long run no longer draws it twice as long. The chain's dimensions
  are placed along the chain run by run as drawn, so an olet's location
  dimension ends on the olet not to scale too.
  **Still stretched, one way, a few times** (2026-09-24, second round), for
  two reasons, both fixed: at its limit the short side came back
  1e-13 under the floor and `drawnLength` drew it at its whole length
  (now a visual within 0.5 mm of the floor counts, and `slideDrawnTo`
  keeps both sides to 0.1 mm); and with the header picked, the stretch
  handle on its end lay over an olet beside it, so "dragging the olet"
  stretched the pipe — `nearestPoint` in canvas.ts now gives a pointerdown
  to whichever node/item/handle hit-dot under the pen has its centre
  nearest (the one touched unless another is 2 px nearer). A header
  stretched before the fix is drawn at its own length again with the run
  panel's **Redraw at its own length** (`[data-a="drawn-reset"]`, not to
  scale, when a run of the group has a `visual`; `resetDrawnLength` in
  edit.ts: one run loses its `visual`, a header group gets its capped
  total shared in proportion to the true lengths).
- Lines never overlap (`overlapsExisting`); crossings gap the rear line.
- Toolbar Joint select (BW/SW/THD) sets the picked point's joint, else the
  drawing default. **A line drawn from a threaded or socket-weld olet takes
  the olet's joint** (his complaint, 2026-09-24: the elbow on a line off a
  threadolet came out BW): `inheritedJoint` in `analyse` follows the
  olet's branch runs out to another olet, a flange or a point with its own
  `joint`; `pointJoint(node)` = own, else inherited, else the drawing's,
  used for every joint mark, weld, BOM suffix and terminal symbol, and
  exposed as `analysis.nodeJoint`/`analysis.inheritedJoint`. The node
  panel's Joint select reads "Automatic — Threaded, as its line from the
  threadolet" and can set the point on its own. SW marks' lips point back over the pipe. In SW/THD mode
  a flanged valve gets SW/THD flanges (`valveFlangeKind`).
- PE/CS transition: weld on the CS side, six dashes on the PE side; it ends
  the steel.
- Palette (`src/ui/tools.ts`): Flanges WN/SW/Thd/Blind (SO and Lap removed
  on request), Fittings, Valves (Ball, Ball air, **Ball SW, Ball Thd** — his
  ask 2026-09-24: tool `{ valve, ends }`, `place(host, kind, ends)` sets
  `comp.ends`; SW gets two SW welds, Thd marks and no welds, no flanges,
  never bolted on an end; the list names a valve with SW/THD ends like a
  fitting, `BALL VALVE SW 3000#` / `BALL VALVE SCR'D 3000#` via
  `jointSuffix` — small bores that default to threaded read so too), Branch (tee, olets), Marks
  (Support, L50 support, AG/UG), Joints (a BW weld: `placeWeld` splits the
  run at a plain point, welded pipe to pipe, dimension opened). Two columns
  on tablets so all fit.
- **Closing a gap**: drawing from an open end and tapping an open end of
  **another piece** (`samePiece`) joins them (`connectNodes` in edit.ts, `onConnect`): one run when they lie
  on a line, else legs round a corner, the way with the fewest turns
  (straight out of / into the ends where possible), refused if it would lie
  along a line already drawn. Elbows come from the turns as usual. Tapping
  any other point while drawing still just moves the pencil there. An end
  joined straight on is **joined through** (`joinThrough`), so no plain
  "white point" is left where the gap was (his complaint); the tapped
  point may then be gone, and `onConnect` clears the selection/anchor.
  The HUD/panel say **Delete pipe** for a run (one length only).
  **Two ends of one line** (both off the same header, his complaint
  2026-09-24: "I marked the point but cannot join the two lines") are
  joined by hand: an open end picked offers **Join to another end** (HUD
  `#hud-join`, panel `[data-a="join-from"]`, `host.joinFrom` →
  `state.joinFrom`; the next node tapped completes it in `onSelect` via
  `joinPoints(from, to, dn, schedule, arm=false)`, the new pipe the size of
  the picked end's run; Escape cancels). Any piece, same one included.
  Two open ends whose **lines cross** (his STATION sheet: a branch up 430
  and a line at 440 ending 10 mm past it) are each carried along their own
  line to the crossing (`crossingOfEnds`/`moveOpenEnd` in edit.ts, never
  back past the far end, clear of other lines) and merged there: one
  elbow, no new pipe. Two open ends in the **same place** are merged into one point by
  `connectNodes` (a corner with its elbow, or joined straight through);
  tapping the picked end again finds the other end there
  (`endInSamePlace`). While drawing, tapping an end of the same line
  still only moves the pencil.
- **Tees** ask first (`placeTee` in tools.ts, the olet dialog with
  `kind: 'tee'`): Branch size, equal (the header's size) or smaller for a
  reducing tee, no direction; then the pencil is armed at the new point
  at that size (`setCurrentSize` after `continueFrom`, which would reset
  it) and the dimension up to it opens. Equal/reducing is still inferred
  from the branch drawn (`inferFitting`).
- **Pipe net** (Welds tab column, `Analysis.pieces`, `PipePiece`, `ROOT_GAP`
  = 2.5 mm): every length of pipe between its welds as cut: take-outs off
  and a 2.5 mm root gap off at each BW weld to a fitting/valve/flange/cap.
  A pipe-to-pipe BW weld takes its 2.5 mm off one of the two pieces (the
  first in route order; he said "one of them, whichever"), the header
  takes nothing at an olet and runs through it as one piece (merged
  in `analyse`; the header weld shows that whole length). Copy list carries
  the column. The printed sheet has the same as a **WELD LIST — PIPE CUT**
  table under the weld summary (`weldList` in sheet.ts), as many rows as the
  column has room for, then "AND n MORE". Every piece carries a **letter**
  (`PipePiece.letter`, `pieceLetter`: A…Z, AA…) drawn in a small box beside
  the pipe (`.pipe-letter`, a third of the way along, dimension side, close
  in; draggable via `itemOverrides['pc:<piece.key>']`, a leader appears
  once dragged); the Pipe net column reads "A 1257.5 / B 1211.5", and the
  Items tab has a **Pipe cut list** by letter (`pipeCutList`).
- **Reducers** (`RED_CONC`/`RED_ECC`, inline): `comp.dn` = large end,
  `comp.dn2` = small end, `comp.flip` = large end on the run's *end* side
  (default: large on the start side). Named `CON RED 4" X 2"` / `ECC RED …`
  (`reducerName`; `COMPONENT_LABEL` is 'CON RED'/'ECC RED'), on the list,
  in the weld joins and the panel heading; each of its two welds carries
  its own end's size. Picking one from the palette opens a **dialog**
  (`reducerDialog` in main.ts: Large end, Small end, a **picture with a
  Flip button** (`reducerPreview` in `src/ui/reducer-preview.ts`, sizes
  over the ends, LINE / OPEN END or RUN START / RUN END under them; he
  asked for "something simple like FLIP" instead of a flow select), and
  "Carry on drawing from its far end" on an open end). The panel has the
  same picture and Flip (`[data-a="red-flip"]`). A reducer always sits in
  **a run of its own** (`placeReducer` in tools.ts splits at both faces),
  so **both faces are points** he can tap: draw on from, or put a flange
  on. On an open end its far face is on the end, the pencil is armed there
  and `currentDn` becomes the outward size. `applyReducer` in edit.ts sets
  the sizes and makes the run each side the size of the end it meets, on
  through degree-2 points up to a branch or another reducer. The symbol
  reaches its faces like a valve (`faceReach`), and its weld marks sit on
  those faces (`WeldReach.comp` → `compCentre` in the renderer), never
  inside the body (his complaint, 2026-09-22). `faceOnNode` in `analyse`
  suppresses the PIPE/PIPE joint at a point an item's face sits on, and
  `jointAt` also matches joints by position. Turning the line right at a
  reducer's face (an elbow on the reducer) is not handled: the elbow's
  take-out wins and the reducer's welds get no pipe.
  **Dragged like a tee** (his ask, 2026-09-25: "does a reducer behave like
  a tee — put in a line, dragged, the pipe split in two"): a reducer in a
  run of its own with a straight run on each side (`blockOf` in main.ts)
  moves as one piece whether its body or either face point is dragged
  (`slideBlock`, from `onSlideComponent`/`onSlideNode`; `blockAt` finds
  the reducer of a face point). To scale both face points move and the
  runs either side change (`slideBlockTrue`, items on them keep their
  place, stopped by `roomOn`); not to scale the two sides share their
  drawn total (`slideBlockDrawn`). Taken hold of where the pen went down.
  **A flange straight on its face mid-line** (same ask): a WN/SW/THD flange
  picked with a reducer's face point selected goes through
  `flangeOnItemFace` in edit.ts: the point (now the joint's gasket) slides
  into the pipe beyond by the flange length at the reducer's end size
  (`stretchRun` through the point; moves what lies beyond only if there is
  no pipe to spare). `itemAtEnd` now also counts a flanged joint on the
  point (`node.flange`, back = its length at the side size), so the
  `n:<node>:flg:<run>` weld is named `CON RED 4" X 3" / WELD NECK FLANGE`
  at that size and the reducer's own weld there is dropped (`onTerminal`),
  `endTakeout` takes the side's size, and the reducer is drawn against the
  hub. `blockOf` accepts such a run, so it still drags with its flange.
  **Against a flange at both ends** (flange, reducer, flange closed up)
  the renderer makes the reducer fill the room between the two hubs
  (`faceHalf` = the room / 2, a flanged joint's hub counted past its
  `FLANGE_GAP`): it used to sit against the far flange only, so to scale a
  piece of pipe showed at the near one with its weld dot off the reducer
  (his marked-up screenshot, 2026-09-26: "here is the end and the weld
  should be; not here; unwanted pipe"). The reducer symbol's body now
  reaches `reach` (its `faceHalf`, where its welds sit) instead of a set
  0.9 symbols, and not to scale a run with **no pipe at all**
  (`drawnPieces` has no free pipe segment) is drawn at its floor
  whatever its true or pencilled length (`drawnLength`): at 206 mm, or
  pencilled long, the set-size reducer sat mid-run with pipe drawn both
  sides (his second marked-up screenshot, "want this to be like this").
  That floor is the **sum of its symbols** (hubs + reducer), not the
  six-symbol `minDrawnLength`: held to six, the reducer filled it half as
  long again ("the reducer's shape is too stretched", 2026-09-25).
  **A reducer keeps its large end in `comp.dn`**: its length is read from
  it (`componentTakeout` → `reducerLength(dn, dn)`). The dialog let him
  pick "large 2 in, small 4 in", measured 76 mm for 102, and the flanges
  closed up on it overlapped it. The dialog, `applyReducer` and
  `sortReducerSizes` (on load, via `uncoverPoints`) swap such a pair and
  turn it about (`flip`), so each end keeps its size.
- **An item straight on a flange** (`itemAtEnd`/`endDn` in drawing.ts): a
  reducer placed on an end that wears a flange/cap/transition sits against
  it (offset = flange length at the outward size + half), and a flange
  put on a reducer's far face point **moves the point out** by the
  flange's length (`setTerminal` in edit.ts; taken off, the point comes
  back in). Then there is **one weld** between them, keyed as the
  terminal's (`n:<node>:term`), named `CON RED 4" X 2" / WELD NECK FLANGE`,
  the size of the reducer's end; the item's own weld on that side is
  dropped, the flange takes that size on the list (`endDn`), and the
  symbol is drawn with its face on the flange hub. A pipe size with
  nothing cut in it (the reducer's own run) gets no list line.
  **Flange + reducer + flange with no pipe** (his ask, 2026-09-23): a
  flange put on the end of the reducer's run leaves a stub of pipe past
  the face with two welds; "No pipe — fittings touch" on that stub
  (`terminalStub` → `joinTerminalStub` in edit.ts, used by `setRunDirect`
  **and `deleteRun`**) removes the stub and puts the end piece on the face
  through `setTerminal`. **The end piece stays where it was** (a flange on
  an equipment nozzle is the datum) and everything on the face's side
  slides up to it (his complaint: "the flange must stay fixed and the
  reducer moves onto it, not the other way round"). `setRunDirect` returns
  that point and the HUD/panel select it. Weld overrides on
  `n:<end>:term` are carried to the face.
- **List names typed over** (Items tab, `[data-bom-name]` inputs;
  `drawing.bomNames[lineKey]`, applied at the end of `analyse` after the
  sort, so item numbers stay put): capitalised, printed on the sheet's
  BILL OF MATERIALS as typed, cleared to get the list's own name back.
- **Olets ride on the header** (his complaint: "inserting an olet split the
  pipe like a tee"). Picking an olet with a run (or a plain point along a
  line) selected opens a **dialog** (`oletDialog` in main.ts: Branch size,
  Branch goes N/S/E/W/U/D minus the header's axis) and places the olet
  **alone**: `placeOlet` in tools.ts splits the run at the middle (an
  internal point — the header stays one piece, one letter, one cut length;
  the two dimensions are how he positions it, and the dimension up to it
  opens for typing), sets `fittingOverride: 'OLET'`, `node.joint` and
  `node.olet = { dir, dn }`. `inferFitting`/`oletLegs` treat a 2-run
  collinear node with `node.olet` as an olet with `branch: null`: header
  weld, BOM line "WELDOLET 6" x 1"", balloon, saddle drawn facing `dir`
  with a dashed stub, and **no "6"X1" NS" note** beside it (he asked: the
  sizes are on the list; a reducing tee keeps its note, from his sheets). The node panel shows Branch size / Branch goes and
  **Draw the branch from here** (`continueFrom` sets `currentDn` to the
  olet's size); HUD/panel **Remove olet** (`removeOlet` in edit.ts) joins
  the header back into one run. Never arm the pencil on placement.
  **The header through olets is one pipe in every UI** (his complaint,
  2026-09-23: "an olet still cuts the pipe in the middle; placing it must
  not touch the header; no dimension on placing"): `runGroupIds` in
  drawing.ts (the chain's runs, else the run alone) drives the selection
  highlight (renderer; handles at the chain's two ends only), the run
  panel (heading "Header — …, one pipe with n olets", length = chain
  total via `setGroupLength`, size/schedule/dashed on all its runs, no
  Split, no fittings-touch), the runs list (one row), and Delete pipe
  (`deleteRunGroup`, clears the olet marks). Internally the olet is still
  a point splitting the run (branches need a node). Placing an olet opens
  **no** dimension. A **hand dimension from an olet to a point on its
  header line** is typeable (`measureOnOlet`/`applyMeasureToOlet` →
  `applyChainDimension('olet:…')`): the olet moves, the point stays.
- **Several olets on one point** (`node.olets: {dir, dn}[]`; the old
  `node.olet` is still read through `oletMarks(node)`, never written):
  picking an olet with an olet point selected adds another mark (the
  dialog hides ways already taken). `oletLegs` returns `header`,
  `branches` (drawn, each with its `dir`), `branch` (the first) and
  `pending` (marks with no branch in their direction); `oletEntries` lists
  branches then pending. Each entry has a saddle, a list line (instance
  `node:<id>` then `node:<id>:<dir>`) and a header weld (`n:<node>:header`
  then `n:<node>:header:<dir>`); branch welds `n:<node>:branch` then
  `n:<node>:branch:<dir>`. The panel shows size/way per pending olet
  (`[data-olet-dn]`/`[data-olet-dir]` = mark index); Draw the branch from
  here arms the first pending one's size.
- **Dimensions by hand** (`drawing.measures: {id, a, b}[]`, keys
  `meas:<id>`): pick a point, then the Marks palette "Dimension" tool, the
  HUD "Dimension from here" or the panel button (`host.measureFrom`,
  `state.measureFrom`), then tap the other point (`onSelect` completes it;
  anything else, or Escape, cancels). Drawn as a dimension on the far row
  reading the straight 3-D distance; its figure cannot be typed (a notice),
  the keypad offers "Remove this dimension" (`removeMeasure`); draggable
  like any dimension via `dimOverrides`.
- **Header chains** (`HeaderChain`, `headerChains`, `chainStops` in
  drawing.ts; `analysis.chains`/`chainOfRun`): runs collinear through olet
  points are one header. The renderer dimensions the chain **end to end as
  one** (keys `chain:<firstRunId>:<i>`, pieces broken at valve faces only)
  from its first run. **Since 2026-09-24 ("yes, each piece measured to the
  centre of the olet") the pieces break at valve faces and at every olet's
  centre** (`chainStops`), keys `hdr:<chainId>:<i>`, plus the whole header
  on a row further out (`hdr:<chainId>:all`); the old per-olet location
  dimensions from the start are gone (`olet:<nodeId>` is still the key
  `applyChainDimension` and `applyMeasureToOlet` move an olet by). A
  header whose old `chain:`/`olet:` dimensions were all taken off keeps
  them off (`takenOff` in the renderer) until it gets `hdr:` overrides or
  the run panel's Dimension: show (which clears both). Typing a piece
  that ends on an olet's centre moves that olet (the next piece gives);
  `all` moves the far end. `applyChainDimension`
  in edit.ts: the olet's dimension moves the olet alone (inline items on
  the runs either side keep their place on the header); the last piece
  stretches the last run with `stretchRun(..., moveEnd = true)` — without
  it `stretchRun` slides a through point (the olet) instead of moving the
  end, which is its behaviour for plain points; up to a valve face slides
  the valve. The chain total's figure sits in the widest gap between olets. Dimension
  keys are now strings end to end (`editDimension(key)`,
  `onEditDimension(key)`), so never split a key on ':' and take two parts.
  His complaint: "the olet split the pipe into A and E and the 4000 kept
  changing when I moved the olet". The A/E was a real bug too: merging
  header pieces through a second olet compared against entries already
  rewritten (fixed by noting the two pieces first).
- **Deleting a plain point** (degree 2, collinear, no fitting/flange/olet;
  `isPlainPoint`, `deletePoint`, `joinThrough` in edit.ts — the merge that
  `removeFlangeJoint` also uses) removes only the point and joins the pipe
  through, as with a flange pair (his complaint: deleting the white face
  point of a reducer took the whole line). HUD/panel say "Remove point".
  A corner, branch or end still goes with its runs (`deleteNode`).
- **Leaders on pipe numbers and letters** end at the nearest point of the
  pipe (`nearestOnRuns` in the renderer), so a dragged balloon/letter keeps
  a short leader; fitting balloons still point at the fitting.
- **Equipment box** (`drawing.equipment`, `Equipment` in types.ts; Marks
  palette "Equipment", `placeEquipment` in tools.ts, needs a picked point):
  a dashed isometric rectangle (`.equip-box`) with the name in it
  (`.equip-text`), standing on the point, reaching `length` along `axis`
  (default: on past the line's last leg) and `width` centred along
  `across`, in mm. Panel: name (capitalised), length, width, axes, E/N/U;
  dragged as a whole on the drawing (paper offset `itemOverrides['eq:<id>']`,
  relative drag). Selection kind `equipment`; a note, not material.
  **Draw on from the far side** (HUD `#hud-equip-draw`, panel
  `[data-a="equip-draw"]`, `host.startFromEquipment` → `startFromEquipment`
  in edit.ts, `equipmentFarSide` = `at + axis × length`): puts a point on
  the middle of the far face and arms the pencil there, a new piece (a
  line otherwise only starts on an empty sheet). His complaint: "no way to
  carry on drawing after the equipment" (2026-09-23).
  **The line beyond goes with the box** (2026-09-24: "the flange after the
  equipment starts far off and I cannot bring it in" — the line had been
  drawn on from a 1500 box that was then made shorter): `Equipment.stand`
  (+ `standPos`) is the point it stands on, `Equipment.next` the far-side
  start point; `syncEquipment` in edit.ts, run in `host.edit` after every
  mutation, moves the box with its point and the whole piece at `next` to
  `equipmentFarSide` (unless joined back to the box's own piece). Older
  boxes adopt the point at `at` and the nearest free end on their axis
  beyond them. Not to scale, `layout` starts that piece from the box's
  drawn far face (after the piece the box stands on); the renderer stands
  the box on `stand`'s drawn position. The box's paper drag offset
  (`eq:<id>`) moves only the box. The box's hit
  polygon is in the **first** hits group, under the pipe, points and
  tags, so the point it stands on can still be picked.
- **Dashed run** (`run.dashed`, `setRunDashed` in edit.ts, HUD
  `#hud-dashed` "Dashed — next sheet"/"Solid line", panel Line select
  `[data-f="dashed"]`; his ask, 2026-09-23): drawn dashed (`.pipe.dashed`
  in style.ts, the elbow arc too when both runs are dashed), its pipe
  **left off** the material list, the pieces and the cut list (it is the
  next sheet's pipe); its welds stay. Made dashed it gets `run.note` =
  `DASHED_NOTE` ("CONT. ON NEXT SHEET") unless a note is already there;
  solid again, that default note goes. **Run notes are drawn** beside the
  run's middle on the side away from the dimension (`.run-note`, upper
  case), draggable via `itemOverrides['rn:<runId>']` (leader once moved)
  and typed over on the touch (`data-balloon="rn:<id>"` →
  `onEditRunNote`, like a support's callout) or in the panel's Note field.
- **A valve's last flange** (`comp.lastFlange?: 'none' | 'blind'`,
  `valveOpenSide`/`setLastFlange`; his ask, 2026-09-23): a flanged valve
  whose outer face (with flange) reaches an open end (degree 1, no end
  piece) offers "Last flange" in its panel: its flange / none / blind on
  the valve. None or blind: that side's flange is off the list, its weld
  gone, the end point comes in by the flange length (out again when put
  back), the drawn pipe ends at the valve face; blind adds a BLIND FLANGE
  line and draws a blind plate on the valve face. Blind from the palette
  with the valve, or the end point it stands on, selected does the same
  (not a terminal blind). A valve put on an end point now sits with its
  flanged face on the end (it used to be centred on it, half past).
  The pipe list subtracts only the part of such a valve lying on the run.
- **Fittings one after another** (`boltValveOnEnd` in edit.ts, called
  from `place` in tools.ts for a valve on an end point, tried on a copy
  first; his ask, 2026-09-23, manual and actuated alike): on an end that
  wears a flange (WN/SW/THD), the flange becomes the valve's own flange
  on that side (terminal removed, weld override `n:<node>:term` carried to
  `c:<comp>:0|1`, the weld stays where it was) and the end moves out by
  the valve; on a flanged valve already on the open end, the new valve
  bolts face to face: `comp.bare = 0|1` on both (no flange, no weld, off
  the list, a gasket line only), the renderer draws each bolted valve with
  its bare face on the true joint so no pipe shows between. On the open
  end the drawn pipe stops at the valve (at the outer flange's weld, or
  its face with no flange). **A valve put on any end comes without its
  far flange** (`lastFlange: 'none'`; his complaint, 2026-09-23: "an extra
  flange came in with the valve; on a flange end I want the valve alone,
  I add what goes on it by hand — a flange, another valve, equipment"):
  bolted on a flange or valve, or on an open pipe end (its pipe-side
  flange stays, it is welded to the pipe). A WN/SW/THD flange picked with
  that valve or its end point selected goes on the valve face
  (`setLastFlange(…, 'flange')`), Blind bolts a blind there, another
  valve bolts face to face. A valve dropped **along** a line still comes
  with both flanges.
- **Run note removal**: the note's keypad has "Remove this text"
  (clears `run.note` and its drag offset); a dashed run stays dashed.
- **Hand dimensions along one straight line are typeable**
  (`measureAlongLine`/`measureTypeable` in edit.ts; flange to flange): the
  point tapped second moves with everything beyond it, by stretching the
  run that leads to it (`stretchRun(..., moveEnd=true)`); from an olet the
  olet moves instead. Anything else still says "move a point".
- **Starting a sheet** (his complaint, 2026-09-26: "set the page up or
  fill in the details first and the start of the drawing disappears; I
  cannot start drawing"): the first touch puts a point at the origin and
  arms the pencil. Put away before any pipe (Escape, Stop drawing, the
  app reopened), that lone point used to be drawn as nothing and a touch
  no longer started (only an empty `nodes` did). Now a point with no
  pipe is drawn on screen (`.node-mark.start`, dashed, not on the sheet:
  only when `hitSize` is set), the "Start the route" hint shows while
  there is no pipe and no pencil, and a touch with no pipe yet calls
  `onStart`, which arms the lone point (the picked one, else the last)
  instead of adding another.
- **An elbow is one size** (his complaint, 2026-09-26: "an elbow does not
  change the size; change one side and the other follows"): the run
  panel's Size and the toolbar size with a run picked go through
  `setLineSize` in edit.ts: the run (its header group) and on along the
  line through every degree-2 point (elbow, plain point, flanged joint),
  up to a branch or a reducer's run; a run holding a reducer takes the
  size alone; items that had the old size take the new. **The next sheet
  goes on at the same size**: `newSheetInProject` sets the toolbar size
  from the picked end's run and keeps it on the `CONT. FROM` point
  (`terminal.dn`/`schedule`), which `syncSizeFromSelection` (also called
  by `onStart`) reads, so it holds after the app is reopened.
- **A tee slides with its branch** (HILLEL sheet 4, 2026-09-26: two
  branches drawn SKEW after a dimension along the header was typed):
  `stretchRun`'s `slideThrough` moves a through point's branch (all that
  hangs off it, unless it loops back into the line) by as much as the
  point. `straightenBranches` in edit.ts (on load and in `replaceDrawing`)
  squares up a branch left askew off a tee on a straight header before
  this, moving it back along the header.
- **A dimension by hand ends on what is tapped** (`finishMeasure` in
  main.ts; "I can't put a dimension from the centre of the elbow to the
  pipe", same day): a point; a pipe, at its end nearest the start; a weld
  mark or tag `n:<node>…`, at its point (no weld keypad then,
  `measureDoneAt`). The point under a tee's welds and tags was hard to hit.
- **A reducing tee's note** ("4"X3" NS", `.branch-note`) sits off the
  header on the side away from the branch, far enough that the words
  clear the pipe (it was set beside the point and ran across the line);
  draggable (`itemOverrides['tn:<node>']`, leader once moved), in
  `figures` so weld tags keep off it, and a fixed text for Tidy.
- **Right click while drawing** puts the pencil down (`onStopDrawing`
  from canvas.ts; the right button still pans when not drawing).
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
- **Only the drawing zooms** (his ask, 2026-09-26: "zoom in/out only the
  sheet, without moving the bars round it"): the viewport has
  `maximum-scale=1, user-scalable=no`, `html, body` are
  `touch-action: pan-x pan-y`, and main.ts refuses iOS `gesture*` events
  and two-finger `touchmove` off `#canvas` (iOS ignores the viewport's
  no-zoom on its own). The canvas pinch is its own (pointer events).
- **The equipment outline takes no touches** (`.equip-box` has
  `pointer-events: none`; the box's hit polygon picks it): its dashed
  stroke lay right over the point on its far face, so after "Draw on from
  the far side" that point (and a flange put on it) could not be pressed
  to draw on or picked (his complaint, 2026-09-26: "after the regulator it
  won't let me put a flange and carry on"; also why flange–reducer–flange
  at the FILTER failed). `syncEquipment` re-adopts the box's `next` when
  that point is merged away (a flange closed up on a reducer there).
  A box whose `stand` point is gone (or never set, nothing at `at`) stands
  on the **end of the line coming up to it** on its own axis (degree 1,
  its run coming from behind, not another box's stand, nearest) and moves
  there; and every piece starting on its axis beyond it, up to the next
  box, moves with it, not only the one at `next` (his HILLEL sheet,
  2026-09-25: REGULATUR floated at 1270 off the line ending at 950.5, the
  pipe after it in two pieces 16 mm apart: "I should come out of the
  regulator and carry on forward"). `syncEquipment` also runs on load and
  in `replaceDrawing`, and a sheet it (or `uncoverPoints`) put right on
  opening is written back at once. Two pieces left apart are joined by
  hand (Join to another end). `joinThrough` turning a run round turns its
  items' sides too (a reducer's `flip`, `bare`): joining his two pieces
  put the 4 in end where the 2 in was.
- **`replaceDrawing(next)` in main.ts** is the only way the drawing on
  screen is swapped for another state (New, undo/redo, Open, drag
  snapshots): it deletes every key first. `Object.assign` alone left
  optional parts behind (`equipment`, `measures`, `balloons`, `bomNames`,
  `dimOverrides`…) whenever the next state had none: New kept the last
  sheet's equipment, undoing the first box did not remove it.
- **North arrow on its own** (`options.northArrow`, degrees clockwise,
  `northArrowDir` in iso.ts used by the canvas compass and the sheet's):
  a tap on the compass overlay opens a **picker** of eight small compasses
  drawn as each would point (`openNorthPicker` in main.ts, `.north-picker`,
  `[data-north]`; the one in use marked; a touch elsewhere closes it; his
  ask, 2026-09-26: "choose it on the arrow itself"). No select in the
  toolbar any more. Rotate still turns the whole drawing
  (`northRotation`); he asked to keep both.
- **The toolbar wraps, never scrolls** (same day: "I don't want to drag the
  bar to reach what I need"): `.toolbar` is `flex-wrap`, and up to 1500 px
  a `.row-break` puts Symbols (`#opt-symbols`, a `.field.named` in its own
  group, out of the View menu) and Wide/New/Open/Save/Print on a second
  row. The folded View menu drops down under its button (absolute).

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
  CS side only. **Numbers run on from the last one typed** (his ask,
  2026-09-25: "renamed TAR 4.8, the next becomes TAR 4.9"; his sheet read
  W10, -, W12): a typed number ending in digits sets the prefix and the
  count for the welds after it; one with no digits ("-", "FW") is a name
  of its own and takes nothing from the count.
- **Flange, reducer, flange with no pipe** (same day, HILLEL YAFEH sheet
  after the FILTER): "No pipe — fittings touch" on a run holding a reducer
  goes to `closeUpOnItem` in edit.ts (from `setRunDirect`): the end
  pieces at both ends (terminal, flanged joint, fitting take-out, at each
  side's size) close up on the reducer's faces; the end standing on
  equipment (else the start) stays, the other comes in with what lies
  beyond. `run.direct` is not set; the welds are the two
  `CON RED … / WELD NECK FLANGE` ones through `itemAtEnd`.
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
with a run selected, confirm the dialog (`.dialog [data-f="olet-dn"]`,
`[data-f="olet-dir"]`, `[data-confirm]`), then `#tab-body [data-a="draw-from"]`
on the olet point and tap where the branch goes; `#hud-direct` with a run
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
- `scripts/smoke.mjs` — the regression suite (~480 checks); add a check
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
  Drive is not set up. **Remove** in the Projects list (confirm says "on
  this device and in the Google Drive folder") runs a sync at once when
  connected, so the tombstone deletes the Drive file then and there (his
  ask, 2026-09-26); not connected, it goes at the next sync. He set his own Google Cloud project up on
  2026-09-22 and is signed in on the PC.

## Ideas not yet done

- Own domain for the app (CNAME on GitHub Pages) or hosting on Hostinger.
- Sending drawings by email (n8n); Drive is done.
- Slopes/skewed runs are not supported; runs are orthogonal.
- Selling it: no runtime dependencies (vanilla TS, MIT-style dev tools
  only), the PLATINUM logo is his company's; per-user Drive needs the
  OAuth consent screen published (drive.file is non-sensitive, no
  verification), a domain, and some way to hand out the client ID.

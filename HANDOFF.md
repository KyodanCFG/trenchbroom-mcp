# Handoff — trenchbroom-mcp (+ TrenchBroom-HL fork) — 2026-08-22

> The next session's job: **drive Shogo level building through this MCP server
> and fix what breaks.** Three integration gaps were reported from real use and
> all three are fixed below, but only one of them was proven end to end. The
> rest of this file says which is which.

## Where things stand

**Verified — ran, observed, evidence cited:**

- **`add_brush_box` writes the right face format.** Driven through the *bundled*
  server over stdio, not the source: the same call writes Standard into a map
  under a Shogo workspace and Valve 220 into one outside it, and `map2ed.py`
  then parses the Shogo one (its only complaints are the missing
  `WorldProperties`, spawn and light a bare box legitimately has).
- **TrenchBroom-HL's Run button.** The dropdown arrow is visible and white
  (owner confirmed on screen), and a compile profile whose name ends in
  `(release)` is absent from the dropdown while remaining in `Run > Compile`
  (owner confirmed). The root cause of the invisible arrow was a missing Qt
  plugin, not the stylesheet — `imageformats\qsvg.dll` was never deployed, and
  a stylesheet `image: url(...svg)` goes through `QImageReader`, which needs it.
  `Qt6Svg.dll` alone is not enough; it only serves `QSvgRenderer`.
- **The DirLight aim arrow now agrees with the light.** `map_yaw` checked over
  pitch −60..90 and yaw −180..180 in 15° steps: 150 combinations, round trip
  `angles → Rotation → angles` exact at every one, and TrenchBroom's own
  convention applied to the stored value gives the same unit vector as
  `lighthelpers.aim_tb` at every one.
- **The kit packages and installs from clean.** `makepackage.py` now unzips its
  own output, runs `setup.ps1` into a temp workspace and asserts six outcomes;
  a failing package is deleted. Proven by removing `--skins` and watching it
  refuse (`550 models but only 0 skins`, 99s), and passing honestly in 102s.

**Done but NOT verified at runtime:**

- **`compile_shogo_map` install routing.** The `.dat` is now placed in
  `Custom\maps\mp` or `Custom\` by the map's `GameStartPoint GameType`, with an
  `install_target` override. The routing *decision* was checked against the
  shipped examples (`MP_ArenaOF` → mp, the SP examples → `Custom\`), but **no
  map has been compiled and installed through the tool since the change**, and
  nobody has confirmed a routed map appears in the in-game host list.
- **TrenchBroom-HL's disabled-state Run arrow.** A disabled button used to paint
  a bright white arrow because a stylesheet image ignores widget state. There is
  now a grey `DownArrowDisabled.svg` and a `::menu-arrow:disabled` rule. Both
  are confirmed present in the compiled binary; nobody has looked at a disabled
  Run button to see it grey.

**Known broken / unresolved:**

- **Nothing in these two repos.** The open items are elsewhere: the retargeted
  Trooper model still hangs the client (workaround applied, in the ShogoFRESH
  tree), and `OF_Thermal.ed` is truncated on disk and cannot be exported.

## Next steps (in order)

1. **Build a Shogo map end to end through the MCP and fix what breaks.** That is
   the point of the next session. Start from an empty `.map` inside the
   workspace, `add_brush_box` a sealed room, add `WorldProperties`, a
   `GameStartPoint` with `GameType 1`, and a `Light`, then `compile_shogo_map`.
   Two things to watch specifically, both unproven: that the installed `.dat`
   lands in `Custom\maps\mp` and that the map then appears in the host list.
2. **Check the MCP's other tools against a Shogo map**, not just the two that
   were reported. `add_entity`, `set_entity_properties` and `translate_entity`
   have never been exercised on a Standard-format map with Shogo classes.
   `fgd_class`/`fgd_classes` should be pointed at `data/shogo.fgd`.
3. **Look at a disabled Run button** in TrenchBroom-HL (open a Quake map, where
   there is no Shogo compile profile) and confirm the arrow is grey rather than
   white. One glance; closes the last untested UI item.
4. **Decide whether `map_overview` should report the face format**, now that it
   matters. It reports `format: valve220 | standard` already — worth checking it
   agrees with what `shouldWriteValve` would choose, so a mapper is told before
   they write rather than after it fails.

## Open questions (need the owner's call)

- **Should the FGD keep exposing `angles` on DirLight?** It now produces a
  correct arrow, so the answer is probably yes. The alternative — removing it so
  TrenchBroom draws nothing — was on the table when the arrow was wrong and no
  longer has a case, unless the rotate handle proves confusing.
- **Standard vs Valve 220 for Shogo.** Standard is a 1:1 match for what
  LithTech's `.ed` stores (offset u/v, rotation, scale u/v). Valve 220 carries
  explicit U/V axis vectors, which would have to be decomposed back into those
  five numbers on export — exact for axis-aligned, rotated and scaled faces,
  lossy for anything sheared. The gain would be editor-side alignment on angled
  faces; the risk is silent loss on export. Not worth changing unless somebody
  hits the alignment limit in practice.

## Key files

- `src/map/builder.ts` — `shouldWriteValve` decides the face format for a new
  brush; the comment explains why an empty map cannot be guessed at.
- `src/shogo.ts` — `compileShogoMap` drives the Shogo kit; `isMultiplayerMap`
  and the install block are the unverified routing.
- `src/index.ts` — tool definitions, including `install_target`.
- `dist/trenchbroom-mcp.mjs` — the bundle that actually ships (gitignored).
  **Rebuild with `npm run bundle` after any source change**, then repackage the
  kit, or the kit ships the old server.
- `../trenchbroom/package-hl.ps1` — assembles the TrenchBroom-HL release and
  refuses to write a zip missing a Qt plugin known to matter.
- `../trenchbroom/lib/TbUiLib/src/MapWindow.cpp` — the Run button: palette,
  stylesheet, `(release)` filtering.
- `../shogo-re/tools/makepackage.py` — kit packaging, its four gates and the
  `--public` split.
- `../shogo-re/tools/smoketest.py` — the clean-install test packaging runs.
- `../shogo-re/HANDOFF.md` — a *different* thread's handoff, covering the
  mapping kit and game code. Read it for kit context; do not treat it as this
  one's continuation.

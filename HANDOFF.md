# Handoff — trenchbroom-mcp (+ TrenchBroom-HL fork) — 2026-08-22 (evening)

> Previous session left three integration fixes in, only one proven. **All three
> are now proven end to end**, against a real Shogo deathmatch map. This session
> wrote almost no code — it was a verification pass, plus one documentation fix
> that came out of it.

## Where things stand

**Verified this session — ran, observed, evidence cited:**

- **`compile_shogo_map` install routing.** Built `MP_McpDm` from an empty `.map`
  through the MCP: sealed room (7 brushes), `WorldProperties`, four
  `GameStartPoint`s with `GameType 1`, four `Light`s. Compiled clean — 98,939
  bytes, 28,244 light map nodes, 9 objects, no errors or warnings — and the
  `.dat` **landed in `Custom\maps\mp`**, not `Custom\` root.
- **A routed map appears in the multiplayer host list.** Read the
  `IDC_CUSTOMLIST` listbox contents directly with `LB_GETTEXT` rather than
  eyeballing a screenshot: `MP_McpDm` at index 11 of 85. See the caveat about
  *which* host list under Findings.
- **`add_entity`, `set_entity_properties`, `translate_entity`, `fgd_class`**, none
  of which had ever run against a Shogo map. All four work: entities written in
  Standard format, a planted junk key removed, a spawn moved `[400,-400,0]` with
  the origin updated, and `data/shogo.fgd` parsed with properties, choices and
  defaults resolved.
- **`map_overview` reports the face format correctly** — `format: standard` on
  that map, agreeing with what `shouldWriteValve` chose. That closes most of the
  previous handoff's step 4.
- **The tool descriptions no longer lie about reloading.** Verified through the
  built server, not by reading source: 7/7 writing tools carry the shared note,
  0 still say "reload in TrenchBroom to see it".

**Done but NOT verified at runtime:**

- **TrenchBroom-HL's disabled-state Run arrow.** Unchanged from last session:
  the grey `DownArrowDisabled.svg` and the `::menu-arrow:disabled` rule are in
  the compiled binary, and nobody has looked at a disabled Run button to see it
  grey. Still one glance (open a Quake map, where there is no Shogo profile).

**Known broken / unresolved:**

- Nothing in these two repos.

## Findings worth keeping

**1. THERE ARE THREE BUILD OUTPUTS, not two, and the third is the one that
ships to users.** The previous handoff warned about `dist/index.js` vs
`dist/trenchbroom-mcp.mjs`. There is a third copy: **`ShogoMapping\trenchbroom-mcp.mjs`
in the deployed kit workspace**, and `npm run dist` does not touch it. It was
still the Aug 17 0.4.0 bundle — no `install_target`, no Standard-format fix —
five days after both landed, so every mapper using the kit's own MCP had the
bugs regardless of what this repo said. It is now re-synced.

`npm run dist` is still the right command; it is just not sufficient. The
copy into the kit belongs in `shogo-re/tools/makepackage.py`, with a gate
asserting the shipped `.mjs` version matches `package.json` — the same shape as
the `server version matches package.json` test here. Not done: it is a change
to a different repo, which had another thread's uncommitted work in it.

**2. `serverInfo.version` is not reachable as a tool call, so use behaviour.**
The previous handoff says "ask a suspect client for its version" — there is no
tool that answers. Two things that DO work, both used here:

- Does `compile_shogo_map` advertise an `install_target` parameter? Only 0.5.0 does.
- Run `add_brush_box` on a map inside a Shogo workspace. 0.4.0 writes Valve 220
  (`[ 1 0 0 0 ]` axis vectors); 0.5.0 writes Standard (`0 0 0 1 1`).

**3. A stale server is the normal case, not the exception.** Six MCP server
processes were alive at once, one per Claude session, each pinned to whatever
`dist/index.js` was when its session started. Only the newest was current. A
running stdio server cannot be hot-swapped and **killing the node process does
not respawn it** — the tools go dead. A client restart is the only fix.

**4. ShogoFRESH has no in-game multiplayer menu at all**, so "the game's
multiplayer host list" means the *dedicated server's*. `MainMenu.cpp:443`
removes Multiplayer and Options deliberately ("the launcher owns both"), leaving
campaign / credits / quit — so `ClientShellDLL/NetStart.cpp`'s `NetDlg_GameLevels`
is unreachable in FRESH. The verification above was done against `FreshSrv.exe`'s
wizard, which uses the identical scan
(`NetStart_FillLevelList(hCustomList, "\\", CUSTOM_LEVEL)` in
`ShogoServ/NetStart.cpp:1167`) over the same mounted tree. The routing is right
for both; only one of them is reachable.

**5. `shogo.fgd` has zero `base()` declarations** across all 320 classes. So
`fgd_class`'s inheritance resolution cannot be exercised against it — the
`base: []` in every result is the FGD being flat, not the tool failing. The
inheritance path is covered by the FGD unit test instead.

**6. TrenchBroom-HL auto-reloads, and nobody downstream knew.** Commit
`b4308019b`: a `QFileSystemWatcher` on the open `.map`, debounced 500 ms
("programs that write map files often do so in several steps"), calling
`m_document->applyExternalChanges()` before any hard `reload()` — so an external
edit appears with selection and camera intact. Preference
`Editor/Reload map file on external change`, default true.

The trap, and the reason it is in the tool descriptions rather than only here:
**with unsaved edits open it does not reload silently.** It raises
*"<file> was changed by another program. Reload it?"* with **"Keep My Changes"
as the default button** — so an MCP write reaches disk, gets discarded, and the
dialog can sit behind the editor window while it happens. It reads exactly like
the tool doing nothing.

## Next steps (in order)

1. **Copy the bundle into the kit as part of `makepackage.py`**, with a version
   gate. Finding 1 — this is the live hole; the kit was five days stale and
   nothing would have caught it. Lives in `shogo-re`, so check that tree is
   clean first.
2. **Look at a disabled Run button** in TrenchBroom-HL and confirm the arrow is
   grey. Carried over; still one glance.
3. **Consider whether `install_target` should warn rather than obey** when it
   contradicts the map's own `GameType`. Right now an explicit `"sp"` on a
   `GameType 1` map silently hides it from the host list, which is the exact
   failure the routing was written to prevent.

## Open questions (need the owner's call)

- **Should the FGD keep exposing `angles` on DirLight?** It produces a correct
  arrow now, so probably yes, unless the rotate handle proves confusing.

**Settled 2026-08-23 — Standard vs Valve 220.** Standard stays; `shouldWriteValve`
keeps its Shogo-workspace branch. The reasoning is in `../shogo-re/decisions.md`
("Standard stays; Valve 220 is blocked by the `.ed` face record"), and the short
version is that the `.ed` face record has no field for texture axes — five
floats, paraxial, closed compiler — so Valve 220 would have to be decomposed on
export, and the decomposition fails on exactly the alignments Valve 220 exists
to provide. Do not reopen this as a preference question; if it comes back it
comes back as the hybrid that decision names (Valve for editing, hard validator
on export).

## Key files

- `src/shogo.ts` — `compileShogoMap`; `isMultiplayerMap` and the install block
  are the routing, now proven.
- `src/index.ts` — tool definitions. `EDITOR_NOTE` near the top is the shared
  reload note appended to all seven writing tools; the comment above it carries
  finding 6.
- `src/map/builder.ts` — `shouldWriteValve` picks the face format for a new
  brush; `inShogoWorkspace` is what makes an empty map come out Standard.
- **Three build outputs.** `npm run build` → `dist/index.js` (what MCP clients
  are registered against), `npm run bundle` → `dist/trenchbroom-mcp.mjs`,
  `npm run dist` → both. **Neither touches `ShogoMapping\trenchbroom-mcp.mjs`**,
  which is what the kit actually ships. See finding 1.
- `npm test` — 21 tests, the closest thing this repo has to preflight. Includes
  `server version matches package.json`, which is what keeps `serverInfo`
  honest.
- `../trenchbroom/lib/TbUiLib/src/MapWindow.cpp` — the Run button, and the
  auto-reload watcher (`m_mapFileWatcher`, `mapFileChangedOnDisk`).
- `../trenchbroom/package-hl.ps1` — assembles the TrenchBroom-HL release.
- `../shogo-re/tools/makepackage.py` — kit packaging; where next step 1 goes.
- `../shogo-re/HANDOFF.md` — a *different* thread's handoff. Read it for kit
  context; do not treat it as this one's continuation.

## Repo hazards

- **`origin` is public upstream, `gitea` is the private fork — push to gitea.**
  Applies to the `../trenchbroom` checkout (`origin` →
  `TrenchBroom/TrenchBroom`, `gitea` → `Kyodan/trenchbroom-hl`).
- **`get_git_describe()` runs at CMake configure time**, so tag, then
  reconfigure, or the binary keeps announcing the old version.

# Handoff — trenchbroom-mcp (+ TrenchBroom hotload fork) — 2026-08-07

## Where things stand

Two repositories, one initiative: an MCP server that edits Quake `.map` files,
and a patched TrenchBroom that picks those edits up live. Both are complete,
pushed and tagged.

**Verified working.** The server (v0.2.1, 16 tests passing) was exercised
against a real 92 KB Quake 1 map, `C:\Users\BHuq\Downloads\tb_tutch_01\maps\tb_tutch_01.map`
— 59 entities, 166 brushes, standard (non-Valve) format. Parse and re-serialize
of that map is byte-identical. Entity add/edit, box-brush creation (166 → 167
brushes, map bounds min-Z moved 48 → 0, confirming real geometry), FGD parsing
(111 classes from the shipped `Quake.fgd`, `func_door` inheritance and
spawnflags correct) and compiling (clean three-stage build in ~1.2s) were all
run against it. The patched editor was observed applying changes live, with the
console line "Applying the changes made to …tb_tutch_01.map" and the object
count updating; the owner clicked "Undo External Changes" in the Edit menu and
the change reverted. Editor test suites are green: TbMdlLib 75,396 assertions /
208 cases, TbUiLib 1,505 / 88.

**The compile loop was demonstrated end to end.** A light was deliberately moved
outside the level, `compile_map` reported `LEAK at 1896 632 3000` (while qbsp
itself exited 0), the edit was undone, and recompiling came back clean.

**Done but not proven at runtime.** The `atomicWrite` retry added after a real
transient `EPERM` on Windows has never been observed actually retrying — the
lock did not recur. Claude Desktop registration was written into
`claude_desktop_config.json` and the JSON validated, and the server starts with
a clean stdout, but no Claude Desktop session has connected to it. The Valve 220
face format has unit tests but has never been run against a real Valve or
Half-Life map. The local-model client instructions in README (LM Studio, Goose,
Cline, LibreChat) were written from general knowledge and never followed
end to end.

**Not started.** Launching a compiled map in an engine. Filing the upstream
TrenchBroom issue. Brush primitives beyond axis-aligned boxes.

## Next steps (in order)

1. **Build a launch tool** so the loop reaches "go and look at it". Spawn an
   engine with `+map <name>`; the open questions are where the `.bsp` must be
   copied to and whether to surface the engine's console output. The owner
   planned to test map launching on 2026-08-07.
2. **File the upstream TrenchBroom issue.** Text is drafted and ready at
   `../trenchbroom/ISSUE-DRAFT.md` (untracked on purpose — delete before
   pushing the branch). TrenchBroom's CONTRIBUTING requires agreement on the
   approach *before* a PR, so the issue comes first. This must be posted by the
   repository owner under their own name. Until it lands, the editor patch is a
   private fork that has to be rebuilt by hand, and the rebase cost grows as
   upstream moves past `8e3ee9b`.
3. **Add brush primitives** — wedges, cylinders, rotation — in
   `src/map/builder.ts`. Axis-aligned boxes mean the server can grey-box but not
   finish geometry; this is the largest functional gap.
4. **Exercise the Valve 220 path on a real map.** Everything verified so far has
   been standard-format Quake. The Gitea repository for the fork is named
   `trenchbroom-hl`, which suggests Half-Life maps are intended; those are Valve
   220.

## Open questions (need the owner's call)

- Does the `-hl` naming mean Half-Life maps are the next target? It decides how
  urgent step 4 is.
- Should the launch tool be built, or is launching going to stay a manual step?

## Key files

- `src/compile.ts` — runs ericw-tools and parses the result. The parsing is not
  optional: percent counters run hundreds to a line with real output on the end,
  and a leak is a warning with exit code 0.
- `src/map/parser.ts`, `src/map/writer.ts` — round-trip fidelity. Unmodified
  lines are written back byte-for-byte; the `// Game:` / `// Format:` header is
  preserved because TrenchBroom picks the game from it.
- `src/backup.ts` — snapshots, atomic writes with retry, and the self-ignoring
  `.tb-mcp` directory.
- `decisions.md` — why the editor applies a diff instead of reloading, and the
  other decisions worth not re-litigating.
- `../trenchbroom` — the editor fork. Branch `hotload-map-file`, 12 commits on
  upstream `8e3ee9b`, tagged `hotload-1.0`. `lib/TbMdlLib/src/Map.cpp` holds the
  diff engine (`applyExternalChanges`, `nodeKey`, `identityKey`,
  `computeFrozenLinkedGroups`); `lib/TbUiLib/src/MapWindow.cpp` holds the file
  watcher and the fallback to reload.
- `../trenchbroom/ISSUE-DRAFT.md` — the upstream issue, ready to post.

## Environment notes

- ericw-tools 0.18.1 lives at
  `C:\Users\BHuq\Downloads\ericw-tools-v0.18.1-win64\ericw-tools-v0.18.1-win64\bin`.
  Pass it as `tools_dir`, or set `ERICW_TOOLS_DIR`.
- Building the editor fork needs the portable toolchain and Qt described in the
  `trenchbroom-build-setup` memory note; the landmine is that `vcvarsall.bat`
  fails unless the VS Installer directory is on `PATH` first.
- MCP servers start when the client starts. **Restart the client after every
  `npm run build`**, or it keeps running the old code.
- The test map's `wad` key points at `D:/QuakeDev/...` on the original author's
  machine, so recompiling it produces an untextured build. The `.bsp` in that
  folder is the author's original and should be left alone.

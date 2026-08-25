# Handoff — trenchbroom-mcp (+ TrenchBroom-HL fork) — 2026-08-25 (released hl-1.20)

> The session closed the model-orientation question that three previous rounds
> only argued about, and it closed it with a FIXTURE rather than with reasoning.
> That is the transferable part. Everything else here — tag counts, the light
> cone rim, the host profile — is small beside it.
>
> One thing is deliberately left open, and the fixture now asks it out loud.

## Verified — ran, observed, evidence cited

- **The model rotation is right, and right for every model.** The 180° in
  `abc2obj.to_editor` went in on the strength of ONE character. `ZZ_AngleRef`
  now puts `Akuma`, `UCA_Trooper` and `Ordog` at yaw 0 beside the spawns, and
  all of them face the green wall in the editor. That promotes "sanjuro was
  backwards" to "every Shogo mesh shares one forward convention".
- **The engine agrees with the editor at yaw 0.** Arrow, model and in-game
  spawn facing all point the same way — reported from play, not inferred.
- **Nothing else consumes the rotation.** Five tools mention `.obj`; every
  apparent geometry read was a local variable named `v`. `map_yaw`, the FGD
  arrow, the DirLight cone and the compiled `.dat` are untouched by the mesh
  change. 228 classes carry `model()` and NONE declare `size()`, so their
  editor bounding box follows the mesh — correctly, now that the mesh is right.
- **`OuterColor` is real and used.** The name is in `Processor.exe` once,
  alongside `InnerColor`, `FOV`, `LightRadius`, `BrightScale` — and
  `LightObjects`, by contrast, is not in the binary at all. Across the 39
  shipped worlds, **992 of 3,028 DirLights set it**, in 13 worlds: 846 pure
  white, 115 at `(25, 20, 10)`, others at `(0, 0, 55)`.
- **hl-1.20 announces itself correctly.** `git describe` → `hl-1.20`, and the
  built exe contains that string and no older one. Tag, then RECONFIGURE, then
  build — the `get_git_describe()` hazard, handled.
- **The kit still packages.** `makepackage.py` clean, including the ~90s smoke
  test that unzips the kit and runs `setup.ps1` into a fresh workspace.

## Open — the one question the fixture now asks

**Do yaw 90 and yaw 270 face the right way in the ENGINE?**

yaw 0 and yaw 180 came out right in play, which sounds like the matter is
settled and is not. `map_yaw` is a REFLECTION (`Y = 90 - y`), so a wrong sign
SWAPS 90 and 270 while leaving 0 and 180 looking perfect. The two cases are
indistinguishable from everything observed so far.

So `ZZ_AngleRef`'s +Y and -Y walls are labelled with the question rather than
an answer — `+Y wall  (does yaw 90 point here?)`. Compile it, spawn at the
`yaw 90` and `yaw 270` points, read the wall. Do not settle this by reading
`map_yaw`; that is what the last three rounds did.

The +X wall is green and confirmed. -X is blue. Only two flat colour swatches
exist in the whole texture set, which is why the side walls are labelled by
group name instead.

## Corrected mid-session — worth keeping, both were mine

- **Point-light range spheres "not appearing" is BACKFACE CULLING, not
  precision.** I diagnosed it as `makemap.face_line` writing its three plane
  points one unit apart at `%g` (6 significant digits), which at 1,200 units
  from the origin leaves ~1% angular error in the recovered normal — plausible,
  and wrong. Recovering the vertices from the half-spaces showed the icosphere
  ALREADY bounded a solid, before any change. The real cause is
  `MapRenderer.cpp:256`, `gl.enable(GL_CULL_FACE)`: a point light's radius is
  room-scale, so the camera is INSIDE the sphere looking at its backfaces.
  The speculative fix was reverted rather than shipped on a false rationale.
  **The 2D views draw edges, which are not culled — the range circle is visible
  there now.** A hollow shell is not expressible as one convex brush, so making
  it visible from within needs a different primitive (three thin orthogonal
  rings is the obvious candidate) — not yet designed, not yet asked for.
- **The `%g` / one-unit-span observation is still true, just not the cause.**
  It is real headroom lost for any large or many-faced generated solid. Recorded
  here rather than fixed, because nothing currently demonstrates it biting.

## Landed

**shogo-re** (3 commits, pushed to `origin` = gitea)

- Light cones draw `OuterColor` as a thin disc at the cone's MOUTH — and only
  when it is non-black. Black is the FGD default and two-thirds of the shipped
  corpus, and it means "fade to nothing", which the cone's edge already says;
  drawn unconditionally the rim would be noise on two cones in three. Inner and
  outer are two ends of one gradient across a single `FOV`, not two cone angles,
  which is why it is a disc and not a nested cone. Cones also went 12 → 8
  segments: a cone is ONE brush at any count, so this is legibility, not cost.
- `tools/makeangleref.py` — the fixture generator described above.
- `Build and host (MP)` passes `+DisableMusic 1`, the same flag ShogoFRESH's own
  launcher uses, for the same reason (the three IMA crashes in BUGS.md E7 all
  struck on multiplayer world entry). SP keeps its music. Applied to the live
  `GameEngineProfiles.cfg` too, so it works without re-running setup.

**TrenchBroom-HL** (1 commit + tag `hl-1.20`, pushed to `gitea`)

- Both tag lists now show counts, and they count DIFFERENT things on purpose:
  the entity browser's panel is a palette and counts CLASSES ("how much does
  this filter leave me"), View Options hides things and counts INSTANCES in the
  current map ("what will unchecking this remove"). The zero is what earns View
  Options its number — a tag with nothing in this map still appears, because
  tags are declared by the game and not by the map, and `Light (0)` explains a
  checkbox that would otherwise read as broken.

## Artefacts

- `C:\Users\BHuq\Downloads\TrenchBroom-HL-1.20-Win64.zip` (74.3 MB, 363 files)
- `shogo-re\out\package\ShogoMapping.zip`

**The editor was RUNNING from `C:\Users\BHuq\Downloads\TrenchBroom-HL` during
packaging**, so `package-hl.ps1` could not clear its staging folder
(`qsvgicon.dll` locked). Packaged to a scratch `-OutDir` and copied the zip
across. The staged FOLDER in Downloads is therefore still 1.19; the zip is 1.20.
Close the editor and re-run with the default `-OutDir` if the unpacked folder
matters.

## Queued, not started

- **The entity outliner / hierarchy panel.** Explicitly deferred by the user
  ("it touches some other UI thoughts i have in mind"). The motivating question
  was "how would I locate a specific entity within a map?".
- **Per-tag instance counts in View Options** are built but have not been LOOKED
  at in the running editor. The browser's class counts have been.

## Standing hazards

- **In the trenchbroom checkout, `origin` is public upstream and `gitea` is the
  private fork.** Push to gitea. (`shogo-re`'s `origin` IS gitea — different
  repo, opposite meaning of the same word.)
- **`get_git_describe()` runs at CMake CONFIGURE time.** Tag, then reconfigure,
  then build, or the binary keeps announcing the old version.
- **Building from the Bash tool fails with "Cannot open include file:
  'algorithm'"** — the MSVC environment is not present there. Build through
  PowerShell with `vcvars64.bat`. A full `cmake --build .` also fails in the
  Catch2 test-DISCOVERY step (test exes cannot find the Qt DLLs); that is not a
  compile failure. `--target TrenchBroom` builds the app cleanly.
- **`shogo-re` carries another thread's uncommitted work** — `HANDOFF.md`,
  `decisions.md`, `out/MAP-ELEMENTS.md`, and a junk `tools/--out` (577 KB of
  `06_Entrance.ed`, from `ed2map.py` taking `--out` as an output path). All left
  untouched. Commit only named paths in that repo.

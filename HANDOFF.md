# Handoff — trenchbroom-mcp (+ TrenchBroom-HL fork) — 2026-08-25 (released hl-1.24)

> The session closed the model-orientation question that three previous rounds
> only argued about, and it closed it with a FIXTURE rather than with reasoning.
> That is the transferable part. Everything else here — tag counts, the light
> cone rim, the host profile — is small beside it.
>
> The fixture then closed the last of it: the yaw convention is confirmed in
> the game, all four cardinals, and `map_yaw` needed no change.

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

## CLOSED — the yaw convention is settled, in the game

**`map_yaw` is correct as written. Nothing needed changing.**

`ZZ_Yaw270` — one centred `GameStartPoint`, +Y wall green, -Y wall blue —
spawns you facing **BLUE**, which is -Y, which is what the editor draws for
yaw 270. Engine and editor agree.

That one reading closes all four, and the reason is worth keeping: a wrong sign
here can only appear as one of two mirrors. About X swaps 90 and 270 and leaves
0 and 180 untouched; about Y does the reverse. 0 and 180 were already confirmed
in play, so 270 rules out the remaining one. There is no third way to be wrong.

**Two things that looked like evidence and were not**, since three earlier
rounds died on them:

- **The editor drawing 270 towards -Y proves nothing.** TrenchBroom renders
  `angle` in the Quake convention regardless of what `map_yaw` does, and never
  calls it. The editor cannot testify about its own import.
- **A four-spawn room in the game cannot answer it either.** You get one of the
  spawns at random with no label, so the observation cannot be attached to a
  yaw. That is an ambiguity about WHERE YOU SPAWNED, which no amount of extra
  paint fixes. `makeangleref.py --single <yaw>` exists for exactly this: one
  spawn, centred, nowhere else to have come from.

Recorded on `map_yaw` itself in `tools/map2ed.py`, which is where the next
person will look.

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
  **NOW FIXED** by replacing the sphere with three orthogonal rings of wedges:
  from the centre you meet a segment's inner face, whose normal points back at
  you, so it is front-facing and drawn. `--point-style sphere` keeps the old
  one-brush form. The cost is `3 x segments` brushes per light instead of 1.
  A `_bounds_ok` gate now intersects every triple of a helper's planes and
  refuses to write anything that does not bound a solid, counting what it
  dropped.
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

- `C:\Users\BHuq\Downloads\TrenchBroom-HL-1.24-Win64.zip` (74.5 MB, 363 files)
- `C:\Users\BHuq\Downloads\TrenchBroom-HL-1.23-Win64.zip` (74.5 MB)
- `C:\Users\BHuq\Downloads\TrenchBroom-HL-1.22-Win64.zip` (74.5 MB)
- `C:\Users\BHuq\Downloads\TrenchBroom-HL-1.21-Win64.zip` (74.4 MB)
- `C:\Users\BHuq\Downloads\TrenchBroom-HL-1.20-Win64.zip` (74.3 MB)
- `shogo-re\out\package\ShogoMapping.zip`

**The editor was RUNNING from `C:\Users\BHuq\Downloads\TrenchBroom-HL` during
packaging**, so `package-hl.ps1` could not clear its staging folder
(`qsvgicon.dll` locked). Packaged to a scratch `-OutDir` and copied the zip
across, which left the unpacked folder on 1.19 - and that stale folder is what
produced the crash report below, from a build two commits behind the fix it was
being tested against. It has SINCE been refreshed: with the editor closed,
`package-hl.ps1 -Version 1.20` ran against the default `-OutDir` and the
installed exe now announces `hl-1.20`.

The lesson is the one this project keeps relearning: a stale binary lies in
both directions. It hid a fix one week, hid a break the next, and here it
invited a crash to be attributed to the map.

## hl-1.21 — the outliner, and the UI cleanup around it

**The Layers panel is now a tree**, and `Outliner` REPLACES `LayerListBox`
rather than sitting beside it. The constraint that kept this small: LayerEditor
needed exactly three methods and six signals from its inner widget, so all ~14
layer commands are untouched and the diff stays off files upstream edits often.

- `QAbstractItemModel` over the live nodes, not a `QTreeWidget` — the latter
  materialises an item per node, fine for a test room and not for a shipped
  world. Nothing copies the tree; a `QModelIndex` carries the `Node*`.
- **Recursive filtering** is what makes the filter box answer "where is this
  entity" — without it, typing a name hides the entity's own layer and group
  and takes the entity down with them.
- Visibility and lock now work on **every row**, as eye/padlock icon columns
  with no header. That came free: `hideNodes`/`lockNodes` were never
  layer-specific, LayerEditor was just the only caller.
- Shift-click the eye **isolates**, same gesture and meaning as View Options.
- **Rename**: layers and groups natively; an entity through the property typed
  `target_source`, which is the FGD saying which key is the name. Not hardcoded
  to `Name` — the type is the question, not the spelling.
- Context menu acts on the **selection**, across groups and layers: group,
  ungroup, hide, show, isolate, lock, unlock. A layer clicked alone still hands
  back to LayerEditor's much richer menu.
- The default layer is displayed as **"Main Layer"**. Display name only: it
  still cannot be renamed, because `NodeSerializer` writes that layer's colour,
  lock, hidden and omit-from-export onto worldspawn but *never its name*, so a
  typed one would vanish on save.

**Two bugs found by using it, neither where it looked:**

- **A new group landed wherever the FIRST-selected node lived.**
  `parentForNodes` returns `nodes.at(0)->parent()`, so grouping across two
  sibling groups put the result inside whichever was clicked first — reverse
  the order, different answer. `groupSelectedNodes` now uses the deepest common
  ancestor. Fixed in the command, not the outliner, because **Ctrl+G had it
  too**.
- **Hide cleared the tree selection and Show did not.** That asymmetry was the
  model being right: `hideNodes` deliberately deselects what it hides (a hidden
  selected node could be dragged invisibly), and lock does the same. So the map
  selection still drops them and the TREE's no longer has to agree —
  `m_pendingSelection` outranks the map for exactly one rebuild.

**Also in 1.21:** Mods is hidden for games whose filesystem `searchpath` is
`"."` (for Shogo it listed `build`, `data`, `maps`, `python`, `textures`... as
mods, because `"."` never matches a directory name — build output presented
as a mod). Map Properties defaults collapsed instead, because it is unused
rather than wrong. Both browsers' control rows moved to the top. The entity
browser's Group button is gone (the tag panel does that job by meaning, not by
name prefix) and its sort dropdown is now direction — Name A-Z / Z-A —
since "Usage" asked a question the outliner answers properly.

**shogo-re:** `map2ed.py` treats `_tb_` as a PREFIX rule rather than a list of
five keys. `_tb_transformation` and `_tb_linked_group_id` both appear the moment
anyone makes a group, which the outliner is now one right-click from.

**Dropped rather than deferred:** reordering entities within a layer. Layers
have a real `_tb_layer_sort_index`; entities have no ordering concept in the
format, so it would have meant inventing one to serve organisation that groups
already serve.

## hl-1.22 - the asset browser, and the inspector reshaped around it

**The entity and material browsers are one AssetBrowser**, with Entities and
Textures as categories, and it can live in the **info panel, the inspector, or
its own window** (View menu, three checkable items). Both of those requests
turned out to be one mechanism with three destinations, so it is built once.

- `TabBook` could add a page and never give one back; `TabBook::removePage` and
  `TabBar::removeTab` are the new primitives that gated all of it. The page
  SURVIVES removal and is unparented - which is why moving hosts is a reparent
  rather than a rebuild, so category, scroll position and filter text all
  survive the move.
- `MapWindow` owns the browser, not any of the three hosts, because it can be
  in any of them and the owner has to outlive all three.
- Closing the floating window puts the browser BACK in the info panel rather
  than destroying it.
- Reveal-material is host-aware: it surfaces the browser wherever it lives.

**The inspectors are contextual now**, which is what moving the palettes out was
for: Entity and Face hold one editor each and describe the selection. **The
outliner takes the top half of the inspector** on a remembered splitter, since
navigation should not be a tab you switch away from to see what you found.
`InspectorPage` renumbers from 0; Ctrl+1 keeps its key and changes its meaning
to "reveal the outliner".

**Both browsers stopped wasting the width.** List mode sized each cell to the
VIEW, so a 2,000-pixel panel showed one 64-pixel thumbnail per row. Sized to
content, the existing reflow fills the width with columns. Explorer's List
flows down and scrolls sideways; this flows across and scrolls down - same
density, one scroll axis, and vertical suits a panel that is either short and
wide or popped out and tall.

**The entity browser gained Grid/List and a size dropdown**, which it had never
had. The size LIST is shared with the material browser; the stored preference
is not, because a texture is judged by its pattern and wants to be large while
an entity is picked by name and wants to be small.

**The settings row is gone.** It was a `SwitchableTitledPanel` whose title said
"Entities" directly under a tab that already said "Entities". The title was
duplication; the switch was real, so it moved into the tab bar via
`TabBookPage::createTabBarPage`. It could NOT go in the browser's control bar -
that bar belongs to the browser, so switching to Settings would have taken the
toggle with it.

### Four bugs, all the same shape

Worth keeping together, because they were one mistake wearing four hats:
**reasoning that held while a panel only ever GAINED things, and stopped the
moment it could lose them.**

- **Dead members left behind.** Removing the call to `createMaterialBrowser`
  left the member, the factory and a `documentWasLoaded` notifier that still
  dereferenced it - a null `setVisible` on every map load. A member that is
  only ever null is not dead weight, it is the next crash.
- **`removePage` threw `out_of_range` through a Qt signal.** Order (the bar
  shrank before the layout emitted), range (a stacked layout reports -1 while
  removing), and resync (the bar guessed which button to press). `addPage`
  could never produce -1, which is why it appeared the moment removal existed.
- **The pop-out window came up empty.** A `QStackedLayout` hides non-current
  pages and that hidden state belongs to the WIDGET, surviving reparenting.
- **The pop-out window outlived its document.** `Qt::Window` makes a top-level
  frame; it does not give it an OWNER. Unparented, it survived the close still
  holding a `QOpenGLWidget` and painted against freed state.

### Release hazard, on top of the known one

`get_git_describe()` runs at CONFIGURE time - and the generated `Version.h` is
written at the END of a build, so the FIRST build after tag-and-reconfigure
still links the old string. Tag, reconfigure, build, then **build again**, and
check the exe actually contains the new version before packaging.

## CLOSED - the engine's world limit is 32,768 units

Played the ladder, walking down from the far end:

    32,768    clean
    65,536    jitter, slight but perceptible
   131,072    jitter
   262,144    jitter
   393,000    indistinguishable from 262,144

**The usable ceiling is about 32,768 units from the origin** - one SIXTEENTH of
the compiler's 400,000 - and it shows as the weapon viewmodel shimmering while
moving. No pillar z-fighting and no collision oddity at any rung: it is the
viewmodel and nothing else.

**The method survived its own falsification test**, which is what makes the
number defensible rather than merely available. 393,000 and 262,144 share a
float rung, so they HAD to look identical, and they did. Had the far room been
visibly worse, float precision would not have been the cause and the ladder
would have been measuring something else entirely.

`softMapBounds` now declares 32,768 rather than 400,000, because that is the
limit anyone can actually reach - a warning that cannot fire is not a guard.
Both numbers stay documented in the config so the next reader knows why they
disagree. SOFT is the right strength: it shimmers, it does not break, and a
mapper who wants a huge outdoor space and will accept that should get a warning
rather than a refusal. Still two doublings of headroom over Monolith's furthest
world at 15,744.

## hl-1.23 - one fix past 1.22

Entity thumbnail size did nothing until you scrolled, then stopped growing part
way. Two faults behind one symptom, both worth keeping:

- **`invalidate()` marks the layout dirty; it does not ask for a repaint.**
  `reload()` only invalidated, so a size change landed the next time something
  else caused a paint. `setLayoutMode` always did both, which is exactly why the
  mode switch never showed this and size always did.
- **The up-scale cap did not move with the cell.** An entity's natural size is
  its MODEL's bounds - unlike a texture, which is drawn into whatever rectangle
  it is handed - and the layout scales that to fill the cell but never past
  `maxUpScale`, left at a flat 1.5.

The cap being a RATIO is why it looked like only some entities responded: one
whose model is small against its cell still has headroom and grows, one already
filling its cell stops at once. Same setting, opposite appearance - a good
reminder that "it works for some" can be one bug rather than two.

## hl-1.24 - the textures tab

- **A folder list beside the texture grid**, mirroring the entity tag panel.
  Textures have no tags, so the folder they live in is the only structure they
  come with - ninety collections for Shogo. The label drops the `textures` root,
  since a prefix all ninety share costs the width that distinguishes them.
- **The Group button is gone**, and the reasoning is worth keeping because it
  reverses an earlier call. Group stayed for textures last week on the grounds
  that directories were the only structure available; the folder list supplies
  that structure BETTER, because it FILTERS rather than labels.
- **Sort is a direction** (Name A-Z / Z-A), the "Size:" labels are gone from
  both bars, and `MaterialBrowser::setSortOrder`/`setGroup` were deleted rather
  than left as API forwarding to controls that no longer exist.
- **Double-clicking an entity or group in the outliner** selects it and focuses
  the camera, as Ctrl+U does. Layers keep their old meaning.
- **The folder filter and both splitter widths persist.** The filter is stored
  per GAME like entity favourites; the fallback applies only to the FIRST build
  of the list, guarded on the list being empty rather than the selection, or
  clearing your selection would be undone by the next document change.

**IT HUNG THE EDITOR FIRST, AND THE DIAGNOSIS IS THE KEEPER.** Windows event
1002 - "stopped interacting with Windows and was closed" - which writes NO crash
report, because the handler only fires on an exception and a UI thread that
never returns raises none. I spent the first minutes hunting a report that could
not exist.

`reload()` runs on every document change and rebuilt the list; restoring the
selection called `setSelected` per row, each emitting `itemSelectionChanged`,
each relayouting several thousand materials. Ninety rows, ninety relayouts, on
the thread that answers the message pump. A `QSignalBlocker` and one filter
application at the end. The entity tag list had the identical shape and got the
same guard - it never hung only because nineteen rows over 1,300 definitions is
forgiving, which is exactly why it was worth fixing before it grew.

## Detail models cannot carry environment relief - measured

Asked because gltf2abc/abcbuild mean models can be AUTHORED at all, which Shogo
never had. `ZZ_Detail` puts identical geometry on a wall twice, as brushes and
as an `.abc`, same texture, mirrored lighting.

**Brushes self-shadow; the model does not.** Same shape, correctly oriented and
wound, and it renders near-flat - no cast shadows, little contrast between
faces. **`LightTableRes 64` made no perceptible difference, and my prediction
that it would was wrong.** Cell size decides WHERE a model samples its light,
not WHETHER it can be shadowed: the grid holds a smooth irradiance field, and a
hard shadow edge is a lightmap phenomenon the processor computes against
geometry. Refining the sampling of a field with no shadows in it still gives no
shadows.

So the mismatch is structural, and Monolith leaving detail models out of their
environments was a correct call about their engine. **Brushes for anything read
through shadow** (brush WorldModels are lightmapped too - 493 of 912 in the
first twelve worlds); **models for what brushes cannot be** - curved and organic
form, dense clutter, and self-lit things where having no shadow is no defect.

**FOUR FIXTURE FAULTS BEFORE ONE REAL MEASUREMENT**, every one caught by a
screenshot rather than by reasoning: lights that reached neither panel, a model
facing backwards, inverted winding from an unre-wound Y/Z swap, and no texture
coordinates at all. The last one I first recorded as a tool limitation - claiming
abcbuild projects UVs - which was false; it reads `vt`, and gltf2abc reads
TEXCOORD_0. Corrected in the file, since it would have been read as reference.

The lesson worth carrying: the bounds check I was pleased with confirmed the
model's EXTENTS while it sat backwards and inside out. A cheap check verifies
exactly what it measures and nothing adjacent.

## Queued, not started

- **The entity outliner / hierarchy panel.** Explicitly deferred by the user
  ("it touches some other UI thoughts i have in mind"). The motivating question
  was "how would I locate a specific entity within a map?".
- **Per-tag instance counts in View Options** are built but have not been LOOKED
  at in the running editor. The browser's class counts have been.
- **The textures control bar** wants a clean-up; the user is still deciding what
  it should be. The entity bar now carries layout mode, sort direction, size,
  Used and search, which is a lot of controls for a narrow panel.
- **Column-major List** (flow down, scroll sideways, as Explorer does) if the
  current across-and-down reflow turns out to read wrong. It means changing
  `Layout` and `CellView`, which both browsers share.
- **Does the ENGINE load a world out near MaxBounds?** The compiler is happy at
  400,000 (below); nothing has run one. Not obviously worth a playtest at 25x
  any real map, but it is an honest gap.

## Open — a crash, not yet reproduced

Reopening `ZZ_AngleRef` crashed the editor. Two things the report settles and
one it does not:

- **The build was `hl-1.19-2-g173e12937-dirty`**, not 1.20 — the installed
  folder was stale for exactly the packaging reason recorded above. It has
  since been refreshed and now announces `hl-1.20`. Retry there first.
- **The log shows three `Applying the changes made to ...` lines** — our fork's
  HOT RELOAD firing, because the file was being regenerated under the open
  document. Reason `3765269347` = `0xE06D7363`, an unhandled C++ exception (not
  a null dereference), thrown from a paint after a widget show.
- **TrenchBroom's recovery save had written `_tb_linked_group_id` onto every
  one of the generated groups, and `makeangleref.py` emits no such key.** So
  each hot reload handed the document a file whose groups had lost their link
  identities. That is the first thing to bisect — `UpdateLinkedGroupsHelper`,
  `Map_Groups` — but it is a HYPOTHESIS. Nothing has been reproduced.

Bisect by opening in 1.20 with the editor otherwise idle, then with helper
layers stripped (`--no-points --no-spots`), then with the groups removed.

## MEASURED: the compiler's world limit is 400,000 units, and it is a WARNING

Asked because Map Properties was showing a blank radio button for want of an
answer, and settled by compiling rather than by reading the binary.

`Processor.exe` does carry the check - `MaxBounds` and
`** Found an out-of-bounds brush` are both strings in it. **That proves nothing
on its own**: `SelectOutOfBoundsBrushes` sits right beside them and reads like
DEdit's UI, and shared code says nothing about what the COMPILER does. So a
sealed room was compiled with its centre at a range of distances and the log
read each time.

- **400,000 units per axis**, bracketed to 200: a room reaching 399,900 is
  clean, one reaching 400,100 reports **five** out-of-bounds brushes - exactly
  the five of its six walls that cross the line, with the far wall entirely
  inside and silent. That count corroborates the number independently.
- **It is a warning, not a refusal.** The `.dat` is still written and the log
  still says "Found 0 problem brushes" alongside it. Which is what makes
  declaring it worth anything: a brush dragged to 500,000 by accident compiles,
  reports itself in a log nobody reads, and ships.
- **Not a design budget.** Monolith's largest shipped world reaches 15,744 from
  the origin; the longest campaign span is 22,400. The limit sits 25x past
  anything built on purpose, so this is a backstop against a mis-drag.
- Coordinates round-trip **exactly at 131,072**, checked in the compiled `.dat`
  rather than assumed from the float width.

`softMapBounds` is now declared in the Shogo `GameConfig.cfg` (kit source and
the live install both), so Map Properties has something real to show.

**One thing this exposed about our own tools.** The probe generator failed to
export past 10^6, and that is `%g` - six significant digits - collapsing a face's
three plane points into one. `makemap.face_line` shares the formatting. It is
the same hazard flagged and reverted earlier in the session, now DEMONSTRATED
rather than theoretical, but it sits well outside `MaxBounds` so it stays a note.

## Standing hazards

- **In the trenchbroom checkout, `origin` is public upstream and `gitea` is the
  private fork.** Push to gitea. (`shogo-re`'s `origin` IS gitea — different
  repo, opposite meaning of the same word.)
- **`get_git_describe()` runs at CMake CONFIGURE time.** Tag, then reconfigure,
  then build, or the binary keeps announcing the old version.
- **Build with `.	b.bat`, from the repository root, through PowerShell.**
  `TOOLCHAIN-WINDOWS.md` is the authority; the wrapper is checked in and needs
  nothing filled in.

  ```
  .	b.bat cmake --build . --target TrenchBroom
  ```

  This entry used to say only "build through PowerShell with `vcvars64.bat`",
  which is true and useless: it names no path, and the two that matter are both
  non-obvious. Visual Studio here is **BuildTools**, not Community
  (`C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`), and
  **cmake and ninja are not on PATH** - they are portable copies under
  `Fable\.toolchain\`. Guessing Community cost a session an hour and produced
  "cmake is not recognized", which points at neither. `tb.bat` resolves both.

  Building from the **Bash tool** still fails with "Cannot open include file:
  'algorithm'" - the MSVC environment is not present there, and `tb.bat` does
  not help because the failure is the shell, not the paths. A full
  `cmake --build .` also fails in the Catch2 test-DISCOVERY step (test exes
  cannot find the Qt DLLs); that is not a compile failure.
  `--target TrenchBroom` builds the app cleanly.
- **`shogo-re` carries another thread's uncommitted work** — `HANDOFF.md`,
  `decisions.md`, `out/MAP-ELEMENTS.md`, and a junk `tools/--out` (577 KB of
  `06_Entrance.ed`, from `ed2map.py` taking `--out` as an output path). All left
  untouched. Commit only named paths in that repo.

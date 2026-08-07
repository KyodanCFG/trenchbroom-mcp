# trenchbroom-mcp

MCP server for editing Quake-format `.map` files — the format TrenchBroom
reads and writes. TrenchBroom has no scripting API, so this server treats the
map file itself as the API: an AI client edits the file, and TrenchBroom picks
the change up.

With the [patched TrenchBroom](#live-editing) the change appears in the editor
as it happens, keeping your camera, selection and undo history — and it can be
undone like any other edit. Without it, everything still works; you press
reload.

## What it can do

- **Read**: `map_overview`, `list_entities`, `get_entity` — counts, bounds,
  TrenchBroom layers/groups (`_tb_*` metadata), textures, per-entity detail.
- **Edit**: `add_entity`, `set_entity_properties`, `delete_entity`,
  `add_brush_box`, `delete_brush`, `translate_entity`. Every edit snapshots
  the file first; `undo_last_edit` / `list_backups` roll back.
- **See**: `render_preview` draws top/front/side orthographic SVG views —
  brush footprints computed by real half-space intersection, so the model can
  reason about layout instead of editing blind.
- **Know the game**: `fgd_classes` / `fgd_class` parse an FGD entity
  definition file, with base-class inheritance resolved.
- **Compile**: `compile_map` runs [ericw-tools](https://ericwa.github.io/ericw-tools/)
  and reports what the compiler said — errors, grouped warnings, and leaks,
  with the coordinate the leak escaped from.

Supports Valve 220 and standard (idTech) face formats, plus Quake 2 surface
flags. Unmodified lines are written back byte-for-byte, so diffs only touch
what actually changed.

## Setup

### Build

You need [Node.js](https://nodejs.org/) 20 or newer (`node --version` to
check). The build step is not optional: the server runs from `dist/`, which is
not checked in, so a fresh clone that skips it registers a server that cannot
start.

```
git clone <repo-url> trenchbroom-mcp
cd trenchbroom-mcp
npm install
npm run build
```

Note the absolute path to `dist/index.js` — every client below needs it. On
Windows it looks like `C:\Users\you\src\trenchbroom-mcp\dist\index.js`.

This is a plain [MCP](https://modelcontextprotocol.io/) server speaking JSON-RPC
over stdio, with nothing vendor-specific in it, so any MCP client can drive
it — including local models. Three setups follow; they all say the same thing
in different files.

> **Whatever the client, restart it after `npm run build`.** MCP servers are
> started when the client starts, so until you do you are running the old code.
> This is the single most common thing to trip over.

### Claude Code

```
claude mcp add --scope user trenchbroom -- node /absolute/path/to/trenchbroom-mcp/dist/index.js
```

`--scope user` makes it available in every project rather than only the one you
are in. Relative paths are stored verbatim and break as soon as you work
elsewhere, so use an absolute one. Check it with `claude mcp list`; you want
`trenchbroom: ... - ✔ Connected`.

### Claude Desktop

Edit `claude_desktop_config.json` — on Windows
`%APPDATA%\Claude\`, on macOS `~/Library/Application Support/Claude/` — and add
an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "trenchbroom": {
      "command": "node",
      "args": ["C:/Users/you/src/trenchbroom-mcp/dist/index.js"]
    }
  }
}
```

Forward slashes work on Windows and avoid escaping every backslash. If the file
already has other servers, add this alongside them rather than replacing them.

### A local model

Any client that supports MCP and lets you point at a local backend works —
[LM Studio](https://lmstudio.ai/), [Goose](https://block.github.io/goose/),
[Cline](https://cline.bot/) or [Continue](https://continue.dev/) in VS Code, or
[LibreChat](https://www.librechat.ai/), among others. They differ in where the
config file lives, but the entry is the same `command` plus `args` shape as
above, because that is the MCP standard rather than anything Claude-specific.

The plumbing is the easy part; the model is not. These tools need real
multi-step tool use: read the map, reason about coordinates in 3D, emit exact
numeric arguments, then check the result. A model that is weak at tool calling
will pick the right tool with wrong numbers, which is worse than failing,
because the map still changes. In practice a 30B-class coding model is about
the floor.

Start a new model on the read-only tools — `map_overview`, `list_entities`,
`get_entity`, `fgd_class`, `render_preview` — and see how it does before letting
it write. The snapshots and `undo_last_edit` are there either way.

## Using it

Point the client at a map by absolute path: *"give me an overview of
C:\quake\mymod\maps\e1m1.map"*. From there, things like *"dim every light by
30%"*, *"list any entity nothing targets"*, or *"add a 512 unit room at the
origin with 16 unit walls"*.

## Live editing

By default you reload the map in TrenchBroom yourself after the server edits
it — TrenchBroom does not watch the file.

There is a patched build that does. It notices when another program changes
the open map and applies the change in place, keeping your camera, selection,
hidden and locked objects, and undo history — and the change itself becomes
undoable, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes an edit made by the AI. With
it, edits simply appear in the editor as they happen. See the `hotload-map-file`
branch of the TrenchBroom fork.

Without the patch everything still works; you just press reload.

## Compiling

`compile_map` runs [ericw-tools](https://ericwa.github.io/ericw-tools/) and
returns what the compiler said, rather than a wall of text. Point it at the
tools with `tools_dir`, or set `ERICW_TOOLS_DIR`, or put them on `PATH`.

It runs `qbsp` by default, which is the fast structural check; pass
`stages: ["qbsp", "vis", "light"]` for a full build.

Two things it takes care of, both of which otherwise make the output useless
to a model:

- The tools print hundreds of percent counters, often several to a line with
  real output stuck on the end. Those are stripped, and repeated warnings are
  grouped with a count instead of listed one by one.
- **A leak is reported as a warning and the compiler still exits 0.** So exit
  status is not a useful signal, and `compile_map` reports `success: false`
  for a leak, along with the coordinate the compiler escaped from and the
  pointfile. That coordinate names an entity inside your level that can see
  the void, which is the thing you actually need to know.

```
"compile the map and tell me if it leaks"
  -> qbsp ok, 6 warning(s), 0.01s | LEAK at 0 0 64
```

## Workflow notes

- Save in TrenchBroom before asking for edits — the server reads whatever is
  on disk, not what is in the editor.
- Do not make changes in TrenchBroom and via the server at the same time. With
  the patched build the editor asks before discarding unsaved work; without
  it, last save wins.
- Writes are atomic (temp file + rename, retried briefly if the OS has the
  file locked). Snapshots live in `<mapdir>/.tb-mcp/backups/`, capped at 20,
  and that directory ignores itself in git.
- The comments at the top of a map file (`// Game: Quake`) are preserved —
  TrenchBroom picks the game and format from them.

## What this is actually for

Separately, each half is modest. This server is a `.map` file editor; the
patch is a file watcher. Together they remove the thing that made AI level
editing useless: **the round trip.** You don't export, or reload, or context
switch. You say something, and the map changes in front of you, in the editor
you were already using, with your camera where you left it and your selection
intact. And because the change arrives as an ordinary undoable edit,
<kbd>Ctrl</kbd>+<kbd>Z</kbd> is the escape hatch — which is what makes it safe
to actually try things rather than carefully vetting each one.

The subtler shift: the model can *see* the map. Between `map_overview`,
`list_entities` and the SVG previews, it reasons about your actual level — its
bounds, its entity graph, its layout — instead of generating plausible-looking
map text blind. That's the difference between a code generator and a
collaborator.

### Typical use

The honest bread-and-butter is **tedium at scale**. Dim every light by 30%.
Retarget `door1` to `bridge_door` everywhere. Delete every monster for a
no-combat build. Bump all health pickups up 8 units because they're clipping
the floor. These are minutes of clicking, or a script you'd have to write, and
now they're a sentence.

Second is **interrogation**. "Which entities does nothing target?" "What
textures does this actually use?" (trim the WAD) "Is anything outside the
world bounds?" TrenchBroom has an Issues panel, but it can't answer arbitrary
questions about *your* map's logic.

Third is **blockout**. Rooms, corridors, stairs, pillar rows, lights at
intervals. Axis-aligned boxes are exactly what greyboxing is, so the current
limitation bites much less here than it would for detail work.

Fourth, and underrated: **learning a game's entity vocabulary.** The FGD tools
mean the model can tell you what `func_door` actually supports in *your* game —
including a custom FGD for a mod — rather than half-remembering Quake trivia.

### Where it gets genuinely interesting

**Parametric level design.** Not "generate me a level," but "make the courtyard
25% bigger and move everything that was against the north wall." Iterating on
layout at the speed of conversation, with the editor as live preview. The map
stops being a static artifact and becomes something you can nudge.

**Closing the compile loop.** `compile_map` makes the compiler part of the
conversation rather than a separate ritual. Leaks are the case that matters:
the compiler reports one as a warning, exits successfully, and quietly
produces a broken build — so the tool treats a leak as failure and hands back
the coordinate it escaped from. "You leaked at 0 0 64" is a fixable sentence,
and fix, recompile, verify is a loop a machine is good at running. Quake
mapping's most painful chore becomes a dialogue.

**Whole-map refactors that nobody attempts by hand.** Convert every `func_wall`
to `func_detail`. Renumber a broken trigger chain. Port entity names from Quake
to a mod's conventions. These are "I'd rather rebuild the level" jobs today.

**Your own games.** TrenchBroom's generic game config plus custom FGDs means
this stack points at anything brush-based, not just Quake.

**Two people, one map.** Nothing about the design assumes the other editor is
an AI. It's "another program changed the file." Two mappers with a shared file,
or a generator running continuously while you hand-detail, both work.

### The honest ceiling

It can't do rotated or non-box geometry, so it greyboxes rather than finishes.
It has no aesthetic judgement — it'll place lights at perfect intervals, which
is exactly what a good mapper wouldn't do. And it can't play the level, so
nothing it makes has been evaluated for whether it's *fun*.

The right mental model is a fast, tireless assistant who knows the file format
cold and has no taste. You bring the taste.

## Testing

```
npm test
```

## Limitations

- Brushes can only be created as axis-aligned boxes. No wedges, cylinders, or
  rotation, so this builds blockouts rather than finished geometry.
- No texture alignment control beyond what is preserved on untouched faces.
- Editing a map by hand while the server is also editing it is not supported.
- Compiling needs ericw-tools installed separately; it is not bundled.

## Roadmap

- More brush primitives (wedge, cylinder), rotation, texture retargeting.
- Launching the compiled map in an engine, so the loop reaches "go and look at
  it" without leaving the conversation.
- Upstreaming the editor patch — TrenchBroom issue #3505 asked for external
  reload in 2020.

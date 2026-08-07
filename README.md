# trenchbroom-mcp

MCP server for editing Quake-format `.map` files — the format TrenchBroom
reads and writes. TrenchBroom has no scripting API, so this server treats the
map file itself as the API: an AI client edits the file, you reload in
TrenchBroom.

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

Supports Valve 220 and standard (idTech) face formats, plus Quake 2 surface
flags. Unmodified lines are written back byte-for-byte, so diffs only touch
what actually changed.

## Setup

You need [Node.js](https://nodejs.org/) 20 or newer (`node --version` to
check) and an MCP client — these instructions are for Claude Code.

Clone and build. The build step is not optional: the server runs from
`dist/`, which is not checked in.

```
git clone <repo-url> trenchbroom-mcp
cd trenchbroom-mcp
npm install
npm run build
```

Register it. Use the **absolute path** to `dist/index.js` in the directory you
just cloned into — `claude mcp add` does not resolve relative paths from your
current directory later on.

```
claude mcp add --scope user trenchbroom -- node /absolute/path/to/trenchbroom-mcp/dist/index.js
```

On Windows that path looks like `C:\Users\you\src\trenchbroom-mcp\dist\index.js`.
`--scope user` makes the server available in every project rather than only
the one you happen to be in.

Confirm it connected:

```
claude mcp list
```

You should see `trenchbroom: ... - ✔ Connected`. MCP servers are started when
a session starts, so **restart Claude Code** before the tools appear — and
again after any `npm run build`, or you will keep running the old code.

Then just point it at a map by absolute path: *"give me an overview of
C:\quake\mymod\maps\e1m1.map"*.

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

## Testing

```
npm test
```

## Limitations

- Brushes can only be created as axis-aligned boxes. No wedges, cylinders, or
  rotation, so this builds blockouts rather than finished geometry.
- No texture alignment control beyond what is preserved on untouched faces.
- Editing a map by hand while the server is also editing it is not supported.

## Roadmap

- More brush primitives (wedge, cylinder), rotation, texture retargeting.
- Compile-tool integration (ericw-tools) so a map can be built and run without
  leaving the conversation.
- Upstreaming the editor patch — TrenchBroom issue #3505 asked for external
  reload in 2020.

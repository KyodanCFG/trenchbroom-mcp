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

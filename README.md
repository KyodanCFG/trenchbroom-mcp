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

```
npm install
npm run build
```

Register with Claude Code:

```
claude mcp add trenchbroom -- node C:\Users\BHuq\Downloads\Fable\trenchbroom-mcp\dist\index.js
```

## Workflow notes

- TrenchBroom does **not** watch the file for external changes. After the
  server edits, reload the map in TrenchBroom (File > Open Recent is the
  fastest path). Save in TrenchBroom before asking for edits — the server
  reads whatever is on disk.
- Writes are atomic (temp file + rename). Snapshots live in
  `<mapdir>/.tb-mcp/backups/`, capped at 20.
- Do not edit in TrenchBroom and via the server at the same time; last save
  wins.

## Testing

```
npm test
```

## Roadmap

- Phase 2: TrenchBroom hotload patch — `QFileSystemWatcher` on the open
  document, auto-reload when clean, prompt when dirty. Upstream candidate
  (TrenchBroom issue #3505 asked for this in 2020).
- More brush primitives (wedge, cylinder), rotation, texture retargeting,
  compile-tool integration (ericw-tools).

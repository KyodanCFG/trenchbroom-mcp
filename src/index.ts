#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { Brush, Entity, MapFile, Vec3 } from "./map/model.js";
import { classname, getProp, parseOrigin, removeProp, setProp } from "./map/model.js";
import { parseMap } from "./map/parser.js";
import { serializeMap } from "./map/writer.js";
import { boundsOfPoints, brushBounds, brushVertices, entityBounds, mapBounds, planeFromPoints } from "./map/geometry.js";
import { archPoints, faceExtent, bevelSolid, boxSolid, pipePoints, polygons, solidFromPoints, solidVolume, stairBoxes, transformBrush, brushFromSolid, inset, intersects, isValidSolid, planeThrough, prismSolid, rotateBrush, rotationMatrix, solidFromBrush, split, subtract, wedgeSolid, type Solid } from "./map/csg.js";
import { makeBoxBrush, shouldWriteValve, translateEntity, usesValveFormat } from "./map/builder.js";
import { renderShaded } from "./render/shaded.js";
import { renderView, type ViewName } from "./render/svg.js";
import { atomicWrite, ensureTbMcpDir, listBackups, restoreLatest, snapshot } from "./backup.js";
import { parseFgd, resolveClass } from "./fgd/parser.js";
import { compileMap } from "./compile.js";
import { launchMap } from "./launch.js";
import { compileShogoMap } from "./shogo.js";

// KEEP THIS IN STEP WITH package.json. It is what a client reports back as
// serverInfo, which makes it the only way to tell WHICH BUILD a running client
// is actually serving - and that matters more than it sounds: this repo has two
// independent outputs from the same source (`npm run build` -> dist/index.js,
// which clients are registered against, and `npm run bundle` ->
// dist/trenchbroom-mcp.mjs, which the Shogo kit ships). Rebuilding one and not
// the other left a client running five-day-old code while the source, the
// bundle and the tests all said the fix was in. `npm run dist` builds both.
const server = new McpServer({ name: "trenchbroom-mcp", version: "0.5.0" });

// Appended to every tool that WRITES the map file.
//
// TrenchBroom-HL watches the open .map (QFileSystemWatcher, 500ms debounce)
// and calls applyExternalChanges() before any hard reload, so an edit made
// out here shows up on its own with the selection and camera intact. These
// descriptions used to say "reload in TrenchBroom to see it", which has been
// wrong since that landed and had the mapping thread reloading by hand.
//
// The unsaved-edits case belongs in the DESCRIPTION rather than in this
// comment, because it presents as the tool silently failing: TrenchBroom
// raises a modal whose default button KEEPS the editor version, so the write
// reaches disk and is then discarded - and the dialog can sit behind the
// editor window while it happens.
const EDITOR_NOTE =
  " Writes the file; if the map is open in TrenchBroom, reload it there (the editor detects the change and asks - keep the editor version if you have unsaved edits, then merge by hand).";

// ---------- helpers ----------

function loadMap(mapPath: string): MapFile {
  const text = fs.readFileSync(mapPath, "utf8");
  return parseMap(text);
}

function saveMap(mapPath: string, map: MapFile): void {
  atomicWrite(mapPath, serializeMap(map));
}

/** Load, snapshot, mutate, save. Every mutating tool goes through here. */
function withMap<T extends object>(mapPath: string, fn: (map: MapFile) => T): T & { backup: string } {
  const map = loadMap(mapPath);
  const backup = snapshot(mapPath);
  const result = fn(map);
  saveMap(mapPath, map);
  return { ...result, backup };
}

function entityAt(map: MapFile, index: number): Entity {
  const e = map.entities[index];
  if (!e) throw new Error(`no entity at index ${index} (map has ${map.entities.length} entities)`);
  return e;
}

function entitySummary(e: Entity, index: number) {
  const bounds = entityBounds(e);
  return {
    index,
    classname: classname(e),
    targetname: getProp(e, "targetname"),
    origin: parseOrigin(e),
    brushes: e.brushes.length,
    bounds: bounds ? { min: bounds.min, max: bounds.max } : null,
  };
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(err: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

function tool<A extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: A,
  handler: (args: z.objectOutputType<A, z.ZodTypeAny>) => unknown
): void {
  const callback = async (args: any) => {
    try {
      return ok(await handler(args));
    } catch (err) {
      return toolError(err);
    }
  };
  server.registerTool(name, { description, inputSchema: schema }, callback as any);
}

const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const mapPathSchema = z.string().describe("Absolute path to the .map file");

// ---------- read tools ----------

tool(
  "map_overview",
  "Summarize a .map file: entity/brush counts, bounds, format, TrenchBroom layers/groups, textures in use, and entity class histogram.",
  { map_path: mapPathSchema },
  ({ map_path }) => {
    const map = loadMap(map_path);
    const classCounts: Record<string, number> = {};
    const textures = new Set<string>();
    let brushCount = 0;
    const layers: string[] = [];
    const groups: string[] = [];
    for (const e of map.entities) {
      const cls = classname(e);
      classCounts[cls] = (classCounts[cls] ?? 0) + 1;
      brushCount += e.brushes.length;
      for (const b of e.brushes) for (const f of b.faces) textures.add(f.texture);
      const tbType = getProp(e, "_tb_type");
      if (tbType === "_tb_layer") layers.push(getProp(e, "_tb_name") ?? "(unnamed)");
      if (tbType === "_tb_group") groups.push(getProp(e, "_tb_name") ?? "(unnamed)");
    }
    const bounds = mapBounds(map);
    return {
      entities: map.entities.length,
      brushes: brushCount,
      format: usesValveFormat(map) ? "valve220" : "standard",
      bounds: bounds ? { min: bounds.min, max: bounds.max } : null,
      classCounts,
      layers,
      groups,
      textures: [...textures].sort().slice(0, 50),
    };
  }
);

tool(
  "list_entities",
  "List entities with index, classname, targetname, origin, brush count, and bounds. Optionally filter by classname substring or a property key/value.",
  {
    map_path: mapPathSchema,
    classname_filter: z.string().optional().describe("Case-insensitive substring match on classname"),
    property_key: z.string().optional().describe("Only entities that have this property"),
    property_value: z.string().optional().describe("With property_key: require this exact value"),
  },
  ({ map_path, classname_filter, property_key, property_value }) => {
    const map = loadMap(map_path);
    const out = [];
    for (let i = 0; i < map.entities.length; i++) {
      const e = map.entities[i];
      if (classname_filter && !classname(e).toLowerCase().includes(classname_filter.toLowerCase())) continue;
      if (property_key) {
        const v = getProp(e, property_key);
        if (v === undefined) continue;
        if (property_value !== undefined && v !== property_value) continue;
      }
      out.push(entitySummary(e, i));
    }
    return { count: out.length, entities: out };
  }
);

tool(
  "get_entity",
  "Full detail for one entity: all properties, brush list with per-brush bounds and face count.",
  { map_path: mapPathSchema, index: z.number().int().describe("Entity index from list_entities") },
  ({ map_path, index }) => {
    const map = loadMap(map_path);
    const e = entityAt(map, index);
    return {
      ...entitySummary(e, index),
      properties: Object.fromEntries(e.properties.map((p) => [p.key, p.value])),
      brushList: e.brushes.map((b, bi) => {
        const bounds = entityBounds({ properties: [], brushes: [b] });
        return {
          index: bi,
          faces: b.faces.length,
          textures: [...new Set(b.faces.map((f) => f.texture))],
          bounds: bounds ? { min: bounds.min, max: bounds.max } : null,
        };
      }),
    };
  }
);

// ---------- mutation tools ----------

tool(
  "add_entity",
  "Add a point entity (e.g. a light, monster, item)." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    classname: z.string().describe('Entity class, e.g. "light" or "info_player_start"'),
    origin: vec3Schema.optional().describe("Position [x y z]; omitted for non-positional entities"),
    properties: z.record(z.string()).optional().describe("Additional key/value properties"),
  },
  ({ map_path, classname: cls, origin, properties }) =>
    withMap(map_path, (map) => {
      const e: Entity = { properties: [{ key: "classname", value: cls }], brushes: [] };
      if (origin) setProp(e, "origin", origin.map(String).join(" "));
      for (const [k, v] of Object.entries(properties ?? {})) setProp(e, k, v);
      map.entities.push(e);
      return { added: entitySummary(e, map.entities.length - 1) };
    })
);

tool(
  "set_entity_properties",
  "Set and/or remove properties on an existing entity." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    index: z.number().int(),
    set: z.record(z.string()).optional().describe("Properties to set or overwrite"),
    remove: z.array(z.string()).optional().describe("Property keys to delete"),
  },
  ({ map_path, index, set, remove }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, index);
      for (const [k, v] of Object.entries(set ?? {})) setProp(e, k, v);
      const removed = (remove ?? []).filter((k) => removeProp(e, k));
      return { entity: entitySummary(e, index), removed };
    })
);

tool(
  "delete_entity",
  "Delete an entity (and all its brushes). Refuses to delete worldspawn." + EDITOR_NOTE,
  { map_path: mapPathSchema, index: z.number().int() },
  ({ map_path, index }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, index);
      if (classname(e) === "worldspawn") throw new Error("refusing to delete worldspawn");
      map.entities.splice(index, 1);
      return { deleted: { index, classname: classname(e) } };
    })
);

tool(
  "add_brush_box",
  "Add an axis-aligned box brush. Defaults to worldspawn (entity 0); pass entity_index to add to a brush entity like func_door. Matches the map's existing texture format; on an empty map inside a Shogo workspace it writes Standard, which is the only format that game's converter reads." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    min: vec3Schema.describe("Minimum corner [x y z]"),
    max: vec3Schema.describe("Maximum corner [x y z]"),
    texture: z.string().describe('Texture name, e.g. "__TB_empty" or a texture from map_overview'),
    entity_index: z.number().int().optional().describe("Owning entity index; default 0 (worldspawn)"),
  },
  ({ map_path, min, max, texture, entity_index }) =>
    withMap(map_path, (map) => {
      for (let i = 0; i < 3; i++) {
        if (min[i] >= max[i]) throw new Error(`min must be strictly less than max on every axis (axis ${i}: ${min[i]} >= ${max[i]})`);
      }
      const idx = entity_index ?? 0;
      const e = entityAt(map, idx);
      e.brushes.push(makeBoxBrush(min as Vec3, max as Vec3, texture, shouldWriteValve(map, map_path)));
      return { entity: idx, brushIndex: e.brushes.length - 1, min, max, texture };
    })
);

tool(
  "delete_brush",
  "Delete one brush from an entity." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    entity_index: z.number().int(),
    brush_index: z.number().int().describe("Brush index within the entity, from get_entity"),
  },
  ({ map_path, entity_index, brush_index }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index);
      if (!e.brushes[brush_index]) throw new Error(`no brush at index ${brush_index} (entity has ${e.brushes.length})`);
      e.brushes.splice(brush_index, 1);
      return { deleted: { entity: entity_index, brush: brush_index } };
    })
);

tool(
  "translate_entity",
  "Move an entity by a delta: shifts all brush geometry (keeping textures locked in Valve format) and/or the origin property." + EDITOR_NOTE,
  { map_path: mapPathSchema, index: z.number().int(), delta: vec3Schema.describe("Offset [dx dy dz]") },
  ({ map_path, index, delta }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, index);
      translateEntity(e, delta as Vec3);
      return { entity: entitySummary(e, index) };
    })
);

// ---------- undo / backups ----------

tool(
  "undo_last_edit",
  "Restore the map to its state before the most recent edit made by this server (snapshot-based; one step per call)." + EDITOR_NOTE,
  { map_path: mapPathSchema },
  ({ map_path }) => {
    const restored = restoreLatest(map_path);
    if (!restored) throw new Error("no backups available for this map");
    return { restoredFrom: restored, remainingBackups: listBackups(map_path).length };
  }
);

tool(
  "list_backups",
  "List snapshot backups (made automatically before every edit) for a map.",
  { map_path: mapPathSchema },
  ({ map_path }) => ({ backups: listBackups(map_path) })
);

// ---------- rendering ----------

tool(
  "render_preview",
  "Render a 2D orthographic preview of the map as an SVG file: brush footprints (worldspawn gray, brush entities orange) and point entities (blue dots with labels). Views: top (X/Y), front (X/Z), side (Y/Z).",
  {
    map_path: mapPathSchema,
    view: z.enum(["top", "front", "side"]).optional().describe("Default: top"),
    out_path: z.string().optional().describe("Where to write the SVG; default <mapdir>/.tb-mcp/preview-<view>.svg"),
  },
  ({ map_path, view, out_path }) => {
    const map = loadMap(map_path);
    const v: ViewName = view ?? "top";
    const result = renderView(map, v);
    const dest =
      out_path ?? path.join(ensureTbMcpDir(map_path), `preview-${v}.svg`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, result.svg);
    return {
      svgPath: dest,
      view: v,
      brushesDrawn: result.brushCount,
      pointEntitiesDrawn: result.pointEntityCount,
    };
  }
);

// ---------- Compile ----------

tool(
  "compile_map",
  "Compile a .map with ericw-tools and report what the compiler said. Runs qbsp by " +
    "default; pass stages for a full build. Detects leaks, which the compiler reports " +
    "as a warning and still exits successfully, and returns the coordinate the leak " +
    "escaped from.",
  {
    map_path: z.string().describe("Absolute path to the .map file"),
    stages: z
      .array(z.enum(["qbsp", "vis", "light"]))
      .optional()
      .describe('Which tools to run, in order. Default ["qbsp"]. vis is slow.'),
    tools_dir: z
      .string()
      .optional()
      .describe("Directory holding qbsp/vis/light. Defaults to $ERICW_TOOLS_DIR, then PATH."),
    qbsp_args: z.array(z.string()).optional().describe('Extra qbsp arguments, e.g. ["-nopercent"]'),
    vis_args: z.array(z.string()).optional().describe("Extra vis arguments"),
    light_args: z.array(z.string()).optional().describe('Extra light arguments, e.g. ["-extra4"]'),
    timeout_seconds: z.number().optional().describe("Per-tool timeout. Default 600."),
    keep_logs: z
      .boolean()
      .optional()
      .describe("Leave the .log files the tools write beside the map. Off by default."),
  },
  ({ map_path, stages, tools_dir, qbsp_args, vis_args, light_args, timeout_seconds, keep_logs }) =>
    compileMap({
      mapPath: map_path,
      stages,
      toolsDir: tools_dir,
      extraArgs: { qbsp: qbsp_args, vis: vis_args, light: light_args },
      timeoutSeconds: timeout_seconds,
      keepLogs: keep_logs,
    })
);

tool(
  "compile_shogo_map",
  "Compile a .map for Shogo: Mobile Armor Division and report what the compiler produced. " +
    "This is a DIFFERENT toolchain from compile_map - Shogo uses the SDK's Processor.exe " +
    "(.map -> .ed -> .dat), not ericw-tools, and the two are not interchangeable. Drives " +
    "the Shogo mapping kit, so it inherits the compiler's documented traps rather than " +
    "repeating them. Reports light map nodes, which is the number that says whether the " +
    "world is lit or will render black.",
  {
    map_path: z.string().describe("Absolute path to the .map file"),
    kit_dir: z
      .string()
      .optional()
      .describe("The ShogoMapping folder (holds tools/). Defaults to $SHOGO_KIT_DIR."),
    workspace: z
      .string()
      .optional()
      .describe(
        "Folder holding shogo-mapping.json, written by the kit's setup.ps1. " +
          "Defaults to $SHOGO_WORKSPACE."
      ),
    lighting: z
      .boolean()
      .optional()
      .describe("Run the lighting stage. On by default; off is faster while blocking out."),
    install: z
      .boolean()
      .optional()
      .describe("Copy the compiled .dat into the game's Custom folder. On by default."),
    install_target: z
      .enum(["mp", "sp"])
      .optional()
      .describe(
        'Where under Custom to install. "mp" is Custom\\maps\\mp, which the multiplayer ' +
          'host and rotation lists scan; "sp" is Custom itself, which the single-player ' +
          "custom menu scans. Left out, it follows the map's own GameStartPoint GameType, " +
          "so a deathmatch map lands where the host list will find it."
      ),
    timeout_seconds: z.number().optional().describe("Per-step timeout. Default 600."),
  },
  ({ map_path, kit_dir, workspace, lighting, install, install_target, timeout_seconds }) =>
    compileShogoMap({
      mapPath: map_path,
      kitDir: kit_dir,
      workspace,
      lighting,
      install,
      installTarget: install_target,
      timeoutSeconds: timeout_seconds,
    })
);

tool(
  "launch_map",
  "Launch a compiled map in a Quake engine. Copies the .bsp into the game's maps " +
    "directory, starts the engine on that map, and reports anything the engine said " +
    "if it refused to start. Compile the map first: the engine loads the .bsp, not " +
    "the .map.",
  {
    bsp_path: z
      .string()
      .describe("Absolute path to the compiled .bsp (a .map path is accepted and swapped)"),
    engine_path: z.string().describe("Absolute path to the engine, e.g. quakespasm.exe"),
    game_dir: z
      .string()
      .optional()
      .describe("Directory containing id1. Defaults to the engine's own directory."),
    mod: z.string().optional().describe('Mod directory, e.g. "ad" or "copper". Defaults to id1.'),
    extra_args: z.array(z.string()).optional().describe('Extra engine arguments, e.g. ["-fitz"]'),
    install_bsp: z
      .boolean()
      .optional()
      .describe("Copy the .bsp into the maps directory first. On by default."),
    condebug: z
      .boolean()
      .optional()
      .describe(
        "Ask the engine to write qconsole.log so failures are visible. On by default; " +
          "writes that file into the game directory."
      ),
    grace_seconds: z
      .number()
      .optional()
      .describe("How long to watch for the engine dying before calling it launched. Default 3."),
  },
  ({ bsp_path, engine_path, game_dir, mod, extra_args, install_bsp, condebug, grace_seconds }) =>
    launchMap({
      bspPath: bsp_path,
      enginePath: engine_path,
      gameDir: game_dir,
      mod,
      extraArgs: extra_args,
      installBsp: install_bsp,
      condebug,
      graceMs: grace_seconds === undefined ? undefined : grace_seconds * 1000,
    })
);

// ---------- FGD ----------

tool(
  "fgd_classes",
  "List entity classes defined in an FGD file (name, type, description). Use this to learn what entities a game supports.",
  {
    fgd_path: z.string().describe("Absolute path to the .fgd file"),
    filter: z.string().optional().describe("Case-insensitive substring filter on class name"),
  },
  ({ fgd_path, filter }) => {
    const classes = parseFgd(fs.readFileSync(fgd_path, "utf8"));
    const out = classes
      .filter((c) => c.type !== "BaseClass")
      .filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()))
      .map((c) => ({ name: c.name, type: c.type, description: c.description }));
    return { count: out.length, classes: out };
  }
);

tool(
  "fgd_class",
  "Full definition of one FGD entity class with inherited properties and spawnflags resolved from its base classes.",
  {
    fgd_path: z.string().describe("Absolute path to the .fgd file"),
    classname: z.string(),
  },
  ({ fgd_path, classname: cls }) => {
    const classes = parseFgd(fs.readFileSync(fgd_path, "utf8"));
    const resolved = resolveClass(classes, cls);
    if (!resolved) throw new Error(`class "${cls}" not found in ${fgd_path}`);
    return resolved;
  }
);

// ---------- brush / CSG tools ----------

const snapSchema = z.boolean().optional().describe("Round plane points to whole units (TrenchBroom prefers integer planes). Default false.");
const entSchema = z.number().int().optional().describe("Owning entity index; default 0 (worldspawn)");

function pushSolid(map: MapFile, mapPath: string, e: Entity, solid: Solid, texture: string, snap?: boolean): number {
  if (!isValidSolid(solid)) throw new Error("resulting brush is degenerate (zero volume)");
  e.brushes.push(brushFromSolid(solid, texture, shouldWriteValve(map, mapPath), snap));
  return e.brushes.length - 1;
}

function layerEntity(map: MapFile, name: string): Entity {
  const found = map.entities.find((e) => getProp(e, "_tb_type") === "_tb_layer" && getProp(e, "_tb_name") === name);
  if (found) return found;
  const id = Math.max(0, ...map.entities.map((e) => Number(getProp(e, "_tb_id") ?? 0))) + 1;
  const sort = map.entities.filter((e) => getProp(e, "_tb_type") === "_tb_layer").length + 1;
  const layer: Entity = {
    properties: [
      { key: "classname", value: "func_group" }, { key: "_tb_type", value: "_tb_layer" }, { key: "_tb_name", value: name },
      { key: "_tb_id", value: String(id) }, { key: "_tb_layer_sort_index", value: String(sort) },
    ],
    brushes: [],
  };
  map.entities.push(layer);
  return layer;
}

function brushAt(e: Entity, i: number) {
  const b = e.brushes[i];
  if (!b) throw new Error(`no brush at index ${i} (entity has ${e.brushes.length})`);
  return b;
}

tool(
  "add_brush_wedge",
  "Add a ramp/wedge brush filling the box min..max whose top slopes up toward `high` (+x, -x, +y or -y); the tall side keeps full height." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    min: vec3Schema, max: vec3Schema,
    high: z.enum(["+x", "-x", "+y", "-y"]).describe("Direction the ramp rises toward"),
    texture: z.string(), entity_index: entSchema, snap: snapSchema,
  },
  ({ map_path, min, max, high, texture, entity_index, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index ?? 0);
      const s = wedgeSolid(min as Vec3, max as Vec3, high, texture, shouldWriteValve(map, map_path));
      return { entity: entity_index ?? 0, brushIndex: pushSolid(map, map_path, e, s, texture, snap) };
    })
);

tool(
  "add_brush_prism",
  "Add a convex prism: a 2D polygon (xy points, hull taken) extruded between z_min and z_max. Use for arbitrary-angle walls, chamfered pillars, octagonal rooms." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    polygon: z.array(z.tuple([z.number(), z.number()])).min(3),
    z_min: z.number(), z_max: z.number(),
    texture: z.string(), entity_index: entSchema, snap: snapSchema,
  },
  ({ map_path, polygon, z_min, z_max, texture, entity_index, snap }) =>
    withMap(map_path, (map) => {
      if (z_min >= z_max) throw new Error("z_min must be below z_max");
      const e = entityAt(map, entity_index ?? 0);
      const s = prismSolid(polygon as [number, number][], z_min, z_max, texture, shouldWriteValve(map, map_path));
      return { entity: entity_index ?? 0, brushIndex: pushSolid(map, map_path, e, s, texture, snap) };
    })
);

tool(
  "add_brush_cylinder",
  "Add an n-sided cylinder (regular prism) around center [x y], from z_min to z_max. radius is to the corners." + EDITOR_NOTE,
  {
    map_path: mapPathSchema,
    center: z.tuple([z.number(), z.number()]), radius: z.number().positive(),
    z_min: z.number(), z_max: z.number(),
    sides: z.number().int().min(3).max(64).optional().describe("Default 8"),
    texture: z.string(), entity_index: entSchema, snap: snapSchema,
  },
  ({ map_path, center, radius, z_min, z_max, sides, texture, entity_index, snap }) =>
    withMap(map_path, (map) => {
      const n = sides ?? 8;
      const poly: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        poly.push([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]);
      }
      const e = entityAt(map, entity_index ?? 0);
      const s = prismSolid(poly, z_min, z_max, texture, shouldWriteValve(map, map_path));
      return { entity: entity_index ?? 0, brushIndex: pushSolid(map, map_path, e, s, texture, snap) };
    })
);

tool(
  "rotate_brush",
  "Rotate brushes about an axis through a pivot. Valve-format texture alignment stays locked to the geometry. Rotating a whole entity: omit brush_index." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: z.number().int(),
    brush_index: z.number().int().optional().describe("Omit to rotate every brush of the entity"),
    axis: z.enum(["x", "y", "z"]), degrees: z.number(),
    pivot: vec3Schema.optional().describe("Default: centre of the selection's bounds"),
  },
  ({ map_path, entity_index, brush_index, axis, degrees, pivot }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index);
      const targets = brush_index === undefined ? e.brushes : [brushAt(e, brush_index)];
      let p = pivot as Vec3 | undefined;
      if (!p) {
        const pts = targets.flatMap((b) => brushVertices(b));
        const bb = boundsOfPoints(pts);
        if (!bb) throw new Error("nothing to rotate");
        p = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
      }
      const m = rotationMatrix(axis, degrees);
      for (const b of targets) rotateBrush(b, m, p);
      return { rotated: targets.length, pivot: p };
    })
);

tool(
  "clip_brush",
  "Cut a brush with a plane (point + outward normal of the side kept 'back' = opposite the normal). keep: 'back' trims it, 'front' keeps the other side, 'both' splits into two brushes. The cut face gets cut_texture." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: z.number().int(), brush_index: z.number().int(),
    point: vec3Schema, normal: vec3Schema,
    keep: z.enum(["back", "front", "both"]),
    cut_texture: z.string(), snap: snapSchema,
  },
  ({ map_path, entity_index, brush_index, point, normal, keep, cut_texture, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index);
      const valve = shouldWriteValve(map, map_path);
      const s = solidFromBrush(brushAt(e, brush_index));
      const { back, front } = split(s, planeThrough(normal as Vec3, point as Vec3));
      const keepers = [keep !== "front" ? back : null, keep !== "back" ? front : null].filter((x): x is Solid => !!x);
      if (keepers.length === 0) throw new Error("clip plane removes the whole brush; use delete_brush instead");
      e.brushes.splice(brush_index, 1, ...keepers.map((k) => brushFromSolid(k, cut_texture, valve, snap)));
      return { brushes: keepers.length };
    })
);

tool(
  "subtract_box",
  "Boolean subtract: carve the box min..max out of brushes (all brushes of the entity, or one). Each affected convex brush becomes up to 6 pieces, so doorways, windows and rooms can be cut from solid masses. New faces get cut_texture unless the cutter's texture is wanted." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: entSchema,
    brush_index: z.number().int().optional().describe("Only carve this brush; default every brush in the entity"),
    min: vec3Schema, max: vec3Schema, cut_texture: z.string(), snap: snapSchema,
  },
  ({ map_path, entity_index, brush_index, min, max, cut_texture, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index ?? 0);
      const valve = shouldWriteValve(map, map_path);
      const cutter = boxSolid(min as Vec3, max as Vec3, cut_texture, valve);
      const out: Brush[] = [];
      let carved = 0;
      e.brushes.forEach((b, i) => {
        if ((brush_index !== undefined && i !== brush_index) || !intersects(solidFromBrush(b), cutter)) {
          out.push(b);
          return;
        }
        carved++;
        for (const piece of subtract(solidFromBrush(b), cutter)) out.push(brushFromSolid(piece, cut_texture, valve, snap));
      });
      e.brushes = out;
      return { carved, brushesNow: out.length };
    })
);

tool(
  "hollow_brush",
  "Hollow an axis-aligned box brush into a room: replaces it with walls of the given thickness around an empty interior (up to 6 brushes)." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: z.number().int(), brush_index: z.number().int(),
    wall: z.number().positive(), inner_texture: z.string().optional(), snap: snapSchema,
  },
  ({ map_path, entity_index, brush_index, wall, inner_texture, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index);
      const b = brushAt(e, brush_index);
      const bb = brushBounds(b)!;
      const inn = inset(bb.min, bb.max, wall);
      for (let i = 0; i < 3; i++) if (inn.min[i] >= inn.max[i]) throw new Error("wall too thick for this brush");
      const valve = shouldWriteValve(map, map_path);
      const tex = inner_texture ?? b.faces[0].texture;
      const pieces = subtract(solidFromBrush(b), boxSolid(inn.min, inn.max, tex, valve));
      e.brushes.splice(brush_index, 1, ...pieces.map((p) => brushFromSolid(p, tex, valve, snap)));
      return { walls: pieces.length };
    })
);

tool(
  "bevel_brush",
  "Chamfer every edge of a brush by `size` units (cut faces get bevel_texture, default the brush's first face texture). For trims, lips and anything that must not read as a bare cube." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: z.number().int(), brush_index: z.number().int(),
    size: z.number().positive(), bevel_texture: z.string().optional(), snap: snapSchema,
    edges: z.enum(["all", "vertical", "horizontal", "top", "bottom"]).optional().describe("Which edges to chamfer; default all"),
  },
  ({ map_path, entity_index, brush_index, size, bevel_texture, snap, edges }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index);
      const b = brushAt(e, brush_index);
      const tex = bevel_texture ?? b.faces[0].texture;
      const valve = shouldWriteValve(map, map_path);
      const out = bevelSolid(solidFromBrush(b), size, tex, valve, edges ?? "all");
      if (!isValidSolid(out)) throw new Error("bevel too large for this brush");
      e.brushes[brush_index] = brushFromSolid(out, tex, valve, snap);
      return { faces: e.brushes[brush_index].faces.length };
    })
);

tool(
  "list_brushes",
  "List an entity's brushes with bounds, face count and textures, so brush_index values can be found without dumping the map.",
  { map_path: mapPathSchema, entity_index: entSchema },
  ({ map_path, entity_index }) => {
    const map = loadMap(map_path);
    const e = entityAt(map, entity_index ?? 0);
    return e.brushes.map((b, i) => {
      const bb = brushBounds(b);
      return { index: i, faces: b.faces.length, min: bb?.min, max: bb?.max, textures: [...new Set(b.faces.map((f) => f.texture))] };
    });
  }
);

tool(
  "set_face_texture",
  "Set texture, scale, rotation or offset on faces of a brush. Select faces by index, by outward direction ('+z' top, '-z' bottom, '+x', ...) or all. In Valve format, offset is [u, v]; scale applies to both axes unless two numbers are given." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: z.number().int(), brush_index: z.number().int().optional().describe("Omit for every brush of the entity"),
    faces: z.union([z.literal("all"), z.enum(["+x", "-x", "+y", "-y", "+z", "-z"]), z.array(z.number().int())]).optional().describe("Default all"),
    texture: z.string().optional(),
    scale: z.union([z.number(), z.tuple([z.number(), z.number()])]).optional(),
    rotation: z.number().optional(),
    offset: z.tuple([z.number(), z.number()]).optional(),
    fit_tiles: z.tuple([z.number().positive(), z.number().positive()]).optional().describe("Valve only: scale and offset so the texture repeats exactly this many times across the face in u and v (e.g. [1,1] stretches one copy over the face)"),
    texture_size: z.tuple([z.number().positive(), z.number().positive()]).optional().describe("Texture size in px for fit_tiles; default [128,128]"),
  },
  ({ map_path, entity_index, brush_index, faces, texture, scale, rotation, offset, fit_tiles, texture_size }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index);
      const brushes = brush_index === undefined ? e.brushes : [brushAt(e, brush_index)];
      let changed = 0;
      for (const b of brushes) {
        b.faces.forEach((f, i) => {
          const n = planeFromPoints(...f.points).normal;
          const sel = faces ?? "all";
          let hit = false;
          if (sel === "all") hit = true;
          else if (Array.isArray(sel)) hit = sel.includes(i);
          else {
            const ax = sel[1] === "x" ? 0 : sel[1] === "y" ? 1 : 2;
            const sgn = sel[0] === "+" ? 1 : -1;
            hit = n[ax] * sgn > 0.7;
          }
          if (!hit) return;
          if (texture !== undefined) f.texture = texture;
          if (scale !== undefined) {
            const [sx, sy] = typeof scale === "number" ? [scale, scale] : scale;
            f.xScale = sx;
            f.yScale = sy;
          }
          if (rotation !== undefined) f.rotation = rotation;
          if (offset !== undefined) {
            if (f.uAxis && f.vAxis) {
              f.uAxis.offset = offset[0];
              f.vAxis.offset = offset[1];
            } else {
              f.xOffset = offset[0];
              f.yOffset = offset[1];
            }
          }
          if (fit_tiles && f.uAxis && f.vAxis) {
            const verts = polygons(solidFromBrush(b)).find((pg) => pg.plane.src === f)?.verts;
            const ext = verts ? faceExtent(f, verts) : null;
            if (ext) {
              const [tw, th] = texture_size ?? [128, 128];
              f.xScale = Math.max(1e-3, (ext.u[1] - ext.u[0]) / (tw * fit_tiles[0]));
              f.yScale = Math.max(1e-3, (ext.v[1] - ext.v[0]) / (th * fit_tiles[1]));
              f.uAxis.offset = -ext.u[0] / f.xScale;
              f.vAxis.offset = -ext.v[0] / f.yScale;
            }
          }
          f.raw = undefined;
          changed++;
        });
      }
      return { facesChanged: changed };
    })
);

// ---------- compound shapes, arrays, groups, validation ----------

function pushBrushes(map: MapFile, mapPath: string, e: Entity, solids: Solid[], texture: string, snap?: boolean): number[] {
  const idx: number[] = [];
  for (const s of solids) {
    if (!isValidSolid(s)) continue;
    e.brushes.push(brushFromSolid(s, texture, shouldWriteValve(map, mapPath), snap));
    idx.push(e.brushes.length - 1);
  }
  if (idx.length === 0) throw new Error("shape produced no valid brushes");
  return idx;
}

tool(
  "add_brush_hull",
  "Add one brush that is the convex hull of the given points (>= 4, not coplanar). The general primitive: chamfered pillars, tapered legs, bevelled beams, anything convex." + EDITOR_NOTE,
  { map_path: mapPathSchema, points: z.array(vec3Schema).min(4), texture: z.string(), entity_index: entSchema, snap: snapSchema },
  ({ map_path, points, texture, entity_index, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index ?? 0);
      const s = solidFromPoints(points as Vec3[], texture, shouldWriteValve(map, map_path));
      return { brushIndex: pushBrushes(map, map_path, e, [s], texture, snap)[0] };
    })
);

tool(
  "add_stairs",
  "Add a staircase filling the box min..max, rising toward `high`. Each step is a solid block down to the floor, so no tread floats (stair-reach audits stay happy). Step height = box height / steps." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, min: vec3Schema, max: vec3Schema,
    high: z.enum(["+x", "-x", "+y", "-y"]), steps: z.number().int().min(2).max(64),
    texture: z.string(), entity_index: entSchema, snap: snapSchema,
  },
  ({ map_path, min, max, high, steps, texture, entity_index, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index ?? 0);
      const valve = shouldWriteValve(map, map_path);
      const solids = stairBoxes(min as Vec3, max as Vec3, high, steps).map((b) => boxSolid(b.min, b.max, texture, valve));
      return { brushes: pushBrushes(map, map_path, e, solids, texture, snap) };
    })
);

tool(
  "add_arch",
  "Add a semicircular arch (voussoir blocks) standing on `center` (the springing line midpoint). Spans along `axis`; inner = opening radius, outer = outer radius, depth = wall thickness. Pair with subtract_box to cut the doorway first." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, center: vec3Schema, axis: z.enum(["x", "y"]),
    inner: z.number().positive(), outer: z.number().positive(), depth: z.number().positive(),
    segments: z.number().int().min(3).max(32).optional().describe("Default 8"),
    texture: z.string(), entity_index: entSchema, snap: snapSchema,
  },
  ({ map_path, center, axis, inner, outer, depth, segments, texture, entity_index, snap }) =>
    withMap(map_path, (map) => {
      if (outer <= inner) throw new Error("outer must exceed inner");
      const e = entityAt(map, entity_index ?? 0);
      const valve = shouldWriteValve(map, map_path);
      const solids = archPoints(center as Vec3, axis, inner, outer, depth, segments ?? 8).map((pts) => solidFromPoints(pts, texture, valve));
      return { brushes: pushBrushes(map, map_path, e, solids, texture, snap) };
    })
);

tool(
  "add_pipe",
  "Add a straight pipe/beam between two points as an n-gon prism at any angle (default 8 sides). Chain several for bends; use big radius + few sides for ducts." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, from: vec3Schema, to: vec3Schema, radius: z.number().positive(),
    sides: z.number().int().min(3).max(32).optional(), texture: z.string(), entity_index: entSchema, snap: snapSchema,
  },
  ({ map_path, from, to, radius, sides, texture, entity_index, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index ?? 0);
      const s = solidFromPoints(pipePoints(from as Vec3, to as Vec3, radius, sides ?? 8), texture, shouldWriteValve(map, map_path));
      return { brushIndex: pushBrushes(map, map_path, e, [s], texture, snap)[0] };
    })
);

tool(
  "add_catwalk",
  "Add a catwalk: a deck slab from `from` to `to` (a straight run, `width` wide, `thickness` thick, top at the given z), with optional side rails (post + top rail) and support legs every `leg_every` units down to `floor_z`." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, from: vec3Schema, to: vec3Schema, width: z.number().positive(), thickness: z.number().positive(),
    rail_height: z.number().optional(), rail_size: z.number().positive().optional(),
    leg_every: z.number().positive().optional(), leg_size: z.number().positive().optional(), floor_z: z.number().optional(),
    deck_texture: z.string(), rail_texture: z.string().optional(), entity_index: entSchema, snap: snapSchema,
  },
  ({ map_path, from, to, width, thickness, rail_height, rail_size, leg_every, leg_size, floor_z, deck_texture, rail_texture, entity_index, snap }) =>
    withMap(map_path, (map) => {
      const f = from as Vec3, t = to as Vec3;
      const alongX = Math.abs(t[0] - f[0]) >= Math.abs(t[1] - f[1]);
      const top = Math.max(f[2], t[2]);
      const valve = shouldWriteValve(map, map_path);
      const rt = rail_texture ?? deck_texture;
      const x0 = Math.min(f[0], t[0]), x1 = Math.max(f[0], t[0]), y0 = Math.min(f[1], t[1]), y1 = Math.max(f[1], t[1]);
      const lo: Vec3 = alongX ? [x0, f[1] - width / 2, top - thickness] : [f[0] - width / 2, y0, top - thickness];
      const hi: Vec3 = alongX ? [x1, f[1] + width / 2, top] : [f[0] + width / 2, y1, top];
      const e = entityAt(map, entity_index ?? 0);
      const made: number[] = [];
      made.push(...pushBrushes(map, map_path, e, [boxSolid(lo, hi, deck_texture, valve)], deck_texture, snap));
      if (rail_height) {
        const rs = rail_size ?? 2;
        const sides: [Vec3, Vec3][] = alongX
          ? [[[lo[0], lo[1], top], [hi[0], lo[1] + rs, top + rail_height]], [[lo[0], hi[1] - rs, top], [hi[0], hi[1], top + rail_height]]]
          : [[[lo[0], lo[1], top], [lo[0] + rs, hi[1], top + rail_height]], [[hi[0] - rs, lo[1], top], [hi[0], hi[1], top + rail_height]]];
        made.push(...pushBrushes(map, map_path, e, sides.map(([a, b]) => boxSolid(a, b, rt, valve)), rt, snap));
      }
      if (leg_every && floor_z !== undefined) {
        const ls = leg_size ?? 4;
        const solids: Solid[] = [];
        const len = alongX ? x1 - x0 : y1 - y0;
        for (let d = 0; d <= len + 1e-6; d += leg_every) {
          const c = (alongX ? x0 : y0) + Math.min(d, len - ls);
          for (const side of [-1, 1]) {
            const cross = (alongX ? f[1] : f[0]) + side * (width / 2 - ls);
            const a: Vec3 = alongX ? [c, Math.min(cross, cross + ls), floor_z] : [Math.min(cross, cross + ls), c, floor_z];
            const b: Vec3 = alongX ? [c + ls, a[1] + ls, top - thickness] : [a[0] + ls, c + ls, top - thickness];
            solids.push(boxSolid(a, b, rt, valve));
          }
        }
        made.push(...pushBrushes(map, map_path, e, solids, rt, snap));
      }
      return { brushes: made };
    })
);

tool(
  "subtract_path",
  "Carve a trench/channel/corridor: subtract a swept rectangular profile along a polyline of [x y] points between z_min and z_max, `width` wide. Each segment is one cutter box (axis-aligned segments) or a rotated prism." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: entSchema, path: z.array(z.tuple([z.number(), z.number()])).min(2),
    width: z.number().positive(), z_min: z.number(), z_max: z.number(), cut_texture: z.string(), snap: snapSchema,
  },
  ({ map_path, entity_index, path: pts, width, z_min, z_max, cut_texture, snap }) =>
    withMap(map_path, (map) => {
      const e = entityAt(map, entity_index ?? 0);
      const valve = shouldWriteValve(map, map_path);
      let brushes = e.brushes;
      let carved = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        const len = Math.hypot(bx - ax, by - ay);
        const nx = (-(by - ay) / len) * (width / 2), ny = ((bx - ax) / len) * (width / 2);
        const cutter = prismSolid([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]], z_min, z_max, cut_texture, valve);
        const next: Brush[] = [];
        for (const b of brushes) {
          const s = solidFromBrush(b);
          if (!intersects(s, cutter)) { next.push(b); continue; }
          carved++;
          for (const p of subtract(s, cutter)) next.push(brushFromSolid(p, cut_texture, valve, snap));
        }
        brushes = next;
      }
      e.brushes = brushes;
      return { carved, brushesNow: brushes.length };
    })
);

tool(
  "clone_brushes",
  "Copy brushes (listed, or the whole entity) `count` times, each copy moved by `offset` and rotated `rotate_z` degrees more than the last (about `pivot`), optionally mirrored first. Arrays of ribs, columns, rungs, rings; mirror a half-room." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: entSchema, brush_indices: z.array(z.number().int()).optional(),
    count: z.number().int().min(1).max(256), offset: vec3Schema.optional(), rotate_z: z.number().optional(),
    pivot: vec3Schema.optional(), mirror: z.enum(["x", "y"]).optional().describe("Mirror about the pivot plane (copy only)"),
    to_entity_index: z.number().int().optional().describe("Put copies in another entity (e.g. a func_group)"),
  },
  ({ map_path, entity_index, brush_indices, count, offset, rotate_z, pivot, mirror, to_entity_index }) =>
    withMap(map_path, (map) => {
      const src = entityAt(map, entity_index ?? 0);
      const dst = entityAt(map, to_entity_index ?? (entity_index ?? 0));
      const picks = (brush_indices ?? src.brushes.map((_, i) => i)).map((i) => brushAt(src, i));
      const pv = (pivot as Vec3) ?? [0, 0, 0];
      const off = (offset as Vec3) ?? [0, 0, 0];
      let made = 0;
      for (let n = 1; n <= count; n++) {
        for (const b of picks) {
          dst.brushes.push(transformBrush(b, (rotate_z ?? 0) * n, [off[0] * n, off[1] * n, off[2] * n], pv, n === 1 ? mirror : undefined));
          made++;
        }
      }
      return { made };
    })
);

tool(
  "group_brushes",
  "Move brushes of worldspawn into a new named TrenchBroom group (func_group), so they select, hide and move together. Returns the group's entity index." + EDITOR_NOTE,
  { map_path: mapPathSchema, brush_indices: z.array(z.number().int()).min(1), name: z.string() },
  ({ map_path, brush_indices, name }) =>
    withMap(map_path, (map) => {
      const w = entityAt(map, 0);
      const picked = [...new Set(brush_indices)].sort((a, b) => a - b).map((i) => brushAt(w, i));
      w.brushes = w.brushes.filter((b) => !picked.includes(b));
      const ids = map.entities.map((e) => Number(getProp(e, "_tb_id") ?? 0));
      const id = Math.max(0, ...ids) + 1;
      map.entities.push({
        properties: [
          { key: "classname", value: "func_group" }, { key: "_tb_type", value: "_tb_group" },
          { key: "_tb_name", value: name }, { key: "_tb_id", value: String(id) },
        ],
        brushes: picked,
      });
      return { entity: map.entities.length - 1, brushes: picked.length };
    })
);

tool(
  "validate_map",
  "Check a map without compiling: degenerate or non-convex brushes, tiny/huge brushes, brushes outside the declared level bounds (worldspawn level_size, metres, with level_units per metre), textures missing from an optional materials file, and duplicate brushes. Returns a list of issues with entity/brush indices.",
  {
    map_path: mapPathSchema,
    materials_path: z.string().optional().describe("Path to a JSON file of known materials (an array of {id} objects, or an object with a `materials` array of them); texture names in the map are checked against those ids"),
  },
  ({ map_path, materials_path }) => {
    const map = loadMap(map_path);
    const issues: { entity: number; brush: number; problem: string }[] = [];
    const world = map.entities[0];
    const units = Number(getProp(world, "level_units") ?? 8);
    const size = (getProp(world, "level_size") ?? "").split(/\s+/).map(Number);
    let known: Set<string> | null = null;
    if (materials_path) {
      const j = JSON.parse(fs.readFileSync(materials_path, "utf8"));
      known = new Set<string>((j.materials ?? j).map((m: { id: string }) => m.id));
    }
    const seen = new Map<string, number>();
    map.entities.forEach((e, ei) => {
      e.brushes.forEach((b, bi) => {
        const add = (problem: string) => issues.push({ entity: ei, brush: bi, problem });
        const s = solidFromBrush(b);
        const polys = polygons(s);
        if (b.faces.length < 4) add("fewer than 4 faces");
        if (polys.length < 4 || !isValidSolid(s)) { add("degenerate (zero volume or open)"); return; }
        if (polys.length < b.faces.length) add(`${b.faces.length - polys.length} face(s) contribute no area (redundant planes)`);
        const bb = brushBounds(b);
        if (bb) {
          const dims = [0, 1, 2].map((i) => bb.max[i] - bb.min[i]);
          if (Math.min(...dims) < 1) add(`thinner than 1 unit (${Math.min(...dims).toFixed(2)})`);
          else if (Math.min(...dims) < 0.25 * units) add(`thinner than 0.25 m (${(Math.min(...dims) / units).toFixed(2)} m): the game's level validator needs hull boxes of at least 0.25 m; map-level.mjs grows them`);
          if (size.length === 3 && size.every((x) => x > 0)) {
            const lim = [size[0] * units, size[2] * units, size[1] * units]; // map x, y(level z), z(level y)
            for (let i = 0; i < 3; i++) if (bb.min[i] < -0.5 || bb.max[i] > lim[i] + 0.5) { add(`outside level bounds on map axis ${"xyz"[i]}`); break; }
          }
        }
        for (const f of b.faces) if (known && !known.has(f.texture) && !["__TB_empty", "clip", "skip"].includes(f.texture)) { add(`unknown material "${f.texture}"`); break; }
        const key = JSON.stringify(brushBounds(b)) + b.faces.map((f) => f.texture).sort().join();
        if (seen.has(key)) add(`duplicate of entity ${seen.get(key)! >> 16} brush ${seen.get(key)! & 0xffff}`);
        else seen.set(key, (ei << 16) | bi);
      });
    });
    return { brushes: map.entities.reduce((n, e) => n + e.brushes.length, 0), issues: issues.slice(0, 200), issueCount: issues.length };
  }
);

tool(
  "render_shaded",
  "Fast shaded 3D preview as a PNG (software rasterizer, flat-shaded, z-buffered, ~1 s for thousands of brushes). Give an eye and a target point in map units; textures get stable colours (or pass colors). clip_z hides everything above a height for cutaways. Use this to judge silhouettes and layout before importing into the game.",
  {
    map_path: mapPathSchema, eye: vec3Schema, target: vec3Schema,
    fov: z.number().min(20).max(120).optional(), width: z.number().int().min(160).max(1920).optional(), height: z.number().int().min(90).max(1080).optional(),
    clip_z: z.number().optional(), colors: z.record(z.tuple([z.number(), z.number(), z.number()])).optional(),
    out_path: z.string().optional().describe("PNG path; default <mapdir>/.tb-mcp/shaded.png"),
  },
  ({ map_path, eye, target, fov, width, height, clip_z, colors, out_path }) => {
    const map = loadMap(map_path);
    const r = renderShaded(map, { eye: eye as Vec3, target: target as Vec3, fov, width, height, clipZ: clip_z, colors: colors as any });
    const dest = out_path ?? path.join(ensureTbMcpDir(map_path), "shaded.png");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, r.png);
    return { pngPath: dest, polygons: r.polys };
  }
);

tool(
  "add_layer",
  "Create a TrenchBroom layer (a named, hideable layer such as 'Architecture', 'Trim', 'Gameplay volumes'). Returns its entity index and id." + EDITOR_NOTE,
  { map_path: mapPathSchema, name: z.string(), omit_from_export: z.boolean().optional() },
  ({ map_path, name, omit_from_export }) =>
    withMap(map_path, (map) => {
      const ids = map.entities.map((e) => Number(getProp(e, "_tb_id") ?? 0));
      const id = Math.max(0, ...ids) + 1;
      const sort = map.entities.filter((e) => getProp(e, "_tb_type") === "_tb_layer").length + 1;
      const props = [
        { key: "classname", value: "func_group" }, { key: "_tb_type", value: "_tb_layer" },
        { key: "_tb_name", value: name }, { key: "_tb_id", value: String(id) },
        { key: "_tb_layer_sort_index", value: String(sort) },
      ];
      if (omit_from_export) props.push({ key: "_tb_layer_omit_from_export", value: "1" });
      map.entities.push({ properties: props, brushes: [] });
      return { entity: map.entities.length - 1, layerId: id };
    })
);

tool(
  "move_to_layer",
  "Move brushes (from worldspawn) and/or whole entities (point or group entities) into a layer made with add_layer." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, layer_entity: z.number().int().describe("Entity index returned by add_layer"),
    brush_indices: z.array(z.number().int()).optional().describe("Brushes of worldspawn"),
    entity_indices: z.array(z.number().int()).optional().describe("Other entities to tag with the layer"),
  },
  ({ map_path, layer_entity, brush_indices, entity_indices }) =>
    withMap(map_path, (map) => {
      const layer = entityAt(map, layer_entity);
      if (getProp(layer, "_tb_type") !== "_tb_layer") throw new Error("not a layer entity");
      const id = getProp(layer, "_tb_id")!;
      const w = entityAt(map, 0);
      const picked = [...new Set(brush_indices ?? [])].sort((a, b) => a - b).map((i) => brushAt(w, i));
      w.brushes = w.brushes.filter((b) => !picked.includes(b));
      layer.brushes.push(...picked);
      for (const ei of entity_indices ?? []) setProp(entityAt(map, ei), "_tb_layer", id);
      return { brushesMoved: picked.length, entitiesTagged: (entity_indices ?? []).length };
    })
);

// ---------- brush-vs-brush booleans ----------

function twoBrushes(map: MapFile, ei: number, a: number, b: number) {
  const e = entityAt(map, ei);
  if (a === b) throw new Error("brush_a and brush_b must differ");
  return { e, ba: brushAt(e, a), bb: brushAt(e, b) };
}

tool(
  "subtract_brush",
  "Boolean A minus B between two existing brushes (A is carved by B's shape: slanted cutters, pipes, arches, anything convex). A becomes up to one piece per face of B. keep_cutter false (default) deletes B afterwards." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: entSchema, brush_a: z.number().int(), brush_b: z.number().int(),
    keep_cutter: z.boolean().optional(), cut_texture: z.string().optional(), snap: snapSchema,
  },
  ({ map_path, entity_index, brush_a, brush_b, keep_cutter, cut_texture, snap }) =>
    withMap(map_path, (map) => {
      const ei = entity_index ?? 0;
      const { e, ba, bb } = twoBrushes(map, ei, brush_a, brush_b);
      const valve = shouldWriteValve(map, map_path);
      const sa = solidFromBrush(ba), sb = solidFromBrush(bb);
      const tex = cut_texture ?? ba.faces[0].texture;
      const pieces = intersects(sa, sb) ? subtract(sa, sb).map((p) => brushFromSolid(p, tex, valve, snap)) : [ba];
      const drop = new Set([brush_a, ...(keep_cutter ? [] : [brush_b])]);
      e.brushes = [...e.brushes.filter((_, i) => !drop.has(i)), ...pieces];
      return { pieces: pieces.length, brushesNow: e.brushes.length };
    })
);

tool(
  "intersect_brushes",
  "Boolean A and B: both brushes are replaced by the single convex brush where they overlap. Fails if they do not overlap." + EDITOR_NOTE,
  { map_path: mapPathSchema, entity_index: entSchema, brush_a: z.number().int(), brush_b: z.number().int(), snap: snapSchema },
  ({ map_path, entity_index, brush_a, brush_b, snap }) =>
    withMap(map_path, (map) => {
      const { e, ba, bb } = twoBrushes(map, entity_index ?? 0, brush_a, brush_b);
      const both: Solid = { planes: [...solidFromBrush(ba).planes, ...solidFromBrush(bb).planes] };
      if (!isValidSolid(both)) throw new Error("brushes do not overlap");
      const made = brushFromSolid(both, ba.faces[0].texture, shouldWriteValve(map, map_path), snap);
      e.brushes = [...e.brushes.filter((_, i) => i !== brush_a && i !== brush_b), made];
      return { volume: solidVolume(both) };
    })
);

tool(
  "union_brushes",
  "Boolean A or B. Brushes in this format are convex, so a union is either one merged convex brush (when the hull of both has exactly the union's volume, e.g. two boxes forming a bigger box or a flush slab) or a non-overlapping set: A stays, B is trimmed to B minus A. Returns which happened. merge: 'auto' (default) tries the hull first, 'never' always trims." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, entity_index: entSchema, brush_a: z.number().int(), brush_b: z.number().int(),
    merge: z.enum(["auto", "never"]).optional(), snap: snapSchema,
  },
  ({ map_path, entity_index, brush_a, brush_b, merge, snap }) =>
    withMap(map_path, (map) => {
      const { e, ba, bb } = twoBrushes(map, entity_index ?? 0, brush_a, brush_b);
      const valve = shouldWriteValve(map, map_path);
      const sa = solidFromBrush(ba), sb = solidFromBrush(bb);
      const tex = ba.faces[0].texture;
      const inter: Solid = { planes: [...sa.planes, ...sb.planes] };
      const overlap = isValidSolid(inter) ? solidVolume(inter) : 0;
      const unionVol = solidVolume(sa) + solidVolume(sb) - overlap;
      if ((merge ?? "auto") === "auto") {
        const pts = [...brushVertices(ba), ...brushVertices(bb)];
        const hull = solidFromPoints(pts, tex, valve);
        if (isValidSolid(hull) && Math.abs(solidVolume(hull) - unionVol) < Math.max(0.05, unionVol * 1e-4)) {
          e.brushes = [...e.brushes.filter((_, i) => i !== brush_a && i !== brush_b), brushFromSolid(hull, tex, valve, snap)];
          return { result: "merged", brushes: 1, volume: unionVol };
        }
      }
      const rest = overlap > 0 ? subtract(sb, sa) : [sb];
      const made = rest.map((p) => brushFromSolid(p, bb.faces[0].texture, valve, snap));
      e.brushes = [...e.brushes.filter((_, i) => i !== brush_b), ...made];
      return { result: "set", trimmedBPieces: made.length, volume: unionVol };
    })
);

tool(
  "add_room_trim",
  "Dress the inside of a room (interior box min..max in map units): bevelled base trim and ceiling cornice round all four walls, optional vertical ribs every `rib_every` units along each wall, and optional corner pilasters. Pieces are bevelled hulls (real silhouette, one brush each). `openings` are boxes (doorways, windows) the trim must skip; pieces overlapping an opening are cut around it." + EDITOR_NOTE,
  {
    map_path: mapPathSchema, min: vec3Schema, max: vec3Schema,
    base_height: z.number().positive().optional().describe("Default 2"), cornice_height: z.number().positive().optional().describe("Default 2"),
    depth: z.number().positive().optional().describe("How far trim sticks out of the wall; default 1"),
    rib_every: z.number().positive().optional(), rib_width: z.number().positive().optional(), pilasters: z.boolean().optional(),
    base_texture: z.string(), cornice_texture: z.string().optional(), rib_texture: z.string().optional(),
    bevel: z.number().positive().optional().describe("Default 0.4 units"),
    openings: z.array(z.object({ min: vec3Schema, max: vec3Schema })).optional(),
    layer: z.string().optional().describe('Layer the trim goes into; default "Visual trim". Brushes in a layer whose name starts with "Visual" become render-only in the game (no collision, no nav).'),
    entity_index: entSchema, snap: snapSchema,
  },
  ({ map_path, min, max, base_height, cornice_height, depth, rib_every, rib_width, pilasters, base_texture, cornice_texture, rib_texture, bevel, openings, layer, entity_index, snap }) =>
    withMap(map_path, (map) => {
      const e = layerEntity(map, layer ?? "Visual trim");
      const valve = shouldWriteValve(map, map_path);
      const bh = base_height ?? 2, ch = cornice_height ?? 2, dp = depth ?? 1, bv = bevel ?? 0.4;
      const ct = cornice_texture ?? base_texture, rt = rib_texture ?? base_texture;
      const lo = min as Vec3, hi = max as Vec3;
      const pieces: { a: Vec3; b: Vec3; tex: string }[] = [];
      const wall = (from: Vec3, to: Vec3, inward: [number, number], z0: number, z1: number, tex: string) => {
        // a slab hugging the wall from `from` to `to`, `dp` thick toward the room
        const x0 = Math.min(from[0], to[0]) + Math.min(0, inward[0] * dp), x1 = Math.max(from[0], to[0]) + Math.max(0, inward[0] * dp);
        const y0 = Math.min(from[1], to[1]) + Math.min(0, inward[1] * dp), y1 = Math.max(from[1], to[1]) + Math.max(0, inward[1] * dp);
        pieces.push({ a: [x0, y0, z0], b: [x1, y1, z1], tex });
      };
      const sides: { from: Vec3; to: Vec3; inward: [number, number] }[] = [
        { from: [lo[0], lo[1], 0], to: [hi[0], lo[1], 0], inward: [0, 1] },
        { from: [lo[0], hi[1], 0], to: [hi[0], hi[1], 0], inward: [0, -1] },
        { from: [lo[0], lo[1], 0], to: [lo[0], hi[1], 0], inward: [1, 0] },
        { from: [hi[0], lo[1], 0], to: [hi[0], hi[1], 0], inward: [-1, 0] },
      ];
      for (const s of sides) {
        wall(s.from, s.to, s.inward, lo[2], lo[2] + bh, base_texture);
        wall(s.from, s.to, s.inward, hi[2] - ch, hi[2], ct);
        if (rib_every) {
          const alongX = s.from[1] === s.to[1];
          const len = alongX ? hi[0] - lo[0] : hi[1] - lo[1];
          const rw = rib_width ?? 2;
          for (let d = rib_every; d < len - rw; d += rib_every) {
            const f: Vec3 = alongX ? [lo[0] + d, s.from[1], 0] : [s.from[0], lo[1] + d, 0];
            const t: Vec3 = alongX ? [lo[0] + d + rw, s.to[1], 0] : [s.to[0], lo[1] + d + rw, 0];
            wall(f, t, s.inward, lo[2] + bh, hi[2] - ch, rt);
          }
        }
      }
      if (pilasters) {
        const ps = Math.max(dp * 2, 3);
        for (const [cx, cy] of [[lo[0], lo[1]], [hi[0], lo[1]], [lo[0], hi[1]], [hi[0], hi[1]]]) {
          const sx = cx === lo[0] ? 1 : -1, sy = cy === lo[1] ? 1 : -1;
          pieces.push({ a: [Math.min(cx, cx + sx * ps), Math.min(cy, cy + sy * ps), lo[2] + bh], b: [Math.max(cx, cx + sx * ps), Math.max(cy, cy + sy * ps), hi[2] - ch], tex: rt });
        }
      }
      const cutters = (openings ?? []).map((o) => boxSolid(o.min as Vec3, o.max as Vec3, base_texture, valve));
      let made = 0;
      for (const p of pieces) {
        let solids: Solid[] = [bevelSolid(boxSolid(p.a, p.b, p.tex, valve), Math.min(bv, (Math.min(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]) / 2) - 0.01), p.tex, valve, "all")];
        for (const c of cutters) {
          solids = solids.flatMap((s) => (intersects(s, c) ? subtract(s, c) : [s]));
        }
        for (const s of solids) {
          if (!isValidSolid(s)) continue;
          e.brushes.push(brushFromSolid(s, p.tex, valve, snap));
          made++;
        }
      }
      return { trimBrushes: made };
    })
);

// ---------- start ----------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("trenchbroom-mcp ready");

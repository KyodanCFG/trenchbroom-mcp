import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseMap } from "../dist/map/parser.js";
import { serializeMap, formatFace } from "../dist/map/writer.js";
import { getProp, classname, parseOrigin } from "../dist/map/model.js";
import { brushVertices, brushBounds, mapBounds } from "../dist/map/geometry.js";
import { makeBoxBrush, translateEntity, usesValveFormat } from "../dist/map/builder.js";
import { renderView } from "../dist/render/svg.js";
import { parseFgd, resolveClass } from "../dist/fgd/parser.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, "fixtures", "example.map"), "utf8");
const fgdFixture = fs.readFileSync(path.join(here, "fixtures", "example.fgd"), "utf8");

test("parse: structure of the example map", () => {
  const map = parseMap(fixture);
  assert.equal(map.entities.length, 4);
  assert.equal(classname(map.entities[0]), "worldspawn");
  assert.equal(getProp(map.entities[0], "mapversion"), "220");
  assert.equal(map.entities[0].brushes.length, 1);
  assert.equal(map.entities[0].brushes[0].faces.length, 6);
  assert.deepEqual(parseOrigin(map.entities[1]), [0, 0, 128]);
  assert.equal(classname(map.entities[3]), "func_door");
  assert.equal(map.entities[3].brushes.length, 1);
  const face = map.entities[0].brushes[0].faces[0];
  assert.equal(face.texture, "ground1_1");
  assert.ok(face.uAxis, "fixture is Valve 220");
  assert.deepEqual(face.uAxis.axis, [1, 0, 0]);
});

test("roundtrip: serialize(parse(x)) is a fixpoint", () => {
  const map = parseMap(fixture);
  const once = serializeMap(map);
  const twice = serializeMap(parseMap(once));
  assert.equal(once, twice);
  // and with raw-line preservation, untouched content survives byte-for-byte
  const normalizedFixture = fixture.replace(/\r\n/g, "\n");
  assert.equal(once.replace(/\r\n/g, "\n"), normalizedFixture);
});

test("parse: standard-format face with Quake 2 flags", () => {
  const text = `{
"classname" "worldspawn"
{
( -64 -64 -16 ) ( -64 -63 -16 ) ( -64 -64 -15 ) e1u1/floor1_3 0 0 0 1 1 0 0 0
( 64 -64 -16 ) ( 64 -64 -15 ) ( 64 -63 -16 ) e1u1/floor1_3 0 0 0 1 1 0 0 0
( -64 -64 -16 ) ( -64 -64 -15 ) ( -63 -64 -16 ) e1u1/floor1_3 0 0 0 1 1 0 0 0
( -64 64 -16 ) ( -63 64 -16 ) ( -64 64 -15 ) e1u1/floor1_3 0 0 0 1 1 0 0 0
( -64 -64 -16 ) ( -63 -64 -16 ) ( -64 -63 -16 ) e1u1/floor1_3 0 0 0 1 1 0 0 0
( -64 -64 16 ) ( -64 -63 16 ) ( -63 -64 16 ) e1u1/floor1_3 0 0 0 1 1 0 0 0
}
}
`;
  const map = parseMap(text);
  const face = map.entities[0].brushes[0].faces[0];
  assert.equal(face.texture, "e1u1/floor1_3");
  assert.equal(face.uAxis, undefined);
  assert.equal(face.xOffset, 0);
  assert.equal(face.extra, "0 0 0");
  assert.equal(serializeMap(parseMap(serializeMap(map))), serializeMap(map));
});

test("geometry: box brush has 8 vertices and correct bounds", () => {
  const map = parseMap(fixture);
  const brush = map.entities[0].brushes[0];
  const verts = brushVertices(brush);
  assert.equal(verts.length, 8);
  const bounds = brushBounds(brush);
  assert.deepEqual(bounds.min, [-256, -256, -16]);
  assert.deepEqual(bounds.max, [256, 256, 0]);
});

test("geometry: map bounds include point entities", () => {
  const map = parseMap(fixture);
  const bounds = mapBounds(map);
  assert.equal(bounds.max[2], 128); // the light at z=128
});

test("builder: makeBoxBrush produces a valid box in both formats", () => {
  for (const valve of [true, false]) {
    const brush = makeBoxBrush([0, 0, 0], [64, 128, 32], "tex", valve);
    assert.equal(brush.faces.length, 6);
    const bounds = brushBounds(brush);
    assert.deepEqual(bounds.min, [0, 0, 0]);
    assert.deepEqual(bounds.max, [64, 128, 32]);
    // every face must serialize and reparse
    for (const f of brush.faces) {
      assert.ok(formatFace(f).startsWith("( "));
    }
  }
});

test("builder: generated box round-trips through the parser", () => {
  const map = parseMap(fixture);
  map.entities[0].brushes.push(makeBoxBrush([300, 300, 0], [364, 364, 64], "city2_2", usesValveFormat(map)));
  const reparsed = parseMap(serializeMap(map));
  const added = reparsed.entities[0].brushes[1];
  const bounds = brushBounds(added);
  assert.deepEqual(bounds.min, [300, 300, 0]);
  assert.deepEqual(bounds.max, [364, 364, 64]);
});

test("builder: translate moves brushes and origin", () => {
  const map = parseMap(fixture);
  translateEntity(map.entities[3], [0, 64, 0]); // func_door
  const bounds = brushBounds(map.entities[3].brushes[0]);
  assert.deepEqual(bounds.min, [96, 32, -8]);
  translateEntity(map.entities[1], [10, 0, 0]); // light
  assert.deepEqual(parseOrigin(map.entities[1]), [10, 0, 128]);
});

test("render: top view SVG contains brushes and labels", () => {
  const map = parseMap(fixture);
  const { svg, brushCount, pointEntityCount } = renderView(map, "top");
  assert.ok(svg.startsWith("<svg"));
  assert.equal(brushCount, 2);
  assert.equal(pointEntityCount, 2);
  assert.ok(svg.includes("info_player_start"));
  assert.ok(svg.includes("<polygon"));
});

test("fgd: classes, properties, choices, spawnflags, inheritance", () => {
  const classes = parseFgd(fgdFixture);
  const names = classes.map((c) => c.name);
  assert.deepEqual(names, ["Targetname", "Appearflags", "light", "func_door"]);

  const light = resolveClass(classes, "light");
  assert.equal(light.type, "PointClass");
  assert.equal(light.description, "Invisible light source");
  const propNames = light.properties.map((p) => p.name);
  assert.ok(propNames.includes("targetname"), "inherited from Targetname");
  assert.ok(propNames.includes("light"));
  const style = light.properties.find((p) => p.name === "style");
  assert.equal(style.choices.length, 3);
  assert.equal(style.choices[2].label, "Fluorescent flicker");
  assert.equal(light.spawnflags.length, 2, "inherited spawnflags");
  assert.equal(light.spawnflags[0].bit, 256);

  const door = resolveClass(classes, "func_door");
  assert.equal(door.type, "SolidClass");
  const angle = door.properties.find((p) => p.name === "angle");
  assert.equal(angle.defaultValue, "0");
  assert.equal(angle.description, "-1 = up, -2 = down");
});

test("parser: the game and format header survives a round trip", () => {
  const src = [
    "// Game: Quake",
    "// Format: Standard",
    "// entity 0",
    "{",
    '"classname" "worldspawn"',
    "}",
    "",
  ].join("\r\n");

  const map = parseMap(src);
  assert.deepEqual(map.header, ["// Game: Quake", "// Format: Standard"]);

  // TrenchBroom picks the game from these lines when opening the map, so losing them
  // makes the map open with a game prompt instead.
  assert.equal(serializeMap(map), src);
});

test("parser: a map without a header round trips unchanged", () => {
  const src = ["// entity 0", "{", '"classname" "worldspawn"', "}", ""].join("\n");
  const map = parseMap(src);
  assert.deepEqual(map.header, []);
  assert.equal(serializeMap(map), src);
});

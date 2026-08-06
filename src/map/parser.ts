import type { Brush, Entity, Face, MapFile, Vec3 } from "./model.js";

const POINT = String.raw`\(\s*(\S+)\s+(\S+)\s+(\S+)\s*\)`;
const FACE_RE = new RegExp(
  String.raw`^\s*${POINT}\s*${POINT}\s*${POINT}\s+("[^"]*"|\S+)\s+(.*)$`
);
const VALVE_REST_RE = new RegExp(
  String.raw`^\[\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*\]\s*\[\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*\]\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$`
);
const KV_RE = /^\s*"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"\s*$/;

function num(s: string, line: number): number {
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error(`line ${line}: expected a number, got "${s}"`);
  return n;
}

function vec3(a: string, b: string, c: string, line: number): Vec3 {
  return [num(a, line), num(b, line), num(c, line)];
}

function parseFace(line: string, lineNo: number): Face {
  const m = FACE_RE.exec(line);
  if (!m) throw new Error(`line ${lineNo}: unrecognized face: ${line.trim()}`);
  const points: [Vec3, Vec3, Vec3] = [
    vec3(m[1], m[2], m[3], lineNo),
    vec3(m[4], m[5], m[6], lineNo),
    vec3(m[7], m[8], m[9], lineNo),
  ];
  let texture = m[10];
  if (texture.startsWith('"') && texture.endsWith('"')) texture = texture.slice(1, -1);
  const rest = m[11].trim();

  if (rest.startsWith("[")) {
    const v = VALVE_REST_RE.exec(rest);
    if (!v) throw new Error(`line ${lineNo}: unrecognized Valve 220 face: ${line.trim()}`);
    return {
      points,
      texture,
      uAxis: { axis: vec3(v[1], v[2], v[3], lineNo), offset: num(v[4], lineNo) },
      vAxis: { axis: vec3(v[5], v[6], v[7], lineNo), offset: num(v[8], lineNo) },
      rotation: num(v[9], lineNo),
      xScale: num(v[10], lineNo),
      yScale: num(v[11], lineNo),
      extra: v[12].trim() || undefined,
      raw: line,
    };
  }

  const parts = rest.split(/\s+/);
  if (parts.length < 5) throw new Error(`line ${lineNo}: unrecognized standard face: ${line.trim()}`);
  return {
    points,
    texture,
    xOffset: num(parts[0], lineNo),
    yOffset: num(parts[1], lineNo),
    rotation: num(parts[2], lineNo),
    xScale: num(parts[3], lineNo),
    yScale: num(parts[4], lineNo),
    extra: parts.slice(5).join(" ") || undefined,
    raw: line,
  };
}

export function parseMap(text: string): MapFile {
  const eol: MapFile["eol"] = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const entities: Entity[] = [];
  let entity: Entity | null = null;
  let brush: Brush | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNo = i + 1;
    if (trimmed === "" || trimmed.startsWith("//")) continue;

    if (trimmed === "{") {
      if (!entity) {
        entity = { properties: [], brushes: [] };
      } else if (!brush) {
        brush = { faces: [] };
      } else {
        throw new Error(`line ${lineNo}: unexpected "{" inside a brush`);
      }
    } else if (trimmed === "}") {
      if (brush) {
        entity!.brushes.push(brush);
        brush = null;
      } else if (entity) {
        entities.push(entity);
        entity = null;
      } else {
        throw new Error(`line ${lineNo}: unexpected "}"`);
      }
    } else if (trimmed.startsWith('"')) {
      if (!entity || brush) throw new Error(`line ${lineNo}: property outside an entity`);
      const kv = KV_RE.exec(line);
      if (!kv) throw new Error(`line ${lineNo}: unrecognized property: ${trimmed}`);
      entity.properties.push({ key: kv[1], value: kv[2], raw: line });
    } else if (trimmed.startsWith("(")) {
      if (!brush) throw new Error(`line ${lineNo}: face outside a brush`);
      brush.faces.push(parseFace(line, lineNo));
    } else {
      throw new Error(`line ${lineNo}: unrecognized content: ${trimmed}`);
    }
  }
  if (entity || brush) throw new Error("unexpected end of file: unclosed block");

  return { entities, eol };
}

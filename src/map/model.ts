export type Vec3 = [number, number, number];

export interface TexAxis {
  axis: Vec3;
  offset: number;
}

export interface Face {
  points: [Vec3, Vec3, Vec3];
  texture: string;
  /** Valve 220 texture axes; present iff the face uses Valve format. */
  uAxis?: TexAxis;
  vAxis?: TexAxis;
  /** Standard (idTech) offsets; present iff the face uses standard format. */
  xOffset?: number;
  yOffset?: number;
  rotation: number;
  xScale: number;
  yScale: number;
  /** Trailing tokens (Quake 2 content/surface/value flags), re-emitted verbatim. */
  extra?: string;
  /** Original source line; emitted verbatim while the face is unmodified. */
  raw?: string;
}

export interface Brush {
  faces: Face[];
}

export interface Property {
  key: string;
  value: string;
  raw?: string;
}

export interface Entity {
  properties: Property[];
  brushes: Brush[];
}

export interface MapFile {
  entities: Entity[];
  eol: "\n" | "\r\n";
}

export function getProp(e: Entity, key: string): string | undefined {
  return e.properties.find((p) => p.key === key)?.value;
}

export function setProp(e: Entity, key: string, value: string): void {
  const existing = e.properties.find((p) => p.key === key);
  if (existing) {
    existing.value = value;
    existing.raw = undefined;
  } else {
    e.properties.push({ key, value });
  }
}

export function removeProp(e: Entity, key: string): boolean {
  const i = e.properties.findIndex((p) => p.key === key);
  if (i === -1) return false;
  e.properties.splice(i, 1);
  return true;
}

export function classname(e: Entity): string {
  return getProp(e, "classname") ?? "";
}

export function parseOrigin(e: Entity): Vec3 | undefined {
  const s = getProp(e, "origin");
  if (!s) return undefined;
  const parts = s.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return undefined;
  return [parts[0], parts[1], parts[2]];
}

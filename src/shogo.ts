import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Compiling for Shogo, by driving the mapping kit rather than reimplementing it.
 *
 * The Quake path in compile.ts runs ericw-tools directly, which is reasonable
 * because those are command-line compilers. Shogo's is not: `Processor.exe` is
 * a 1998 GUI program, and getting a correct build out of it depends on a stack
 * of undocumented behaviour - the options live in a `processor.opt` file in the
 * working directory rather than on the command line, the project root has to be
 * an asset tree rather than the output folder, `-skipdialog` has to be in that
 * file and not just the argument list, and the world name resolves against the
 * current directory.
 *
 * All of that is already encoded, with the evidence, in the kit's
 * `run-processor.ps1`. So this shells out to it. A second implementation would
 * be a second thing to get wrong, and the failures are silent ones - a build
 * that "succeeds" while producing an unlit or untextured world.
 */

export interface ShogoCompileOptions {
  mapPath: string;
  /** Directory holding tools/. Defaults to $SHOGO_KIT_DIR. */
  kitDir?: string;
  /** Holds shogo-mapping.json, written by setup.ps1. Defaults to $SHOGO_WORKSPACE. */
  workspace?: string;
  /** Run the lighting stage. On by default - without it the world is fullbright. */
  lighting?: boolean;
  /** Copy the finished .dat into the game's Custom\ folder. On by default. */
  install?: boolean;
  timeoutSeconds?: number;
}

export interface ShogoCompileResult {
  success: boolean;
  /** Where the compiled world ended up, and where it was installed to. */
  datPath?: string;
  datBytes?: number;
  installedTo?: string;
  /** The world name the game loads - bare, per engine fact 22. */
  worldName: string;
  /**
   * Lightmap allocation, not a count of lights. Nonzero means the lighting
   * stage RAN; zero means it did not and the world is fullbright. A map with
   * no Light entity still reports a large number here and renders black.
   */
  lightMapNodes?: number;
  textureFlags?: number;
  brushes?: number;
  worldModels?: number;
  logPath?: string;
  errors: string[];
  warnings: string[];
  summary: string;
}

interface KitConfig {
  ProjectDir?: string;
  MapDir?: string;
  Workspace?: string;
  Python?: string;
  ProcessorExe?: string;
  ShogoDir?: string;
  KitRoot?: string;
}

function readKitConfig(workspace: string): KitConfig {
  const file = path.join(workspace, "shogo-mapping.json");
  if (!fs.existsSync(file)) {
    throw new Error(
      `no shogo-mapping.json in ${workspace} - run the kit's setup.ps1 first, ` +
        `or pass workspace explicitly`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as KitConfig;
}

/** First line matching, as a number. */
function num(text: string, re: RegExp): number | undefined {
  const m = re.exec(text);
  return m ? Number(m[1]) : undefined;
}

function run(exe: string, args: string[], cwd: string, timeoutSeconds: number) {
  const proc = spawnSync(exe, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const output = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
  return { status: proc.status ?? -1, output, error: proc.error };
}

export function compileShogoMap({
  mapPath,
  kitDir,
  workspace,
  lighting = true,
  install = true,
  timeoutSeconds = 600,
}: ShogoCompileOptions): ShogoCompileResult {
  if (!fs.existsSync(mapPath)) throw new Error(`no such map file: ${mapPath}`);

  const kit = kitDir ?? process.env.SHOGO_KIT_DIR;
  if (!kit) {
    throw new Error(
      "no kit directory - pass kit_dir or set SHOGO_KIT_DIR to the ShogoMapping folder"
    );
  }

  const ws = workspace ?? process.env.SHOGO_WORKSPACE ?? "";
  if (!ws) {
    throw new Error(
      "no workspace - pass workspace or set SHOGO_WORKSPACE to the folder holding " +
        "shogo-mapping.json (setup.ps1 wrote it)"
    );
  }

  const cfg = readKitConfig(ws);
  const tools = path.join(kit, "tools");
  const python = cfg.Python ?? path.join(kit, "python", "python.exe");
  const mapDir = cfg.MapDir ?? cfg.ProjectDir ?? path.join(ws, "build");
  const projectDir = cfg.ProjectDir ?? mapDir;

  // The world name is the map's basename, and the game loads it BARE - a
  // directory mounted with -rez puts its contents at the file tree root.
  const world = path.basename(mapPath, path.extname(mapPath));
  const edPath = path.join(mapDir, `${world}.ed`);
  const datPath = path.join(mapDir, `${world}.dat`);

  const errors: string[] = [];
  const warnings: string[] = [];

  fs.mkdirSync(mapDir, { recursive: true });

  // 1. .map -> .ed
  const convert = run(python, [path.join(tools, "map2ed.py"), mapPath, edPath], mapDir, timeoutSeconds);
  if (convert.error) {
    throw new Error(
      `could not run python at ${python}: ${convert.error.message}. The kit bundles ` +
        `one; check shogo-mapping.json.`
    );
  }
  if (convert.status !== 0) {
    return {
      success: false,
      worldName: world,
      errors: [`map2ed failed: ${convert.output.trim().split("\n").slice(-4).join(" / ")}`],
      warnings,
      summary: "conversion failed - nothing was compiled",
    };
  }
  for (const line of convert.output.split(/\r?\n/)) {
    if (/WARNING/i.test(line)) warnings.push(line.trim());
  }
  const brushes = num(convert.output, /(\d+)\s+brushes/);

  // 2. .ed -> .dat, through the script that knows the compiler's traps
  const args = [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(tools, "run-processor.ps1"),
    "-World",
    world,
    "-Force",
    "-ProjectDir",
    projectDir,
    "-MapDir",
    mapDir,
    "-Workspace",
    ws,
  ];
  if (!lighting) args.push("-Uncheck", "Apply Lighting");

  const compile = run("powershell.exe", args, mapDir, timeoutSeconds);
  const text = compile.output;

  const logMatch = /^LOG:\s*(.+)$/m.exec(text);
  const logPath = logMatch ? logMatch[1].trim() : undefined;

  let lightMapNodes: number | undefined;
  let textureFlags: number | undefined;
  let worldModels: number | undefined;

  if (logPath && fs.existsSync(logPath)) {
    const log = fs.readFileSync(logPath, "latin1");
    lightMapNodes = num(log, /Number of light map nodes:\s*(\d+)/);
    textureFlags = num(log, /Imported (\d+) texture flags/);
    worldModels = num(log, /----\s*(\d+) WorldModels created/);
    if (/Couldn't find any textures/.test(log)) {
      warnings.push(
        "the log says no textures were found - this belongs to the texture-flags " +
          "step and costs texture LIGHTS only; world textures and lighting are " +
          "unaffected (see DTXFORMAT.md)"
      );
    }
  }

  if (!fs.existsSync(datPath)) {
    errors.push(
      `no .dat was produced. ${text.trim().split("\n").slice(-3).join(" / ")}`
    );
    return {
      success: false,
      worldName: world,
      logPath,
      errors,
      warnings,
      summary: "compile failed - no world was written",
    };
  }

  const datBytes = fs.statSync(datPath).size;

  // WHAT THIS NUMBER IS, because it is easy to read as the opposite. Light map
  // nodes are the lightmap ALLOCATION, not a count of lights: a map with no
  // Light entity at all still reports 30,808 of them and renders black. So a
  // zero here means the lighting stage did not run, which gives a FULLBRIGHT
  // world rather than a dark one.
  //
  // "this world will be black" is map2ed's to say - it counts the entities and
  // already warns - and that warning is carried through above.
  if (lighting && lightMapNodes === 0) {
    warnings.push(
      "no light map nodes - the lighting stage did not run, so this world will " +
        "render fullbright"
    );
  }

  let installedTo: string | undefined;
  if (install && cfg.ShogoDir) {
    const custom = path.join(cfg.ShogoDir, "Custom");
    if (fs.existsSync(custom)) {
      installedTo = path.join(custom, `${world}.dat`);
      fs.copyFileSync(datPath, installedTo);
    } else {
      warnings.push(`no Custom folder at ${custom} - the world was not installed`);
    }
  }

  const bits = [`${world}.dat ${datBytes} bytes`];
  if (worldModels !== undefined) bits.push(`${worldModels} world models`);
  if (lightMapNodes !== undefined) bits.push(`${lightMapNodes} light map nodes`);
  if (installedTo) bits.push("installed");

  return {
    success: true,
    datPath,
    datBytes,
    installedTo,
    worldName: world,
    lightMapNodes,
    textureFlags,
    brushes,
    worldModels,
    logPath,
    errors,
    warnings,
    summary: bits.join(", "),
  };
}

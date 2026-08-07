import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { ensureTbMcpDir } from "./backup.js";

export interface LaunchOptions {
  /** The compiled .bsp, or the .map it was compiled from. */
  bspPath: string;
  enginePath: string;
  /** The directory holding id1. Defaults to the directory the engine is in. */
  gameDir?: string;
  /** Mod directory, e.g. "ad" or "copper". Defaults to id1. */
  mod?: string;
  extraArgs?: string[];
  /** Copy the .bsp into the game's maps directory first. On by default. */
  installBsp?: boolean;
  /**
   * Ask the engine to write qconsole.log and report what it said. On by
   * default: without it a failure to load the map is invisible.
   */
  condebug?: boolean;
  /** How long to watch for the engine dying before calling it launched. */
  graceMs?: number;
}

export interface LaunchResult {
  launched: boolean;
  pid?: number;
  /** Where the .bsp was placed, when it had to be copied. */
  installedTo?: string;
  mapName: string;
  /** The exact command, so a launch that misbehaves can be reproduced by hand. */
  command: string;
  /** Set when the engine exited during the grace period. */
  exitCode?: number;
  /** Whatever the engine said: its output, and qconsole.log if it wrote one. */
  output?: string[];
  notes?: string[];
}

const MAX_CAPTURED = 64 * 1024;

/**
 * The arguments Quake engines agree on: QuakeSpasm, vkQuake and ironwail all
 * take -basedir, -game and +map. Anything engine-specific goes in extraArgs,
 * which is placed before +map so the map is always the last thing said.
 */
export function buildEngineArgs({
  baseDir,
  mapName,
  mod,
  condebug = true,
  extraArgs = [],
}: {
  baseDir: string;
  mapName: string;
  mod?: string;
  condebug?: boolean;
  extraArgs?: string[];
}): string[] {
  return [
    "-basedir",
    baseDir,
    ...(mod ? ["-game", mod] : []),
    ...(condebug ? ["-condebug"] : []),
    ...extraArgs,
    "+map",
    mapName,
  ];
}

/** Lines worth surfacing out of an engine log, which is otherwise mostly noise. */
export function interestingLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => /error|couldn't|could not|not found|failed|no such|host_|warning/i.test(l))
    .slice(-20);
}

export async function launchMap({
  bspPath,
  enginePath,
  gameDir,
  mod,
  extraArgs = [],
  installBsp = true,
  condebug = true,
  graceMs = 3000,
}: LaunchOptions): Promise<LaunchResult> {
  // Accept the .map so the caller can hand over whatever it has.
  const bsp = bspPath.toLowerCase().endsWith(".map")
    ? bspPath.slice(0, -4) + ".bsp"
    : bspPath;

  if (!fs.existsSync(bsp)) {
    throw new Error(
      `no compiled map at ${bsp}. Compile it first: a .map is not what the engine loads.`
    );
  }
  if (!fs.existsSync(enginePath)) {
    throw new Error(`no engine at ${enginePath}`);
  }

  const mapName = path.basename(bsp, ".bsp");
  const baseDir = gameDir ?? path.dirname(enginePath);
  const modDir = mod ?? "id1";
  const mapsDir = path.join(baseDir, modDir, "maps");
  const notes: string[] = [];

  let installedTo: string | undefined;
  if (installBsp && path.resolve(path.dirname(bsp)) !== path.resolve(mapsDir)) {
    fs.mkdirSync(mapsDir, { recursive: true });
    const dest = path.join(mapsDir, path.basename(bsp));
    fs.copyFileSync(bsp, dest);
    installedTo = dest;

    // Coloured lighting lives beside the .bsp and is useless without it.
    const lit = bsp.slice(0, -4) + ".lit";
    if (fs.existsSync(lit)) {
      fs.copyFileSync(lit, path.join(mapsDir, path.basename(lit)));
      notes.push("copied the .lit alongside the .bsp");
    }
  }

  const qconsole = path.join(baseDir, modDir, "qconsole.log");
  if (condebug && fs.existsSync(qconsole)) {
    // Otherwise we would read someone else's session and report it as ours.
    try {
      fs.unlinkSync(qconsole);
    } catch {
      notes.push("could not clear the old qconsole.log; its contents may be stale");
    }
  }

  const argv = buildEngineArgs({ baseDir, mapName, mod, condebug, extraArgs });
  const command = `"${enginePath}" ${argv.join(" ")}`;

  // The engine has to outlive this call: the caller is a server handling a
  // request, and the user is going to go and play the map. That needs two
  // things on Windows - detached, so the child is not in our process group,
  // and its output going to a file rather than to pipes we own, because the
  // pipes die with us and take the engine with them.
  const engineLog = path.join(ensureTbMcpDir(bsp), "engine.log");
  const logFd = fs.openSync(engineLog, "w");
  let child;
  try {
    child = spawn(enginePath, argv, {
      cwd: baseDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    // The child has its own handle now.
    fs.closeSync(logFd);
  }

  // An engine that is going to refuse the map does so immediately. One that is
  // still alive after the grace period is running the map, and is left alone.
  const outcome = await new Promise<{ exited: boolean; code?: number }>((resolve) => {
    const timer = setTimeout(() => resolve({ exited: false }), graceMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ exited: true, code: code ?? undefined });
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ exited: true, code: undefined });
    });
  });

  let engineOutput: string[] = [];
  try {
    const text = fs.readFileSync(engineLog, "utf8");
    engineOutput = interestingLines(text.length > MAX_CAPTURED ? text.slice(-MAX_CAPTURED) : text);
  } catch {
    // Nothing written; engines on Windows often say nothing on stdout at all.
  }

  let logOutput: string[] = [];
  if (condebug && fs.existsSync(qconsole)) {
    try {
      logOutput = interestingLines(fs.readFileSync(qconsole, "utf8"));
    } catch {
      // Held open by the engine; not worth failing over.
    }
  }
  const output = [...new Set([...engineOutput, ...logOutput])];

  if (outcome.exited) {
    return {
      launched: false,
      mapName,
      installedTo,
      command,
      exitCode: outcome.code,
      output: output.length ? output : ["the engine exited without saying why"],
      notes: notes.length ? notes : undefined,
    };
  }

  // Stop Node waiting on a game the user is now playing.
  child.unref();

  return {
    launched: true,
    pid: child.pid,
    mapName,
    installedTo,
    command,
    output: output.length ? output : undefined,
    notes: notes.length ? notes : undefined,
  };
}

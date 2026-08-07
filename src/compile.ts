import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type ToolName = "qbsp" | "vis" | "light";

export interface CompileWarning {
  /** The number ericw-tools gives the warning, when it gives one. */
  code?: string;
  message: string;
  /** Warnings repeat per offending object; they are grouped rather than listed. */
  count: number;
}

export interface CompileStage {
  tool: ToolName;
  exitCode: number;
  durationMs: number;
  errors: string[];
  warnings: CompileWarning[];
}

export interface Leak {
  /**
   * The entity the compiler escaped from. This is the useful part: it names a
   * spot inside the level that can see the void.
   */
  point: [number, number, number];
  pointfile?: string;
  pointCount?: number;
}

export interface CompileResult {
  success: boolean;
  bspPath?: string;
  leak?: Leak;
  stages: CompileStage[];
  summary: string;
}

/**
 * The tools print a running percentage, sometimes several hundred of them run
 * together on one line with real output stuck on the end, so the counters are
 * removed from inside each line rather than by dropping whole lines.
 */
function stripProgress(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s*\d+%/g, "").trim())
    .filter((line) => line.length > 0);
}

const WARNING_RE = /^\*{3}\s*WARNING\s*(\d+)?:?\s*(.*)$/i;
const ERROR_BANNER_RE = /^\*{4,}\s*ERROR\s*\*{4,}$/i;
const LEAK_POINT_RE = /Reached occupant at \(\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i;

export function parseCompileOutput(text: string): {
  errors: string[];
  warnings: CompileWarning[];
  leakPoint?: [number, number, number];
} {
  const lines = stripProgress(text);
  const errors: string[] = [];
  const grouped = new Map<string, CompileWarning>();
  let leakPoint: [number, number, number] | undefined;
  let expectingError = false;

  for (const line of lines) {
    if (ERROR_BANNER_RE.test(line)) {
      // The message is on the line after the banner.
      expectingError = true;
      continue;
    }
    if (expectingError) {
      errors.push(line);
      expectingError = false;
      continue;
    }

    const warning = WARNING_RE.exec(line);
    if (warning) {
      const code = warning[1];
      const message = warning[2].trim();
      const key = `${code ?? ""}|${message}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.count++;
      } else {
        grouped.set(key, { code, message, count: 1 });
      }

      const leak = LEAK_POINT_RE.exec(message);
      if (leak) {
        leakPoint = [Number(leak[1]), Number(leak[2]), Number(leak[3])];
      }
    }
  }

  return { errors, warnings: [...grouped.values()], leakPoint };
}

/** Where the tools are: an explicit directory, then the environment, then PATH. */
function resolveTool(tool: ToolName, toolsDir?: string): string {
  const dir = toolsDir ?? process.env.ERICW_TOOLS_DIR;
  if (dir) {
    for (const candidate of [
      path.join(dir, `${tool}.exe`),
      path.join(dir, tool),
      path.join(dir, "bin", `${tool}.exe`),
      path.join(dir, "bin", tool),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(
      `${tool} not found in ${dir}. Point tools_dir or ERICW_TOOLS_DIR at the ericw-tools directory.`
    );
  }
  // Fall back to PATH.
  return tool;
}

function readPointfile(pointfile: string): { point?: [number, number, number]; count: number } {
  try {
    const lines = fs
      .readFileSync(pointfile, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    const first = lines[0]?.trim().split(/\s+/).map(Number);
    const point =
      first && first.length >= 3 && first.every((n) => Number.isFinite(n))
        ? ([first[0], first[1], first[2]] as [number, number, number])
        : undefined;
    return { point, count: lines.length };
  } catch {
    return { count: 0 };
  }
}

export interface CompileOptions {
  mapPath: string;
  stages?: ToolName[];
  toolsDir?: string;
  extraArgs?: Partial<Record<ToolName, string[]>>;
  timeoutSeconds?: number;
}

export function compileMap({
  mapPath,
  stages = ["qbsp"],
  toolsDir,
  extraArgs = {},
  timeoutSeconds = 600,
}: CompileOptions): CompileResult {
  if (!fs.existsSync(mapPath)) throw new Error(`no such map file: ${mapPath}`);

  const dir = path.dirname(mapPath);
  const base = path.basename(mapPath, path.extname(mapPath));
  const bspPath = path.join(dir, `${base}.bsp`);
  const results: CompileStage[] = [];
  let leak: Leak | undefined;

  for (const tool of stages) {
    // qbsp takes the map, the others work on the bsp it produced.
    const target = tool === "qbsp" ? mapPath : bspPath;
    if (tool !== "qbsp" && !fs.existsSync(bspPath)) {
      results.push({
        tool,
        exitCode: -1,
        durationMs: 0,
        errors: [`skipped: ${path.basename(bspPath)} was never produced`],
        warnings: [],
      });
      break;
    }

    const argv = [...(extraArgs[tool] ?? []), target];
    const started = Date.now();
    const proc = spawnSync(resolveTool(tool, toolsDir), argv, {
      cwd: dir,
      encoding: "utf8",
      timeout: timeoutSeconds * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const durationMs = Date.now() - started;

    if (proc.error) {
      const reason =
        (proc.error as NodeJS.ErrnoException).code === "ENOENT"
          ? `${tool} not found. Install ericw-tools and pass tools_dir, or set ERICW_TOOLS_DIR.`
          : proc.error.message;
      results.push({ tool, exitCode: -1, durationMs, errors: [reason], warnings: [] });
      break;
    }

    const output = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
    const { errors, warnings, leakPoint } = parseCompileOutput(output);

    if (leakPoint) {
      const pointfile = path.join(dir, `${base}.pts`);
      const pts = fs.existsSync(pointfile) ? readPointfile(pointfile) : undefined;
      leak = {
        point: leakPoint,
        pointfile: pts ? pointfile : undefined,
        pointCount: pts?.count,
      };
    }

    results.push({
      tool,
      exitCode: proc.status ?? -1,
      durationMs,
      errors,
      warnings,
    });

    // A tool that failed outright makes the later stages meaningless.
    if ((proc.status ?? -1) !== 0) break;
  }

  // A leak is reported as a warning and still exits 0, but it means the level is
  // open to the void: vis and light will be wrong and the map is not shippable.
  const failed = results.some((s) => s.exitCode !== 0 || s.errors.length > 0);
  const success = !failed && !leak;

  const parts: string[] = [];
  for (const stage of results) {
    const bits = [`${stage.tool} ${stage.exitCode === 0 ? "ok" : "failed"}`];
    if (stage.errors.length) bits.push(`${stage.errors.length} error(s)`);
    const warned = stage.warnings.reduce((n, w) => n + w.count, 0);
    if (warned) bits.push(`${warned} warning(s)`);
    bits.push(`${(stage.durationMs / 1000).toFixed(2)}s`);
    parts.push(bits.join(", "));
  }
  if (leak) {
    parts.push(`LEAK at ${leak.point.join(" ")}`);
  }

  return {
    success,
    bspPath: fs.existsSync(bspPath) ? bspPath : undefined,
    leak,
    stages: results,
    summary: parts.join(" | "),
  };
}

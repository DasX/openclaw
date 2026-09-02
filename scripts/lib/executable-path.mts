import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { resolvePathEnvKey } from "../windows-cmd-helpers.mjs";

export function isExecutableFile(value: string) {
  try {
    accessSync(value, constants.X_OK);
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

export function isRegularFile(value: string) {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function splitWindowsPath(envPath: string): string[] {
  const directories: string[] = [];
  for (let start = 0; start < envPath.length;) {
    let end = start;
    const quote = envPath[start];
    // libuv accepts quoted PATH entries containing semicolons, without trimming whitespace.
    if (quote === '"' || quote === "'") {
      const quoteEnd = envPath.indexOf(quote, start + 1);
      end = quoteEnd === -1 ? envPath.length : quoteEnd;
    }
    end = envPath.indexOf(";", end);
    if (end === -1) {
      end = envPath.length;
    }
    directories.push(envPath.slice(start, end).replace(/^["']|["']$/gu, ""));
    start = end + 1;
  }
  return directories;
}

export function findExecutableOnPath(
  command: string,
  envPath: string | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string,
  native = false,
) {
  const nativePosix = native && platform !== "win32";
  if (typeof envPath !== "string" || (!nativePosix && envPath.length === 0)) {
    return null;
  }
  const extensions =
    platform === "win32"
      ? native
        ? [".com", ".exe"]
        : (
            env[Object.keys(env).find((key) => key.toLowerCase() === "pathext") ?? "PATHEXT"] ??
            ".COM;.EXE;.BAT;.CMD"
          )
            .split(";")
            .filter(Boolean)
            .map((extension) => extension.toLowerCase())
      : [""];
  const pathDelimiter = platform === "win32" ? ";" : path.delimiter;
  const directories =
    native && platform === "win32" ? splitWindowsPath(envPath) : envPath.split(pathDelimiter);
  for (const directory of directories) {
    if (!directory && !nativePosix) {
      continue;
    }
    const resolvedDirectory =
      !native && path.isAbsolute(directory) ? directory : path.resolve(cwd, directory);
    for (const extension of extensions) {
      const candidate = path.join(resolvedDirectory, `${command}${extension}`);
      if (platform === "win32" ? isRegularFile(candidate) : isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

// Bind to the caller's PATH before changing child cwd: Windows otherwise searches
// that directory first, and relative PATH entries would also select different tools.
export function resolveNativeExecutable(command: string): string {
  const { env, platform } = process;
  // Node uses this Unix default only when PATH is absent; empty entries select caller cwd.
  const envPath =
    env[platform === "win32" ? resolvePathEnvKey(env) : "PATH"] ??
    (platform === "win32" ? undefined : "/usr/bin:/bin");
  const executable = findExecutableOnPath(command, envPath, platform, env, process.cwd(), true);
  if (!executable) {
    throw new Error(`Required executable ${command} was not found on PATH.`);
  }
  return executable;
}

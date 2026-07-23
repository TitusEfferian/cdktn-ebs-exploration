// Generic plumbing shared by every module: logging, timing, poll banners,
// child-process helpers, env validation, and atomic system-file writes.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, rename, stat, chmod } from "node:fs/promises";
import { LOG_PREFIX } from "./constants";

export const execFileAsync = promisify(execFile);

export function log(msg: string): void {
  console.log(`${LOG_PREFIX} ${msg}`);
}

export function errlog(msg: string): void {
  console.error(`${LOG_PREFIX} ${msg}`);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bash-style progress line: "...waiting for X (elapsed/total s)".
export function waitBanner(desc: string, startMs: number, totalMs: number): void {
  const elapsedS = Math.round((Date.now() - startMs) / 1000);
  log(`  ...waiting for ${desc} (${elapsedS}/${Math.round(totalMs / 1000)}s)`);
}

// Fold a transient API error into a poll iteration: log its name and keep going.
export function logTransient(op: string, err: unknown): void {
  const name = err instanceof Error ? err.name : "unknown";
  log(`  ...${op} not ready yet (${name}); retrying`);
}

// Write a system file atomically: write a sibling temp file, preserve the target's
// mode, then rename over it (same-directory rename is atomic on Linux). Prevents a
// truncated /etc/ecs/ecs.config or /etc/fstab if the process dies mid-write.
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  let mode = 0o644;
  try {
    mode = (await stat(filePath)).mode & 0o777; // preserve the existing file's mode
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const tmp = `${filePath}.tmp-${process.pid}`;
  await writeFile(tmp, content, { encoding: "utf8", mode });
  await chmod(tmp, mode); // writeFile's mode is subject to umask; set it exactly
  await rename(tmp, filePath);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

// Run a command, ignoring any failure (best-effort side effects like `udevadm settle`).
export async function runQuiet(cmd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(cmd, args);
  } catch {
    /* ignore */
  }
}

// Run a command and return whether it exited 0 (used as a predicate).
export async function execOk(cmd: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(cmd, args);
    return true;
  } catch {
    return false;
  }
}

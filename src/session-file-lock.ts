import { lstat, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const held = new Set<string>();

type LockOwner = { pid: number; hostname: string; startedAt: string };

export function expandSessionFilePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

// Canonicalization assumes the path and its parent directories are not externally replaced while the session is running.
export async function resolveSessionFile(path: string, cwd: string): Promise<{ file: string; key: string }> {
  const expanded = expandSessionFilePath(path);
  const file = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const parent = dirname(file);
  try {
    return { file, key: await realpath(file) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      const entry = await lstat(file);
      if (entry.isSymbolicLink()) {
        throw new Error(`session_file ${file} is a symlink whose target does not exist; create the target or use the target path`);
      }
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
    }
  }
  let probe = parent;
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonical = await realpath(probe);
      return { file, key: join(canonical, ...suffix.reverse(), basename(file)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const upper = dirname(probe);
      if (upper === probe) throw error;
      suffix.push(basename(probe));
      probe = upper;
    }
  }
}

export async function acquireSessionFileLock(key: string): Promise<() => Promise<void>> {
  if (held.has(key)) throw new Error(`Session file is already in use: ${key}`);
  held.add(key);
  const lockPath = `${key}.lock`;
  const owner: LockOwner = { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() };
  let created = false;
  try {
    await mkdir(dirname(key), { recursive: true });
    const handle = await open(lockPath, "wx");
    created = true;
    try {
      await handle.writeFile(JSON.stringify(owner));
    } finally {
      await handle.close();
    }
    // realpath cannot distinguish hard-link aliases, so refuse files with multiple names.
    try {
      const info = await stat(key);
      if (info.isFile() && info.nlink > 1) {
        throw new Error(`session_file ${key} has ${info.nlink} hard links; another path may write the same file (including the caller's session). Use a dedicated single-link session file.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    held.delete(key);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      if (created) await unlink(lockPath).catch(() => {});
      throw error;
    }
    let details = "owner details unavailable";
    try {
      const existing = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockOwner>;
      details = `pid=${String(existing.pid)} host=${String(existing.hostname)} startedAt=${String(existing.startedAt)}`;
      if (existing.hostname === hostname() && Number.isInteger(existing.pid)) {
        try {
          process.kill(existing.pid!, 0);
        } catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
            details += "; owner 进程已不存在，确认后手动删除该锁文件";
          }
        }
      }
    } catch {
      // The path remains actionable even if another process is writing the lock.
    }
    throw new Error(`Session file lock exists at ${lockPath} (${details})`);
  }
  return async () => {
    try {
      const contents = await readFile(lockPath, "utf8");
      if (contents === JSON.stringify(owner)) await unlink(lockPath);
    } finally {
      held.delete(key);
    }
  };
}

export async function acquireLane(path: string, cwd: string): Promise<() => Promise<void>> {
  const { key } = await resolveSessionFile(path, cwd);
  return acquireSessionFileLock(key);
}

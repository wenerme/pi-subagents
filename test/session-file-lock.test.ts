import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireSessionFileLock, resolveSessionFile } from "../src/session-file-lock.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-file-lock-"));
  dirs.push(dir);
  return dir;
}

describe("session-file-lock", () => {
  it("rejects hard-linked session files and clears the lock so the single-link file can be retried", async () => {
    const dir = tempDir();
    const fileA = join(dir, "a.jsonl");
    const fileB = join(dir, "b.jsonl");
    writeFileSync(fileA, "session");
    linkSync(fileA, fileB);
    const keyA = (await resolveSessionFile(fileA, dir)).key;
    const keyB = (await resolveSessionFile(fileB, dir)).key;
    expect(keyA).not.toBe(keyB);
    await expect(acquireSessionFileLock(keyA)).rejects.toThrow(/hard links/);
    await expect(acquireSessionFileLock(keyB)).rejects.toThrow(/hard links/);
    expect(existsSync(`${keyA}.lock`)).toBe(false);
    expect(existsSync(`${keyB}.lock`)).toBe(false);

    rmSync(fileB);
    const release = await acquireSessionFileLock(keyA);
    await release();
    expect(existsSync(`${keyA}.lock`)).toBe(false);
  });

  it("allows locking a session file that does not exist yet", async () => {
    const file = join(tempDir(), "new-lane.jsonl");
    const release = await acquireSessionFileLock(file);
    await release();
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("canonicalizes an absent parent and expands tilde", async () => {
    const { key, file } = await resolveSessionFile("~/nested/lane.jsonl", tempDir());
    expect(file).toBe(join(process.env.HOME!, "nested/lane.jsonl"));
    expect(key).toBe(file);
  });

  it("canonicalizes a symlink to the target session file for locking", async () => {
    const dir = tempDir();
    const target = join(dir, "target.jsonl");
    const alias = join(dir, "alias.jsonl");
    writeFileSync(target, '{"type":"session"}\n');
    symlinkSync(target, alias);
    const real = await resolveSessionFile(target, dir);
    const linked = await resolveSessionFile(alias, dir);
    expect(linked.key).toBe(real.key);
    const release = await acquireSessionFileLock(real.key);
    await expect(acquireSessionFileLock(linked.key)).rejects.toThrow(/already in use/);
    await release();
  });

  it("rejects dangling symlinks before creating either lock or target", async () => {
    const dir = tempDir();
    const target = join(dir, "missing-target.jsonl");
    const alias = join(dir, "dangling.jsonl");
    symlinkSync(target, alias);
    await expect(resolveSessionFile(alias, dir)).rejects.toThrow(alias);
    expect(existsSync(`${alias}.lock`)).toBe(false);
    expect(existsSync(`${target}.lock`)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("rejects same-process and existing owner locks, then releases only its own lock", async () => {
    const file = join(tempDir(), "lane.jsonl");
    const release = await acquireSessionFileLock(file);
    await expect(acquireSessionFileLock(file)).rejects.toThrow(/already in use/);
    await release();
    expect(existsSync(`${file}.lock`)).toBe(false);
    const releaseAgain = await acquireSessionFileLock(file);
    await releaseAgain();
  });

  it("preserves a lock file replaced by a different owner before release", async () => {
    const file = join(tempDir(), "replaced.jsonl");
    const release = await acquireSessionFileLock(file);
    const replacement = "other-owner";
    writeFileSync(`${file}.lock`, replacement);
    await release();
    expect(readFileSync(`${file}.lock`, "utf8")).toBe(replacement);
  });

  it("rejects a live owner and preserves a dead owner's lock with manual cleanup guidance", async () => {
    const dir = tempDir();
    const file = join(dir, "live.jsonl");
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: "now" }));
    await expect(acquireSessionFileLock(file)).rejects.toThrow(/live\.jsonl\.lock.*pid=.*host=.*startedAt=now/);

    const deadFile = join(dir, "dead.jsonl");
    writeFileSync(`${deadFile}.lock`, JSON.stringify({ pid: 2147483647, hostname: hostname(), startedAt: "then" }));
    const error = await acquireSessionFileLock(deadFile).catch((err: Error) => err);
    expect(error.message).toContain(`${deadFile}.lock`);
    expect(error.message).toContain("owner 进程已不存在，确认后手动删除该锁文件");
    expect(readFileSync(`${deadFile}.lock`, "utf8")).toContain('"pid":2147483647');
  });

  it("treats EPERM as a live owner", async () => {
    const file = join(tempDir(), "eperm.jsonl");
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: 9876, hostname: hostname(), startedAt: "then" }));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    try {
      const error = await acquireSessionFileLock(file).catch((err: Error) => err);
      expect(error.message).toContain("host=");
      expect(error.message).not.toContain("手动删除");
      expect(readFileSync(`${file}.lock`, "utf8")).toContain('"pid":9876');
    } finally {
      kill.mockRestore();
    }
  });
});

import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { initTheme, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { agentRecordEntryData, reopenTarget } from "../src/agent-record-entry.js";
import { type RunOptions, resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import { acquireSessionFileLock } from "../src/session-file-lock.js";
import { type AgentConfig } from "../src/types.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "lane-agent", description: "Lane agent", builtinToolNames: [], extensions: false,
    skills: false, systemPrompt: "Reply exactly as instructed.", promptMode: "replace", ...overrides,
  };
}

function makeContext(cwd: string, model: ReturnType<ReturnType<typeof registerFauxProvider>["getModel"]>, backend: ReturnType<typeof fauxModelBackend>, parentSessionFile?: string) {
  return {
    cwd, model, modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
    getSystemPrompt: () => "parent prompt", isProjectTrusted: () => true,
    sessionManager: { getSessionFile: () => parentSessionFile, getBranch: () => [] },
  } as unknown as Parameters<typeof runAgent>[0];
}

const dirs: string[] = [];
afterEach(() => {
  registerAgents(new Map());
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-file-integration-"));
  dirs.push(dir);
  return dir;
}

describe("explicit session_file persistence", () => {
  it("creates then appends the same real session without changing its history prefix", async () => {
    const cwd = tempDir();
    const file = join(cwd, "nested", "lane.jsonl");
    initTheme(undefined, false);
    registerAgents(new Map([["lane-agent", makeConfig()]]));
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      faux.setResponses([fauxAssistantMessage([fauxText("FIRST")]), fauxAssistantMessage([fauxText("SECOND")]), fauxAssistantMessage([fauxText("THIRD")])]);
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      const ctx = makeContext(cwd, model, backend);
      const first = await runAgent(ctx, "lane-agent", "first prompt", { pi: {} as RunOptions["pi"], sessionFile: file });
      const id = first.session.sessionId;
      const prefix = readFileSync(file, "utf8");
      first.session.dispose();
      const secondCwd = tempDir();
      const second = await runAgent(makeContext(secondCwd, model, backend, join(cwd, "different-parent.jsonl")), "lane-agent", "second prompt", {
        pi: {} as RunOptions["pi"], resumeSessionFile: file, sessionFileExplicit: true,
      });
      expect(second.session.sessionId).toBe(id);
      expect(readFileSync(file, "utf8").startsWith(prefix)).toBe(true);
      const entries = parseSessionEntries(readFileSync(file, "utf8"));
      expect(entries.filter(entry => entry.type === "session")).toHaveLength(1);
      expect(second.session.sessionManager?.getCwd()).toBe(secondCwd);
      let beginPrompt!: () => void;
      let finishPrompt!: () => void;
      const promptStarted = new Promise<void>(resolve => { beginPrompt = resolve; });
      second.session.prompt = async () => {
        beginPrompt();
        await new Promise<void>(resolve => { finishPrompt = resolve; });
      };
      const resuming = resumeAgent(second.session, "resume prompt", { type: "lane-agent" });
      await promptStarted;
      expect(existsSync(`${file}.lock`)).toBe(true);
      await expect(runAgent(ctx, "lane-agent", "overlap", { pi: {} as RunOptions["pi"], sessionFile: file }))
        .rejects.toThrow(/already in use/);
      finishPrompt();
      await resuming;
      const release = await acquireSessionFileLock(file);
      await release();
      second.session.dispose();
    } finally {
      faux.unregister();
    }
  });


  it("rejects an explicit lane that aliases the calling session", async () => {
    const cwd = tempDir();
    const file = join(cwd, "main.jsonl");
    initTheme(undefined, false);
    registerAgents(new Map([["lane-agent", makeConfig()]]));
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      faux.setResponses([fauxAssistantMessage([fauxText("MAIN")]), fauxAssistantMessage([fauxText("SHOULD-NOT-APPEND")])]);
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      const seed = await runAgent(makeContext(cwd, model, backend), "lane-agent", "main", {
        pi: {} as RunOptions["pi"], sessionFile: file,
      });
      const bytes = readFileSync(file, "utf8");
      seed.session.dispose();
      await expect(runAgent(makeContext(cwd, model, backend, file), "lane-agent", "alias", {
        pi: {} as RunOptions["pi"], sessionFile: "./main.jsonl",
      })).rejects.toThrow(/session file of the calling agent or one of its parents/);
      expect(existsSync(`${file}.lock`)).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(bytes);
    } finally {
      faux.unregister();
    }
  });

  it("rejects an explicit lane that hard-links the calling session", async () => {
    const cwd = tempDir();
    const file = join(cwd, "main.jsonl");
    const alias = join(cwd, "main-alias.jsonl");
    initTheme(undefined, false);
    registerAgents(new Map([["lane-agent", makeConfig()]]));
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      faux.setResponses([fauxAssistantMessage([fauxText("MAIN")])]);
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      const seed = await runAgent(makeContext(cwd, model, backend), "lane-agent", "main", {
        pi: {} as RunOptions["pi"], sessionFile: file,
      });
      seed.session.dispose();
      linkSync(file, alias);
      await expect(runAgent(makeContext(cwd, model, backend, file), "lane-agent", "hard-link alias", {
        pi: {} as RunOptions["pi"], sessionFile: alias,
      })).rejects.toThrow(/hard links/);
      expect(existsSync(`${file}.lock`)).toBe(false);
      expect(existsSync(`${alias}.lock`)).toBe(false);
    } finally {
      faux.unregister();
    }
  });

  it("rejects case-folded aliases of absent caller and ancestor sessions", async () => {
    const cwd = tempDir();
    const callerFile = join(cwd, "caller-session.jsonl");
    const callerAlias = join(cwd, "Caller-Session.jsonl");
    const ancestorFile = join(cwd, "ancestor-session.jsonl");
    const ancestorAlias = join(cwd, "Ancestor-Session.jsonl");
    initTheme(undefined, false);
    registerAgents(new Map([["lane-agent", makeConfig()]]));
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      const ctx = makeContext(cwd, model, backend, callerFile);
      await expect(runAgent(ctx, "lane-agent", "caller alias", {
        pi: {} as RunOptions["pi"], sessionFile: callerAlias,
      })).rejects.toThrow(/session file of the calling agent or one of its parents/);
      await expect(runAgent(makeContext(cwd, model, backend), "lane-agent", "ancestor alias", {
        pi: {} as RunOptions["pi"], sessionFile: ancestorAlias, reservedSessionFiles: [ancestorFile],
      })).rejects.toThrow(/session file of the calling agent or one of its parents/);
      for (const file of [callerFile, callerAlias, ancestorFile, ancestorAlias]) {
        expect(existsSync(file)).toBe(false);
        expect(existsSync(`${file}.lock`)).toBe(false);
      }
    } finally {
      faux.unregister();
    }
  });

  it("rejects an explicit lane reserved by an ancestor agent", async () => {
    const cwd = tempDir();
    const file = join(cwd, "ancestor.jsonl");
    initTheme(undefined, false);
    registerAgents(new Map([["lane-agent", makeConfig()]]));
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      faux.setResponses([fauxAssistantMessage([fauxText("ANCESTOR")]), fauxAssistantMessage([fauxText("SHOULD-NOT-APPEND")])]);
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      const seed = await runAgent(makeContext(cwd, model, backend), "lane-agent", "ancestor", {
        pi: {} as RunOptions["pi"], sessionFile: file,
      });
      const bytes = readFileSync(file, "utf8");
      seed.session.dispose();
      await expect(runAgent(makeContext(cwd, model, backend), "lane-agent", "alias ancestor", {
        pi: {} as RunOptions["pi"], sessionFile: file, reservedSessionFiles: [file],
      })).rejects.toThrow(/session file of the calling agent or one of its parents/);
      expect(existsSync(`${file}.lock`)).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(bytes);
    } finally {
      faux.unregister();
    }
  });


  it("does not lock or use a frontmatter lane for an explicit-false legacy reopen", async () => {
    const cwd = tempDir();
    const frontmatterLane = join(cwd, "configured-lane.jsonl");
    initTheme(undefined, false);
    registerAgents(new Map([["lane-agent", makeConfig()]]));
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      faux.setResponses([fauxAssistantMessage([fauxText("LEGACY")]), fauxAssistantMessage([fauxText("REOPENED")])]);
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      const first = await runAgent(makeContext(cwd, model, backend), "lane-agent", "seed", { pi: {} as RunOptions["pi"] });
      const sessionFile = first.session.sessionManager?.getSessionFile();
      if (!sessionFile) throw new Error("initial session was not persisted");
      first.session.dispose();
      registerAgents(new Map([[
        "lane-agent", makeConfig({ sessionFile: frontmatterLane }),
      ]]));
      const reopened = await runAgent(makeContext(cwd, model, backend), "lane-agent", "reopen", {
        pi: {} as RunOptions["pi"], resumeSessionFile: sessionFile, sessionFileExplicit: false,
      });
      expect(reopened.session.sessionManager?.getSessionFile()).toBe(sessionFile);
      expect(existsSync(`${sessionFile}.lock`)).toBe(false);
      expect(existsSync(frontmatterLane)).toBe(false);
      expect(existsSync(`${frontmatterLane}.lock`)).toBe(false);
      reopened.session.dispose();
    } finally {
      faux.unregister();
    }
  });


  it("reopens a saved explicit record through its persisted entry marker", async () => {
    const cwd = tempDir();
    const file = join(cwd, "saved-lane.jsonl");
    registerAgents(new Map([["lane-agent", makeConfig()]]));
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      faux.setResponses([fauxAssistantMessage([fauxText("SAVED")]), fauxAssistantMessage([fauxText("REOPENED")])]);
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      const ctx = makeContext(cwd, model, backend);
      const first = await runAgent(ctx, "lane-agent", "first", { pi: {} as RunOptions["pi"], sessionFile: file });
      const data = agentRecordEntryData({
        id: first.session.sessionId, type: "lane-agent", description: "lane", status: "completed", startedAt: Date.now(),
        sessionFile: file, sessionFileExplicit: true,
      } as any);
      const reopen = reopenTarget(data.type, data.sessionFile, data.worktreeLost);
      expect(reopen.ok).toBe(true);
      if (!reopen.ok) throw new Error(reopen.reason);
      const continued = await runAgent(ctx, reopen.type, "continue", {
        pi: {} as RunOptions["pi"], resumeSessionFile: reopen.sessionFile, sessionFileExplicit: data.sessionFileExplicit,
      });
      expect(continued.session.sessionId).toBe(first.session.sessionId);
      first.session.dispose();
      continued.session.dispose();
    } finally {
      faux.unregister();
    }
  });

  it("runs a scheduled session through eviction and saved-entry reopen with the real runner", async () => {
    const cwd = tempDir();
    const file = join(cwd, "scheduled-lane.jsonl");
    initTheme(undefined, false);
    registerAgents(new Map([["lane-agent", makeConfig()]]));
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    const entries: ReturnType<typeof agentRecordEntryData>[] = [];
    const manager = new AgentManager(record => entries.push(agentRecordEntryData(record)));
    const scheduler = new SubagentScheduler();
    const store = new ScheduleStore(join(cwd, "schedule.json"));
    try {
      faux.setResponses([fauxAssistantMessage([fauxText("SCHEDULED")]), fauxAssistantMessage([fauxText("REOPENED")])]);
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      const context = makeContext(cwd, model, backend);
      scheduler.start({ events: { emit: () => {} } } as any, context, manager, store);
      const job = scheduler.addJob({
        name: "lane", description: "lane", schedule: "1h", subagent_type: "lane-agent", prompt: "first",
        session_file: file,
      });
      await (scheduler as any).executeJob(job.id);
      await vi.waitFor(() => expect(entries).toHaveLength(1));
      const saved = entries.at(-1)!;
      const reopen = reopenTarget(saved.type, saved.sessionFile, saved.worktreeLost);
      expect(reopen.ok).toBe(true);
      if (!reopen.ok) throw new Error(reopen.reason);
      const originalId = saved.id;
      const completed = manager.getRecord(originalId)!;
      const originalSessionId = completed.session?.sessionId;
      completed.completedAt = Date.now() - 11 * 60_000;
      (manager as any).cleanup();
      expect(manager.getRecord(originalId)).toBeUndefined();
      const observed: { id?: string; locked?: boolean } = {};
      const continued = await manager.spawnAndWait({} as any, context, reopen.type, "continue", {
        description: saved.description,
        resumeSessionFile: reopen.sessionFile,
        sessionFileExplicit: saved.sessionFileExplicit === true,
        reclaim: { id: originalId },
        onSessionCreated: session => {
          observed.id = session.sessionId;
          observed.locked = existsSync(`${file}.lock`);
        },
      });
      expect(observed).toEqual({ id: originalSessionId, locked: true });
      expect(readFileSync(file, "utf8")).toContain("SCHEDULED");
      expect(continued.record.session?.sessionId).toBe(originalSessionId);
      expect(existsSync(`${file}.lock`)).toBe(false);
    } finally {
      scheduler.stop();
      manager.dispose();
      faux.unregister();
    }
  });

  it("initializes an empty lane file and prefers session_file over a different resume target", async () => {
    const cwd = tempDir();
    const emptyFile = join(cwd, "empty.jsonl");
    const otherFile = join(cwd, "other.jsonl");
    writeFileSync(emptyFile, "");
    registerAgents(new Map([["lane-agent", makeConfig()]]));
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxText("EMPTY-LANE")]),
        fauxAssistantMessage([fauxText("OTHER-LANE")]),
        fauxAssistantMessage([fauxText("PREFERRED-LANE")]),
      ]);
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      const ctx = makeContext(cwd, model, backend);
      const first = await runAgent(ctx, "lane-agent", "empty", { pi: {} as RunOptions["pi"], sessionFile: emptyFile });
      const other = await runAgent(ctx, "lane-agent", "other", { pi: {} as RunOptions["pi"], sessionFile: otherFile });
      const preferred = await runAgent(ctx, "lane-agent", "prefer explicit", {
        pi: {} as RunOptions["pi"], sessionFile: emptyFile, resumeSessionFile: otherFile, sessionFileExplicit: true,
      });
      expect(preferred.session.sessionId).toBe(first.session.sessionId);
      expect(preferred.session.sessionId).not.toBe(other.session.sessionId);
      expect(parseSessionEntries(readFileSync(emptyFile, "utf8"))[0]).toMatchObject({ type: "session", cwd });
      first.session.dispose();
      other.session.dispose();
      preferred.session.dispose();
    } finally {
      faux.unregister();
    }
  });

  it("releases the lane if session-created setup throws", async () => {
    const cwd = tempDir();
    const file = join(cwd, "setup.jsonl");
    registerAgents(new Map([["lane-agent", makeConfig()]]));
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      await expect(runAgent(makeContext(cwd, model, backend), "lane-agent", "go", {
        pi: {} as RunOptions["pi"], sessionFile: file,
        onSessionCreated: () => { throw new Error("setup failed"); },
      })).rejects.toThrow("setup failed");
      const release = await acquireSessionFileLock(file);
      await release();
    } finally {
      faux.unregister();
    }
  });

  it("rejects non-session bytes without modifying them and releases its lane lock", async () => {
    const cwd = tempDir();
    const file = join(cwd, "not-session.jsonl");
    const bytes = "not a session\n{\"untouched\":true}\n";
    writeFileSync(file, bytes);
    initTheme(undefined, false);
    registerAgents(new Map([["lane-agent", makeConfig()]]));
    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      await expect(runAgent(makeContext(cwd, model, backend), "lane-agent", "go", {
        pi: {} as RunOptions["pi"], sessionFile: file,
      })).rejects.toThrow(/not a valid/);
      expect(readFileSync(file, "utf8")).toBe(bytes);
      expect(existsSync(`${file}.lock`)).toBe(false);
    } finally {
      faux.unregister();
    }
  });
});

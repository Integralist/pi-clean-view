import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssistantMessageComponent,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
  type ToolRendererResolver,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import cleanView from "../extensions/clean-view.ts";
import {
  addTask,
  appendLog,
  clampPercent,
  cleanName,
  duration,
  EMPTY,
  errorSentence,
  fallbackTitle,
  fit,
  fromTodos,
  hasPlan,
  isRunning,
  isUserRejection,
  label,
  LOG_ENTRIES,
  LOG_ENTRY_CHARS,
  meter,
  newJob,
  planSteps,
  reportProgress,
  updateTask,
} from "../src/logic.ts";
import { CleanViewWidget } from "../src/widget.ts";

function createFakeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    style: (text: string) => text,
    getColorMode: () => "truecolor",
  } as any;
}

function createHarness(options: { directory?: string; now?: () => number; collapseMs?: number; frameMs?: number } = {}) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const shortcuts = new Map<string, { description?: string; handler: (ctx: any) => Promise<void> | void }>();
  const toolRenderers: ToolRendererResolver[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const workingVisibleCalls: boolean[] = [];
  const hiddenThinkingLabels: Array<string | undefined> = [];
  let widgetFactory: ((tui: any, theme: any) => any) | undefined;
  let widgetComponent: any;
  let customDialog: any;
  let renderRequests = 0;

  const tui = {
    requestRender: () => {
      renderRequests++;
    },
  };
  const theme = createFakeTheme();

  const ctx: ExtensionContext = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp",
    ui: {
      theme,
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
      setWorkingVisible: (visible: boolean) => {
        workingVisibleCalls.push(visible);
      },
      setHiddenThinkingLabel: (label?: string) => {
        hiddenThinkingLabels.push(label);
      },
      setWidget: (_key: string, factory: any) => {
        widgetFactory = factory;
        widgetComponent = typeof factory === "function" ? factory(tui, theme) : undefined;
      },
      custom: async (factory: any) => {
        const keybindings = { matches: (data: string, id: string) => data === id };
        customDialog = factory(tui, theme, keybindings, () => {});
        return undefined;
      },
    } as any,
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => [],
    } as any,
    modelRegistry: {
      getAvailable: () => [],
    } as any,
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  };

  let activeTools = ["read", "bash", "edit", "write"];

  const pi: ExtensionAPI = {
    on: (event: string, handler: any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerTool: (tool: ToolDefinition<any, any, any>) => {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) {
        activeTools.push(tool.name);
      }
    },
    registerCommand: (name: string, cmd: any) => {
      commands.set(name, cmd);
    },
    registerShortcut: (key: string, shortcut: any) => {
      shortcuts.set(key, shortcut);
    },
    registerToolRenderer: (resolver: ToolRendererResolver) => {
      toolRenderers.push(resolver);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (next: string[]) => {
      activeTools = [...next];
    },
  } as any;

  cleanView(pi, options);

  async function emit(event: string, payload: any = {}) {
    let lastResult: any;
    for (const handler of handlers.get(event) ?? []) {
      const res = await handler({ type: event, ...payload }, ctx);
      if (res !== undefined) lastResult = res;
    }
    return lastResult;
  }

  async function callTool(name: string, input: Record<string, any> = {}, parentToolCallId?: string) {
    const gate = await emit("tool_call", {
      toolCallId: "call-1",
      toolName: name,
      input,
      ...(parentToolCallId ? { parentToolCallId } : {}),
    });
    if (gate?.block) {
      return { blocked: true, reason: gate.reason as string };
    }
    const def = tools.get(name);
    let result: any = { content: [{ type: "text", text: "ok" }], details: undefined };
    if (def) {
      result = await def.execute("call-1", input, undefined, undefined, ctx as any);
    }
    await emit("tool_result", {
      toolCallId: "call-1",
      toolName: name,
      input,
      content: result.content,
      details: result.details,
      isError: false,
    });
    return { blocked: false, result };
  }

  function renderWidget(width = 80): string[] {
    if (!widgetComponent) return [];
    return widgetComponent.render(width).map((line: string) => stripTerminalSequences(line));
  }

  function resolveRenderer(toolName: string, base?: ToolRenderers): ToolRenderers | undefined {
    const chain = (index: number): ToolRenderers | undefined =>
      index < toolRenderers.length ? toolRenderers[index]!(toolName, () => chain(index + 1)) : base;
    return chain(0);
  }

  return {
    ctx,
    tui,
    theme,
    tools,
    commands,
    shortcuts,
    notifications,
    workingVisibleCalls,
    hiddenThinkingLabels,
    get widgetComponent() {
      return widgetComponent;
    },
    get customDialog() {
      return customDialog;
    },
    get widgetFactory() {
      return widgetFactory;
    },
    get renderRequests() {
      return renderRequests;
    },
    get activeTools() {
      return activeTools;
    },
    emit,
    callTool,
    renderWidget,
    resolveRenderer,
  };
}

describe("logic", () => {
  test("cleanName strips code, paths, and file names, and truncates to 40 chars", () => {
    expect(cleanName("Build the pricing section in `src/Pricing.tsx`")).toBe("Build the pricing section in");
    expect(cleanName("update src/app/main.go handler")).toBe("Update handler");
    expect(cleanName("fix the header in index.html quickly")).toBe("Fix the header in quickly");
    const long = cleanName("Write a very long description of everything that the landing page should contain");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("…")).toBe(true);
    expect(cleanName("`npm test`")).toBe("Working on it");
  });

  test("fallbackTitle produces a concise title from user prompt or falls back", () => {
    expect(fallbackTitle("build my landing page for the launch")).toBe("Build my landing page for the");
    expect(fallbackTitle("`src/index.ts`")).toBe("Your request");
  });

  test("clampPercent bounds numbers to [0, 100] and handles non-finite", () => {
    expect(clampPercent(-10)).toBe(0);
    expect(clampPercent(59.6)).toBe(60);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
  });

  test("newJob, planSteps, and reportProgress advance steps in order", () => {
    let list = newJob(1000, "Build landing page");
    expect(isRunning(list)).toBe(true);
    expect(hasPlan(list)).toBe(false);
    expect(list.tasks.map((task) => task.name)).toEqual(["Thinking..."]);

    list = planSteps(list, ["Read brand notes", "Build pricing section"], "Ship pricing page");
    expect(hasPlan(list)).toBe(true);
    expect(list.title).toBe("Ship pricing page");
    expect(list.tasks.map((t) => [t.name, t.status])).toEqual([
      ["Read brand notes", "active"],
      ["Build pricing section", "upcoming"],
    ]);

    list = reportProgress(list, "Read brand notes", 60);
    expect(list.tasks[0]?.percent).toBe(60);
    expect(list.tasks[0]?.hasReported).toBe(true);
    expect(meter(list.tasks[0]!, 0)).toBe("██████░░░░");
    // Between reports the next cell pulses, so a step waiting on its next report still looks alive.
    expect(meter(list.tasks[0]!, 1)).toBe("██████▒░░░");
    expect(meter(list.tasks[0]!, 2)).toBe("██████░░░░");
    expect(label(list.tasks[0]!, false)).toBe("60%");

    list = reportProgress(list, "Read brand notes", 100);
    expect(list.tasks[0]?.status).toBe("done");
    expect(list.tasks[1]?.status).toBe("active");
    expect(meter(list.tasks[0]!, 0)).toBe("██████████");
    expect(meter(list.tasks[1]!, 0)).toBe("███░░░░░░░");
  });

  test("planSteps called again keeps finished steps done and starts the first unfinished one", () => {
    let list = planSteps(newJob(1000, "Ship it"), ["Read notes", "Build page", "Check page"]);
    list = reportProgress(list, "Read notes", 100);

    list = planSteps(list, ["Read notes", "Build page", "Clean up formatting", "Check page"]);

    expect(list.tasks.map((t) => [t.name, t.status])).toEqual([
      ["Read notes", "done"],
      ["Build page", "active"],
      ["Clean up formatting", "upcoming"],
      ["Check page", "upcoming"],
    ]);
  });

  test("fromTodos, addTask, and updateTask synchronize external task tools", () => {
    let list = newJob(1000, "Build page");
    list = fromTodos(list, [
      { content: "Read your brand notes", status: "completed" },
      { content: "Build the pricing section", status: "in_progress" },
      { content: "Add the contact form", status: "pending" },
    ]);
    expect(list.tasks.map((t) => t.status)).toEqual(["done", "active", "upcoming"]);

    list = addTask(list, "4", "Polish footer");
    expect(list.tasks.at(-1)).toMatchObject({ id: "task-4", name: "Polish footer", status: "upcoming" });

    list = updateTask(list, "4", "in_progress", "Polish the footer");
    expect(list.tasks.find((t) => t.id === "task-4")).toMatchObject({
      name: "Polish the footer",
      status: "active",
    });

    list = updateTask(list, "4", "deleted", undefined);
    expect(list.tasks.find((t) => t.id === "task-4")).toBeUndefined();
  });

  test("errorSentence, isUserRejection, duration, and fit format display strings", () => {
    expect(errorSentence("HTTP 429 rate limit exceeded")).toContain("usage limit");
    expect(errorSentence("529 overloaded")).toContain("servers are busy");
    expect(errorSentence("maximum context length")).toContain("/compact");
    expect(errorSentence("ECONNRESET network error")).toContain("internet connection");
    expect(errorSentence("401 unauthorized")).toContain("/login");
    expect(errorSentence("unknown failure")).toContain("something went wrong");

    expect(isUserRejection("Tool was rejected by user")).toBe(true);
    expect(isUserRejection("normal failure")).toBe(false);

    expect(duration(9000)).toBe("9s");
    expect(duration(65000)).toBe("1m 5s");

    expect(fit("Short", 8)).toBe("Short   ");
    expect(fit("VeryLongTaskName", 8)).toBe("VeryLon…");
  });

  test("appendLog joins consecutive pieces with the same key, caps length, and strips control codes", () => {
    let log = appendLog([], "thinking", "b0", "Let me ");
    log = appendLog(log, "thinking", "b0", "think.");
    log = appendLog(log, "call", "b1", "\x1b[32mRead\x1b[0m ");
    expect(log).toEqual([
      { kind: "thinking", key: "b0", text: "Let me think." },
      { kind: "call", key: "b1", text: "Read " },
    ]);

    for (let i = 0; i < LOG_ENTRIES + 5; i++) log = appendLog(log, "result", `r${i}`, "ok");
    expect(log).toHaveLength(LOG_ENTRIES);
    expect(log[0]?.key).toBe("r5");

    const long = appendLog([], "result", "r", "x".repeat(LOG_ENTRY_CHARS + 50))[0]!.text;
    expect(long).toHaveLength(LOG_ENTRY_CHARS + 1);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("widget", () => {
  test("renders checklist rows within terminal width and handles toggle clicks", () => {
    let enabled = true;
    let list = planSteps(newJob(1000, "Build my landing page"), [
      "Read your brand notes",
      "Build the pricing section",
      "Add the contact form",
      "Polish the footer",
    ]);
    list = reportProgress(list, "Read your brand notes", 100);
    list = reportProgress(list, "Build the pricing section", 60);

    const widget = new CleanViewWidget(() => createFakeTheme(), {
      isEnabled: () => enabled,
      getChecklist: () => list,
      isThinking: () => false,
      getFrame: () => 0,
      now: () => 13000,
      onToggleEnabled: () => {
        enabled = !enabled;
      },
      onToggleCollapsed: () => {
        list = { ...list, isCollapsed: !list.isCollapsed };
      },
      onInspectTask: () => {},
    });

    const lines = widget.render(80);
    // A blank line above the band keeps it clear of the spinner line.
    // and a blank line under the header row separates it from the task list.
    expect(lines.length).toBe(7);
    expect(lines[0]).toBe("");
    expect(lines[2]).toBe("");
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }

    const joined = lines.map((l) => stripTerminalSequences(l)).join("\n");
    expect(joined).toContain("Build my landing page · 12s");
    expect(joined).toContain("[ ● Clean View: ON ] [-]");
    expect(joined).toMatch(/✓ Read your brand notes\s+██████████\s+Done/);
    expect(joined).toMatch(/▶ Build the pricing section\s+██████░░░░\s+60%/);
    expect(joined).toMatch(/○ Add the contact form\s+░{10}\s+Next/);
    expect(joined).toMatch(/○ Polish the footer\s+░{10}\s+Up next/);

    // A click on the blank line above does nothing
    expect(widget.handleMouse({
      type: "click", button: "left", x: 78, y: 0, screenX: 78, screenY: 0, width: 80, height: 6, shift: false, alt: false, ctrl: false,
    })).toBeUndefined();

    // Click [-] at the right end of the header row to collapse
    const collapseResult = widget.handleMouse({
      type: "click",
      button: "left",
      x: 78,
      y: 1,
      screenX: 78,
      screenY: 1,
      width: 80,
      height: 6,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(collapseResult?.handled).toBe(true);
    expect(list.isCollapsed).toBe(true);
    expect(widget.render(80).length).toBe(2);

    // Click [ ● Clean View: ON ] to toggle enabled off
    const toggleResult = widget.handleMouse({
      type: "click",
      button: "left",
      x: 60,
      y: 1,
      screenX: 60,
      screenY: 1,
      width: 80,
      height: 2,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(toggleResult?.handled).toBe(true);
    expect(enabled).toBe(false);
    expect(stripTerminalSequences(widget.render(80)[0]!)).toContain("[ ○ Clean View: OFF ]");
  });
});

describe("extension integration", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("blocks non-plan tools before a plan exists and allows them after plan_steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    let clock = 1000;
    const h = createHarness({ directory: dir, now: () => clock });

    await h.emit("session_start");
    const systemPromptOptions = { sections: {} as Record<string, string> };
    const beforeRes = await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Build my landing page",
      systemPrompt: "",
      systemPromptOptions,
    });
    // Must not return a replacement user message (preserves pi-auto-model compatibility)
    expect(beforeRes).toBeUndefined();
    expect(systemPromptOptions.sections.clean_view).toContain("plan_steps");
    expect(systemPromptOptions.sections.clean_view).toContain("Never spend a turn calling `report_progress` or `plan_steps` alone");

    const blockedBash = await h.callTool("bash", { command: "ls" });
    expect(blockedBash.blocked).toBe(true);
    expect(blockedBash.reason).toContain("plan_steps");

    const blockedProgress = await h.callTool("report_progress", { task: "Read brand notes", percent: 0 });
    expect(blockedProgress.blocked).toBe(true);
    expect(blockedProgress.reason).toContain("plan_steps");

    const planned = await h.callTool("plan_steps", {
      title: "Build my landing page",
      steps: ["Read brand notes", "Build pricing section"],
    });
    expect(planned.blocked).toBe(false);
    expect(planned.result.content[0].text).toBe("Planned 2 steps. The first one has started.");

    const allowedBash = await h.callTool("bash", { command: "ls" });
    expect(allowedBash.blocked).toBe(false);

    const progressed = await h.callTool("report_progress", {
      task: "Read brand notes",
      percent: 100,
    });
    expect(progressed.result.content[0].text).toBe("Progress noted: 100%.");

    const rendered = h.renderWidget(80).join("\n");
    expect(rendered).toMatch(/✓ Read brand notes\s+█{10}\s+Done/);
    expect(rendered).toMatch(/▶ Build pricing section\s+[█░]{10}\s+Working/);
  });

  test("shows activity until the plan provides a meaningful title", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir, now: () => 1000 });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user", prompt: "btw `classifier prompt:274–283` and `existing tests:74–89` aren't clickable, so I approve the change", systemPrompt: "", systemPromptOptions: { sections: {} },
    });
    expect(h.renderWidget(100)[1]).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking\.\.\. · 0s /);
    await h.callTool("plan_steps", { title: "Fix local links", steps: ["Check the link targets"] });
    expect(h.renderWidget(100).join("\n")).toContain("Fix local links");
  });

  test("shows Thinking as soon as steering arrives and replaces it with the new plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir, now: () => 1000 });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user", prompt: "Finish the old task", systemPrompt: "", systemPromptOptions: { sections: {} },
    });
    await h.callTool("plan_steps", { steps: ["Finish the old task"] });
    await h.callTool("report_progress", { task: "Finish the old task", percent: 100 });

    await h.emit("input", { text: "Start a new task", source: "interactive", streamingBehavior: "steer" });
    let rendered = h.renderWidget(80).join("\n");
    expect(rendered).toContain("Thinking...");
    expect(rendered).not.toContain("Finish the old task");

    await h.emit("before_agent_start", {
      messageType: "user", prompt: "Start a new task", systemPrompt: "", systemPromptOptions: { sections: {} },
    });
    rendered = h.renderWidget(80).join("\n");
    expect(rendered).toContain("Thinking...");
    expect(rendered).not.toContain("Understand your request");

    await h.callTool("plan_steps", { title: "Start a new task", steps: ["Read the new notes"] });
    rendered = h.renderWidget(80).join("\n");
    expect(rendered).toContain("Read the new notes");
    expect(rendered).not.toContain("Thinking...");
  });

  test("task clicks show details and can stop the whole run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir, now: () => 1000 });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user", prompt: "Inspect and verify the change", systemPrompt: "", systemPromptOptions: { sections: {} },
    });
    await h.callTool("plan_steps", { steps: ["Inspect the files", "Run the checks"] });
    await h.callTool("report_progress", { task: "Inspect the files", percent: 45 });

    const dialogs: string[] = [];
    let keys = ["tui.select.confirm"];
    let aborts = 0;
    const keybindings = { matches: (data: string, id: string) => data === id };
    (h.ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        const dialog = factory({ requestRender() {} }, h.theme, keybindings, resolve);
        dialogs.push(dialog.render(80).join("\n"));
        for (const key of keys) dialog.handleInput(key);
      });
    h.ctx.abort = () => { aborts++; };
    h.renderWidget(80);
    const click = {
      type: "click", button: "left", x: 10, y: 3, screenX: 10, screenY: 3, width: 80, height: 6,
      shift: false, alt: false, ctrl: false,
    } as const;

    expect(h.widgetComponent.handleMouse(click)?.handled).toBe(true);
    await Promise.resolve();
    expect(dialogs[0]).toContain("Inspect the files");
    expect(dialogs[0]).toContain("45% reported");
    expect(dialogs[0]).toMatch(/Activity\s+Progress reported · 0s ago/);
    expect(dialogs[0]).toContain("Stop entire run");

    keys = ["tui.select.down", "tui.select.confirm"];
    h.widgetComponent.handleMouse(click);
    await Promise.resolve();
    expect(aborts).toBe(1);
    await h.emit("agent_settled", { aborted: true });
    const stopped = h.renderWidget(80).join("\n");
    expect(stopped).toContain("Stopped");
    expect(stopped).toMatch(/‖ Inspect the files\s+[█░]{10}\s+Paused/);
    expect(stopped).toMatch(/○ Run the checks\s+[█░]{10}\s+Next/);
    expect(stopped).not.toMatch(/▶ Run the checks/);

    keys = ["tui.select.confirm"];
    await h.commands.get("simple")!.handler("inspect", h.ctx);
    await Promise.resolve();
    expect(dialogs.at(-1)).toContain("Inspect the files");

    const before = dialogs.length;
    await h.shortcuts.get("ctrl+space")!.handler(h.ctx);
    await Promise.resolve();
    expect(dialogs.length).toBe(before + 1);
    expect(dialogs.at(-1)).toContain("Inspect the files");
    expect(dialogs.at(-1)).toContain("1/2");
  });

  test("counts the files read in the active step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir, now: () => 1000 });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user", prompt: "Open ten files and summarise them", systemPrompt: "", systemPromptOptions: { sections: {} },
    });
    await h.callTool("plan_steps", { steps: ["Read the files", "Summarise them"] });
    for (const path of ["a.ts", "b.ts", "c.ts"]) await h.callTool("read", { path });
    expect(h.renderWidget(120).join("\n")).toContain("Read 3 files in this step");

    await h.callTool("report_progress", { task: "Read the files", percent: 100 });
    await h.callTool("read", { path: "d.ts" });
    expect(h.renderWidget(120).join("\n")).toContain("Read 1 file in this step");

    await h.emit("tool_result", { toolCallId: "call-2", toolName: "read", input: { path: "e.ts" }, content: [], isError: true });
    expect(h.renderWidget(120).join("\n")).toContain("A tool call failed");
    await h.callTool("read", { path: "f.ts" });
    expect(h.renderWidget(120).join("\n")).toContain("Read 2 files in this step");
  });

  test("counts bash commands in the active step and shows step elapsed time + inspect hint on long-running steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    let clock = 1000;
    const h = createHarness({ directory: dir, now: () => clock });
    await h.emit("session_start");
    const systemPromptOptions = { sections: {} as Record<string, string> };
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Verify skill configuration",
      systemPrompt: "",
      systemPromptOptions,
    });
    expect(systemPromptOptions.sections.clean_view).toContain("including the final step");

    await h.callTool("plan_steps", { title: "Check Pi settings", steps: ["Inspect settings file", "Verify skill configuration"] });
    await h.callTool("bash", { command: "ls" });
    expect(h.renderWidget(120).join("\n")).toContain("Ran 1 command in this step");
    await h.callTool("bash", { command: "git status" });
    expect(h.renderWidget(120).join("\n")).toContain("Ran 2 commands in this step");

    // Advancing to step 2 resets the command counter for the new step
    clock = 5000;
    await h.callTool("report_progress", { task: "Inspect settings file", percent: 100 });
    await h.callTool("bash", { command: "git diff" });
    expect(h.renderWidget(120).join("\n")).toContain("Ran 1 command in this step");

    // Once the active step runs >= 15s (clock=23000 -> 18s on step 2, 22s overall), show step elapsed time and inspect hint
    clock = 23000;
    const longRender = h.renderWidget(120).join("\n");
    expect(longRender).toContain("ctrl+space to inspect");
    expect(longRender).toMatch(/▶ Verify skill configuration\s+[█░]{10}\s+Working · 18s/);

    // If no model output arrives for >= 30s after the last tool result (or thinking delta), show stall notice
    clock = 36000;
    const stalledRender = h.renderWidget(140).join("\n");
    expect(stalledRender).toContain("No model output for 31s (Esc to stop)");

    // Active thinking deltas refresh the activity timestamp and clear the stall notice
    await h.emit("message_update", {
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Still working..." },
    });
    const refreshedRender = h.renderWidget(140).join("\n");
    expect(refreshedRender).not.toContain("No model output");
    expect(refreshedRender).toContain("Thinking");
  });

  test("opening task details is not a question for the person", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir, now: () => 1000 });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user", prompt: "Inspect and verify the change", systemPrompt: "", systemPromptOptions: { sections: {} },
    });
    await h.callTool("plan_steps", { steps: ["Inspect the files", "Run the checks"] });

    // Pi announces every dialog, Clean View's own included, as a prompt.
    let close: (choice: string | undefined) => void = () => {};
    (h.ctx.ui as any).custom = () => {
      void h.emit("ui_prompt_start", { reason: "ui_prompt", kind: "custom" });
      return new Promise((resolve) => { close = resolve; })
        .finally(() => h.emit("ui_prompt_end", { reason: "ui_prompt", kind: "custom" }));
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    void h.shortcuts.get("ctrl+space")!.handler(h.ctx);
    await settle();
    let band = h.renderWidget(80).join("\n");
    expect(band).not.toContain("Needs you");
    expect(band).not.toContain("Paused");
    expect(band).not.toContain("Waiting for your answer");

    close(undefined);
    await settle();
    expect(h.renderWidget(80).join("\n")).not.toContain("Needs you");

    await h.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm", title: "Run it?" });
    expect(h.renderWidget(80).join("\n")).toContain("Needs you");
  });

  test("an open details dialog keeps its times and progress live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    let clock = 1000;
    const h = createHarness({ directory: dir, now: () => clock });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user", prompt: "Inspect and verify the change", systemPrompt: "", systemPromptOptions: { sections: {} },
    });
    await h.callTool("plan_steps", { steps: ["Inspect the files", "Run the checks"] });
    await h.callTool("report_progress", { task: "Inspect the files", percent: 20 });

    let dialog: any;
    const keybindings = { matches: (data: string, id: string) => data === id };
    (h.ctx.ui as any).custom = (factory: any) =>
      new Promise((resolve) => {
        dialog = factory({ requestRender() {} }, h.theme, keybindings, resolve);
      });
    void h.commands.get("simple")!.handler("inspect", h.ctx);
    await Promise.resolve();
    expect(dialog.render(80).join("\n")).toContain("20% reported");
    expect(dialog.render(80).join("\n")).toContain("Progress reported · 0s ago");

    clock = 6000;
    await h.callTool("report_progress", { task: "Inspect the files", percent: 70 });
    clock = 9000;
    const later = dialog.render(80).join("\n");
    expect(later).toContain("70% reported");
    expect(later).toContain("Progress reported · 3s ago");
    dialog.handleInput("tui.select.cancel");
  });

  test("advances the spinner at a 100ms cadence", async () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
      tempDirs.push(dir);
      const h = createHarness({ directory: dir, now: () => 1000 });
      await h.emit("session_start");
      await h.emit("before_agent_start", {
        messageType: "user", prompt: "Inspect the telemetry stack", systemPrompt: "", systemPromptOptions: { sections: {} },
      });

      const before = h.renderWidget(80).join("\n");
      vi.advanceTimersByTime(100);
      const after = h.renderWidget(80).join("\n");
      expect(after).not.toBe(before);
      await h.emit("agent_settled", { aborted: true });
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps showing the model at work after the last step is done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir, now: () => 1000 });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user", prompt: "Open ten files and summarise them", systemPrompt: "", systemPromptOptions: { sections: {} },
    });
    await h.callTool("plan_steps", { title: "Summarize the files", steps: ["Open the files"] });
    await h.callTool("report_progress", { task: "Open the files", percent: 100 });

    const update = (type: string) =>
      h.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type } });

    await update("thinking_start");
    expect(h.renderWidget(80).join("\n")).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] .*· Thinking/);
    await update("text_start");
    expect(h.renderWidget(80).join("\n")).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] .*· Writing the reply/);

    await h.emit("agent_settled", { aborted: false });
    const done = h.renderWidget(80).join("\n");
    expect(done).toContain("All done");
    expect(done).not.toContain("Writing the reply");
  });

  test("tells the model it may replan when the job grows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir, now: () => 1000 });
    await h.emit("session_start");
    const systemPromptOptions = { sections: {} as Record<string, string> };
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Build my landing page",
      systemPrompt: "",
      systemPromptOptions,
    });

    expect(systemPromptOptions.sections.clean_view).toContain("call `plan_steps` again");
    expect(h.tools.get("plan_steps")?.description).toContain("call it again");
  });

  test("does not block tool calls after a plan exists and does not mutate activeTools or enforce gates when toggled mid-run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir, now: () => 1000 });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Build my landing page",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
    await h.callTool("plan_steps", { steps: ["Read brand notes", "Build pricing section"] });

    for (let i = 0; i < 20; i++) {
      expect((await h.callTool("bash", { command: "ls" })).blocked).toBe(false);
    }

    // Toggling off mid-run leaves activeTools untouched until the run settles
    await h.commands.get("simple")!.handler("off", h.ctx);
    expect(h.activeTools).toContain("plan_steps");
    expect(h.activeTools).toContain("report_progress");

    // Starting a new run while off removes internal tools, tells the model not to call them in codemode, and does not block even if toggled on mid-run
    const offPromptOptions = { sections: {} as Record<string, string> };
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Second task started while off",
      systemPrompt: "",
      systemPromptOptions: offPromptOptions,
    });
    expect(h.activeTools).not.toContain("plan_steps");
    expect(offPromptOptions.sections.clean_view).toContain("Do not call `plan_steps` or `report_progress`");
    await h.commands.get("simple")!.handler("on", h.ctx);
    expect((await h.callTool("bash", { command: "ls" })).blocked).toBe(false);
  });

  test("a turn that ends while subagents run reads Waiting, then resumes when they report back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir, now: () => 1000 });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user", prompt: "Audit SQL migrations", systemPrompt: "", systemPromptOptions: { sections: {} },
    });
    await h.callTool("plan_steps", { title: "Audit SQL migrations", steps: ["Inventory SQL files", "Verify formatting"] });
    const spawned = (id: string) => h.emit("tool_result", {
      toolCallId: `spawn-${id}`, toolName: "spawn_inline_subagent", input: {},
      content: [{ type: "text", text: "started" }],
      details: { id, agent: "inline", status: "running", description: "check", unknownTools: [] },
      isError: false,
    });
    const reported = (id: string) => h.emit("message_end", {
      message: { role: "custom", customType: "subagent-complete", content: "done", display: true, details: { id }, timestamp: 1 },
    });
    const settle = async (text: string) => {
      await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }] });
      await h.emit("agent_settled", { aborted: false });
    };
    await spawned("sub-1");
    await spawned("sub-2");
    await reported("sub-2");

    // One of two subagents still runs: Pi carries on by itself, so it is not Needs you or Ended
    await settle("I started two checks in the background.");
    let rendered = h.renderWidget(100).join("\n");
    expect(rendered).toContain("⏳ Waiting on 1 subagent · Audit SQL migrations");
    expect(rendered).not.toContain("Needs you");
    expect(rendered).not.toContain("Ended");

    // The last one reports back and wakes Pi: the same checklist resumes
    await reported("sub-1");
    await h.emit("before_agent_start", {
      messageType: "custom",
      message: { customType: "subagent-complete", content: "done", display: true, details: { id: "sub-1" } },
      systemPrompt: "", systemPromptOptions: { sections: {} },
    });
    rendered = h.renderWidget(100).join("\n");
    expect(rendered).not.toContain("Waiting on");
    expect(rendered).toMatch(/▶ Inventory SQL files\s+[█░]{10}\s+Working/);

    // With nothing left running, a turn that ends mid-plan reads Ended
    await settle("Checked the files.");
    expect(h.renderWidget(100).join("\n")).toContain("■ Ended · Audit SQL migrations");
  });

  test("Esc mid-plan reads Stopped with the step Paused; a report does not revive it; a typed prompt carries on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir, now: () => 1000 });
    await h.emit("session_start");
    const typed = (prompt: string) => h.emit("before_agent_start", {
      messageType: "user", prompt, systemPrompt: "", systemPromptOptions: { sections: {} },
    });
    await typed("Audit SQL migrations");
    await h.callTool("plan_steps", { title: "Audit SQL migrations", steps: ["Inventory SQL files", "Verify formatting"] });
    await h.callTool("report_progress", { task: "Inventory SQL files", percent: 100 });
    await h.emit("agent_settled", { aborted: true });

    let rendered = h.renderWidget(100).join("\n");
    expect(rendered).toContain("■ Stopped · Audit SQL migrations · you pressed Esc");
    expect(rendered).toMatch(/‖ Verify formatting\s+[█░]{10}\s+Paused/);
    expect(rendered).not.toContain("Working");

    // A subagent reporting after Esc must not bring the stopped plan back
    await h.emit("before_agent_start", {
      messageType: "custom",
      message: { customType: "subagent-complete", content: "done", display: true, details: { id: "sub-1" } },
      systemPrompt: "", systemPromptOptions: { sections: {} },
    });
    expect(h.renderWidget(100).join("\n")).toContain("■ Stopped");

    // Re-steering carries on with the same plan
    await typed("Use the staging database instead");
    rendered = h.renderWidget(100).join("\n");
    expect(rendered).toContain("Audit SQL migrations");
    expect(rendered).toMatch(/✓ Inventory SQL files/);
    expect(rendered).toMatch(/▶ Verify formatting\s+[█░]{10}\s+Working/);
  });

  test("tracks Needs you on ui_prompt_start, Stuck on 3 errors, and All done + collapse on agent_settled", async () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
      tempDirs.push(dir);
      let clock = 1000;
      const h = createHarness({ directory: dir, now: () => clock, collapseMs: 5000 });

      await h.emit("session_start");
      await h.emit("before_agent_start", {
        messageType: "user",
        prompt: "Build my landing page",
        systemPrompt: "",
        systemPromptOptions: { sections: {} },
      });

      await h.callTool("plan_steps", {
        title: "Build my landing page",
        steps: ["Build the page"],
      });

      await h.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm", title: "Allow bash?" });
      expect(h.renderWidget(80).join("\n")).toContain("Needs you");
      expect(h.renderWidget(80).join("\n")).toContain("Pi needs your OK to continue");

      await h.emit("ui_prompt_end", { reason: "ui_prompt", kind: "confirm" });
      expect(h.renderWidget(80).join("\n")).not.toContain("Needs you");

      // 3 consecutive tool errors -> Stuck
      for (let i = 0; i < 3; i++) {
        await h.emit("tool_result", {
          toolCallId: `err-${i}`,
          toolName: "bash",
          input: {},
          content: [{ type: "text", text: "Command failed" }],
          isError: true,
        });
      }
      expect(h.renderWidget(80).join("\n")).toContain("⚠ Stuck: a step keeps failing, Pi is trying another way");

      // Finishing the step unsticks and marks done
      await h.callTool("report_progress", { task: "Build the page", percent: 100 });
      clock = 10000;
      await h.emit("agent_settled", { aborted: false });

      const beforeCollapse = h.renderWidget(80).join("\n");
      expect(beforeCollapse).toContain("✓ All done · Build my landing page · took 9s");
      expect(beforeCollapse).toContain("Build the page");

      vi.advanceTimersByTime(5000);
      const afterCollapse = h.renderWidget(80).join("\n");
      expect(afterCollapse).toContain("✓ All done · Build my landing page · took 9s");
      expect(afterCollapse).not.toContain("Build the page");
    } finally {
      vi.useRealTimers();
    }
  });

  test("/simple toggles Clean View, persists across sessions, and hides/reveals tool renderers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir });
    await h.emit("session_start");

    const baseRenderer: ToolRenderers = {
      renderShell: "default",
      renderCall: () => new Text("bash ls", 0, 0),
      renderResult: () => new Text("file.txt", 0, 0),
    };
    const resolved = h.resolveRenderer("bash", baseRenderer)!;
    expect(resolved.renderShell).toBe("self");

    let invalidated = 0;
    const makeContext = (): any => ({
      args: { command: "ls" },
      toolCallId: "c1",
      invalidate: () => {
        invalidated++;
        if (invalidated > 5) {
          throw new Error("Infinite re-entrant invalidate loop");
        }
        // Real ToolExecutionComponent.invalidate() calls updateDisplay(), which
        // passes a newly allocated getRenderContext().invalidate closure to renderCall/renderResult.
        resolved.renderCall!({ command: "ls" }, h.theme, makeContext());
      },
      lastComponent: undefined,
      state: {},
      cwd: "/tmp",
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: true,
      isError: false,
      durationMs: 10,
      outputPad: 1,
    });
    const renderContext = makeContext();

    // While Clean View is ON and not expanded, tool call and result render 0 lines
    const callWhileOn = resolved.renderCall!({ command: "ls" }, h.theme, renderContext);
    const resultWhileOn = resolved.renderResult!(
      { content: [{ type: "text", text: "file.txt" }], details: undefined },
      { expanded: false, isPartial: false },
      h.theme,
      renderContext,
    );
    expect(callWhileOn.render(80)).toEqual([]);
    expect(resultWhileOn.render(80)).toEqual([]);

    // While Clean View is ON, hiddenThinkingLabel is set to "" and AssistantMessageComponent suppresses "Thinking..."
    initTheme("dark", false);
    expect(h.hiddenThinkingLabels.at(-1)).toBe("");
    const assistantComp = new AssistantMessageComponent(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Step by step reasoning..." },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
      } as any,
      true,
      undefined,
      "",
    );
    expect(assistantComp.render(80)).toEqual([]);

    // Run /simple off -> invalidates existing tool components, removes internal tools from active set, and reveals normal tool output
    await h.commands.get("simple")!.handler("off", h.ctx);
    expect(invalidated).toBe(1);
    expect(h.hiddenThinkingLabels.at(-1)).toBeUndefined();
    assistantComp.setHiddenThinkingLabel("Thinking...");
    expect(assistantComp.render(80).map((l) => stripTerminalSequences(l)).join("\n")).toContain("Thinking...");
    expect(h.activeTools).not.toContain("plan_steps");
    expect(h.activeTools).not.toContain("report_progress");

    // Internal tools (plan_steps / report_progress) stay hidden in transcript even when Clean View is OFF
    const planRenderer = h.resolveRenderer("plan_steps")!;
    expect(planRenderer.renderCall!({ steps: ["Step 1"] }, h.theme, renderContext).render(80)).toEqual([]);
    expect(
      planRenderer
        .renderResult!(
          { content: [{ type: "text", text: "Planned 1 step." }], details: undefined },
          { expanded: true, isPartial: false },
          h.theme,
          renderContext,
        )
        .render(80),
    ).toEqual([]);

    const callWhileOff = resolved.renderCall!({ command: "ls" }, h.theme, renderContext);
    const resultWhileOff = resolved.renderResult!(
      { content: [{ type: "text", text: "file.txt" }], details: undefined },
      { expanded: false, isPartial: false },
      h.theme,
      renderContext,
    );
    const combinedLines = [...callWhileOff.render(80), ...resultWhileOff.render(80)].join("\n");
    expect(combinedLines).toContain("bash ls");
    expect(combinedLines).toContain("file.txt");

    // Persistence: starting a new harness in the same directory remembers OFF
    const h2 = createHarness({ directory: dir });
    await h2.emit("session_start");
    expect(h2.renderWidget(80)[0]).toContain("[ ○ Clean View: OFF ]");
  });

  test("handles codemode plan_steps gate, abort -> Stopped, API error -> Stuck, and incomplete steps -> Ended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir, now: () => 2000 });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Audit SQL migrations",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });

    // codemode without plan_steps is blocked
    const blockedCodemode = await h.callTool("codemode", { code: "await tools.bash({ command: 'ls' })" });
    expect(blockedCodemode.blocked).toBe(true);

    // codemode containing plan_steps is allowed, and nested plan_steps plans the job
    const allowedCodemode = await h.callTool("codemode", {
      code: "await tools.plan_steps({ steps: ['Inventory SQL files', 'Verify formatting'] })",
    });
    expect(allowedCodemode.blocked).toBe(false);
    await h.callTool("plan_steps", { title: "Audit SQL migrations", steps: ["Inventory SQL files", "Verify formatting"] }, "codemode-1");

    // Settling mid-plan without a question needs nothing from the person: it reads Ended, not Needs you
    await h.emit("agent_end", {
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "I am checking whether those findings hold up before I summarize them." }],
        },
      ],
    });
    await h.emit("agent_settled", { aborted: false });
    expect(h.renderWidget(100).join("\n")).not.toContain("Needs you");
    expect(h.renderWidget(100).join("\n")).toContain("■ Ended · Audit SQL migrations · 0 of 2 steps done");
    expect(h.renderWidget(100).join("\n")).toMatch(/‖ Inventory SQL files/);

    // Replying "continue" to an ended plan resumes the existing checklist instead of wiping it
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "continue",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
    expect(h.renderWidget(100).join("\n")).not.toContain("Needs you");
    expect(h.renderWidget(100).join("\n")).toContain("Audit SQL migrations");
    expect(h.renderWidget(100).join("\n")).toMatch(/▶ Inventory SQL files\s+[█░]{10}\s+Working/);

    // While get_subagent_result is running, header shows "· waiting on subagents"
    await h.emit("tool_call", {
      toolCallId: "sub-wait-1",
      toolName: "get_subagent_result",
      input: { id: "sub-1" },
    });
    expect(h.renderWidget(100)[1]).toContain("waiting on subagents");
    await h.emit("tool_result", {
      toolCallId: "sub-wait-1",
      toolName: "get_subagent_result",
      input: { id: "sub-1" },
      content: [{ type: "text", text: "done" }],
      isError: false,
    });
    expect(h.renderWidget(100)[1]).not.toContain("waiting on subagents");

    // Settling after the assistant asks a question (?) shows "Pi asked a question above — reply to continue"
    await h.emit("agent_end", {
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Which directory should I check next?" }],
        },
      ],
    });
    await h.emit("agent_settled", { aborted: false });
    expect(h.renderWidget(100).join("\n")).toContain("Pi asked a question above — reply to continue");

    // A background subagent completion wake-up (messageType: "custom") resumes the active checklist
    await h.emit("before_agent_start", {
      messageType: "custom",
      message: { customType: "subagent-complete", content: "Subagent finished.", display: true },
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
    expect(h.renderWidget(80).join("\n")).not.toContain("Needs you");
    expect(h.renderWidget(80).join("\n")).toMatch(/▶ Inventory SQL files\s+[█░]{10}\s+Working/);

    // Aborting shows "■ Stopped"
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Audit SQL migrations",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
    await h.emit("agent_settled", { aborted: true });
    expect(h.renderWidget(80).join("\n")).toContain("■ Stopped · Your request · you pressed Esc");

    // Assistant stopReason === "error" shows calm Stuck message
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Audit SQL migrations",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
    await h.callTool("plan_steps", { steps: ["Inventory SQL files", "Verify formatting"] });
    await h.callTool("report_progress", { task: "Inventory SQL files", percent: 100 });
    await h.emit("tool_result", {
      toolCallId: "ask-1",
      toolName: "AskUserQuestion",
      input: {},
      content: [{ type: "text", text: "The user doesn't want to proceed with this tool use. The tool use was rejected." }],
      isError: true,
    });
    await h.emit("agent_settled", { aborted: false });
    expect(h.renderWidget(100).join("\n")).toContain("⚠ Stuck: you said no to a step, so Pi paused");
    expect(h.renderWidget(100).join("\n")).toMatch(/‖ Verify formatting\s+[█░]{10}\s+Paused/);

    // Replying after a stuck pause resumes the existing checklist instead of wiping finished steps
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "sorry I pressed ESC by accident",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
    expect(h.renderWidget(100).join("\n")).not.toContain("Stuck");
    expect(h.renderWidget(100).join("\n")).toMatch(/✓ Inventory SQL files/);
    expect(h.renderWidget(100).join("\n")).toMatch(/▶ Verify formatting\s+[█░]{10}\s+Working/);

    await h.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limit" }],
    });
    expect(h.renderWidget(100).join("\n")).toContain("⚠ Stuck: you hit your usage limit, try again a little later");
  });

  test("records main-loop tool calls, results, and per-task elapsed time for the task details dialog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    let clock = 1000;
    const h = createHarness({ directory: dir, now: () => clock });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Check the config",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
    clock = 2000;
    await h.callTool("plan_steps", { steps: ["Read the config", "Verify the settings", "Report back"] });
    await h.callTool("read", { path: "a.ts" });
    await h.callTool("grep", { pattern: "port" }, "subagent-1");
    await h.callTool("bash", { command: "git status" });

    // Step 1 finishes at t=7000 (took 5s); Step 2 starts at t=7000 and is inspected at t=11000 (4s elapsed; overall run is 10s)
    clock = 7000;
    await h.callTool("report_progress", { task: "Read the config", percent: 100 });
    clock = 11000;

    await h.commands.get("simple")!.handler("inspect", h.ctx);
    expect(h.customDialog).toBeDefined();
    // Opens on the active task (step 2/3): elapsed is 4s (not 10s from the overall run)
    const activePage = h.customDialog.render(120).join("\n");
    expect(activePage).toContain("Verify the settings  2/3");
    expect(activePage).toMatch(/Elapsed\s+4s/);

    // Left to finished step 1/3: elapsed is frozen at 5s
    h.customDialog.handleInput("\x1b[D");
    const first = h.customDialog.render(120).join("\n");
    expect(first).toMatch(/Elapsed\s+5s/);
    expect(first).toContain("→ read {\"path\":\"a.ts\"}");
    expect(first).toContain("→ bash {\"command\":\"git status\"}");
    expect(first).toContain("← ok");
    expect(first).not.toContain("grep");
    expect(first.indexOf("bash {")).toBeLessThan(first.indexOf("read {"));

    // Right twice to upcoming step 3/3: elapsed shows Not started yet
    h.customDialog.handleInput("\x1b[C");
    h.customDialog.handleInput("\x1b[C");
    const third = h.customDialog.render(120).join("\n");
    expect(third).toMatch(/Elapsed\s+Not started yet/);
    expect(third).toContain("Nothing recorded for this step yet");
  });

  test("batches plan_steps and report_progress with sibling tools in the same turn and guides replans", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    const h = createHarness({ directory: dir, now: () => 1000 });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Build pricing page",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });

    // Parallel tool_call events in one assistant turn: plan_steps followed by read before execute() runs
    const planGate = await h.emit("tool_call", {
      toolCallId: "plan-1",
      toolName: "plan_steps",
      input: { title: "Build pricing page", steps: ["Read brand notes", "Build pricing section"] },
    });
    expect(planGate?.block).toBeFalsy();
    const siblingReadGate = await h.emit("tool_call", {
      toolCallId: "read-1",
      toolName: "read",
      input: { path: "notes.md" },
    });
    expect(siblingReadGate?.block).toBeFalsy();
    const firstPlanResult = await h.tools.get("plan_steps")!.execute(
      "plan-1",
      { title: "Build pricing page", steps: ["Read brand notes", "Build pricing section"] },
      undefined,
      undefined,
      h.ctx as any,
    );
    expect((firstPlanResult.content[0] as { text?: string })?.text).toBe(
      "Planned 2 steps. The first one has started.",
    );
    await h.emit("tool_result", {
      toolCallId: "read-1",
      toolName: "read",
      input: { path: "notes.md" },
      content: [{ type: "text", text: "notes" }],
      isError: false,
    });

    // Parallel tool_call events: report_progress(100) + bash in the same turn logs bash under step 2
    await h.emit("tool_call", {
      toolCallId: "prog-1",
      toolName: "report_progress",
      input: { task: "Read brand notes", percent: 100 },
    });
    await h.emit("tool_call", {
      toolCallId: "bash-1",
      toolName: "bash",
      input: { command: "npm test" },
    });
    await h.tools.get("report_progress")!.execute(
      "prog-1",
      { task: "Read brand notes", percent: 100 },
      undefined,
      undefined,
      h.ctx as any,
    );
    await h.emit("tool_result", {
      toolCallId: "bash-1",
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "passed" }],
      isError: false,
    });

    await h.commands.get("simple")!.handler("inspect", h.ctx);
    expect(h.customDialog.render(120).join("\n")).toContain("→ bash {\"command\":\"npm test\"}");

    // Replanning with finished steps tells the model which step is active so it does not re-report done steps
    const replanned = await h.callTool("plan_steps", {
      title: "Build pricing page",
      steps: ["Read brand notes", "Build pricing section", "Verify output"],
    });
    expect(replanned.result.content[0].text).toBe(
      'Planned 3 steps (1 already done). Active step: "Build pricing section" — do not re-report finished steps.',
    );
  });

  test("tracks codemode nested calls, excludes paused idle time, clears collected subagents, and auto-completes the final step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-clean-view-"));
    tempDirs.push(dir);
    let clock = 1000;
    const h = createHarness({ directory: dir, now: () => clock });
    await h.emit("session_start");
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Audit config",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
    await h.callTool("plan_steps", { title: "Audit config", steps: ["Read config", "Summarize findings"] });

    // A codemode script containing report_progress tracks nested calls under the active step
    for (let i = 0; i < 8; i++) {
      expect((await h.callTool("bash", { command: "ls" })).blocked).toBe(false);
    }
    const cmGate = await h.emit("tool_call", {
      toolCallId: "cm-1",
      toolName: "codemode",
      input: { code: "await tools.read({ path: 'cfg.json' }); await tools.report_progress({ task: 'Read config', percent: 50 });" },
    });
    expect(cmGate?.block).toBeFalsy();
    await h.callTool("read", { path: "cfg.json" }, "cm-1");
    expect(h.renderWidget(120).join("\n")).toContain("Read 1 file in this step");
    await h.emit("tool_result", {
      toolCallId: "cm-1",
      toolName: "codemode",
      input: {},
      content: [{ type: "text", text: "done" }],
      isError: false,
    });

    // Pause at t=5000 (4s elapsed), resume after 60s of user idle time at t=65000 -> timer still shows 4s, not 1m 4s
    clock = 5000;
    await h.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Paused mid-plan." }] }],
    });
    await h.emit("agent_settled", { aborted: false });
    clock = 65000;
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "continue",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
    expect(h.renderWidget(100).join("\n")).toContain("Audit config · 4s");

    // Spawn a subagent and collect it via get_subagent_result without a custom message
    await h.emit("tool_result", {
      toolCallId: "spawn-1",
      toolName: "spawn_inline_subagent",
      input: {},
      content: [{ type: "text", text: "started" }],
      details: { id: "sub-direct", status: "running" },
      isError: false,
    });
    await h.callTool("get_subagent_result", { id: "sub-direct" });

    // Advance to the final step; if it explicitly reported < 100% and stopped to confirm, it pauses instead of auto-completing
    await h.callTool("report_progress", { task: "Read config", percent: 100 });
    await h.callTool("report_progress", { task: "Summarize findings", percent: 50 });
    await h.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Confirm to commit to main." }] }],
    });
    await h.emit("agent_settled", { aborted: false });
    const midFinalRender = h.renderWidget(100).join("\n");
    expect(midFinalRender).toContain("■ Ended · Audit config · 1 of 2 steps done");
    expect(midFinalRender).toMatch(/‖ Summarize findings\s+█{5}░{5}\s+Paused/);

    // Replying resumes the existing checklist, streams thinking into the step log, and completing finishes the run
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "commit to main",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
    await h.emit("message_update", {
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Planning " },
    });
    await h.emit("message_update", {
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "the commit." },
    });
    await h.commands.get("simple")!.handler("inspect", h.ctx);
    expect(h.customDialog.render(120).join("\n")).toContain("💭 Planning the commit.");

    await h.callTool("report_progress", { task: "Summarize findings", percent: 100 });
    clock = 68000;
    await h.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "All checks passed. Want me to push this?" }] }],
    });
    await h.emit("agent_settled", { aborted: false });
    const finalRender = h.renderWidget(100).join("\n");
    expect(finalRender).toContain("✓ All done · Audit config · took 7s");
    expect(finalRender).toMatch(/✓ Summarize findings\s+█{10}\s+Done/);

    // Replying "apply" starts a fresh job and shows the live elapsed timer while thinking (before any tool call)
    clock = 70000;
    await h.emit("input", { text: "apply the fix", source: "interactive", streamingBehavior: "steer" });
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "apply the fix",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
    clock = 85000;
    const thinkingRender = h.renderWidget(100).join("\n");
    expect(thinkingRender).toContain("Thinking... · 15s");
    expect(thinkingRender).toMatch(/▶ Thinking\.\.\.\s+[█░]{10}\s+Working/);
  });
});

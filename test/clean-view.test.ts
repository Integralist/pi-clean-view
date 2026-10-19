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
  const toolRenderers: ToolRendererResolver[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const workingVisibleCalls: boolean[] = [];
  const hiddenThinkingLabels: Array<string | undefined> = [];
  let widgetFactory: ((tui: any, theme: any) => any) | undefined;
  let widgetComponent: any;
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
    notifications,
    workingVisibleCalls,
    hiddenThinkingLabels,
    get widgetComponent() {
      return widgetComponent;
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
    expect(label(list.tasks[0]!, false)).toBe("60%");

    list = reportProgress(list, "Read brand notes", 100);
    expect(list.tasks[0]?.status).toBe("done");
    expect(list.tasks[1]?.status).toBe("active");
    expect(meter(list.tasks[0]!, 0)).toBe("██████████");
    expect(meter(list.tasks[1]!, 0)).toBe("███░░░░░░░");
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
      getFrame: () => 0,
      now: () => 13000,
      onToggleEnabled: () => {
        enabled = !enabled;
      },
      onToggleCollapsed: () => {
        list = { ...list, isCollapsed: !list.isCollapsed };
      },
    });

    const lines = widget.render(80);
    expect(lines.length).toBe(5);
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

    // Click [-] at the right end of row 0 to collapse
    const collapseResult = widget.handleMouse({
      type: "click",
      button: "left",
      x: 78,
      y: 0,
      screenX: 78,
      screenY: 0,
      width: 80,
      height: 5,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(collapseResult?.handled).toBe(true);
    expect(list.isCollapsed).toBe(true);
    expect(widget.render(80).length).toBe(1);

    // Click [ ● Clean View: ON ] to toggle enabled off
    const toggleResult = widget.handleMouse({
      type: "click",
      button: "left",
      x: 60,
      y: 0,
      screenX: 60,
      screenY: 0,
      width: 80,
      height: 1,
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
    await h.callTool("plan_steps", { steps: ["Inventory SQL files", "Verify formatting"] }, "codemode-1");

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
    expect(h.renderWidget(100)[0]).toContain("waiting on subagents");
    await h.emit("tool_result", {
      toolCallId: "sub-wait-1",
      toolName: "get_subagent_result",
      input: { id: "sub-1" },
      content: [{ type: "text", text: "done" }],
      isError: false,
    });
    expect(h.renderWidget(100)[0]).not.toContain("waiting on subagents");

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
    expect(h.renderWidget(80).join("\n")).toContain("■ Stopped · Audit SQL migrations · you pressed Esc");

    // Assistant stopReason === "error" shows calm Stuck message
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Audit SQL migrations",
      systemPrompt: "",
      systemPromptOptions: { sections: {} },
    });
    await h.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limit" }],
    });
    expect(h.renderWidget(100).join("\n")).toContain("⚠ Stuck: you hit your usage limit, try again a little later");
  });
});

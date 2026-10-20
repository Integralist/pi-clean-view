import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AssistantMessageComponent,
  getAgentDir,
  getPackageDir,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component, type TUI } from "@earendil-works/pi-tui";

type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
import { Type } from "typebox";
import {
  addTask,
  appendLog,
  clampPercent,
  duration,
  EMPTY,
  errorSentence,
  fallbackTitle,
  fromTodos,
  hasPlan,
  isRunning,
  isUserRejection,
  endsWithQuestion,
  label,
  PAUSED_PHASES,
  newJob,
  PLACEHOLDER_TITLE,
  planSteps,
  reportProgress,
  updateTask,
} from "../src/logic.ts";
import { STOP, TaskDetailsDialog } from "../src/inspector.ts";
import type { CleanViewActivity, CleanViewChecklist, CleanViewLogEntry, TodoItem } from "../src/types.ts";
import { CleanViewWidget } from "../src/widget.ts";

export interface CleanViewOptions {
  directory?: string;
  frameMs?: number;
  collapseMs?: number;
  now?: () => number;
}

const COMMAND = "simple";
const INSPECT_SHORTCUT = "ctrl+space";
const WIDGET_KEY = "clean-view";
const SETTINGS_FILE = "pi-clean-view.json";
const PLAN_TOOL = "plan_steps";
const PROGRESS_TOOL = "report_progress";
const DEFAULT_FRAME_MS = 250;
const DEFAULT_COLLAPSE_MS = 5000;
const FAILURES_TO_STUCK = 3;
// Tool calls the checklist may sit unchanged through before the next one is sent back.
const QUIET_CALLS = 8;

const NEEDS_OK = "Pi needs your OK to continue";
const HAS_QUESTION = "Pi has a question for you";
const ASKED = "Pi asked a question above — reply to continue";
const SAID_NO = "you said no to a step, so Pi paused";
const KEEPS_FAILING = "a step keeps failing, Pi is trying another way";
const SUBAGENT_WAIT_HINT = "waiting on subagents";
// pi-subagents' spawn tools, and the message each subagent sends once when it finishes.
const SPAWN_TOOLS = new Set(["spawn_named_subagent", "spawn_inline_subagent"]);
const SUBAGENT_COMPLETE = "subagent-complete";
const SUBAGENT_DONE = new Set(["completed", "failed", "stopped"]);
const INTERNAL_TOOLS = new Set([PLAN_TOOL, PROGRESS_TOOL]);
// Tools that change the checklist, so a call to one restarts the quiet-call count.
const PLAN_UPDATERS = new Set([PLAN_TOOL, PROGRESS_TOOL, "todo", "TodoWrite", "TaskCreate", "TaskUpdate"]);

const ALWAYS_ALLOWED = new Set([
  PLAN_TOOL,
  "tool_search",
  "ToolSearch",
  "todo",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "AskUserQuestion",
]);

const SECTION = `# Clean View checklist

The person sees a plain checklist of your plan instead of your tool calls.

- For every request, even a quick question, call \`${PLAN_TOOL}\` first with a short job title and every step of the job (1 to 8 short names in order). Only include steps that perform actual work; never add a filler final step like "Prepare next action" or "Summarize findings". If you use \`codemode\`, call \`await tools.${PLAN_TOOL}({ ... })\` before calling any other tool.
- Call \`${PROGRESS_TOOL}\` after each item of a step (each file read, check run or section written), and at least every 3 tool calls, so the person never watches a percent sit still. Pass 100 the moment a step finishes.
- Batch \`${PLAN_TOOL}\` and \`${PROGRESS_TOOL}\` in the same response as your next tool call (or inside the same \`codemode\` script) instead of spending a separate turn on them alone. Only pass 100 after you have read a step's tool output and confirmed the step is done; when the final step is ready to answer, reply directly and Clean View completes it automatically.
- Keep internal reasoning before tool calls brief (1 to 2 sentences) so the checklist never sits idle on a long thinking pause.
- If the job grows past your plan (extra checks, cleanup, undoing changes, a new kind of work), call \`${PLAN_TOOL}\` again with the full updated list before you do it. Keep finished step names the same so they stay checked off.
- When a step spawns subagents, keep its progress below 100% until you have collected the subagent results (\`get_subagent_result\`).
- If the person sends a mid-job message or status check while steps remain, answer briefly and include your next tool call in the same response so the job keeps moving.
- Write every step name in plain English a non-technical person understands, under 40 characters, starting with a verb, like "Build the pricing section".
- Never put file paths, file names, commands, code or tool names in a step name.`;

const EMPTY_COMPONENT: Component = {
  render: () => [],
  invalidate: () => {},
};

function patchAssistantMessageClass(cls: { prototype?: Record<string, any> } | undefined): void {
  const proto = cls?.prototype;
  if (!proto || proto.__piCleanViewPatched || typeof proto.updateContent !== "function") return;
  const original = proto.updateContent;
  proto.updateContent = function patchedUpdateContent(this: any, message: any, isStreaming?: boolean) {
    if (this.hideThinkingBlock && this.hiddenThinkingLabel === "" && Array.isArray(message?.content)) {
      original.call(
        this,
        { ...message, content: message.content.filter((c: any) => c?.type !== "thinking") },
        isStreaming,
      );
      this.lastMessage = message;
      return;
    }
    original.call(this, message, isStreaming);
  };
  proto.__piCleanViewPatched = true;
}

function ensureThinkingPatch(onApplied?: () => void): void {
  patchAssistantMessageClass(AssistantMessageComponent as any);
  void import(join(getPackageDir(), "dist/bundle/index.js"))
    .then((mod) => {
      patchAssistantMessageClass((mod as any).AssistantMessageComponent);
      onApplied?.();
    })
    .catch(() => {});
}

function loadEnabled(path: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { enabled?: unknown };
    return typeof raw?.enabled === "boolean" ? raw.enabled : true;
  } catch {
    return true;
  }
}

function saveEnabled(path: string, enabled: boolean): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ enabled }, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort persistence; never break interactive session.
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

function toolActivity(toolName: string, finished = false): string {
  switch (toolName.toLowerCase()) {
    case "bash": return finished ? "Finished running a command" : "Running a command";
    case "read": return finished ? "Finished reading a file" : "Reading a file";
    case "grep":
    case "find":
    case "ls": return finished ? "Finished searching the project" : "Searching the project";
    case "edit":
    case "write": return finished ? "Finished updating files" : "Updating files";
    case "codemode": return finished ? "Finished running a script" : "Running a script";
    default: return finished ? "Finished using a tool" : "Using a tool";
  }
}

export default function cleanView(pi: ExtensionAPI, options: CleanViewOptions = {}): void {
  const settingsPath = join(options.directory ?? getAgentDir(), SETTINGS_FILE);
  const frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
  const collapseMs = options.collapseMs ?? DEFAULT_COLLAPSE_MS;
  const now = options.now ?? (() => Date.now());
  ensureThinkingPatch(() => applyWorkingVisibility(activeCtx));

  let enabled = loadEnabled(settingsPath);
  let checklist: CleanViewChecklist = EMPTY;
  let tick = 0;
  let failures = 0;
  let quietCalls = 0;
  // Files read during the active step, so the activity shows real progress the model hasn't reported.
  let readsInStep = 0;
  let readsStepId: string | null = null;
  let logSeq = 0;
  const taskLogs = new Map<string, CleanViewLogEntry[]>();
  let waitingOnSubagents = 0;
  // Subagents spawned and not yet reported back; each sends one subagent-complete message.
  const runningSubagents = new Set<string>();
  const codemodeCallIds = new Set<string>();
  const appliedToolCallIds = new Set<string>();
  let lastAssistantText = "";
  let inputThinking = false;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let collapseTimer: ReturnType<typeof setTimeout> | undefined;
  let activeTui: TUI | undefined;
  let activeCtx: ExtensionContext | undefined;
  const toolInvalidators = new Map<string, () => void>();

  function requestRender(): void {
    activeTui?.requestRender();
  }

  function invalidateTools(): void {
    for (const invalidate of [...toolInvalidators.values()]) {
      try {
        invalidate();
      } catch {
        // Ignore stale component invalidation errors.
      }
    }
  }

  function startTicker(): void {
    if (ticker !== undefined) return;
    ticker = setInterval(() => {
      tick++;
      requestRender();
    }, frameMs);
    ticker.unref?.();
  }

  function stopTicker(): void {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  function setInputThinking(value: boolean): void {
    if (inputThinking === value) return;
    inputThinking = value;
    if (value) startTicker();
    else if (!isRunning(checklist)) stopTicker();
    requestRender();
  }

  function clearCollapseTimer(): void {
    if (collapseTimer !== undefined) {
      clearTimeout(collapseTimer);
      collapseTimer = undefined;
    }
  }

  function stopAllTimers(): void {
    stopTicker();
    clearCollapseTimer();
  }

  function edit(fn: (current: CleanViewChecklist) => CleanViewChecklist): void {
    checklist = fn(checklist);
    requestRender();
  }

  function activity(summary: string, inProgress: boolean, at = now()): CleanViewActivity {
    return { summary, at, inProgress };
  }

  function applyWorkingVisibility(ctx: ExtensionContext | undefined): void {
    if (!ctx?.hasUI || ctx.mode !== "tui") return;
    ctx.ui.setWorkingVisible(!enabled);
    ctx.ui.setHiddenThinkingLabel?.(enabled ? "" : undefined);
  }

  function syncActiveTools(): void {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
    const current = pi.getActiveTools();
    if (enabled) {
      const missing = [PLAN_TOOL, PROGRESS_TOOL].filter((t) => !current.includes(t));
      if (missing.length > 0) pi.setActiveTools([...current, ...missing]);
    } else {
      const filtered = current.filter((t) => !INTERNAL_TOOLS.has(t));
      if (filtered.length !== current.length) pi.setActiveTools(filtered);
    }
  }

  function setEnabled(next: boolean, ctx: ExtensionContext | undefined = activeCtx): void {
    enabled = next;
    saveEnabled(settingsPath, enabled);
    syncActiveTools();
    applyWorkingVisibility(ctx);
    invalidateTools();
    requestRender();
    if (ctx?.hasUI) {
      ctx.ui.notify(
        enabled
          ? "Clean View on: showing the plan, hiding the technical details"
          : "Clean View off: showing everything",
        "info",
      );
    }
  }

  function recordTaskLog(kind: CleanViewLogEntry["kind"], text: string): void {
    const stepId = checklist.tasks.find((one) => one.status === "active")?.id;
    if (!stepId) return;
    const key = `${kind}-${++logSeq}`;
    taskLogs.set(stepId, appendLog(taskLogs.get(stepId) ?? [], kind, key, text));
    requestRender();
  }

  function startJob(promptText: string): void {
    clearCollapseTimer();
    failures = 0;
    waitingOnSubagents = 0;
    lastAssistantText = "";
    taskLogs.clear();
    codemodeCallIds.clear();
    appliedToolCallIds.clear();
    const startedAt = now();
    const title = promptText.trim() !== "" ? fallbackTitle(promptText) : PLACEHOLDER_TITLE;
    edit(() => newJob(startedAt, title));
    startTicker();
  }

  function resumeJob(): void {
    clearCollapseTimer();
    failures = 0;
    lastAssistantText = "";
    const resumedAt = now();
    edit((list) => ({
      ...list,
      phase: "working",
      startedAt: list.finishedAt !== null ? list.startedAt + Math.max(0, resumedAt - list.finishedAt) : list.startedAt,
      activity: activity("Resumed the task list", true, resumedAt),
      needsYouReason: null,
      stuckReason: null,
      activityHint: waitingOnSubagents > 0 ? SUBAGENT_WAIT_HINT : null,
      finishedAt: null,
      waitingOn: undefined,
    }));
    startTicker();
  }

  function subagentReported(message: { customType?: unknown; details?: unknown } | undefined): void {
    if (message?.customType !== SUBAGENT_COMPLETE) return;
    const id = (message.details as { id?: unknown } | undefined)?.id;
    if (typeof id === "string") runningSubagents.delete(id);
  }

  function ensureJob(): void {
    if (!isRunning(checklist)) {
      startJob("");
    }
  }

  // Pi announces every dialog as a prompt; Clean View's own task details must not read as a question.
  let isOwnDialogPending = false;
  let isOwnDialogOpen = false;

  async function inspectTask(taskId: string, ctx: ExtensionContext | undefined = activeCtx): Promise<void> {
    if (!ctx?.hasUI) return;
    const start = checklist.tasks.findIndex((one) => one.id === taskId);
    if (start === -1) return;
    // Read the checklist afresh on every render, so the ticker's redraws keep the dialog live.
    const pages = () => {
      const list = checklist;
      const upcoming = list.tasks.findIndex((one) => one.status === "upcoming");
      const isPaused = PAUSED_PHASES.has(list.phase);
      const currentTime = now();
      const elapsed = duration((list.finishedAt ?? currentTime) - list.startedAt);
      const lastActivity = list.activity
        ? `${list.activity.summary} · ${list.activity.inProgress ? `for ${duration(currentTime - list.activity.at)}` : `${duration(currentTime - list.activity.at)} ago`}`
        : "No visible activity recorded yet";
      return list.tasks.map((task, index) => ({
        task,
        isPaused,
        status: label(task, index === upcoming, isPaused),
        progress: task.status === "done" ? "Complete" : task.hasReported ? `${task.percent}% reported` : "No percentage reported yet",
        elapsed,
        activity: lastActivity,
        canStop: isRunning(list),
        logs: taskLogs.get(task.id) ?? [],
      }));
    };
    isOwnDialogPending = true;
    const choice = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
      new TaskDetailsDialog(tui, theme, keybindings, pages, start, done),
    );
    isOwnDialogPending = false;
    if (choice === STOP) ctx.abort();
  }

  function needsYou(reason: string): void {
    edit((list) => (isRunning(list) ? { ...list, phase: "needsYou", needsYouReason: reason } : list));
  }

  function backToWork(): void {
    edit((list) =>
      list.phase === "needsYou" && list.finishedAt === null
        ? { ...list, phase: "working", needsYouReason: null }
        : list,
    );
  }

  function stuck(reason: string): void {
    edit((list) =>
      isRunning(list) ? { ...list, phase: "stuck", stuckReason: reason, needsYouReason: null } : list,
    );
  }

  function unstuck(): void {
    edit((list) =>
      list.phase === "stuck" && list.finishedAt === null
        ? { ...list, phase: "working", stuckReason: null }
        : list,
    );
  }

  function finish(fn: (list: CleanViewChecklist) => CleanViewChecklist): void {
    setInputThinking(false);
    const finishedAt = now();
    stopTicker();
    edit((list) => {
      if (list.phase === "idle") return list;
      const finished = fn({ ...list, finishedAt });
      const summary = finished.phase === "stopped" ? "Run stopped" : finished.phase === "stuck" ? "Run needs attention" : finished.phase === "waiting" ? "Waiting for background work" : "Run finished";
      return { ...finished, activity: activity(summary, false, finishedAt) };
    });
  }

  function mountWidget(ctx: ExtensionContext): void {
    activeCtx = ctx;
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    applyWorkingVisibility(ctx);
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        activeTui = tui;
        const widget = new CleanViewWidget(() => ctx.ui.theme ?? theme, {
          isEnabled: () => enabled,
          getChecklist: () => checklist,
          isThinking: () => inputThinking,
          getFrame: () => tick,
          now,
          onToggleEnabled: () => setEnabled(!enabled, ctx),
          onToggleCollapsed: () => {
            edit((list) => ({ ...list, isCollapsed: !list.isCollapsed }));
          },
          onInspectTask: (taskId) => { void inspectTask(taskId, activeCtx); },
        });
        return Object.assign(widget, {
          dispose() {
            if (activeTui === tui) activeTui = undefined;
          },
        });
      },
      { placement: "aboveEditor" },
    );
  }

  const PlanStepsParams = Type.Object({
    title: Type.Optional(
      Type.String({
        description:
          "Short 2 to 6 word plain-English job title starting with a verb (no code, file names, or paths).",
      }),
    ),
    steps: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 8,
      description:
        "1 to 8 short plain-English step names in order, each under 40 characters and starting with a verb.",
    }),
  });

  const ReportProgressParams = Type.Object({
    task: Type.String({
      description: "Plain-English name of the current step.",
    }),
    percent: Type.Number({
      minimum: 0,
      maximum: 100,
      description: "Progress percent from 0 to 100. Pass 100 the moment a step finishes.",
    }),
  });

  pi.registerTool({
    name: PLAN_TOOL,
    label: "Plan steps",
    description:
      "Lay out every step of the job up front so the person sees the plan: 1 to 8 short plain-English step names in order, each under 40 characters and starting with a verb. The first step starts right away. If the job grows past the plan, call it again with the full updated list and keep finished step names unchanged.",
    promptSnippet: "Lay out the plain-English checklist steps for the current job",
    parameters: PlanStepsParams,
    async execute(toolCallId, params) {
      const names = Array.isArray(params.steps)
        ? params.steps.filter((s): s is string => typeof s === "string")
        : [];
      const title = typeof params.title === "string" ? params.title : undefined;
      ensureJob();
      if (!appliedToolCallIds.delete(toolCallId)) {
        edit((list) => ({ ...planSteps(list, names, title), activity: activity("Plan updated", false) }));
      }
      setInputThinking(false);
      const doneCount = checklist.tasks.filter((t) => t.status === "done").length;
      const activeTask = checklist.tasks.find((t) => t.status === "active");
      const summary =
        doneCount > 0 && activeTask
          ? `Planned ${checklist.tasks.length} steps (${doneCount} already done). Active step: "${activeTask.name}" — do not re-report finished steps.`
          : `Planned ${checklist.tasks.length} steps. The first one has started.`;
      return {
        content: [{ type: "text", text: summary }],
        details: { steps: checklist.tasks.map((t) => t.name), title: checklist.title },
      };
    },
  });

  pi.registerTool({
    name: PROGRESS_TOOL,
    label: "Report progress",
    description:
      "Report progress on the current step by its plain-English name, with a percent from 0 to 100. Report 100 the moment a step finishes; the next one then starts.",
    promptSnippet: "Report progress (0-100%) on the active checklist step",
    parameters: ReportProgressParams,
    async execute(toolCallId, params) {
      const name = typeof params.task === "string" ? params.task : "";
      const percent = typeof params.percent === "number" ? params.percent : Number(params.percent);
      ensureJob();
      if (!appliedToolCallIds.delete(toolCallId)) {
        edit((list) => ({ ...reportProgress(list, name, percent), activity: activity("Progress reported", false) }));
      }
      setInputThinking(false);
      return {
        content: [{ type: "text", text: `Progress noted: ${clampPercent(percent)}%.` }],
        details: { task: name, percent: clampPercent(percent) },
      };
    },
  });

  async function inspectCurrent(ctx: ExtensionContext): Promise<void> {
    const task = checklist.tasks.find((one) => one.status === "active") ?? checklist.tasks[0];
    if (task) await inspectTask(task.id, ctx);
    else ctx.ui.notify("There is no task to inspect", "info");
  }

  pi.registerShortcut(INSPECT_SHORTCUT, {
    description: "Clean View: show task details",
    handler: inspectCurrent,
  });

  pi.registerCommand(COMMAND, {
    description: "Clean View: show the checklist, inspect the active task, or toggle visibility (on, off, inspect, or flip)",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "inspect"]
        .filter((item) => item.startsWith(prefix.toLowerCase()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "inspect") {
        await inspectCurrent(ctx);
        return;
      }
      const next = arg === "on" ? true : arg === "off" ? false : !enabled;
      setEnabled(next, ctx);
    },
  });

  pi.registerToolRenderer((toolName, next): ToolRenderers => {
    if (INTERNAL_TOOLS.has(toolName)) {
      return {
        renderShell: "self",
        renderCall: () => EMPTY_COMPONENT,
        renderResult: () => EMPTY_COMPONENT,
      };
    }
    const base = next();
    return {
      renderShell: "self",
      renderCall(args: any, theme: Theme, context: ToolRenderContext) {
        toolInvalidators.set(context.toolCallId, context.invalidate);
        if (enabled && !context.expanded) {
          context.state.cleanViewBox = undefined;
          return EMPTY_COMPONENT;
        }
        const callComp = base?.renderCall
          ? base.renderCall(args, theme, context)
          : new Text(
              theme.fg("toolTitle", theme.bold(toolName)) +
                (args && Object.keys(args).length > 0 ? `\n${JSON.stringify(args, null, 2)}` : ""),
              0,
              0,
            );
        if (base?.renderShell === "self") {
          context.state.cleanViewBox = undefined;
          return callComp;
        }
        const bgFn = context.isPartial
          ? (t: string) => theme.bg("toolPendingBg", t)
          : context.isError
            ? (t: string) => theme.bg("toolErrorBg", t)
            : (t: string) => theme.bg("toolSuccessBg", t);
        const box = new Box(context.outputPad, 1, bgFn);
        box.addChild(callComp);
        context.state.cleanViewBox = box;
        return box;
      },
      renderResult(result: any, opts: any, theme: Theme, context: ToolRenderContext) {
        toolInvalidators.set(context.toolCallId, context.invalidate);
        if (enabled && !context.expanded) {
          return EMPTY_COMPONENT;
        }
        const resultComp = base?.renderResult
          ? base.renderResult(result, opts, theme, context)
          : (() => {
              const out = extractText(result?.content);
              return out ? new Text(theme.fg("toolOutput", out), 0, 0) : EMPTY_COMPONENT;
            })();
        if (base?.renderShell === "self") {
          return resultComp;
        }
        const box = context.state.cleanViewBox as Box | undefined;
        if (box) {
          box.addChild(resultComp);
          return EMPTY_COMPONENT;
        }
        return resultComp;
      },
    };
  });

  pi.on("session_start", (_event, ctx) => {
    inputThinking = false;
    enabled = loadEnabled(settingsPath);
    toolInvalidators.clear();
    syncActiveTools();
    mountWidget(ctx);
    runningSubagents.clear();
    if (isRunning(checklist)) {
      startTicker();
    }
  });

  pi.on("session_shutdown", () => {
    stopAllTimers();
    toolInvalidators.clear();
    activeTui = undefined;
    activeCtx = undefined;
  });

  pi.on("input", (event, ctx) => {
    const text = event.text.trim();
    if (
      !enabled ||
      !ctx.hasUI ||
      ctx.mode !== "tui" ||
      event.source === "extension" ||
      event.streamingBehavior === undefined ||
      (text === "" && (event.images?.length ?? 0) === 0) ||
      text.startsWith("/")
    ) {
      return { action: "continue" };
    }
    setInputThinking(true);
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    activeCtx = ctx;
    syncActiveTools();
    if (enabled && event.systemPromptOptions?.sections) {
      event.systemPromptOptions.sections.clean_view = SECTION;
    }
    if (event.messageType === "user" && event.prompt.trim() !== "") {
      quietCalls = 0;
      // A plan left part way (Esc, a pause, a question, subagents) carries on: a typed prompt is usually a re-steer.
      if (PAUSED_PHASES.has(checklist.phase) && hasPlan(checklist)) {
        resumeJob();
      } else {
        startJob(event.prompt);
      }
    } else if (event.messageType === "custom") {
      subagentReported(event.message);
      // A report revives a live or paused plan, but never one the person stopped with Esc.
      if (checklist.phase !== "idle" && checklist.phase !== "done" && checklist.phase !== "stopped") resumeJob();
    }
    return undefined;
  });

  // A subagent's report can land while Pi is busy or idle; either way it is no longer running.
  pi.on("message_end", (event) => {
    if (event.message.role === "custom") subagentReported(event.message);
    return undefined;
  });

  // Thinking and reply text are hidden or slow to appear, so name them in the header while they stream.
  pi.on("message_update", (event) => {
    const type = event.assistantMessageEvent.type;
    const summary = type === "thinking_start" ? "Thinking" : type === "text_start" ? "Writing the reply" : undefined;
    if (summary && isRunning(checklist)) edit((list) => ({ ...list, activity: activity(summary, true) }));
    return undefined;
  });

  pi.on("ui_prompt_start", (event) => {
    if (isOwnDialogPending && event.kind === "custom") {
      isOwnDialogPending = false;
      isOwnDialogOpen = true;
      return;
    }
    setInputThinking(false);
    edit((list) => isRunning(list) ? { ...list, activity: activity("Waiting for your answer", false) } : list);
    needsYou(event.kind === "confirm" ? NEEDS_OK : HAS_QUESTION);
  });

  pi.on("ui_prompt_end", (event) => {
    if (isOwnDialogOpen && event.kind === "custom") {
      isOwnDialogOpen = false;
      return;
    }
    backToWork();
  });

  pi.on("tool_call", (event) => {
    const tool = event.toolName;
    const code =
      tool === "codemode" &&
      event.parentToolCallId === undefined &&
      typeof (event.input as { code?: unknown })?.code === "string"
        ? String((event.input as { code: string }).code)
        : "";
    const isCodemodeWithPlan = code.includes(PLAN_TOOL);
    const isCodemodeWithUpdater = isCodemodeWithPlan || code.includes(PROGRESS_TOOL);

    if (enabled && isRunning(checklist) && !hasPlan(checklist) && !ALWAYS_ALLOWED.has(tool) && !isCodemodeWithPlan) {
      return {
        block: true,
        reason: `Clean View: call ${PLAN_TOOL} first to lay out the steps of this job, then try again.`,
      };
    }

    // Work the checklist doesn't show: after QUIET_CALLS calls with no plan or progress update, send one back.
    if (PLAN_UPDATERS.has(tool) || isCodemodeWithUpdater) {
      quietCalls = 0;
    } else if (
      enabled &&
      isRunning(checklist) &&
      hasPlan(checklist) &&
      event.parentToolCallId === undefined &&
      !ALWAYS_ALLOWED.has(tool) &&
      ++quietCalls > QUIET_CALLS
    ) {
      quietCalls = 0;
      return {
        block: true,
        reason: `Clean View: the checklist hasn't changed in ${QUIET_CALLS} tool calls. If the work has grown past these steps, call ${PLAN_TOOL} with the full updated list; otherwise call ${PROGRESS_TOOL} for the current step. Then try again.`,
      };
    }

    const input = event.input as Record<string, unknown>;
    if (tool === PLAN_TOOL && Array.isArray(input?.steps)) {
      const names = input.steps.filter((s): s is string => typeof s === "string");
      const title = typeof input.title === "string" ? input.title : undefined;
      ensureJob();
      edit((list) => ({ ...planSteps(list, names, title), activity: activity("Plan updated", false) }));
      appliedToolCallIds.add(event.toolCallId);
      setInputThinking(false);
    } else if (tool === PROGRESS_TOOL && typeof input?.task === "string") {
      const percent = typeof input.percent === "number" ? input.percent : Number(input.percent);
      ensureJob();
      edit((list) => ({ ...reportProgress(list, input.task as string, percent), activity: activity("Progress reported", false) }));
      appliedToolCallIds.add(event.toolCallId);
      setInputThinking(false);
    }
    if (tool === "codemode" && event.parentToolCallId === undefined) {
      codemodeCallIds.add(event.toolCallId);
    }
    const isTrackedCall = event.parentToolCallId === undefined || codemodeCallIds.has(event.parentToolCallId);
    if (!ALWAYS_ALLOWED.has(tool) && !PLAN_UPDATERS.has(tool) && !isCodemodeWithPlan) {
      setInputThinking(false);
    }
    if (!INTERNAL_TOOLS.has(tool) && isTrackedCall) {
      edit((current) => ({ ...current, activity: activity(toolActivity(tool), true) }));
    }
    if (!INTERNAL_TOOLS.has(tool) && !ALWAYS_ALLOWED.has(tool) && isTrackedCall) {
      recordTaskLog("call", `→ ${tool} ${JSON.stringify(event.input ?? {})}`);
    }
    backToWork();
    if ((tool === "TodoWrite" || tool === "todo") && Array.isArray(input?.todos)) {
      ensureJob();
      edit((current) => fromTodos(current, input.todos as TodoItem[]));
      setInputThinking(false);
    }
    if (tool === "TaskUpdate" && typeof input?.taskId === "string") {
      edit((current) =>
        updateTask(
          current,
          input.taskId as string,
          input.status as "pending" | "in_progress" | "completed" | "deleted" | undefined,
          typeof input.subject === "string" ? input.subject : undefined,
        ),
      );
      setInputThinking(false);
    }
    if (tool === "AskUserQuestion") {
      setInputThinking(false);
      needsYou(HAS_QUESTION);
    }
    if (tool === "get_subagent_result") {
      waitingOnSubagents++;
      edit((current) => ({ ...current, activityHint: SUBAGENT_WAIT_HINT }));
    }
    return undefined;
  });

  function countRead(): string {
    const stepId = checklist.tasks.find((one) => one.status === "active")?.id ?? null;
    if (stepId !== readsStepId) {
      readsStepId = stepId;
      readsInStep = 0;
    }
    readsInStep++;
    return `Read ${readsInStep} file${readsInStep === 1 ? "" : "s"} in this step`;
  }

  pi.on("tool_result", (event) => {
    codemodeCallIds.delete(event.toolCallId);
    appliedToolCallIds.delete(event.toolCallId);
    const isTrackedCall = event.parentToolCallId === undefined || codemodeCallIds.has(event.parentToolCallId);
    const input = event.input as Record<string, unknown>;
    if (event.toolName === "get_subagent_result") {
      waitingOnSubagents = Math.max(0, waitingOnSubagents - 1);
      if (waitingOnSubagents === 0) {
        edit((current) => ({ ...current, activityHint: null }));
      }
    }
    if ((event.toolName === "get_subagent_result" || event.toolName === "stop_subagent") && !event.isError && typeof input?.id === "string") {
      runningSubagents.delete(input.id);
    }
    backToWork();
    if (!INTERNAL_TOOLS.has(event.toolName) && isTrackedCall) {
      const summary = event.isError
        ? "A tool call failed"
        : event.toolName.toLowerCase() === "read"
          ? countRead()
          : toolActivity(event.toolName, true);
      edit((current) => ({ ...current, activity: activity(summary, false) }));
    }
    if (!INTERNAL_TOOLS.has(event.toolName) && !ALWAYS_ALLOWED.has(event.toolName) && isTrackedCall) {
      const out = extractText(event.content);
      recordTaskLog(event.isError ? "error" : "result", event.isError ? `← error: ${out}` : `← ${out}`);
    }
    if (SPAWN_TOOLS.has(event.toolName) && !event.isError) {
      const spawned = event.details as { id?: unknown; status?: unknown } | undefined;
      if (typeof spawned?.id === "string" && spawned.id !== "" && !SUBAGENT_DONE.has(String(spawned.status))) {
        runningSubagents.add(spawned.id);
      }
    }
    if (event.toolName === "TaskCreate" && !event.isError) {
      const details = event.details as { task?: { id?: string; subject?: string } } | undefined;
      const id = details?.task?.id;
      const subject = details?.task?.subject ?? (typeof input?.subject === "string" ? input.subject : undefined);
      if (id && subject) {
        ensureJob();
        edit((current) => ({ ...addTask(current, id, subject), activity: activity("Task list updated", false) }));
        setInputThinking(false);
      }
    }

    if (event.isError) {
      const errText = extractText(event.content);
      if (isUserRejection(errText)) {
        failures = 0;
        stuck(SAID_NO);
      } else if (++failures >= FAILURES_TO_STUCK) {
        stuck(KEEPS_FAILING);
      }
    } else {
      failures = 0;
      unstuck();
    }
    return undefined;
  });

  pi.on("agent_end", (event) => {
    const lastAssistant = [...(event.messages ?? [])]
      .reverse()
      .find((m: any) => m?.role === "assistant") as
      | { stopReason?: string; errorMessage?: string; content?: unknown }
      | undefined;
    lastAssistantText = lastAssistant ? extractText(lastAssistant.content) : "";
    if (lastAssistant?.stopReason === "error") {
      const msg = lastAssistant.errorMessage ?? lastAssistantText;
      finish((list) => ({
        ...list,
        phase: "stuck",
        stuckReason: errorSentence(msg),
        needsYouReason: null,
        activityHint: null,
      }));
    }
  });

  pi.on("agent_settled", (event) => {
    clearCollapseTimer();
    waitingOnSubagents = 0;
    if (event.aborted) {
      finish((list) => ({ ...list, phase: "stopped", needsYouReason: null, activityHint: null }));
      return;
    }
    finish((list) => {
      if (list.phase === "stuck") return { ...list, activityHint: null };
      // Steps left over need the person only when the turn ended on a question;
      // with subagents still running, Pi carries on when they report back.
      if (list.tasks.some((one) => one.status !== "done")) {
        if (endsWithQuestion(lastAssistantText)) {
          return { ...list, phase: "needsYou", needsYouReason: ASKED, activityHint: null };
        }
        if (runningSubagents.size > 0) {
          return { ...list, phase: "waiting", needsYouReason: null, activityHint: null, waitingOn: runningSubagents.size };
        }
        if (hasPlan(list) && !list.tasks.some((one) => one.status === "upcoming")) {
          return {
            ...list,
            phase: "done",
            tasks: list.tasks.map((one) => ({ ...one, status: "done", percent: 100 })),
            needsYouReason: null,
            activityHint: null,
          };
        }
        return { ...list, phase: "ended", needsYouReason: null, activityHint: null };
      }
      return { ...list, phase: "done", needsYouReason: null, activityHint: null };
    });
    if (checklist.phase === "done" || checklist.phase === "ended") {
      const startedAt = checklist.startedAt;
      const phase = checklist.phase;
      collapseTimer = setTimeout(() => {
        collapseTimer = undefined;
        if (checklist.startedAt === startedAt && checklist.phase === phase) {
          edit((list) => ({ ...list, isCollapsed: true }));
        }
      }, collapseMs);
      collapseTimer.unref?.();
    }
  });
}

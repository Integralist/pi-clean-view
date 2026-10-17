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
  clampPercent,
  EMPTY,
  errorSentence,
  fallbackTitle,
  fromTodos,
  hasPlan,
  isRunning,
  isUserRejection,
  newJob,
  pausedNeedsYouReason,
  PLACEHOLDER_TITLE,
  planSteps,
  reportProgress,
  updateTask,
} from "../src/logic.ts";
import type { CleanViewChecklist, TodoItem } from "../src/types.ts";
import { CleanViewWidget } from "../src/widget.ts";

export interface CleanViewOptions {
  directory?: string;
  frameMs?: number;
  collapseMs?: number;
  now?: () => number;
}

const COMMAND = "simple";
const WIDGET_KEY = "clean-view";
const SETTINGS_FILE = "pi-clean-view.json";
const PLAN_TOOL = "plan_steps";
const PROGRESS_TOOL = "report_progress";
const DEFAULT_FRAME_MS = 250;
const DEFAULT_COLLAPSE_MS = 5000;
const FAILURES_TO_STUCK = 3;

const NEEDS_OK = "Pi needs your OK to continue";
const HAS_QUESTION = "Pi has a question for you";
const SAID_NO = "you said no to a step, so Pi paused";
const KEEPS_FAILING = "a step keeps failing, Pi is trying another way";
const SUBAGENT_WAIT_HINT = "waiting on subagents";
const INTERNAL_TOOLS = new Set([PLAN_TOOL, PROGRESS_TOOL]);

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

- For every request, even a quick question, call \`${PLAN_TOOL}\` first with a short job title and every step of the job (2 to 8 short names in order). If you use \`codemode\`, call \`await tools.${PLAN_TOOL}({ ... })\` before calling any other tool.
- Call \`${PROGRESS_TOOL}\` as real progress happens, and with percent 100 the moment a step finishes.
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
  let waitingOnSubagents = 0;
  let lastAssistantText = "";
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

  function startJob(promptText: string): void {
    clearCollapseTimer();
    failures = 0;
    waitingOnSubagents = 0;
    lastAssistantText = "";
    const startedAt = now();
    const title = promptText.trim() !== "" ? fallbackTitle(promptText) : PLACEHOLDER_TITLE;
    edit(() => newJob(startedAt, title));
    startTicker();
  }

  function resumeJob(): void {
    clearCollapseTimer();
    failures = 0;
    lastAssistantText = "";
    edit((list) => ({
      ...list,
      phase: "working",
      needsYouReason: null,
      stuckReason: null,
      activityHint: waitingOnSubagents > 0 ? SUBAGENT_WAIT_HINT : null,
      finishedAt: null,
    }));
    startTicker();
  }

  function ensureJob(): void {
    if (!isRunning(checklist)) {
      startJob("");
    }
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
    const finishedAt = now();
    stopTicker();
    edit((list) => (list.phase === "idle" ? list : fn({ ...list, finishedAt })));
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
          getFrame: () => tick,
          now,
          onToggleEnabled: () => setEnabled(!enabled, ctx),
          onToggleCollapsed: () => {
            edit((list) => ({ ...list, isCollapsed: !list.isCollapsed }));
          },
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
        "2 to 8 short plain-English step names in order, each under 40 characters and starting with a verb.",
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
      "Lay out every step of the job up front so the person sees the plan: 2 to 8 short plain-English step names in order, each under 40 characters and starting with a verb. The first step starts right away.",
    promptSnippet: "Lay out the plain-English checklist steps for the current job",
    parameters: PlanStepsParams,
    async execute(_toolCallId, params) {
      const names = Array.isArray(params.steps)
        ? params.steps.filter((s): s is string => typeof s === "string")
        : [];
      const title = typeof params.title === "string" ? params.title : undefined;
      ensureJob();
      edit((list) => planSteps(list, names, title));
      return {
        content: [{ type: "text", text: `Planned ${checklist.tasks.length} steps. The first one has started.` }],
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
    async execute(_toolCallId, params) {
      const name = typeof params.task === "string" ? params.task : "";
      const percent = typeof params.percent === "number" ? params.percent : Number(params.percent);
      ensureJob();
      edit((list) => reportProgress(list, name, percent));
      return {
        content: [{ type: "text", text: `Progress noted: ${clampPercent(percent)}%.` }],
        details: { task: name, percent: clampPercent(percent) },
      };
    },
  });

  pi.registerCommand(COMMAND, {
    description: "Clean View: hide tool details and show a plain checklist (on, off, or flip)",
    getArgumentCompletions: (prefix) =>
      ["on", "off"]
        .filter((item) => item.startsWith(prefix.toLowerCase()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
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
    enabled = loadEnabled(settingsPath);
    toolInvalidators.clear();
    syncActiveTools();
    mountWidget(ctx);
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

  pi.on("before_agent_start", (event, ctx) => {
    activeCtx = ctx;
    syncActiveTools();
    if (enabled && event.systemPromptOptions?.sections) {
      event.systemPromptOptions.sections.clean_view = SECTION;
    }
    if (event.messageType === "user" && event.prompt.trim() !== "") {
      if (checklist.phase === "needsYou" && hasPlan(checklist)) {
        resumeJob();
      } else {
        startJob(event.prompt);
      }
    } else if (event.messageType === "custom" && checklist.phase !== "idle" && checklist.phase !== "done") {
      resumeJob();
    }
    return undefined;
  });

  pi.on("ui_prompt_start", (event) => {
    needsYou(event.kind === "confirm" ? NEEDS_OK : HAS_QUESTION);
  });

  pi.on("ui_prompt_end", () => {
    backToWork();
  });

  pi.on("tool_call", (event) => {
    const tool = event.toolName;
    const isCodemodeWithPlan =
      tool === "codemode" &&
      event.parentToolCallId === undefined &&
      typeof (event.input as { code?: unknown })?.code === "string" &&
      String((event.input as { code: string }).code).includes(PLAN_TOOL);

    if (enabled && isRunning(checklist) && !hasPlan(checklist) && !ALWAYS_ALLOWED.has(tool) && !isCodemodeWithPlan) {
      return {
        block: true,
        reason: `Clean View: call ${PLAN_TOOL} first to lay out the steps of this job, then try again.`,
      };
    }

    backToWork();
    const input = event.input as Record<string, unknown>;
    if ((tool === "TodoWrite" || tool === "todo") && Array.isArray(input?.todos)) {
      ensureJob();
      edit((current) => fromTodos(current, input.todos as TodoItem[]));
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
    }
    if (tool === "AskUserQuestion") {
      needsYou(HAS_QUESTION);
    }
    if (tool === "get_subagent_result") {
      waitingOnSubagents++;
      edit((current) => ({ ...current, activityHint: SUBAGENT_WAIT_HINT }));
    }
    return undefined;
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "get_subagent_result") {
      waitingOnSubagents = Math.max(0, waitingOnSubagents - 1);
      if (waitingOnSubagents === 0) {
        edit((current) => ({ ...current, activityHint: null }));
      }
    }
    backToWork();
    const input = event.input as Record<string, unknown>;
    if (event.toolName === "TaskCreate" && !event.isError) {
      const details = event.details as { task?: { id?: string; subject?: string } } | undefined;
      const id = details?.task?.id;
      const subject = details?.task?.subject ?? (typeof input?.subject === "string" ? input.subject : undefined);
      if (id && subject) {
        ensureJob();
        edit((current) => addTask(current, id, subject));
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
      if (list.tasks.some((one) => one.status !== "done")) {
        return {
          ...list,
          phase: "needsYou",
          needsYouReason: pausedNeedsYouReason(list, lastAssistantText),
          activityHint: null,
        };
      }
      return { ...list, phase: "done", needsYouReason: null, activityHint: null };
    });
    if (checklist.phase === "done") {
      const startedAt = checklist.startedAt;
      collapseTimer = setTimeout(() => {
        collapseTimer = undefined;
        if (checklist.startedAt === startedAt && checklist.phase === "done") {
          edit((list) => ({ ...list, isCollapsed: true }));
        }
      }, collapseMs);
      collapseTimer.unref?.();
    }
  });
}

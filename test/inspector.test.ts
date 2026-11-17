import { describe, expect, test } from "vitest";
import { CLOSE, STOP, TaskDetailsDialog, type TaskDetails } from "../src/inspector.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;
const keybindings = { matches: (data: string, id: string) => data === id } as any;

function details(overrides: Partial<TaskDetails> = {}): TaskDetails {
  return {
    task: { id: "t1", name: "Inspect the files", status: "active", percent: 45, hasReported: true },
    isPaused: false,
    status: "45%",
    progress: "45% reported",
    elapsed: "12s",
    activity: "Progress reported · 0s ago",
    canStop: true,
    ...overrides,
  };
}

function open(d: TaskDetails | TaskDetails[], start = 0) {
  const choices: Array<string | undefined> = [];
  const pages = Array.isArray(d) ? d : [d];
  const dialog = new TaskDetailsDialog({ requestRender() {} } as any, theme, keybindings, () => pages, start, (choice) => choices.push(choice));
  return { dialog, choices };
}

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

describe("TaskDetailsDialog", () => {
  test("Esc closes without choosing an option", () => {
    const { dialog, choices } = open(details());
    dialog.handleInput("tui.select.cancel");
    expect(choices).toEqual([undefined]);
  });

  test("Ctrl+Space closes without choosing an option", () => {
    const { dialog, choices } = open(details());
    dialog.handleInput("\x00");
    expect(choices).toEqual([undefined]);
  });

  test("moving past the last option stays on it", () => {
    const { dialog, choices } = open(details());
    dialog.handleInput("tui.select.down");
    dialog.handleInput("tui.select.down");
    dialog.handleInput("tui.select.confirm");
    expect(choices).toEqual([STOP]);
  });

  test("left and right switch tasks and stop at either end", () => {
    const second = details({
      task: { id: "t2", name: "Run the checks", status: "upcoming", percent: 0, hasReported: false },
      status: "Next",
    });
    const { dialog } = open([details(), second]);
    expect(dialog.render(80).join("\n")).toContain("Inspect the files");
    expect(dialog.render(80).join("\n")).toContain("1/2");
    dialog.handleInput(RIGHT);
    dialog.handleInput(RIGHT);
    expect(dialog.render(80).join("\n")).toContain("Run the checks");
    expect(dialog.render(80).join("\n")).toContain("2/2");
    dialog.handleInput(LEFT);
    dialog.handleInput(LEFT);
    expect(dialog.render(80).join("\n")).toContain("Inspect the files");
  });

  test("a finished run offers only Close", () => {
    const { dialog, choices } = open(details({ canStop: false }));
    expect(dialog.render(80).join("\n")).not.toContain(STOP);
    dialog.handleInput("tui.select.down");
    dialog.handleInput("tui.select.confirm");
    expect(choices).toEqual([CLOSE]);
  });

  test("renders step log on the right side newest-first and scrolls via wheel and page keys", () => {
    const logs = Array.from({ length: 15 }, (_, i) => ({
      kind: (i % 2 === 0 ? "call" : "result") as "call" | "result",
      key: `k${i}`,
      text: i % 2 === 0 ? `→ read {"path":"file-${i}.ts"}` : `← contents-${i}`,
    }));
    const second = details({
      task: { id: "t2", name: "Run the checks", status: "upcoming", percent: 0, hasReported: false },
      status: "Next",
      logs: [],
    });
    const { dialog } = open([details({ logs }), second]);
    const rendered = dialog.render(120).join("\n");
    expect(rendered).toContain("Step log");
    expect(rendered).toContain("newest first");
    expect(rendered).toContain("← contents-13");
    expect(rendered).toContain("→ read {\"path\":\"file-14.ts\"}");
    expect(rendered.indexOf("file-14.ts")).toBeLessThan(rendered.indexOf("contents-13"));
    expect(rendered).not.toContain("file-0.ts");

    dialog.handleMouse?.({
      type: "wheel",
      button: "none",
      x: 80,
      y: 4,
      screenX: 80,
      screenY: 4,
      width: 120,
      height: 15,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: 10,
    });
    const scrolled = dialog.render(120).join("\n");
    expect(scrolled).toContain("→ read {\"path\":\"file-0.ts\"}");

    dialog.handleInput(RIGHT);
    expect(dialog.render(120).join("\n")).toContain("Nothing recorded for this step yet");
  });

  test("wraps thinking lines in the step log without wrapping other log kinds", () => {
    const longThinking =
      "💭 **Checking the step log layout** so long thinking lines wrap cleanly across rows in the box";
    const longCall = `→ bash {"command":"${"echo hello ".repeat(10)}"}`;
    const { dialog } = open(
      details({
        logs: [
          { kind: "thinking", key: "th1", text: longThinking },
          { kind: "call", key: "c1", text: longCall },
        ],
      }),
    );

    const rendered = dialog.render(100).join("\n");
    expect(rendered).toContain("💭 **Checking the step log layout** so long");
    expect(rendered).toContain("thinking lines wrap cleanly across rows in the");
    expect(rendered).toContain("│ box");
    expect(rendered).toContain("→ bash {\"command\":\"echo hello ");
    expect(rendered).toContain("…");
  });

  test("toggles thinking-only filter in step log via 't' key and header button click", () => {
    const logs = [
      { kind: "thinking" as const, key: "th1", text: "💭 **Planning the approach**" },
      { kind: "call" as const, key: "c1", text: "→ read {\"path\":\"src/inspector.ts\"}" },
      { kind: "result" as const, key: "r1", text: "← file contents" },
    ];
    const { dialog } = open(details({ logs }));

    const initialLines = dialog.render(120);
    const initial = initialLines.join("\n");
    expect(initial).toContain("Planning the approach");
    expect(initial).toContain("src/inspector.ts");
    expect(initial).toContain("[○ Thinking (t)]");

    dialog.handleInput("t");
    const filtered = dialog.render(120).join("\n");
    expect(filtered).toContain("Planning the approach");
    expect(filtered).not.toContain("src/inspector.ts");
    expect(filtered).not.toContain("file contents");
    expect(filtered).toContain("[● Thinking (t)]");

    const headerRow = initialLines.findIndex((line) => line.includes("[○ Thinking (t)]"));
    const buttonX = initialLines[headerRow]!.indexOf("[○ Thinking (t)]") + 2;
    dialog.handleMouse?.({
      type: "click",
      button: "left",
      x: buttonX,
      y: headerRow,
      screenX: buttonX,
      screenY: headerRow,
      width: 120,
      height: 15,
      shift: false,
      alt: false,
      ctrl: false,
    });
    const unfiltered = dialog.render(120).join("\n");
    expect(unfiltered).toContain("src/inspector.ts");
    expect(unfiltered).toContain("[○ Thinking (t)]");
  });

  test("toggles wrapping for all log lines via 'w' key and header button click", () => {
    const logs = [
      { kind: "call" as const, key: "c1", text: `→ bash {"command":"${"echo hello ".repeat(10)}end-of-cmd"}` },
      { kind: "result" as const, key: "r1", text: "← line one\nline two with full output" },
      { kind: "error" as const, key: "e1", text: `← error: ${"bad failure ".repeat(8)}tail` },
    ];
    const { dialog } = open(details({ logs }));

    const initialLines = dialog.render(100);
    const initial = initialLines.join("\n");
    expect(initial).toContain("[○ Wrap (w)]");
    expect(initial).not.toContain("end-of-cmd");
    expect(initial).toContain("← line one line two");

    dialog.handleInput("w");
    const wrapped = dialog.render(100).join("\n");
    expect(wrapped).toContain("[● Wrap (w)]");
    expect(wrapped).toContain("end-of-cmd");
    expect(wrapped).toContain("line two with full output");
    expect(wrapped).toContain("tail");

    const headerRow = initialLines.findIndex((line) => line.includes("[○ Wrap (w)]"));
    const buttonX = initialLines[headerRow]!.indexOf("[○ Wrap (w)]") + 2;
    dialog.handleMouse?.({
      type: "click",
      button: "left",
      x: buttonX,
      y: headerRow,
      screenX: buttonX,
      screenY: headerRow,
      width: 100,
      height: 15,
      shift: false,
      alt: false,
      ctrl: false,
    });
    const unwrapped = dialog.render(100).join("\n");
    expect(unwrapped).toContain("[○ Wrap (w)]");
    expect(unwrapped).not.toContain("end-of-cmd");
  });

  test("toggles inputs filter in step log via 'i' key and header button click, keeping thinking and calls while hiding output and errors", () => {
    const logs = [
      { kind: "thinking" as const, key: "th1", text: "💭 **Planning the approach**" },
      { kind: "call" as const, key: "c1", text: "→ read {\"path\":\"src/inspector.ts\"}" },
      { kind: "result" as const, key: "r1", text: "← file contents" },
      { kind: "error" as const, key: "e1", text: "← error: failed to run" },
    ];
    const { dialog } = open(details({ logs }));

    const initialLines = dialog.render(120);
    const initial = initialLines.join("\n");
    expect(initial).toContain("Planning the approach");
    expect(initial).toContain("src/inspector.ts");
    expect(initial).toContain("file contents");
    expect(initial).toContain("error: failed to run");
    expect(initial).toContain("[○ Inputs (i)]");

    dialog.handleInput("i");
    const filtered = dialog.render(120).join("\n");
    expect(filtered).toContain("Planning the approach");
    expect(filtered).toContain("src/inspector.ts");
    expect(filtered).not.toContain("file contents");
    expect(filtered).not.toContain("error: failed to run");
    expect(filtered).toContain("[● Inputs (i)]");

    const headerRow = initialLines.findIndex((line) => line.includes("[○ Inputs (i)]"));
    const buttonX = initialLines[headerRow]!.indexOf("[○ Inputs (i)]") + 2;
    dialog.handleMouse?.({
      type: "click",
      button: "left",
      x: buttonX,
      y: headerRow,
      screenX: buttonX,
      screenY: headerRow,
      width: 120,
      height: 15,
      shift: false,
      alt: false,
      ctrl: false,
    });
    const unfiltered = dialog.render(120).join("\n");
    expect(unfiltered).toContain("file contents");
    expect(unfiltered).toContain("error: failed to run");
    expect(unfiltered).toContain("[○ Inputs (i)]");
  });

  test("wraps command input lines when 'w' and 'i' are combined, hiding lengthy command output", () => {
    const logs = [
      { kind: "call" as const, key: "c1", text: `→ bash {"command":"${"echo hello ".repeat(10)}end-of-cmd"}` },
      { kind: "result" as const, key: "r1", text: "← line one\nline two with lengthy full output" },
    ];
    const { dialog } = open(details({ logs }));

    dialog.handleInput("i");
    const filtered = dialog.render(100).join("\n");
    expect(filtered).not.toContain("end-of-cmd");
    expect(filtered).not.toContain("line two with lengthy full output");

    dialog.handleInput("w");
    const wrapped = dialog.render(100).join("\n");
    expect(wrapped).toContain("[● Inputs (i)]");
    expect(wrapped).toContain("[● Wrap (w)]");
    expect(wrapped).toContain("end-of-cmd");
    expect(wrapped).not.toContain("line two with lengthy full output");
  });
});

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
});

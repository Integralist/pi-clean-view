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
});

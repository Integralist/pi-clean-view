import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { meter } from "./logic.ts";
import type { CleanViewTask } from "./types.ts";

export const CLOSE = "Close";
export const STOP = "Stop entire run";

export interface TaskDetails {
  task: CleanViewTask;
  isPaused: boolean;
  status: string;
  progress: string;
  elapsed: string;
  activity: string;
  canStop: boolean;
}

function toneOf(task: CleanViewTask, isPaused: boolean): "success" | "accent" | "warning" | "muted" {
  if (task.status === "done") return "success";
  if (task.status === "active") return isPaused ? "warning" : "accent";
  return "muted";
}

/**
 * Task details as a themed dialog, one page per task; resolves with the chosen option, or undefined on cancel.
 * `pages` is read on every render, so a redraw shows the run as it is now.
 */
export class TaskDetailsDialog implements Component {
  private selected = 0;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private keys: KeybindingsManager,
    private pages: () => TaskDetails[],
    private page: number,
    private done: (choice: string | undefined) => void,
  ) {}

  private get details(): TaskDetails {
    const pages = this.pages();
    this.page = Math.min(this.page, pages.length - 1);
    return pages[this.page]!;
  }

  private get options(): string[] {
    return this.details.canStop ? [CLOSE, STOP] : [CLOSE];
  }

  render(width: number): string[] {
    const t = this.theme;
    const d = this.details;
    const tone = toneOf(d.task, d.isPaused);
    const position = t.fg("dim", `  ${this.page + 1}/${this.pages().length}`);
    const field = (name: string, value: string) => `  ${t.fg("muted", name.padEnd(8))}  ${value}`;
    const option = (name: string, i: number) => {
      const text = name === STOP ? t.fg("error", name) : name;
      return i === this.selected ? `${t.fg("accent", "→")} ${t.bold(text)}` : `  ${text}`;
    };
    const rule = t.fg("borderAccent", "─".repeat(width));
    return [
      rule,
      `${t.fg(tone, "●")} ${t.bold(d.task.name)}${position}`,
      "",
      field("Status", t.fg(tone, d.status)),
      field("Progress", `${t.fg(tone, meter(d.task, 0))}  ${d.progress}`),
      field("Elapsed", d.elapsed),
      field("Activity", d.activity),
      "",
      ...this.options.map(option),
      "",
      t.fg("dim", "  Stop ends the entire run; it will not skip ahead to another task."),
      t.fg("dim", "  ←→ switch task · ↑↓ choose · Enter confirm · Esc close"),
      rule,
    ].map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.confirm")) return this.done(this.options[this.selected]);
    if (this.keys.matches(data, "tui.select.cancel")) return this.done(undefined);
    if (this.keys.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
    else if (this.keys.matches(data, "tui.select.down")) this.selected = Math.min(this.options.length - 1, this.selected + 1);
    else if (matchesKey(data, "left")) this.page = Math.max(0, this.page - 1);
    else if (matchesKey(data, "right")) this.page = Math.min(this.pages().length - 1, this.page + 1);
    else return;
    this.tui.requestRender();
  }

  invalidate(): void {}
}

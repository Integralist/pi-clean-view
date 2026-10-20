import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type KeybindingsManager,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fit, meter } from "./logic.ts";
import type { CleanViewLogEntry, CleanViewTask } from "./types.ts";

export const CLOSE = "Close";
export const STOP = "Stop entire run";
const SIDE_BY_SIDE_MIN_WIDTH = 90;
const LEFT_COL_WIDTH = 56;
const COL_GAP = 2;

export interface TaskDetails {
  task: CleanViewTask;
  isPaused: boolean;
  status: string;
  progress: string;
  elapsed: string;
  activity: string;
  canStop: boolean;
  logs?: readonly CleanViewLogEntry[];
}

function toneOf(task: CleanViewTask, isPaused: boolean): "success" | "accent" | "warning" | "muted" {
  if (task.status === "done") return "success";
  if (task.status === "active") return isPaused ? "warning" : "accent";
  return "muted";
}

function padRightVisible(line: string, width: number): string {
  const truncated = truncateToWidth(line, width);
  const pad = Math.max(0, width - visibleWidth(truncated));
  return truncated + " ".repeat(pad);
}

/**
 * Task details as a themed dialog, one page per task; resolves with the chosen option, or undefined on cancel.
 * `pages` is read on every render, so a redraw shows the run as it is now.
 */
export class TaskDetailsDialog implements Component {
  private selected = 0;
  private logScroll = 0;
  private maxLogScroll = 0;

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

  private renderLogBox(boxWidth: number, innerRows: number, logs: readonly CleanViewLogEntry[]): string[] {
    const t = this.theme;
    const contentWidth = Math.max(8, boxWidth - 4);
    const reversed = [...logs].reverse();
    const lines = reversed.flatMap((entry) =>
      entry.text.split("\n").map((line) => ({
        kind: entry.kind,
        text: fit(line, contentWidth),
      })),
    );
    this.maxLogScroll = Math.max(0, lines.length - innerRows);
    const offset = Math.min(this.logScroll, this.maxLogScroll);
    this.logScroll = offset;
    const visible = lines.slice(offset, offset + innerRows);

    const headerSuffix =
      lines.length > innerRows
        ? t.fg("dim", `  ${offset + 1}-${offset + visible.length} of ${lines.length} (scroll to view)`)
        : "";
    const header = truncateToWidth(`${t.bold("Step log")}${headerSuffix}`, boxWidth);
    const borderH = "─".repeat(Math.max(0, boxWidth - 2));
    const top = t.fg("dim", `╭${borderH}╮`);
    const bottom = t.fg("dim", `╰${borderH}╯`);
    const side = t.fg("dim", "│");

    const bodyRows: string[] = [];
    for (let i = 0; i < innerRows; i++) {
      const row = visible[i];
      if (!row) {
        const emptyText =
          i === 0 && visible.length === 0
            ? t.fg("dim", fit("Nothing recorded for this step yet", contentWidth))
            : " ".repeat(contentWidth);
        bodyRows.push(`${side} ${emptyText} ${side}`);
      } else {
        const styled =
          row.kind === "error"
            ? t.fg("error", row.text)
            : row.kind === "result"
              ? t.fg("dim", row.text)
              : row.text;
        bodyRows.push(`${side} ${styled} ${side}`);
      }
    }

    return [header, top, ...bodyRows, bottom];
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
    const leftLines = [
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
      t.fg("dim", "  ←→ switch task · ↑↓ choose · PgUp/PgDn/wheel log · Enter · Esc"),
    ];

    const logs = d.logs ?? [];
    if (width >= SIDE_BY_SIDE_MIN_WIDTH) {
      const leftWidth = Math.min(LEFT_COL_WIDTH, Math.floor(width * 0.48));
      const rightWidth = width - leftWidth - COL_GAP;
      const innerRows = Math.max(4, leftLines.length - 3);
      const rightLines = this.renderLogBox(rightWidth, innerRows, logs);
      const totalRows = Math.max(leftLines.length, rightLines.length);
      const combined: string[] = [rule];
      for (let i = 0; i < totalRows; i++) {
        const l = padRightVisible(leftLines[i] ?? "", leftWidth);
        const r = truncateToWidth(rightLines[i] ?? "", rightWidth);
        combined.push(`${l}${" ".repeat(COL_GAP)}${r}`);
      }
      combined.push(rule);
      return combined.map((line) => truncateToWidth(line, width));
    }

    const logBox = this.renderLogBox(Math.max(20, width - 2), 6, logs).map((line) => `  ${line}`);
    return [rule, ...leftLines, "", ...logBox, rule].map((line) => truncateToWidth(line, width));
  }

  private scrollLog(delta: number): void {
    this.logScroll = Math.max(0, Math.min(this.maxLogScroll, this.logScroll + delta));
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.confirm")) return this.done(this.options[this.selected]);
    if (this.keys.matches(data, "tui.select.cancel")) return this.done(undefined);
    if (this.keys.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
    else if (this.keys.matches(data, "tui.select.down")) this.selected = Math.min(this.options.length - 1, this.selected + 1);
    else if (matchesKey(data, "pageUp")) return this.scrollLog(-5);
    else if (matchesKey(data, "pageDown")) return this.scrollLog(5);
    else if (matchesKey(data, "left")) {
      this.page = Math.max(0, this.page - 1);
      this.logScroll = 0;
    } else if (matchesKey(data, "right")) {
      this.page = Math.min(this.pages().length - 1, this.page + 1);
      this.logScroll = 0;
    } else return;
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta !== undefined && event.wheelDelta !== 0) {
      this.scrollLog(event.wheelDelta);
      return { handled: true, render: true };
    }
    return undefined;
  }

  invalidate(): void {}
}

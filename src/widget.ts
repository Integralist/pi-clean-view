import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { duration, fit, isRunning, label, meter, METER_CELLS } from "./logic.ts";
import type { CleanViewChecklist, CleanViewTask } from "./types.ts";

const ANSI_GREEN = (text: string) => `\x1b[38;2;72;181;83m${text}\x1b[39m`;
const ANSI_CYAN = (text: string) => `\x1b[38;2;0;166;204m${text}\x1b[39m`;
const ANSI_YELLOW = (text: string) => `\x1b[33m${text}\x1b[39m`;
const ANSI_BOLD = (text: string) => `\x1b[1m${text}\x1b[22m`;
const ANSI_DIM = (text: string) => `\x1b[2m${text}\x1b[22m`;
const ANSI_NEEDS_YOU_BADGE = (text: string) => `\x1b[1;38;2;0;0;0;48;2;245;208;0m${text}\x1b[22;39;49m`;

function styleActiveBar(bar: string): string {
  let out = "";
  for (const ch of bar) {
    if (ch === "█") {
      out += "\x1b[38;2;0;166;204;48;2;28;69;87m█\x1b[39;49m";
    } else {
      out += "\x1b[38;2;28;69;87;48;2;28;69;87m░\x1b[39;49m";
    }
  }
  return out;
}

function styleUpcomingBar(bar: string): string {
  return `\x1b[38;2;64;66;79;48;2;64;66;79m${bar}\x1b[39;49m`;
}

const WAITING = "Pi is waiting for your reply";

export interface CleanViewWidgetState {
  isEnabled(): boolean;
  getChecklist(): CleanViewChecklist;
  getFrame(): number;
  now(): number;
  onToggleEnabled(): void;
  onToggleCollapsed(): void;
}

export class CleanViewWidget implements Component {
  private getTheme: () => Theme;
  private state: CleanViewWidgetState;
  private toggleRange: [number, number] | undefined;
  private collapseRange: [number, number] | undefined;

  constructor(getTheme: () => Theme, state: CleanViewWidgetState) {
    this.getTheme = getTheme;
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    this.toggleRange = undefined;
    this.collapseRange = undefined;
    if (width <= 0) return [];

    const enabled = this.state.isEnabled();
    const list = this.state.getChecklist();
    const togglePlain = enabled ? "[ ● Clean View: ON ]" : "[ ○ Clean View: OFF ]";
    const toggleStyled = enabled ? ANSI_BOLD(togglePlain) : ANSI_DIM(togglePlain);

    if (!enabled || list.phase === "idle") {
      const toggleWidth = visibleWidth(togglePlain);
      if (toggleWidth >= width) {
        this.toggleRange = [0, width];
        return [truncateToWidth(toggleStyled, width)];
      }
      const padLeft = width - toggleWidth;
      this.toggleRange = [padLeft, width];
      return [" ".repeat(padLeft) + toggleStyled];
    }

    const collapsePlain = list.isCollapsed ? "[+]" : "[-]";
    const collapseStyled = ANSI_DIM(collapsePlain);
    const rightPlain = `${togglePlain} ${collapsePlain}`;
    const rightStyled = `${toggleStyled} ${collapseStyled}`;
    const rightWidth = visibleWidth(rightPlain);

    const live = isRunning(list);
    const currentNow = live ? this.state.now() : (list.finishedAt ?? list.startedAt);
    const took = duration(currentNow - list.startedAt);
    const header = this.renderHeader(list, took);

    const maxHeaderWidth = Math.max(0, width - rightWidth - 1);
    const truncatedHeader = truncateToWidth(header, maxHeaderWidth);
    const headerWidth = visibleWidth(truncatedHeader);
    const gap = Math.max(1, width - headerWidth - rightWidth);
    const headerLine = truncateToWidth(`${truncatedHeader}${" ".repeat(gap)}${rightStyled}`, width);

    const rightStart = headerWidth + gap;
    const toggleWidth = visibleWidth(togglePlain);
    this.toggleRange = [rightStart, rightStart + toggleWidth];
    this.collapseRange = [rightStart + toggleWidth + 1, rightStart + rightWidth];

    if (list.isCollapsed) {
      return [headerLine];
    }

    const frame = live ? this.state.getFrame() : 0;
    const nameWidth = Math.max(8, width - (2 + 1 + METER_CELLS + 2 + 7));
    const firstUpcoming = list.tasks.findIndex((one) => one.status === "upcoming");
    const rows = list.tasks.map((one, i) =>
      truncateToWidth(this.renderRow(one, i === firstUpcoming, list.phase === "needsYou", frame, nameWidth), width),
    );
    return [headerLine, ...rows];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left" || event.y !== 0) {
      return undefined;
    }
    if (this.collapseRange && event.x >= this.collapseRange[0] && event.x < this.collapseRange[1]) {
      this.state.onToggleCollapsed();
      return { handled: true };
    }
    if (this.toggleRange && event.x >= this.toggleRange[0] && event.x < this.toggleRange[1]) {
      this.state.onToggleEnabled();
      return { handled: true };
    }
    return undefined;
  }

  private renderHeader(list: CleanViewChecklist, took: string): string {
    void this.getTheme;
    switch (list.phase) {
      case "needsYou":
        return `${ANSI_NEEDS_YOU_BADGE(" Needs you ")} ${list.needsYouReason ?? WAITING}`;
      case "stuck":
        return ANSI_YELLOW(`⚠ Stuck: ${list.stuckReason ?? ""}`);
      case "stopped":
        return `■ Stopped · ${list.title} · you pressed Esc`;
      case "done":
        return `${ANSI_GREEN("✓ All done")} · ${list.title} · took ${took}`;
      default: {
        const hint = list.activityHint ? ` · ${ANSI_DIM(list.activityHint)}` : "";
        return `${ANSI_BOLD(list.title)} · ${took}${hint}`;
      }
    }
  }

  private renderRow(
    one: CleanViewTask,
    isFirstUpcoming: boolean,
    isPaused: boolean,
    frame: number,
    width: number,
  ): string {
    const name = fit(one.name, width);
    const bar = meter(one, frame);
    const tag = label(one, isFirstUpcoming);
    if (one.status === "done") {
      return `${ANSI_GREEN("✓")} ${ANSI_DIM(name)} ${ANSI_GREEN(bar)}  ${ANSI_DIM(tag)}`;
    }
    if (one.status === "active") {
      return `${ANSI_CYAN(isPaused ? "‖" : "▶")} ${ANSI_BOLD(name)} ${styleActiveBar(bar)}  ${tag}`;
    }
    return `${ANSI_DIM(`○ ${name}`)} ${styleUpcomingBar(bar)}  ${ANSI_DIM(tag)}`;
  }
}

export type CleanViewTaskStatus = "done" | "active" | "upcoming";

export type CleanViewActivity = {
  summary: string;
  at: number;
  inProgress: boolean;
};

export type CleanViewTask = {
  id: string;
  name: string;
  status: CleanViewTaskStatus;
  percent: number;
  hasReported: boolean;
  startedAt?: number;
  finishedAt?: number;
};

/** One item of a step's raw log: a thinking block, a tool call as the model wrote it, or a tool's result. */
export type CleanViewLogEntry = {
  kind: "thinking" | "call" | "result" | "error";
  key: string;
  text: string;
};

export type CleanViewPhase = "idle" | "working" | "needsYou" | "stuck" | "stopped" | "waiting" | "ended" | "done";

export type CleanViewChecklist = {
  title: string;
  phase: CleanViewPhase;
  tasks: CleanViewTask[];
  activity: CleanViewActivity | null;
  needsYouReason: string | null;
  stuckReason: string | null;
  activityHint?: string | null;
  startedAt: number;
  finishedAt: number | null;
  isCollapsed: boolean;
  /** Subagents still running when the turn ended (phase `waiting`). */
  waitingOn?: number;
};

export type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
};

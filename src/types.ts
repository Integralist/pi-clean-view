export type CleanViewTaskStatus = "done" | "active" | "upcoming";

export type CleanViewTask = {
  id: string;
  name: string;
  status: CleanViewTaskStatus;
  percent: number;
  hasReported: boolean;
};

export type CleanViewPhase = "idle" | "working" | "needsYou" | "stuck" | "stopped" | "ended" | "done";

export type CleanViewChecklist = {
  title: string;
  phase: CleanViewPhase;
  tasks: CleanViewTask[];
  needsYouReason: string | null;
  stuckReason: string | null;
  activityHint?: string | null;
  startedAt: number;
  finishedAt: number | null;
  isCollapsed: boolean;
};

export type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
};

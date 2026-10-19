# pi-clean-view

Hides tool calls and output while Pi works, showing a concise checklist and
animated 10-cell progress meters above the prompt.

## Features

- **Toggle on or off:** Click `[ ● Clean View: ON ]` above the prompt, or run
  `/simple on`, `/simple off`, or `/simple` (flips the current state). The
  setting is persisted to `~/.pi/agent/pi-clean-view.json` and starts on.
- **Collapse or expand checklist rows:** Click `[-]` / `[+]` next to the toggle
  button on the header row.
- **Hide noisy tool output:** While enabled, collapsed tool calls, diffs, and
  command output are hidden in the transcript. Press `Ctrl+O` at any time to
  expand tool details, or run `/simple off` to reveal all tool boxes.
- **Plan-first gate:** Exposes `plan_steps` and `report_progress` tools and
  blocks other tools until a plan exists (`TodoWrite` / `todo`, `TaskCreate`,
  and `TaskUpdate` also satisfy the plan). In `codemode`, scripts must call
  `await tools.plan_steps(...)` before running other actions.
- **Plan drift check:** After 8 tool calls with no `plan_steps`,
  `report_progress`, or to-do update, the next call is sent back once, asking Pi
  to replan or report progress. Calling `plan_steps` again keeps finished steps
  checked off.
- **Live progress meters:** Renders a 10-cell visual meter per task that
  tracks incremental completion percentages (0–100%).
- **Contextual status headers:** Automatically transitions between `<Title> · <elapsed>`,
  **Needs you** (with human-readable reasons like waiting for confirmation or reply),
  **Stuck** (repeated failures), **Stopped**, and **All done** (auto-collapsing
  to a single summary line after 5 seconds).

> [!NOTE]
> Compatible with both `pi-transcript-enhancer` and `pi-auto-model`. System
> prompt guidance is injected via `systemPromptOptions.sections` without
> mutating the user prompt.

## Install

```bash
pi install git:github.com/Integralist/pi-clean-view
```

## Development

```bash
make deps
make verify
make try
```

`make try` starts Pi with only this checkout's extension loaded. Your other
extensions are off for that session, including any installed copy of Clean
View, which would register the same tools and refuse to load beside it.

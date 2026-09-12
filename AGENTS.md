## Subagent policy

Before orchestrating subagents, read the pi-subagents skill.

Use `reviewer` for code reviews and rechecks, including Standards/Spec reviews
requested by skills that only say "subagent". Do not substitute `delegate`.

### Context boundaries

Start a new worker for each review-fix round with accepted findings and a
compact handoff. Resume only small same-phase continuations when retaining
history has a concrete benefit and current context plus expected work fits
below the rotation threshold.

At phase boundaries and before resume or fork, check current context-window
usage, not cumulative spend or a peak badge. Include inherited history and
expected next-task growth when deciding whether the work fits.

- Checkpoint at 100k tokens or 50% of the model window, whichever is lower.
- Rotate by 120k tokens or 60%, whichever is lower; earlier for large tasks.
- If usage is unknown, prefer a new child at the boundary.

Give each worker one deliverable slice. Include these thresholds and an
instruction to checkpoint and return if the slice grows beyond its budget
in the worker's task, rather than relying on global instruction inheritance.

### Rotation

Use existing reports to prepare the handoff instead of reviving an oversized
worker just to summarize it. Preserve decisions, worktree and dirty state,
validation results, unresolved findings, and the next task. Reference source
artifacts instead of copying transcripts.

For an active writer, request its checkpoint after the current tool returns.
Confirm it has stopped writing before starting its replacement in the same
worktree, preserving uncommitted changes.

Use compaction only through a supported control and verify reduced current
context before continuing. Otherwise, hand off to a new child. Resume and
writing a handoff document do not reset context.


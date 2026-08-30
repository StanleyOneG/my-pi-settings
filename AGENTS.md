## Subagent orchestration

Use pi-subagents proactively when a task is multi-file, unfamiliar, ambiguous,
risky, requires external research, or benefits from independent verification.

For substantial implementation work, act as the parent orchestrator rather than
the routine implementer:

1. Clarify requirements and acceptance criteria.
2. Use a fresh-context scout to inspect relevant code, conventions, tests, and
   integration points.
3. Use researcher when current external documentation or primary-source
   evidence materially affects the implementation.
4. Have one worker implement the approved scope.
5. Use fresh-context reviewers with distinct, evidence-based review angles.
6. Send accepted findings to one worker for correction.
7. Inspect the final diff and validation evidence before reporting completion.

Keep one writer per cwd or worktree. Parallelize read-only investigation and
review; use isolated worktrees when parallel writers are genuinely necessary.

Use fresh context for scouts, researchers, and adversarial reviewers. Use forked
context for workers and oracle when inherited decisions matter.

Run subagents asynchronously by default. If a child encounters an unapproved
product, scope, architecture, or security decision, it must ask through the
supervisor channel rather than guessing.

Give every child a cold-start-complete contract: objective, exact target/cwd/ref,
authority boundary, relevant context, success criteria, validation, expected
output, and stop/escalation conditions.

Skip delegation for trivial questions, tiny edits, and direct commands where
another agent would not materially improve evidence, review, or isolation.

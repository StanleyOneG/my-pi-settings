## Subagents usage

- Use subagents to effectively complete tasks. Assess quantity, kind and type (single subagents or chains) of subagents that would be most appropriate for a task, and can you pass required context to subagents effectively or you should complete a task by yourself (if big decision making conversation is in the relevant context and there would be loss of very important information during context handling to subagents).
- When assessing quantity, kind and type of subagents to spawn think of subagent's context window to be in a "smart zone" (under ~150k tokens: +30k tokens is acceptable) so that subagent could effectively complete its task in clean "smart zone" context window.
- Use subagents for implementation tasks to keep your context window low to have move opportunities to orchestrate and steer subagents for nice and effective task completion.
- Always pass timeoutMs: 5400000 when launching subagents, including each workflow child in runs.run(...) or runs.all(...). Do not rely only on the outer workflow timeout. Use timeoutMs: 21600000 for the outer workflow.

## pstack/poteto models

When using pstack, select the model configured for the applicable role in ~/.pi/agent/pstack/models.json and pass it explicitly in the subagent call's model parameter. For inherit-parent or auto, resolve and pass the current session's model explicitly. Use a different model only when explicitly instructed by the user.


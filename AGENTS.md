## Subagents usage

- Use subagents to effectively complete tasks. Assess quantity, kind and type (single subagents or chains) of subagents that would be most appropriate for a task, and can you pass required context to subagents effectively or you should complete a task by yourself (if big decision making conversation is in the relevant context and there would be loss of very important information during context handling to subagents).
- When assessing quantity, kind and type of subagents to spawn think of subagent's context window to be in a "smart zone" (under ~150k tokens) so that subagent could effectively complete its task in clean "smart zone" context window.
- Use subagents for implementation tasks to keep your context window low to have move opportunities to orchestrate and steer subagents for nice and effective task completion.


# Council Workflow Reference

Council is a peer-review checkpoint for substantial artifacts. The helper automates reviewer discovery, workspace isolation, prompt construction, and report rendering. The authoring agent still owns judgment.

## When To Use Council

Use Council for specs, implementation plans, code diffs, PR summaries, migration plans, incident analyses, rollback plans, security-sensitive changes, privacy-sensitive changes, and operational analysis that drives a decision.

Skip Council for trivial answers, tiny typo fixes, mechanical edits, and exploratory notes.

## Manual Fallback

If Node or the helper is unavailable:

1. Copy the artifact or diff into the prompt for another available agent.
2. Ask that agent to look for bugs, missing requirements, incorrect assumptions, unverifiable claims, test gaps, operational risks, and unclear user impact.
3. Require output using `BLOCKER`, `SUGGESTION`, `QUESTION`, and `PASS`.
4. Keep reviewer edits out of the author's working tree.
5. Accept or reject each finding explicitly before presenting the final answer.

## Review Loop

Default to at most three rounds. Stop early when all reviewers pass, when no meaningful change was made after a round, when the maximum round count is reached, or when no reviewer agents are available.

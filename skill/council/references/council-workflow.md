# Council Workflow Reference

Council is a peer-review checkpoint for substantial artifacts. The helper automates reviewer discovery, workspace isolation, prompt construction, and report rendering. The authoring agent still owns judgment.

## When To Use Council

Use Council for any spec, plan, implementation plan, implementation approach, proposal, design, PR summary, migration plan, incident analysis, rollout plan, rollback plan, code diff, security/privacy-sensitive change, or decision-driving artifact. Trigger on user phrases like "spec", "plan", "plan your approach", "proposal", "how would you implement", and "review this approach".

Skip Council for trivial answers, tiny typo fixes, mechanical edits, and exploratory notes.

## Manual Fallback

If Node or the helper is unavailable:

1. Copy the artifact or diff into the prompt for another available agent.
2. Ask that agent to look for bugs, missing requirements, incorrect assumptions, unverifiable claims, test gaps, operational risks, and unclear user impact.
3. Require output using `BLOCKER`, `SUGGESTION`, `QUESTION`, and `PASS`.
4. Keep reviewer edits out of the author's working tree.
5. Accept or reject each finding explicitly before presenting the final answer.

## Review Loop

Default to at most three rounds. Stop early when all reviewers pass, when no meaningful change was made after a round, when the maximum round count is reached, when no reviewer agents are available, or when Council cannot run or does not return after one reasonable wait. Treat about five minutes as the normal-chat bound when wall-clock timing is available; if timing is unavailable, use a bounded tool timeout when supported and do not block indefinitely. Clean up temporary artifact files even when Council fails or is abandoned. Keep waiting only when the user explicitly asks you to or when a known task-specific timeout has been configured.

## Diff Review

Use `--diff --base <ref>` for committed PR branches, for example `--base origin/main`. The helper reviews dirty changes and, when a base or upstream ref is available, committed changes against that ref. If the report says `no diff found`, the review is incomplete; rerun with the correct base or create the intended diff before relying on Council.

Reviewer processes time out after 300 seconds by default. Use `--timeout-ms <milliseconds>` only when a task-specific bound is needed. Empty reviewer output and timed-out reviewers make the review incomplete, not passed.

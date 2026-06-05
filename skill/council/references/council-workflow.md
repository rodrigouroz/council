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

## Sandboxed Codex Runs

When Council is launched from a sandboxed Codex shell, reviewer CLIs run as local child processes that need their normal auth/home state and network. Council blocks reviewer launch only when the sandbox has disabled network (`CODEX_SANDBOX_NETWORK_DISABLED`), since reviewers cannot reach their model backends without it; when network is available reviewers launch and any auth failure surfaces as a reviewer error rather than being guessed from environment variables. If reviewers are blocked, rerun with network access: in Codex tool calls request `sandbox_permissions: "require_escalated"` for the helper command; from a human shell start Codex with `codex --sandbox danger-full-access` (or the broader `--dangerously-bypass-approvals-and-sandbox`) only when you understand the risk. If escalation is unavailable or denied, treat the artifact as unreviewed. `--allow-sandboxed-reviewers` is an unconditional override.

## Review Loop

Default to at most three rounds. Stop early when all reviewers pass, when no meaningful change was made after a round, when the maximum round count is reached, when no reviewer agents are available, or when Council cannot run or does not return after one reasonable wait. Treat about five minutes as the normal-chat bound when wall-clock timing is available; if timing is unavailable, use a bounded tool timeout when supported and do not block indefinitely. Clean up temporary artifact files even when Council fails or is abandoned. Keep waiting only when the user explicitly asks you to or when a known task-specific timeout has been configured.

## Diff Review

Use `--diff --base <ref>` for committed PR branches, for example `--base origin/main`. The helper reviews dirty changes and, when a base or upstream ref is available, committed changes against that ref. If the report says `no diff found`, the review is incomplete; rerun with the correct base or create the intended diff before relying on Council.

For closeout review, choose explicit targets when possible:

- `--mode local` reviews dirty working-tree changes only.
- `--mode branch --base <ref>` reviews branch changes against a base ref and appends dirty changes when present.
- `--commit <ref>` reviews one committed change.

`--commit` uses `git show --format= --binary <ref>`. Merge commits may produce no diff with that command shape; use branch/base review when merge-commit content matters.

Use `--reviewers codex,claude` to limit the reviewer set. Use `--parallel-tests "<command>"` when a verification command can run alongside reviewer agents; a failed parallel test makes the closeout incomplete until accepted or resolved. Use `--test-timeout-ms <milliseconds>` when the verification command needs a different budget from reviewer agents.

Parallel tests run in the author's real working tree, not in reviewer disposable workspaces. Choose commands that are safe for the current checkout, and avoid commands that aggressively create/delete files while reviewer workspaces are being prepared from the live checkout. If no diff is found, Council skips parallel tests and reports the review as incomplete.

Council records the review command in its report. Do not put secrets directly in command-line arguments.

Reviewer processes time out after 300 seconds by default. Use `--timeout-ms <milliseconds>` only when a task-specific bound is needed. Council also bounds the whole run with `--run-timeout-ms` (default 480000): on expiry it cancels outstanding reviewers/tests, terminates their process groups, keeps completed results, and reports the review as incomplete. Empty reviewer output and timed-out reviewers make the review incomplete, not passed.

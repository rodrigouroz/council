---
name: council
description: 'MUST use before presenting any spec, plan, implementation plan, implementation approach, proposal, design, PR summary, migration plan, incident analysis, rollout plan, rollback plan, code diff, security/privacy-sensitive change, or decision-driving artifact. Trigger on user phrases like "spec", "plan", "plan your approach", "proposal", "how would you implement", and "review this approach".'
---

# Council Peer Review

Use Council before presenting substantial artifacts. Skip it for trivial answers, tiny typo fixes, mechanical edits, and exploratory notes that are not being presented as a decision.

## Hard Trigger

If the user asks for a spec, plan, implementation plan, implementation approach, proposal, design, PR summary, migration plan, incident analysis, rollout plan, rollback plan, code diff, security/privacy-sensitive change, or decision-driving artifact, you MUST:

1. Draft the artifact; if it is chat-only, put the draft in a temporary file outside the source checkout for review, then remove that file after the run.
2. Run Council before presenting the final version.
3. State whether Council completed, failed, or was skipped and why.

This applies even when the artifact is only a chat response and not a committed file.

This hard trigger does not override the skip rule for trivial answers, tiny typo fixes, mechanical edits, or exploratory notes that are not being presented as a decision.

## Requirements

- Node.js 20 or newer for the bundled helper.
- Git for preferred disposable worktree isolation.
- At least one reviewer CLI on `PATH`: `codex` or `claude`.

If Node or the helper is unavailable, follow the manual fallback in `references/council-workflow.md`. If Git worktrees are unavailable, the helper falls back to a temporary directory copy and discloses that in the report.

Council is not an OS sandbox. Reviewer CLIs run as local processes, so do not pass absolute paths to the author's source checkout unless that exposure is intentional.

## If Council Fails Or Hangs

If Council cannot run or does not return after one reasonable wait, stop waiting, clean up any temporary artifact file you created, disclose that the artifact is unreviewed, and do not imply Council passed. Treat about two minutes as the normal-chat bound when wall-clock timing is available; if timing is unavailable, use a bounded tool timeout when supported and do not block indefinitely. Keep waiting only when the user explicitly asks you to or when a known task-specific timeout has been configured.

## Workflow

1. Draft the artifact or implementation.
2. Run the bundled helper:

```bash
node skill/council/scripts/dist/council.mjs review --artifact /path/to/artifact.md --cwd /path/to/repo --author <codex-or-claude>
```

Replace `<codex-or-claude>` with `codex` when running from Codex and `claude` when running from Claude Code. Council skips the matching reviewer so an agent does not review itself. You can also set `COUNCIL_AUTHOR_AGENT=codex` or `COUNCIL_AUTHOR_AGENT=claude` instead of passing the flag; an explicit `--author` flag wins over the environment variable.

For code diffs:

```bash
node skill/council/scripts/dist/council.mjs review --diff --cwd /path/to/repo --author <codex-or-claude>
```

3. Read the report. Treat `BLOCKER` and `QUESTION` items as needing a decision before final presentation.
   - If the result says `no reviewer agents available`, treat the artifact as unreviewed: install the opposite reviewer CLI, fix the author value, or use the manual fallback in `references/council-workflow.md`.
4. Accept valid findings and revise the artifact or implementation yourself.
5. Reject invalid findings explicitly with a short reason.
6. Re-run Council after meaningful changes while the round limit allows it:

```bash
node skill/council/scripts/dist/council.mjs review --artifact /path/to/artifact.md --cwd /path/to/repo --author <codex-or-claude> --round 2 --max-rounds 3 --change-summary "Addressed rollback and test coverage findings"
```

7. Present the final answer with accepted findings, rejected findings, and remaining risks.

## Reviewer Output

Council reviewers are asked to return concise findings:

```text
BLOCKER: concrete issue with file/line/evidence when available
SUGGESTION: useful but non-blocking improvement
QUESTION: information needed to judge the artifact
PASS: no blocking findings
```

Do not blindly obey reviewers. The authoring agent owns the final judgment.

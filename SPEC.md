# Council Spec

## Purpose

Council is a portable skill plus bundled TypeScript helper for agent peer review.

The core idea is that an authoring agent should consult other available agents before presenting substantial artifacts to the user. The reviewers should cross-check assumptions, inspect code when useful, run verification when appropriate, and return concrete findings. The authoring agent keeps responsibility for judgment and edits.

Council replaces the heavier Camelot product direction. It keeps the useful idea of multiple agents checking each other, but avoids a custom UI, long-running hub, bespoke protocol, persistent coordination model, and product workflow.

## Goals

- Provide a Codex/Claude-compatible skill that tells agents when and how to convene Council.
- Provide a bundled Node.js helper that the skill can invoke without a runtime `npm install`.
- Support review of specs, plans, code diffs, PR summaries, migrations, incident writeups, security-sensitive changes, and decision-driving analysis.
- Let reviewer agents use tools as needed, including dependency installation, code search, test runs, builds, and local inspection.
- Reduce the risk of reviewer activity modifying the author's real working tree by running reviewers from disposable workspaces and disclosing harness limits.
- Support iterative review loops with a hard safeguard limit.
- Package the skill as a zip that can be uploaded or shared.
- Keep setup and usage boring enough that agents actually use it.

## Non-Goals

- No macOS app.
- No custom chat UI.
- No Herald/Chronicle-style event hub.
- No Claims, Quests, Decrees, or persistent Round Table state.
- No automatic code edits by reviewers in the author's workspace.
- No first-version prepared workspace cache.
- No first-version hosted service.
- No opaque precompiled helper binaries.

## Product Shape

The first implementation is a repository containing a skill folder with a bundled TypeScript helper:

```text
council/
  SPEC.md
  .github/workflows/package-skill.yml
  skill/council/
    SKILL.md
    agents/openai.yaml
    evals/
    references/council-workflow.md
    scripts/
      package.json
      package-lock.json
      tsconfig.json
      src/
      test/
      tools/package-skill.mjs
      dist/council.mjs
```

The skill is the agent-facing workflow. The helper is the deterministic harness that discovers reviewers, creates isolated workspaces, invokes agents, limits loops, and emits reports. The packaged zip contains the skill folder, the TypeScript source for auditability, and the bundled JavaScript helper for immediate runtime use.

## Runtime Requirements

- Node.js 20 or newer.
- Git for the preferred worktree isolation path.
- Local reviewer CLIs on `PATH`, initially `codex` and `claude`.

If Node is unavailable, the skill should fall back to manual peer-review instructions instead of pretending the helper ran. If Git worktrees are unavailable, the helper should fall back to copying the working directory to a temporary directory and disclose that fallback in the report.

## Skill Behavior

The Council skill should trigger when an agent is about to present a substantial artifact, including:

- Specs and design docs.
- Implementation plans.
- Code diffs and patch sets.
- Pull request summaries.
- Migrations and rollout plans.
- Incident analyses and rollback plans.
- Security/privacy-sensitive changes.
- Data or operational analyses that drive a decision.

The skill should not require Council for trivial answers, mechanical edits, tiny typo fixes, or exploratory notes.

The skill should instruct the authoring agent to:

1. Draft the artifact.
2. Run the bundled helper with Node.
3. Read the findings and decide what to change.
4. Revise the artifact or implementation when findings are valid.
5. Re-run Council when meaningful changes were made and the round limit allows it.
6. Present the final artifact only after resolving or explicitly rejecting blocking findings.

The authoring agent must not blindly obey reviewers. The author should summarize accepted findings, rejected findings, and rationale.

## Helper Interface

Initial commands:

```bash
node skill/council/scripts/dist/council.mjs review --artifact /path/to/artifact.md --cwd /path/to/repo
node skill/council/scripts/dist/council.mjs review --diff --cwd /path/to/repo
node skill/council/scripts/dist/council.mjs review --artifact /path/to/artifact.md --cwd /path/to/repo --max-rounds 3
```

Defaults:

- `--cwd` defaults to the current directory.
- `--max-rounds` defaults to `3`.
- `--round` defaults to `1`.
- `--author` is optional and accepts `codex` or `claude`; if omitted, the helper reads `COUNCIL_AUTHOR_AGENT`.
- If both are set, `--author` takes precedence over `COUNCIL_AUTHOR_AGENT`.
- When an author is known, reviewers default to every available supported agent except the authoring agent.
- When no author is known, reviewers default to every available supported agent.
- Output defaults to Markdown.
- `--json` emits JSON.
- Report `result` values are `no blocking findings`, `next round recommended`, and `no reviewer agents available`.

The helper should avoid user-facing review modes such as `artifact-only`, `read-only`, or `verify`. Reviewers get a simple instruction: use the tools needed to review well, but do not intentionally modify source. The harness isolates ordinary cwd-relative writes through disposable workspaces and reports mutations it observes.

## Reviewer Agents

Supported reviewers for v1:

- `codex`
- `claude`

Future reviewer:

- `agy`

Discovery should be simple:

- Look for agent executables on `PATH`.
- Skip the reviewer matching `--author` or `COUNCIL_AUTHOR_AGENT` with a visible warning.
- Skip missing agents with a visible warning.
- Allow explicit reviewer selection later, but default to all available reviewers.

Reviewer invocation should use each agent's local CLI. The helper should run one-shot reviewer calls, not persistent sessions.

Known local command shapes as of this spec:

```bash
codex exec --json --skip-git-repo-check --sandbox workspace-write
claude --print --input-format stream-json --output-format stream-json --verbose --permission-mode bypassPermissions
```

## Workspace Isolation

Reviewers may need to install modules, run tests, build code, generate temporary files, and inspect the repository. That is allowed.

The operational invariant is:

> A reviewer may mutate its disposable workspace, and normal cwd-relative reviewer activity must not mutate the author's real working tree.

For each reviewer and round, Council should create an isolated workspace. Preferred implementation:

1. Detect whether `--cwd` is inside a Git repository with a valid `HEAD`.
2. Create a temporary git worktree from the current `HEAD`.
3. Apply the current author diff to that worktree when reviewing uncommitted changes.
4. Copy untracked, non-ignored files into that worktree.
5. Copy or write the artifact under review into the worktree, for example `.council/artifact.md`.
6. Run the reviewer from the disposable worktree.
7. Allow normal tool use inside that workspace.
8. At the end, run `git status --porcelain` in the disposable worktree.
9. Discard the worktree.
10. Include a warning if the reviewer changed tracked files or left notable generated state.

If a Git worktree is not possible, Council can fall back to copying the directory to a temp location, excluding obvious heavy/generated directories when safe. This fallback should be explicit in the report.

Dependency installation is allowed inside disposable workspaces. Global package caches may still be used by package managers. That is acceptable for v1.

Council is not an OS sandbox against malicious reviewers or reviewer CLIs with broad permissions. Review commands run as local processes, so prompts and artifacts should avoid absolute paths to the author's source checkout unless that exposure is intentional.

## Iteration Loop

Council is not only one-shot. It should support an author-review-fix-review loop.

Default limit:

```text
max rounds = 3
```

Loop:

```text
author drafts artifact
Council review round 1
author accepts/rejects findings and revises
Council review round 2
author accepts/rejects findings and revises
Council review round 3
author presents final decision
```

Council should stop early when:

- All reviewers pass or have no blocking findings.
- The author made no meaningful change since the previous review.
- The maximum round count is reached.
- No reviewer agents are available.

The helper should not auto-fix. It returns findings. The authoring agent performs edits and decides whether another round is warranted.

The v1 helper is stateless across rounds. It exposes `--round`, `--max-rounds`, and `--change-summary`; the authoring agent decides whether "no meaningful change since previous review" means the loop should stop. Persistent round-state tracking is a future enhancement.

## Review Prompt Requirements

Each reviewer prompt should include:

- Artifact kind: spec, plan, diff, PR summary, migration, incident analysis, or unknown.
- The artifact content or diff.
- Repository path and relevant context.
- The current round number and maximum rounds.
- For follow-up rounds, a short change summary from the authoring agent.
- Clear instruction to look for bugs, missing requirements, incorrect assumptions, unverifiable claims, test gaps, operational risks, and unclear user impact.
- Clear instruction that reviewer edits are not the deliverable; findings are.
- Output schema instructions.

Reviewers should produce concise findings:

```text
BLOCKER: concrete issue with file/line/evidence when available
SUGGESTION: useful but non-blocking improvement
QUESTION: information needed to judge the artifact
PASS: no blocking findings
```

Reviewers should avoid vague style comments unless the artifact is unclear enough to create real risk.

## Report Format

Markdown report sections:

```text
# Council Review

## Summary
- round
- artifact
- reviewers
- result

## Blocking Findings

## Suggestions

## Questions

## Reviewer Disagreements

## Harness Notes

## Author Checklist
```

JSON output should contain the same data shape:

```json
{
  "round": 1,
  "maxRounds": 3,
  "artifact": "...",
  "reviewers": [],
  "result": "no blocking findings | next round recommended | no reviewer agents available",
  "blockingFindings": [],
  "suggestions": [],
  "questions": [],
  "harnessNotes": [],
  "nextRoundRecommended": false
}
```

The Markdown report is for agents and humans. JSON is for future automation.

A report with `reviewers: []` or `result: "no reviewer agents available"` is not a peer-reviewed pass. The authoring agent should install or enable the opposite reviewer CLI, correct the author value, or use manual fallback review.

## Safety Model

Council's safety model is isolation plus disclosure:

- Reviewers run in disposable workspaces.
- Reviewer changes are ignored.
- Normal cwd-relative reviewer writes do not modify the author's workspace.
- The report notes missing reviewers, failed invocations, setup failures, and reviewer workspace mutations.
- A failed reviewer should not fail the whole Council run if at least one reviewer returns useful output.

Council should not hide harness failures or oversell its isolation boundary. A report with only one successful reviewer should say so clearly.

## Packaging And Distribution

The source of truth should live in GitHub. The distributed artifact is `council-skill.zip`, a zip containing the `council/` skill folder.

Packaging rules:

- Include `SKILL.md`, `agents/openai.yaml`, `references/`, `scripts/src/`, `scripts/dist/council.mjs`, `scripts/package.json`, `scripts/package-lock.json`, and `scripts/tsconfig.json`.
- Include `evals/` with concrete prompts for validating skill behavior.
- Exclude `node_modules`, tests, transient caches, and generated zip files.
- Keep the zip under 25 MB.
- Do not require `npm install` at skill runtime.
- Avoid native npm dependencies.
- Ship source plus bundled output so users can inspect the source and run the helper immediately.

GitHub Actions should:

- Run on pull requests, pushes to `main`, and version tags.
- Install pinned Node dependencies with `npm ci`.
- Run tests.
- Build the bundled helper.
- Fail if the tracked bundled helper differs from a rebuild.
- Package `council-skill.zip`.
- Upload the zip as a workflow artifact for PRs and `main`.
- Create a GitHub Release and attach the zip for tags matching `v*`.

## Testing Strategy

Use fake agent executables in tests instead of real `codex` or `claude`.

Initial tests:

- Parses review CLI flags and rejects invalid combinations.
- Discovers fake reviewers on `PATH`.
- Skips missing reviewers with a warning.
- Creates and removes disposable workspaces.
- Applies a dirty diff to the review workspace.
- Allows reviewer writes inside the disposable workspace without touching the source checkout.
- Detects reviewer workspace mutations and reports them.
- Parses reviewer output into blocking findings, suggestions, questions, and pass status.
- Preserves continuation lines attached to prefixed reviewer findings.
- Exercises the directory-copy fallback path.
- Emits Markdown and JSON reports.
- Packages a zip containing the expected skill files and excluding `node_modules`.
- Includes at least three skill-level evaluation prompts for real usage scenarios.

Prefer Node's built-in test runner with TypeScript loaded through `tsx`.

## Open Questions

- Whether `agy` has a stable local CLI shape.
- Whether review worktrees should be retained with `--keep-workspace` for debugging failed reviews.
- Whether Council should install its skill into `~/.codex/skills` automatically or only ship the skill folder in repo v1.

## First Implementation Plan

1. Replace the Go scaffold with the TypeScript skill package.
2. Add helper command parsing and tests.
3. Implement reviewer discovery and one-shot Codex/Claude runners with fake-agent tests.
4. Implement disposable workspace isolation with tests.
5. Implement prompt construction and reviewer output parsing.
6. Implement Markdown/JSON report rendering.
7. Wire `review` end to end.
8. Write `skill/council/SKILL.md` and metadata.
9. Add package builder for `council-skill.zip`.
10. Add GitHub Actions validation and tag-release workflow.

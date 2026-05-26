# Council

Portable agent peer review for substantial AI-generated work.

Council is a Codex/Claude-compatible skill that asks other local agents to review specs, plans, diffs, incident writeups, migrations, and other decision-driving artifacts before the authoring agent presents final work. Reviewers run from disposable workspaces so cwd-relative edits are discarded, return structured findings, and leave the authoring agent responsible for final judgment.

[![Package Council Skill](https://github.com/rodrigouroz/council/actions/workflows/package-skill.yml/badge.svg)](https://github.com/rodrigouroz/council/actions/workflows/package-skill.yml)

## What It Ships

Council is distributed as a skill zip. The zip contains:

- `SKILL.md` with the agent-facing workflow.
- `agents/openai.yaml` for UI metadata.
- `references/council-workflow.md` for fallback/manual review guidance.
- `evals/` with concrete scenarios for testing skill behavior.
- A bundled Node.js helper at `scripts/dist/council.mjs`.
- TypeScript source for auditing the bundled helper.

The helper is bundled so users do not need to run `npm install` at skill runtime. Source is included so the packaged JavaScript is not an opaque binary.

## How It Works

1. The authoring agent drafts an artifact or implementation.
2. Council creates an isolated workspace for each available reviewer except the authoring agent.
3. Council invokes local reviewer CLIs, currently `codex` and `claude`.
4. Reviewers inspect the artifact, repository, and diff as needed.
5. Council parses reviewer output into `BLOCKER`, `SUGGESTION`, `QUESTION`, and `PASS`.
6. The authoring agent accepts or rejects findings, revises when needed, and reruns Council if meaningful changes were made.

Council is intentionally smaller than Camelot: no custom UI, no event hub, no persistent coordination protocol, and no long-running service.

## Runtime Requirements

- Node.js 20 or newer.
- Git, for the preferred disposable `git worktree` isolation path.
- At least one supported reviewer CLI on `PATH`:
  - `codex`
  - `claude`

If Git worktrees are unavailable, Council falls back to a temporary directory copy and discloses that fallback in the report. If Node is unavailable, the skill includes manual fallback instructions.

Council is not an OS sandbox. Reviewer CLIs still run as local processes with their own permission modes, so avoid putting absolute paths to the author's source checkout in prompts or artifacts when reviewer tools are broadly permitted.

If a report says `no reviewer agents available`, treat the artifact as unreviewed. Install the opposite reviewer CLI, correct the author value, or use the manual fallback instructions in `references/council-workflow.md`.

## Usage From Source

Review an artifact:

```bash
node skill/council/scripts/dist/council.mjs review \
  --artifact /path/to/artifact.md \
  --cwd /path/to/repo \
  --author <codex-or-claude>
```

Replace `<codex-or-claude>` with `codex` when running from Codex and `claude` when running from Claude Code. Council skips the matching reviewer so an agent does not review itself. If you prefer environment configuration, set `COUNCIL_AUTHOR_AGENT=codex` or `COUNCIL_AUTHOR_AGENT=claude`; an explicit `--author` flag wins over the environment variable.

Review the current diff:

```bash
node skill/council/scripts/dist/council.mjs review \
  --diff \
  --cwd /path/to/repo \
  --author <codex-or-claude>
```

Run a follow-up round:

```bash
node skill/council/scripts/dist/council.mjs review \
  --artifact /path/to/artifact.md \
  --cwd /path/to/repo \
  --author <codex-or-claude> \
  --round 2 \
  --max-rounds 3 \
  --change-summary "Addressed rollback and test coverage findings"
```

Emit JSON:

```bash
node skill/council/scripts/dist/council.mjs review \
  --artifact /path/to/artifact.md \
  --cwd /path/to/repo \
  --author <codex-or-claude> \
  --json
```

## Installing The Skill

Download `council-skill.zip` from a GitHub Release and upload or install it through your skill library. The zip root contains the `council/` skill folder, which can be installed into Codex, Claude Code, or both.

For a local build without GitHub Actions, run:

```bash
./scripts/local-release.sh
```

That validates the helper and writes:

```text
skill/council/dist/council-skill.zip
```

To install the generated zip into both local skill directories:

```bash
./scripts/local-release.sh --install-both
```

That installs to:

```text
${CODEX_HOME:-$HOME/.codex}/skills/council
$HOME/.claude/skills/council
```

To install manually into Codex:

```bash
SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$SKILLS_DIR"
rm -rf "$SKILLS_DIR/council"
unzip -q skill/council/dist/council-skill.zip -d "$SKILLS_DIR"
```

To install manually into Claude Code:

```bash
SKILLS_DIR="$HOME/.claude/skills"
mkdir -p "$SKILLS_DIR"
rm -rf "$SKILLS_DIR/council"
unzip -q skill/council/dist/council-skill.zip -d "$SKILLS_DIR"
```

Or build and install for one target:

```bash
./scripts/local-release.sh --install-codex
./scripts/local-release.sh --install-claude
```

`./scripts/local-release.sh --install-local` remains supported as a backward-compatible alias for `--install-codex`.

After installing, start a fresh Codex or Claude Code session or reload skills, then ask for a Council review of a real spec, plan, or diff.

## Development

Install dependencies:

```bash
cd skill/council/scripts
npm ci
```

Run verification:

```bash
npm run typecheck
npm test
npm run check-dist
```

Package the skill zip:

```bash
./scripts/local-release.sh
```

The local release command runs `npm ci`, typecheck, tests, bundle drift check, and packaging. It writes:

```text
skill/council/dist/council-skill.zip
```

That generated zip is ignored by git. The bundled runtime helper, `skill/council/scripts/dist/council.mjs`, is tracked for auditability and immediate skill runtime use.

Skill-level evaluation scenarios live in `skill/council/evals/`. Use them when checking whether the skill triggers, follows the review loop, and falls back correctly when the helper cannot run.

## Release Flow

The local release script mirrors the GitHub Actions job for environments where hosted Actions are unavailable:

```bash
./scripts/local-release.sh
```

To publish the zip as a GitHub Release asset from your machine:

```bash
./scripts/local-release.sh --tag v0.1.0
```

That command creates the tag if needed, pushes it, and creates or updates the release asset with `skill/council/dist/council-skill.zip`. It requires the GitHub CLI (`gh`) to be authenticated.

GitHub Actions can still run on pull requests, pushes to `main`, and tags matching `v*` when account Actions capacity is available.

- Pull requests and `main`: typecheck, test, build, package, and upload `council-skill.zip` as a workflow artifact.
- Version tags such as `v0.1.0`: create a GitHub Release and attach `council-skill.zip`.

CI also rebuilds `skill/council/scripts/dist/council.mjs` and fails if the tracked bundle drifts from source.

## Repository Layout

```text
.
├── SPEC.md
├── .github/workflows/package-skill.yml
├── scripts/local-release.sh
├── skill/council/
│   ├── SKILL.md
│   ├── agents/openai.yaml
│   ├── evals/
│   ├── references/council-workflow.md
│   └── scripts/
│       ├── dist/council.mjs
│       ├── src/
│       ├── test/
│       ├── tools/package-skill.mjs
│       ├── package.json
│       ├── package-lock.json
│       └── tsconfig.json
```

## GitHub Description

Portable agent peer-review skill with a bundled TypeScript helper for isolated Council reviews.

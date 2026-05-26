# Council TypeScript V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the portable Council skill package with a bundled TypeScript helper and GitHub Actions packaging workflow.

**Architecture:** The skill is the product surface. The helper is a Node.js CLI bundled to `skill/council/scripts/dist/council.mjs`; it handles argument parsing, reviewer discovery, isolated workspace setup, reviewer subprocess execution, finding parsing, and report rendering. Packaging is deterministic enough for CI: `npm ci`, tests, build, zip, artifact upload, and tag release.

**Tech Stack:** Node.js 20+, TypeScript, Node built-in test runner, `tsx` for test-time TS loading, `esbuild` for single-file ESM bundling, `yazl` for zip packaging, GitHub Actions.

---

## Tasks

1. Remove the uncommitted Go scaffold and create the TypeScript package under `skill/council/scripts`.
2. Write failing parser/discovery/report tests with fake reviewer executables.
3. Implement the helper modules with standard Node APIs and no runtime dependencies.
4. Add the Council skill, reference workflow, and UI metadata.
5. Add a package script that emits `skill/council/dist/council-skill.zip` with source plus bundled output.
6. Add `.github/workflows/package-skill.yml` for PR/main artifacts and tag releases.
7. Verify with `npm test`, `npm run build`, `npm run package`, inspect the zip, and run the bundled helper in JSON mode with fake reviewers.

## File Responsibilities

- `skill/council/SKILL.md`: concise agent-facing trigger and workflow.
- `skill/council/references/council-workflow.md`: longer fallback and review-loop guidance.
- `skill/council/agents/openai.yaml`: UI metadata.
- `skill/council/scripts/src/cli.ts`: command parsing and top-level review command wiring.
- `skill/council/scripts/src/agents.ts`: reviewer discovery and one-shot runner parsing.
- `skill/council/scripts/src/workspace.ts`: disposable worktree/copy isolation.
- `skill/council/scripts/src/review.ts`: artifact/diff capture, prompt construction, review orchestration, finding parsing.
- `skill/council/scripts/src/report.ts`: Markdown and JSON rendering.
- `skill/council/scripts/src/main.ts`: executable entrypoint.
- `skill/council/scripts/test/*.test.ts`: behavioral tests using fake reviewers and temporary repos.
- `skill/council/scripts/tools/package-skill.mjs`: zip builder.
- `.github/workflows/package-skill.yml`: validation, artifact upload, and tag release.

## Verification

Run:

```bash
cd /Users/rodrigouroz/Projects/council/skill/council/scripts
npm test
npm run build
npm run package
unzip -l ../dist/council-skill.zip | sed -n '1,80p'
```

Expected:

- Tests pass.
- `scripts/dist/council.mjs` exists.
- `../dist/council-skill.zip` exists.
- Zip contains `council/SKILL.md`, `council/agents/openai.yaml`, `council/references/council-workflow.md`, `council/scripts/src/main.ts`, and `council/scripts/dist/council.mjs`.
- Zip does not contain `node_modules`.

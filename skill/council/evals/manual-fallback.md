# Eval: Manual Fallback

## Prompt

Node.js is unavailable, but you still need peer review for an incident rollback plan before sending it to the user.

## Expected Behavior

- Uses `references/council-workflow.md`.
- Manually asks another available reviewer agent for `BLOCKER`, `SUGGESTION`, `QUESTION`, and `PASS` findings.
- Keeps reviewer edits out of the author's working tree.
- Explains that the automated helper could not run.

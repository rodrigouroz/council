# Eval: Diff Review

## Prompt

You have made a non-trivial code diff in a repository and are about to summarize it to the user. Use Council first.

## Expected Behavior

- Runs Council with `--diff`.
- Uses disposable workspace isolation for reviewers.
- Surfaces harness notes such as missing reviewer CLIs or workspace fallback.
- Presents a final summary only after resolving or explicitly rejecting blocking findings.

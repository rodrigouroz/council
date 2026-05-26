# Eval: Spec Review

## Prompt

You are about to present `SPEC.md` for a new local developer tool. Use Council before finalizing it.

## Expected Behavior

- Runs Council against the artifact.
- Treats `BLOCKER` and `QUESTION` findings as needing a decision.
- Summarizes accepted and rejected findings before presenting the final spec.
- Does not blindly apply reviewer suggestions.

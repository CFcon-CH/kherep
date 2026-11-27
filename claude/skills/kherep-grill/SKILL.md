---
name: kherep-grill
description: Use when the user wants to stress-test a consequential plan, decision, design, proposal, or migration whose goal or constraints remain uncertain.
---

# Kherep Grill

Interview the user in focused rounds until the decision is testable. The result should expose assumptions, trade-offs, unresolved facts, and an observable acceptance criterion.

## Privacy first

Before reading sources or dispatching work, classify whether the subject may contain secrets, credentials, personal data, customer material, or private infrastructure details. Keep protected content within an authorized local path. The interview itself must not copy protected payloads into an unapproved context.

## Work in rounds

Model the subject as a decision tree. Ask only questions whose prerequisites are settled. Group independent questions into one round, wait for answers, then recompute the open frontier.

Ask every round through the runtime's interactive question tool (in Claude Code: `AskUserQuestion`), never as a list of questions in the chat text. One call holds at most four questions; a larger round becomes several calls. Each question:

- stands on its own, because the user may see only the question dialog;
- offers two to four concrete alternatives, not an open "what do you think";
- puts the recommended option first and marks it `(Recommended)`, with the one-sentence reason in its description.

Recommendations are required when there is enough evidence to make one. Clearly label uncertainty. Only when the runtime has no interactive question tool, fall back to this text format:

```text
Q1 - Short title
Question with concrete alternatives.
Recommendation: preferred option and one-sentence reason.
```

## Measure facts, ask for decisions

Resolve facts from current code, configuration, executable behavior, or primary documentation when access is allowed. Ask the user about priorities, acceptable trade-offs, authority, and intent. A fact that cannot be established remains `UNKNOWN`; do not turn it into a guess or ask the user to validate a claim the tools could measure.

## Done condition

Finish when these fields are concrete:

| Field | Complete when |
| --- | --- |
| Goal | one sentence in the user's terms |
| Observable outcome | a third party can verify it |
| Scope | included and excluded work are named |
| Constraints | time, cost, compatibility, and authority limits are clear |
| Privacy class | still valid after what was learned |
| Acceptance criterion | written before implementation begins |
| Open risks | accepted, mitigated, or marked unknown |

Record the result in the artifact or tracking system chosen by the user or project. No particular issue tracker, project key, language, or document format is required.

Skip this skill for a small lookup, obvious one-line edit, or mechanical rename.

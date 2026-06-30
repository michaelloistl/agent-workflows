# Context

A previous pass addressed the review feedback on GitHub pull request
#{{PR_NUMBER}}, committed its changes, and wrote a handoff to a notes file. Your
only job now is to emit that handoff as one validated structured-output object —
nothing else. Do NOT edit files, commit, or change any code.

## The handoff notes

<notes>

!`cat {{NOTES_FILE}}`

</notes>

# Task

Return the handoff above as a single JSON object with two fields:

- `summary`: the top-level summary of what was changed, as GitHub-flavoured
  Markdown (non-empty).
- `replies`: an array of per-comment replies, each an object
  `{ "commentId": N, "body": "..." }` — `commentId` is the numeric `id` of the
  inline review comment being replied to, `body` is the reply text. Use `[]` when
  there were no inline comments to reply to.

Preserve the wording; do not summarise away detail. Drop any reply that does not
name a concrete numeric comment id.

Emit exactly one `<replies>` tag wrapping the JSON, then stop. The JSON must be
valid — escape newlines and quotes inside strings:

<replies>
{"summary": "## Addressed review feedback\n\n…what changed…", "replies": [{"commentId": 123456, "body": "Done — …"}]}
</replies>

# Done

After emitting the `<replies>` tag, output:

<promise>COMPLETE</promise>

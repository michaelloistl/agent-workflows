# Context

A previous read-only pass reviewed GitHub pull request #{{PR_NUMBER}} and wrote
its review to a notes file. Your only job now is to emit that review as one
validated structured-output object — nothing else. Do NOT edit files, commit, or
review further.

## The review notes

<notes>

!`cat {{NOTES_FILE}}`

</notes>

# Task

Return the review above as a single JSON object with two fields:

- `summary`: the top-level summary comment, as GitHub-flavoured Markdown
  (non-empty).
- `comments`: an array of inline comments, each an object
  `{ "path": "...", "line": N, "body": "..." }` — `path` is repo-root-relative,
  `line` is the line number in the new version of the file, `body` is the comment
  text. Use `[]` when there are no inline comments.

Preserve the review's wording; do not summarise away detail. Drop any inline
"comment" that does not name a concrete file and line.

Emit exactly one `<review>` tag wrapping the JSON, then stop. The JSON must be
valid — escape newlines and quotes inside strings:

<review>
{"summary": "## Review\n\n…the summary markdown…", "comments": [{"path": "app/models/foo.rb", "line": 12, "body": "…"}]}
</review>

# Done

After emitting the `<review>` tag, output:

<promise>COMPLETE</promise>

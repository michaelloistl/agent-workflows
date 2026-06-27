# Context

A previous read-only pass explored GitHub issue #{{ISSUE_NUMBER}} and wrote its
findings to a notes file. Your only job now is to emit that exploration as one
validated structured-output object — nothing else. Do NOT edit files, commit, or
explore further.

## The exploration notes

<notes>

!`cat {{NOTES_FILE}}`

</notes>

# Task

Return the exploration above as the `comment` field of a single JSON object,
which the workflow posts verbatim as the issue comment. Preserve its
GitHub-flavoured Markdown. Tidy only obvious artefacts (a stray tool log, a
broken line); do not summarise away detail.

Emit exactly one `<comment>` tag wrapping the JSON, then stop. The JSON must be
valid — escape newlines and quotes inside the string:

<comment>
{"comment": "## Exploration\n\n…the exploration markdown…"}
</comment>

# Done

After emitting the `<comment>` tag, output:

<promise>COMPLETE</promise>

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The five VERBS each carry a byte-identical `Install system packages` step, and this
// test is the only thing that keeps them that way. It cannot be one composite action:
// a called reusable workflow resolves `uses: ./…` against the CALLER's checkout, and
// this repo is never on disk in a consumer's job, so the shared copy would have to be
// checked out into the consumer's tree — which these verbs deliberately avoid, since
// they run an agent that stages and pushes commits.
//
// So the copies stay, and the drift they invite is guarded instead. CONTEXT.md calls a
// value that differs only because copies fell out of sync *accidental drift*; nothing
// else in CI reads the verb YAML, so an edit landing in four of five files is otherwise
// silent. `implement-spec.yml` is absent on purpose: it is the orchestrator, triggers no
// agent action, and installs nothing.
const VERBS = ["explore", "implement", "implement-pr", "review-pr", "update-branch"] as const;

const STEP_NAME = "Install system packages";
const STEP_HEADER = `      - name: ${STEP_NAME}`;

// The step's own lines, from its `- name:` through the last line indented under it.
// Steps sit at six spaces and their keys at eight, so "still inside this step" is
// "blank, or indented deeper than the `- name:` that opened it" — which keeps the
// `run: |` block (ten spaces) and drops the next step.
function installStep(verb: string): string {
  const source = readFileSync(
    fileURLToPath(new URL(`../../.github/workflows/${verb}.yml`, import.meta.url)),
    "utf8",
  );
  const lines = source.split("\n");
  assert.equal(
    lines.filter((line) => line === STEP_HEADER).length,
    1,
    `${verb}.yml should have exactly one \`${STEP_NAME}\` step`,
  );

  const body: string[] = [];
  for (const line of lines.slice(lines.indexOf(STEP_HEADER) + 1)) {
    if (line.trim() === "") {
      body.push(line);
      continue;
    }
    if (!line.startsWith("        ")) break;
    body.push(line);
  }
  while (body.at(-1)?.trim() === "") body.pop();

  return [STEP_HEADER, ...body].join("\n");
}

test("every verb ships a byte-identical Install system packages step", () => {
  const [reference, ...others] = VERBS;
  const expected = installStep(reference);
  // Guards the extractor itself: a bad indentation rule would silently compare five
  // empty strings and pass.
  assert.match(expected, /^ {8}run: \|$/m);
  assert.match(expected, /apt-get install/);

  for (const verb of others) {
    assert.equal(installStep(verb), expected, `${verb}.yml has drifted from ${reference}.yml`);
  }
});

// Regression guard for the bug this step's own PR shipped, which only a human review and
// a consumer's red CI run caught: narrowing apt's sources to `/etc/apt/sources.list`
// also drops `ubuntu.sources` — on 24.04 the entire Ubuntu archive — so `update` fetches
// nothing, succeeds, and `install` can no longer locate any package that is not already
// on the image. Consumers whose packages happen to be baked in get a silent no-op.
//
// The step's comments warn against it at length; nothing but this enforces the warning.
// Comment lines are stripped first, because the warning names the option it forbids.
test("no verb narrows apt's source list", () => {
  for (const verb of VERBS) {
    const executable = installStep(verb)
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    assert.doesNotMatch(
      executable,
      /Dir::Etc::sourceparts/,
      `${verb}.yml narrows apt's sources, which leaves apt with no Ubuntu archive`,
    );
  }
});

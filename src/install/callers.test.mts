import { test } from "node:test";
import assert from "node:assert/strict";

import { CALLERS, callersFor, labelsFor, secretsFor } from "./catalog.mts";
import { isGeneratedCaller, renderCaller, repinCaller } from "./callers.mts";

const OPTIONS = {
  workflowsRepo: "michaelloistl/agent-workflows",
  ref: "v1",
  enableRuby: false,
  gitAuthorEmail: "agent@example.com",
  publicRepo: true,
};

function caller(file: string) {
  const found = CALLERS.find((c) => c.file === file);
  assert.ok(found, `no catalog entry for ${file}`);
  return found;
}

test("an issue caller triggers on the label and pins the reusable workflow", () => {
  const yaml = renderCaller(caller("agent-implement.yml"), OPTIONS);
  assert.match(yaml, /^name: Agent Implement$/m);
  assert.match(yaml, /^ {2}issues:\n {4}types: \[labeled\]$/m);
  assert.match(
    yaml,
    /if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.label\.name == 'agent:implement'/,
  );
  assert.match(
    yaml,
    /uses: michaelloistl\/agent-workflows\/\.github\/workflows\/implement\.yml@v1/,
  );
  assert.match(yaml, /secrets: inherit/);
});

// `pull_request_target` runs PR-head code WITH secrets. On a public repo an ungated
// caller lets any external PR start a billed run against the repo's credentials, so
// the author gate is not cosmetic.
test("a PR caller on a public repo gates by author association", () => {
  const yaml = renderCaller(caller("agent-review-pr.yml"), OPTIONS);
  assert.match(yaml, /pull_request_target:/);
  assert.match(yaml, /author_association/);
  assert.match(yaml, /"OWNER","MEMBER","COLLABORATOR"/);
});

test("a PR caller on a private repo skips the author gate", () => {
  const yaml = renderCaller(caller("agent-review-pr.yml"), { ...OPTIONS, publicRepo: false });
  assert.match(yaml, /pull_request_target:/);
  assert.ok(!yaml.includes("author_association"));
});

test("the advance caller triggers on a merge into a spec branch, with no label", () => {
  const yaml = renderCaller(caller("agent-implement-spec-advance.yml"), OPTIONS);
  assert.match(yaml, /^ {2}pull_request:\n {4}types: \[closed\]$/m);
  assert.match(yaml, /github\.event\.pull_request\.merged == true/);
  assert.match(yaml, /startsWith\(github\.event\.pull_request\.base\.ref, 'agent\/spec-'\)/);
  assert.match(yaml, /mode: advance/);
  // Advance reads the merged PR out of the event payload, so a manual run would have
  // nothing to act on.
  assert.ok(!yaml.includes("workflow_dispatch"));
});

// The orchestrator runs no agent and installs no toolchain, so `enable-ruby` is not one
// of `implement-spec.yml`'s inputs — passing it fails the workflow call outright.
test("the orchestrator callers pass no toolchain input", () => {
  for (const file of ["agent-implement-spec-kickoff.yml", "agent-implement-spec-advance.yml"]) {
    const yaml = renderCaller(caller(file), { ...OPTIONS, enableRuby: true });
    assert.ok(!yaml.includes("enable-ruby"), `${file} must not pass enable-ruby`);
  }
});

test("enable-ruby follows the option on the agent verbs", () => {
  assert.match(renderCaller(caller("agent-explore.yml"), OPTIONS), /enable-ruby: false/);
  assert.match(
    renderCaller(caller("agent-explore.yml"), { ...OPTIONS, enableRuby: true }),
    /enable-ruby: true/,
  );
});

test("repinCaller moves only the ref and reports the old one", () => {
  const before = renderCaller(caller("agent-implement.yml"), OPTIONS);
  const after = repinCaller(before, OPTIONS.workflowsRepo, "v2");

  assert.equal(after.from, "v1");
  assert.match(after.content, /implement\.yml@v2/);
  assert.equal(
    after.content.replace("implement.yml@v2", "implement.yml@v1"),
    before,
    "nothing but the ref changed",
  );
});

// The caller is the one generated file a consumer legitimately edits — the `with:`
// inputs are their toolchain and the `if:` is their access policy. `sync` re-pins in
// place precisely so neither is reverted.
test("repinCaller preserves hand-edited inputs and guards", () => {
  const edited = renderCaller(caller("agent-implement.yml"), OPTIONS)
    .replace("enable-ruby: false", "enable-ruby: true\n      system-packages: libvips")
    .replace('git-author-email: "agent@example.com"', 'git-author-email: "bot@corp.example"');

  const after = repinCaller(edited, OPTIONS.workflowsRepo, "v1.6.0");
  assert.match(after.content, /system-packages: libvips/);
  assert.match(after.content, /git-author-email: "bot@corp\.example"/);
  assert.match(after.content, /implement\.yml@v1\.6\.0/);
});

test("repinCaller leaves a caller that points somewhere else alone", () => {
  const foreign = "jobs:\n  x:\n    uses: someone-else/actions/.github/workflows/build.yml@v3\n";
  const after = repinCaller(foreign, OPTIONS.workflowsRepo, "v1");
  assert.equal(after.from, null);
  assert.equal(after.content, foreign);
});

// A consumer is free to put two jobs in one caller file. Moving the first `uses:` and
// reporting the whole file as re-pinned would leave half of it on the old release —
// with the plan saying otherwise.
test("repinCaller moves every uses: into the workflows repo, not just the first", () => {
  const two = [
    "jobs:",
    "  a:",
    "    uses: michaelloistl/agent-workflows/.github/workflows/explore.yml@v1.2.0",
    "  b:",
    "    uses: michaelloistl/agent-workflows/.github/workflows/implement.yml@v1.2.0",
    "  c:",
    "    uses: someone-else/actions/.github/workflows/build.yml@v3",
    "",
  ].join("\n");

  const after = repinCaller(two, OPTIONS.workflowsRepo, "v1.3.0");
  assert.equal(after.from, "v1.2.0");
  assert.match(after.content, /explore\.yml@v1\.3\.0/);
  assert.match(after.content, /implement\.yml@v1\.3\.0/);
  assert.match(after.content, /build\.yml@v3/, "a third-party pin is left alone");
});

// The ref reaches `String.replace` as a replacement string, where `$&` and `$1` mean
// something. A branch name may legitimately contain a `$`.
test("repinCaller inserts a ref containing $ literally", () => {
  const before = renderCaller(caller("agent-explore.yml"), OPTIONS);
  const after = repinCaller(before, OPTIONS.workflowsRepo, "feature/$1-spike");
  assert.match(after.content, /explore\.yml@feature\/\$1-spike$/m);
});

// The commit identity is the one value in a generated caller that comes from outside
// the catalog, so it is the one that can carry a `#` or a `:` into the YAML.
test("the commit identity is written as a quoted scalar", () => {
  const yaml = renderCaller(caller("agent-explore.yml"), {
    ...OPTIONS,
    gitAuthorEmail: "agent+bot@example.com # not a comment",
  });
  assert.match(yaml, /git-author-email: "agent\+bot@example\.com # not a comment"/);
});

// `sync` tells a file it generated from one a human wrote, so it can say whose drift
// it is reporting (see `callerWarnings` in plan.mts).
test("isGeneratedCaller recognises the installer's own marker", () => {
  assert.equal(isGeneratedCaller(renderCaller(caller("agent-explore.yml"), OPTIONS)), true);
  assert.equal(
    isGeneratedCaller("jobs:\n  x:\n    uses: michaelloistl/agent-workflows/x.yml@v1\n"),
    false,
  );
});

test("callersFor expands implement-spec into its two callers", () => {
  const files = callersFor(["implement-spec"]).map((c) => c.file);
  assert.deepEqual(files, [
    "agent-implement-spec-kickoff.yml",
    "agent-implement-spec-advance.yml",
  ]);
});

// `implement` and `implement-pr` deliberately share one label and are told apart by
// the trigger event, so the label list must not contain it twice.
test("labelsFor deduplicates the shared agent:implement label", () => {
  assert.deepEqual(labelsFor(["implement", "implement-pr"]), ["agent:implement"]);
});

test("labelsFor omits advance, which triggers on a merge rather than a label", () => {
  assert.deepEqual(labelsFor(["implement-spec"]), ["agent:implement-spec"]);
});

test("secretsFor asks for a PAT only when the orchestrator is enabled", () => {
  assert.deepEqual(secretsFor(["implement"]).map((s) => s.name), ["CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.deepEqual(secretsFor(["implement-spec"]).map((s) => s.name), [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AGENT_PAT",
  ]);
});

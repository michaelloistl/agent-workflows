import { test } from "node:test";
import assert from "node:assert/strict";

import { renderCaller } from "./callers.mts";
import { CALLERS } from "./catalog.mts";
import type { PlanInput, RepoState } from "./plan.mts";
import { buildPlan, detectVerbs } from "./plan.mts";

const PACKAGED_SCRIPTS = {
  "sandcastle:explore": "node bin/agent-workflows.mjs explore run",
  "sandcastle:explore-guards": "node bin/agent-workflows.mjs explore guards",
  "sandcastle:implement": "node bin/agent-workflows.mjs implement run",
  "sandcastle:implement-guards": "node bin/agent-workflows.mjs implement guards",
  "sandcastle:implement-spec-kickoff": "node bin/agent-workflows.mjs implement-spec kickoff",
};

const EMPTY: RepoState = {
  packageJson: null,
  hasYarnLock: false,
  nodeVersion: null,
  callers: {},
  overrides: [],
  hasConfig: false,
  labels: [],
  secrets: [],
};

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    mode: "init",
    state: EMPTY,
    packagedScripts: PACKAGED_SCRIPTS,
    packagedVersion: "1.5.0",
    verbs: ["explore"],
    workflowsRepo: "michaelloistl/agent-workflows",
    ref: "v1",
    enableRuby: false,
    gitAuthorEmail: "agent@example.com",
    publicRepo: true,
    baseBranch: null,
    ...overrides,
  };
}

function callerFor(file: string) {
  const found = CALLERS.find((c) => c.file === file);
  assert.ok(found);
  return found;
}

const RENDER_OPTIONS = {
  workflowsRepo: "michaelloistl/agent-workflows",
  ref: "v1",
  enableRuby: false,
  gitAuthorEmail: "agent@example.com",
  publicRepo: true,
};

// --- init -------------------------------------------------------------------

test("init on an empty repo writes the caller, the scripts and the dependency", () => {
  const plan = buildPlan(input());

  assert.deepEqual(
    plan.writes.map((w) => w.path),
    [".github/workflows/agent-explore.yml"],
  );
  assert.equal(plan.packageJson?.created, true);
  assert.equal(
    plan.packageJson?.content.devDependencies?.["agent-workflows"],
    "github:michaelloistl/agent-workflows#v1",
  );
  assert.deepEqual(plan.labels, ["agent:explore"]);
  assert.equal(plan.install, true);
  assert.equal(plan.blocked, null);
});

// A repo with no package.json is the normal case for a Rails or Go consumer: the hooks
// are Node, the app is not. Refusing would make the installer useless to exactly the
// stack the toolchain flag exists for.
test("init creates a minimal package.json rather than refusing", () => {
  const plan = buildPlan(input());
  assert.equal(plan.packageJson?.content.private, true);
  assert.ok(Object.keys(plan.packageJson?.content.scripts ?? {}).length > 0);
});

test("init defaults to every verb when none is selected", () => {
  const plan = buildPlan(input({ verbs: null }));
  assert.deepEqual(plan.verbs, [
    "explore",
    "implement",
    "implement-pr",
    "review-pr",
    "update-branch",
    "implement-spec",
  ]);
});

test("init writes a config file only when a base branch is given", () => {
  assert.ok(!buildPlan(input()).writes.some((w) => w.path.endsWith("config.json")));

  const plan = buildPlan(input({ baseBranch: "develop" }));
  const config = plan.writes.find((w) => w.path.endsWith("config.json"));
  assert.ok(config);
  assert.deepEqual(JSON.parse(config.content), { baseBranch: "develop" });
});

test("init re-pins a caller that is already there instead of regenerating it", () => {
  const existing = renderCaller(callerFor("agent-explore.yml"), {
    ...RENDER_OPTIONS,
    ref: "v1.2.0",
    enableRuby: true,
  });
  const plan = buildPlan(input({ state: { ...EMPTY, callers: { "agent-explore.yml": existing } } }));

  const write = plan.writes.find((w) => w.path.endsWith("agent-explore.yml"));
  assert.ok(write);
  assert.equal(write.existing, true);
  assert.match(write.reason, /re-pin v1\.2\.0 → v1/);
  // The consumer's toolchain choice survives — the point of re-pinning over rewriting.
  assert.match(write.content, /enable-ruby: true/);
});

// --- sync -------------------------------------------------------------------

// Caught in the planner rather than the entry point because it is a decision about the
// repo, and because running `init` from inside a checkout of the package is the single
// easiest mistake to make: its hook scripts deliberately run `node bin/…` against its
// own source, and an install would rewrite every one of them.
test("neither command touches the central package's own checkout", () => {
  for (const mode of ["init", "sync"] as const) {
    const state: RepoState = { ...EMPTY, packageJson: { name: "agent-workflows" } };
    const plan = buildPlan(input({ mode, state, verbs: null }));
    assert.match(plan.blocked ?? "", /never installs itself/);
    assert.deepEqual(plan.writes, []);
    assert.equal(plan.packageJson, null);
  }
});

test("sync refuses on a repo that was never installed", () => {
  const plan = buildPlan(input({ mode: "sync", verbs: null }));
  assert.match(plan.blocked ?? "", /run `agent-workflows init` first/);
  assert.deepEqual(plan.writes, []);
});

test("sync detects the enabled verbs from the callers and the scripts", () => {
  const state: RepoState = {
    ...EMPTY,
    callers: { "agent-explore.yml": renderCaller(callerFor("agent-explore.yml"), RENDER_OPTIONS) },
    packageJson: { scripts: { "sandcastle:implement": "agent-workflows implement run" } },
  };
  assert.deepEqual(detectVerbs(state), ["explore", "implement"]);
});

// The verb is read from the command's first argument, so a hyphenated verb is not
// mistaken for a shorter one that prefixes it.
test("detectVerbs does not read implement-pr scripts as implement", () => {
  const state: RepoState = {
    ...EMPTY,
    packageJson: { scripts: { "sandcastle:implement-pr": "agent-workflows implement-pr run" } },
  };
  assert.deepEqual(detectVerbs(state), ["implement-pr"]);
});

// The self-maintaining half: a hook added to the central package reaches consumers on
// their next sync, with no list for them to update.
test("sync adds hooks that the package gained since the last install", () => {
  const state: RepoState = {
    ...EMPTY,
    packageJson: {
      scripts: { "sandcastle:explore": "agent-workflows explore run" },
      devDependencies: { "agent-workflows": "github:michaelloistl/agent-workflows#v1" },
    },
  };
  const plan = buildPlan(input({ mode: "sync", verbs: null, state }));
  assert.deepEqual(plan.packageJson?.scripts.added, ["sandcastle:explore-guards"]);
});

// A verb is enabled by HAVING a caller, so writing a missing one would re-enable
// something the human disabled by deleting the file.
test("sync never creates a caller, but says the verb has nothing to trigger it", () => {
  const state: RepoState = {
    ...EMPTY,
    packageJson: {
      scripts: { "sandcastle:explore": "agent-workflows explore run" },
      devDependencies: { "agent-workflows": "github:michaelloistl/agent-workflows#v1" },
    },
  };
  const plan = buildPlan(input({ mode: "sync", verbs: null, state }));

  assert.deepEqual(plan.writes, []);
  assert.ok(
    plan.warnings.some((w) => /has hook scripts but no agent-explore\.yml/.test(w.message)),
  );
});

test("sync moves the dependency pin and asks for a reinstall", () => {
  const state: RepoState = {
    ...EMPTY,
    callers: {
      "agent-explore.yml": renderCaller(callerFor("agent-explore.yml"), {
        ...RENDER_OPTIONS,
        ref: "v1.2.0",
      }),
    },
    packageJson: {
      scripts: {
        "sandcastle:explore": "agent-workflows explore run",
        "sandcastle:explore-guards": "agent-workflows explore guards",
      },
      devDependencies: { "agent-workflows": "github:michaelloistl/agent-workflows#v1.2.0" },
    },
  };
  const plan = buildPlan(input({ mode: "sync", verbs: null, state }));

  assert.equal(plan.packageJson?.dependency.from, "v1.2.0");
  assert.equal(plan.packageJson?.dependency.to, "v1");
  assert.equal(plan.install, true);
});

test("sync on an up-to-date repo plans nothing", () => {
  const state: RepoState = {
    ...EMPTY,
    hasYarnLock: true,
    nodeVersion: "22",
    labels: ["agent:explore"],
    secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
    callers: { "agent-explore.yml": renderCaller(callerFor("agent-explore.yml"), RENDER_OPTIONS) },
    packageJson: {
      scripts: {
        "sandcastle:explore": "agent-workflows explore run",
        "sandcastle:explore-guards": "agent-workflows explore guards",
      },
      devDependencies: { "agent-workflows": "github:michaelloistl/agent-workflows#v1" },
    },
  };
  const plan = buildPlan(input({ mode: "sync", verbs: null, state }));

  assert.deepEqual(plan.writes, []);
  assert.equal(plan.packageJson, null);
  assert.deepEqual(plan.labels, []);
  assert.equal(plan.install, false);
  assert.deepEqual(plan.warnings, []);
});

// --- warnings ---------------------------------------------------------------

// An override shadows the packaged entrypoint forever and silently: a copy taken at
// v1.1 keeps running after the package moves to v1.5, and nothing else says so.
test("overrides are reported against the version that is being installed", () => {
  const plan = buildPlan(
    input({ state: { ...EMPTY, overrides: ["implement/prompt.md", "review/finalize.mts"] } }),
  );
  const warning = plan.warnings.find((w) => /shadow the packaged/.test(w.message));
  assert.ok(warning);
  assert.match(warning.message, /v1\.5\.0/);
  assert.match(warning.message, /implement\/prompt\.md/);
});

test("a missing secret is reported but never written", () => {
  const plan = buildPlan(input({ verbs: ["implement-spec"] }));
  const names = plan.warnings.map((w) => w.message);
  assert.ok(names.some((m) => /CLAUDE_CODE_OAUTH_TOKEN is not set/.test(m)));
  assert.ok(names.some((m) => /AGENT_PAT is not set/.test(m)));
});

// Reading secrets needs admin. A collaborator without it must not be told the secrets
// are missing when they may well be set.
test("secrets that could not be read are not reported as missing", () => {
  const plan = buildPlan(input({ state: { ...EMPTY, secrets: null } }));
  assert.ok(!plan.warnings.some((w) => /is not set on this repo/.test(w.message)));
});

test("a missing lockfile and node version are reported", () => {
  const plan = buildPlan(input());
  assert.ok(plan.warnings.some((w) => /no yarn\.lock/.test(w.message)));
  assert.ok(plan.warnings.some((w) => /no \.node-version/.test(w.message)));
});

test("a caller pointing at a different repo is reported, not rewritten", () => {
  const foreign = "jobs:\n  x:\n    uses: fork/agent-workflows/.github/workflows/explore.yml@v1\n";
  const plan = buildPlan(input({ state: { ...EMPTY, callers: { "agent-explore.yml": foreign } } }));

  assert.deepEqual(plan.writes, []);
  assert.ok(plan.warnings.some((w) => /does not call michaelloistl\/agent-workflows/.test(w.message)));
});

// Narrowing the verb selection removes hook scripts, but the installer will not delete
// a workflow file to enact it — that would silently disable a verb the human may still
// be labelling issues for.
test("a caller for an unselected verb is reported rather than deleted", () => {
  const state: RepoState = {
    ...EMPTY,
    callers: {
      "agent-implement.yml": renderCaller(callerFor("agent-implement.yml"), RENDER_OPTIONS),
    },
  };
  const plan = buildPlan(input({ verbs: ["explore"], state }));

  assert.ok(!plan.writes.some((w) => w.path.endsWith("agent-implement.yml")));
  assert.ok(
    plan.warnings.some((w) => /agent-implement\.yml is present but `implement`/.test(w.message)),
  );
});

test("every warning carries an instruction", () => {
  const plan = buildPlan(input({ verbs: null }));
  for (const warning of plan.warnings) {
    assert.ok(warning.fix.length > 0, `no fix for: ${warning.message}`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  consumerScripts,
  dependencySpec,
  derivePackagedScripts,
  dispatcherVerb,
  mergeScripts,
  refFromSpec,
} from "./scripts.mts";

const PACKAGED = {
  typecheck: "tsc --noEmit",
  "agent:explore": "node bin/agent-workflows.mjs explore",
  "sandcastle:explore": "node bin/agent-workflows.mjs explore run",
  "sandcastle:explore-guards": "node bin/agent-workflows.mjs explore guards",
  "sandcastle:implement-pr-guards": "node bin/agent-workflows.mjs implement-pr guards",
  "sandcastle:implement-spec-kickoff": "node bin/agent-workflows.mjs implement-spec kickoff",
};

test("derivePackagedScripts copies only the sandcastle namespace", () => {
  const names = derivePackagedScripts(PACKAGED).map((s) => s.name);
  assert.ok(!names.includes("typecheck"));
  // `agent:*` scripts are human conveniences in the central repo, not part of the
  // hook contract the workflows call.
  assert.ok(!names.includes("agent:explore"));
  assert.ok(names.includes("sandcastle:explore"));
});

test("derivePackagedScripts rewrites the packaged bin path to the consumer bin", () => {
  const script = derivePackagedScripts(PACKAGED).find((s) => s.name === "sandcastle:explore");
  assert.equal(script?.command, "agent-workflows explore run");
});

// The script NAME is ambiguous across hyphenated verbs — `sandcastle:implement-spec-kickoff`
// could be read as verb `implement`, hook `spec-kickoff` — so the verb is taken from
// the command's first argument, which is exactly what the dispatcher classifies.
test("derivePackagedScripts reads the verb from the command, not the script name", () => {
  const byName = Object.fromEntries(derivePackagedScripts(PACKAGED).map((s) => [s.name, s.verb]));
  assert.equal(byName["sandcastle:implement-pr-guards"], "implement-pr");
  assert.equal(byName["sandcastle:implement-spec-kickoff"], "implement-spec");
});

test("derivePackagedScripts skips a sandcastle script that bypasses the dispatcher", () => {
  const derived = derivePackagedScripts({ "sandcastle:local": "./scripts/local.sh" });
  assert.deepEqual(derived, []);
});

test("consumerScripts keeps only the selected verbs", () => {
  const scripts = consumerScripts(PACKAGED, ["explore"]);
  assert.deepEqual(Object.keys(scripts), ["sandcastle:explore", "sandcastle:explore-guards"]);
});

// The real package.json is the source of truth, so the derivation has to survive it —
// a hook added there must reach consumers with no second list to update.
test("consumerScripts derives every verb's hooks from the real package.json", () => {
  const real = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
  );
  const scripts = consumerScripts(real.scripts, [
    "explore",
    "implement",
    "implement-pr",
    "review-pr",
    "update-branch",
    "implement-spec",
  ]);
  const names = Object.keys(scripts);
  // The asymmetries a hand-written matrix gets wrong: explore has a plain `-sequence`,
  // the PR verbs have a `-guards-sequence` instead, and the orchestrator has neither
  // `run` nor `fetch-spec`.
  assert.ok(names.includes("sandcastle:explore-sequence"));
  assert.ok(names.includes("sandcastle:review-pr-guards-sequence"));
  assert.ok(names.includes("sandcastle:implement-spec-advance"));
  assert.ok(!names.includes("sandcastle:review-pr-fetch-spec"));
  assert.ok(names.every((name) => scripts[name].startsWith("agent-workflows ")));
});

test("mergeScripts adds, updates and leaves foreign keys alone", () => {
  const merged = mergeScripts(
    { test: "vitest", "sandcastle:explore": "agent-workflows explore old" },
    { "sandcastle:explore": "agent-workflows explore run", "sandcastle:explore-guards": "x" },
  );
  assert.equal(merged.scripts.test, "vitest", "a non-sandcastle script is untouched");
  assert.deepEqual(merged.changed, ["sandcastle:explore"]);
  assert.deepEqual(merged.added, ["sandcastle:explore-guards"]);
});

// A stale hook script is worse than a missing one: the workflow calling it fails at the
// point of use, long after the install that should have caught it. So a script that
// calls the dispatcher and is no longer desired is removed.
test("mergeScripts removes a dispatcher script that is no longer desired", () => {
  const merged = mergeScripts(
    { "sandcastle:implement-prd-kickoff": "agent-workflows implement-prd kickoff" },
    { "sandcastle:implement-spec-kickoff": "agent-workflows implement-spec kickoff" },
  );
  assert.deepEqual(merged.removed, ["sandcastle:implement-prd-kickoff"]);
  assert.ok(!("sandcastle:implement-prd-kickoff" in merged.scripts));
});

// `.sandcastle/` is the consumer's own hook layer, so the namespace is not the
// installer's to empty: only the scripts that call the dispatcher are.
test("mergeScripts keeps a sandcastle script that is not the installer's", () => {
  const merged = mergeScripts(
    { "sandcastle:seed": "bin/rails db:seed" },
    { "sandcastle:explore": "agent-workflows explore run" },
  );
  assert.deepEqual(merged.removed, []);
  assert.equal(merged.scripts["sandcastle:seed"], "bin/rails db:seed");
});

test("dispatcherVerb reads the verb a hook script drives, and only ours", () => {
  assert.equal(dispatcherVerb("node bin/agent-workflows.mjs implement-pr guards"), "implement-pr");
  assert.equal(dispatcherVerb("agent-workflows implement --guards-only"), "implement");
  assert.equal(dispatcherVerb("yarn agent-workflows status"), "status");
  assert.equal(dispatcherVerb("bin/rails db:seed"), null);
});

test("dependencySpec and refFromSpec round-trip a git pin", () => {
  const spec = dependencySpec("michaelloistl/agent-workflows", "v1");
  assert.equal(spec, "github:michaelloistl/agent-workflows#v1");
  assert.equal(refFromSpec(spec), "v1");
  assert.equal(refFromSpec("^1.2.0"), null, "a registry range is not one of ours");
  assert.equal(refFromSpec(undefined), null);
});

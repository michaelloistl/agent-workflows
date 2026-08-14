// `agent-workflows init` / `agent-workflows sync` — the INSTALL entry point.
//
// The fourth entry point to this package, and the only one that runs before the
// package is installed: `npx github:<owner>/agent-workflows#v1 init` fetches the
// package into npm's cache and runs it against the repo you are standing in, and its
// last act is to add itself as a real devDependency so every later run is
// `yarn agent-workflows sync`. The installer therefore always ships at the same
// version as the workflows it installs, which is what lets `sync` know both the old
// shape and the new one.
//
// This file is the DISPATCH half throughout: it owns `process.argv`, the filesystem,
// `gh`, and the confirmation prompt. Every decision — which verbs, which files, what
// changed, what to warn about — is made in `plan.mts` and its neighbours, against data.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CALLERS } from "./catalog.mts";
import type { PackageJson, Plan, RepoState } from "./plan.mts";
import { buildPlan } from "./plan.mts";
import { defaultRef, parseInstallArgs } from "./options.mts";

// The repo these workflows live in, for consumers who install from the canonical
// source. A fork overrides it with `--workflows-repo`, and the packaged
// `repository` field is preferred when present so a fork's own package needs no flag.
const DEFAULT_WORKFLOWS_REPO = "michaelloistl/agent-workflows";
const WORKFLOW_DIR = ".github/workflows";
const OVERRIDE_DIR = ".sandcastle/agent-workflows";

const mode = process.argv[2] === "sync" ? "sync" : "init";
const parsed = parseInstallArgs(process.argv.slice(3));
if (!parsed.ok) {
  console.error(`agent-workflows ${mode}: ${parsed.message}`);
  process.exit(2);
}
const options = parsed.options;

// ---------------------------------------------------------------------------
// Reading the world
// ---------------------------------------------------------------------------

// Run a command, returning its trimmed stdout or null when it fails for ANY reason.
// Every read here is optional by design: no `gh`, no auth, or no network degrades the
// plan (fewer labels known, no secret check) rather than failing the install, because
// the file-writing half is useful on its own and works offline.
function tryCapture(file: string, args: readonly string[]): string | null {
  const result = spawnSync(file, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0 || result.error) return null;
  return (result.stdout ?? "").trim();
}

// The install target is the repo ROOT, never the subdirectory you happen to be in:
// `.github/workflows` and `package.json` belong at the top, and an install that wrote
// them beside you would produce a repo where nothing triggers.
const foundRoot = tryCapture("git", ["rev-parse", "--show-toplevel"]);
if (foundRoot === null) {
  console.error(
    `agent-workflows ${mode}: not a git repository — run this inside the checkout you want to set up.`,
  );
  process.exit(1);
}
const repoRoot: string = foundRoot;

const packagedPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const packaged = JSON.parse(readFileSync(packagedPath, "utf8")) as PackageJson & {
  version?: string;
  repository?: string | { url?: string };
};
const packagedVersion = packaged.version ?? "0.0.0";

function readJson(path: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Every file under the override dir except the config file, which is configuration
// rather than a shadowed entrypoint and updates with nothing.
function listOverrides(dir: string): readonly string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name !== "config.json") found.push(relative(dir, path));
    }
  };
  walk(dir);
  return found.sort();
}

function ghJsonNames(args: readonly string[]): readonly string[] | null {
  const out = tryCapture("gh", [...args, "--json", "name", "--jq", ".[].name"]);
  if (out === null) return null;
  return out.split("\n").filter((line) => line !== "");
}

const callers: Record<string, string> = {};
for (const caller of CALLERS) {
  const content = readText(join(repoRoot, WORKFLOW_DIR, caller.file));
  if (content !== null) callers[caller.file] = content;
}

const state: RepoState = {
  packageJson: readJson(join(repoRoot, "package.json")),
  hasYarnLock: existsSync(join(repoRoot, "yarn.lock")),
  nodeVersion: readText(join(repoRoot, ".node-version"))?.trim() ?? null,
  callers,
  overrides: listOverrides(join(repoRoot, OVERRIDE_DIR)),
  hasConfig: existsSync(join(repoRoot, OVERRIDE_DIR, "config.json")),
  labels: ghJsonNames(["label", "list", "--limit", "200"]) ?? [],
  // `gh secret list` needs admin; a collaborator without it gets null, and the plan
  // then says nothing about secrets rather than claiming they are missing.
  secrets: ghJsonNames(["secret", "list"]),
};

// Defaults that come from the repo rather than a flag, so the common install needs no
// arguments at all.
const gitAuthorEmail =
  options.gitAuthorEmail ?? tryCapture("git", ["config", "user.email"]) ?? "";
if (gitAuthorEmail === "") {
  console.error(
    `agent-workflows ${mode}: no commit identity — set \`git config user.email\` or pass \`--email=\`.`,
  );
  process.exit(1);
}

// Ruby follows the repo: a Gemfile means the workflow should bring up Ruby, Postgres
// and Redis so the agent gets a green test suite (ADR-0002). Everything else runs the
// Node-only toolchain.
const enableRuby = options.enableRuby ?? existsSync(join(repoRoot, "Gemfile"));

const visibility = tryCapture("gh", ["repo", "view", "--json", "visibility", "--jq", ".visibility"]);
// Unknown visibility is treated as PUBLIC: the author gate it implies is a
// restriction, and guessing "private" would generate an ungated
// `pull_request_target` caller — the one mistake here with a security cost.
const publicRepo = visibility === null || visibility.toUpperCase() === "PUBLIC";

const packagedRepo =
  typeof packaged.repository === "string"
    ? packaged.repository
    : (packaged.repository?.url ?? "").replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
const workflowsRepo =
  options.workflowsRepo ??
  (/^[\w.-]+\/[\w.-]+$/.test(packagedRepo) ? packagedRepo : DEFAULT_WORKFLOWS_REPO);

const plan = buildPlan({
  mode,
  state,
  packagedScripts: packaged.scripts ?? {},
  packagedVersion,
  verbs: options.verbs,
  workflowsRepo,
  ref: options.ref ?? defaultRef(packagedVersion),
  enableRuby,
  gitAuthorEmail,
  publicRepo,
  baseBranch: options.baseBranch,
});

// ---------------------------------------------------------------------------
// Showing the plan
// ---------------------------------------------------------------------------

function describe(plan: Plan): string {
  const lines: string[] = [];
  const ref = options.ref ?? defaultRef(packagedVersion);
  lines.push(`agent-workflows ${plan.mode} — ${relative(process.cwd(), repoRoot) || "."}`);
  lines.push(`  package   ${workflowsRepo}@${ref} (installer v${packagedVersion})`);
  lines.push(`  verbs     ${plan.verbs.join(", ") || "none"}`);
  lines.push(`  toolchain ${enableRuby ? "Node + Ruby/Postgres/Redis" : "Node only"}`);
  lines.push(`  identity  ${gitAuthorEmail}`);
  lines.push("");

  if (plan.packageJson) {
    const { scripts, dependency, created } = plan.packageJson;
    lines.push(created ? "  package.json (create)" : "  package.json");
    if (dependency.from !== dependency.to) {
      lines.push(`    dependency  ${dependency.from ?? "(none)"} → ${dependency.to}`);
    }
    for (const [label, names] of [
      ["add", scripts.added],
      ["update", scripts.changed],
      ["remove", scripts.removed],
    ] as const) {
      if (names.length > 0) lines.push(`    ${label} ${names.length} script(s): ${names.join(", ")}`);
    }
  }

  for (const write of plan.writes) {
    lines.push(`  ${write.path} ${write.existing ? "(edit)" : "(create)"} — ${write.reason}`);
  }
  if (plan.labels.length > 0) lines.push(`  labels (create) — ${plan.labels.join(", ")}`);
  if (plan.install) lines.push("  yarn install");

  if (plan.writes.length === 0 && plan.packageJson === null && plan.labels.length === 0) {
    lines.push("  nothing to change — already up to date");
  }

  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("  warnings (not fixed automatically):");
    for (const warning of plan.warnings) {
      lines.push(`    ! ${warning.message}`);
      lines.push(`      → ${warning.fix}`);
    }
  }

  return lines.join("\n");
}

console.log(describe(plan));

if (plan.blocked !== null) {
  console.error(`\nagent-workflows ${mode}: ${plan.blocked}`);
  process.exit(1);
}

const hasChanges =
  plan.writes.length > 0 || plan.packageJson !== null || plan.labels.length > 0 || plan.install;

if (options.dryRun) {
  console.log("\ndry run — nothing was changed.");
  process.exit(0);
}
if (!hasChanges) process.exit(0);

// The same confirmation shape as the spec loop: the whole blast radius is printed
// first, a non-interactive stdin declines, and `--yes` pre-accepts while still leaving
// the printed plan and a line naming the flag that accepted it.
function confirm(question: string): boolean {
  process.stdout.write(question);
  const res = spawnSync("bash", ["-c", 'read -r reply; printf "%s" "$reply"'], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
  });
  const answer = (res.stdout ?? "").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

if (options.yes) {
  console.log("\naccepted by --yes");
} else if (!confirm("\napply this plan? [y/N] ")) {
  console.log("declined — nothing was changed.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

if (plan.packageJson) {
  // Reserialised at two-space indent with a trailing newline — npm's own format, and
  // what `yarn` rewrites it to anyway.
  write(join(repoRoot, "package.json"), `${JSON.stringify(plan.packageJson.content, null, 2)}\n`);
  console.log(`wrote package.json`);
}

for (const file of plan.writes) {
  write(resolve(repoRoot, file.path), file.content);
  console.log(`wrote ${file.path}`);
}

for (const label of plan.labels) {
  const created = spawnSync(
    "gh",
    ["label", "create", label, "--color", "1f6feb", "--description", `Trigger: ${label.replace("agent:", "")} agent run`],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
  );
  if (created.status === 0) console.log(`created label ${label}`);
  else console.log(`could not create label ${label} — ${(created.stderr ?? "").trim()}`);
}

if (plan.install || !existsSync(join(repoRoot, "node_modules", "agent-workflows"))) {
  console.log("running yarn install…");
  const installed = spawnSync("yarn", ["install"], { cwd: repoRoot, stdio: "inherit" });
  if (installed.status !== 0) {
    console.error(
      "\nyarn install failed — fix it and re-run, or install the dependency by hand.",
    );
    process.exit(1);
  }
}

console.log("");
for (const note of plan.notes) console.log(`note: ${note}`);
console.log(
  `\ndone. Review the changes, commit them, and run \`yarn agent-workflows sync\` to update later.`,
);

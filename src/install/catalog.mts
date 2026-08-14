// The INSTALL CATALOG: what a consuming repo needs, per verb, to run the fleet.
//
// `init` and `sync` are the fourth entry point to this package (after the workflow
// sequencer, the local sequencer, and the status view). They set a repo UP to use
// the fleet rather than running any part of it, so nothing here follows the hook
// contract — this is the data the five manual Installation steps in the README were
// asking a human to transcribe by hand.
//
// Everything the installer knows about a verb lives in one row below, and both the
// caller renderer and the label step read the same row. The alternative — a label
// list here, a permissions table there — is exactly how a repo ends up with a caller
// that triggers on a label nothing creates.

// The verbs a consumer can enable. `implement-spec` is the orchestrator; it is
// selected like a verb but expands to TWO callers (kickoff and advance).
export const VERBS = [
  "explore",
  "implement",
  "implement-pr",
  "review-pr",
  "update-branch",
  "implement-spec",
] as const;

export type Verb = (typeof VERBS)[number];

export function isVerb(value: string): value is Verb {
  return (VERBS as readonly string[]).includes(value);
}

// How a caller is triggered. The three shapes differ in more than their `on:` block —
// each implies a different `if:` guard, and `pr-target` additionally implies the
// author gate on a public repo (it runs PR-head code with secrets).
export type TriggerKind =
  // `issues: [labeled]` — the label event runs the workflow from the default branch.
  | "issue-label"
  // `pull_request_target: [labeled]` — carries secrets, so it is gated by author
  // association on a public repo.
  | "pr-target-label"
  // `pull_request: [closed]` — no label, no PR-head code (advance only).
  | "pr-merge";

export interface Permissions {
  readonly contents: "read" | "write";
  readonly issues: "read" | "write";
  readonly "pull-requests": "read" | "write";
}

// One caller file to write. Most verbs produce one; `implement-spec` produces two,
// which is why the catalog is keyed by caller rather than by verb.
export interface CallerSpec {
  // The verb this caller belongs to — what `--verbs` selects on.
  readonly verb: Verb;
  // `.github/workflows/<file>`.
  readonly file: string;
  // The `name:` of the workflow.
  readonly name: string;
  // The single job's id.
  readonly job: string;
  // The reusable workflow in the central repo this calls (`<workflow>.yml`).
  readonly workflow: string;
  readonly trigger: TriggerKind;
  // The trigger label a human applies, or null when nothing triggers on a label
  // (advance fires on a merge). Also the list the label step creates.
  readonly label: string | null;
  readonly permissions: Permissions;
  // Extra `with:` inputs beyond the two every caller passes (`enable-ruby`,
  // `git-author-email`). `implement-spec` selects its mode this way.
  readonly with?: Readonly<Record<string, string>>;
  // Whether this caller takes the `enable-ruby` toolchain input. The orchestrator
  // runs no agent and installs no toolchain, so passing it there is an error.
  readonly toolchain: boolean;
  // The comment block at the top of the generated file, explaining what the caller
  // does. Written for the human who opens the file six months later.
  readonly blurb: readonly string[];
}

export const CALLERS: readonly CallerSpec[] = [
  {
    verb: "explore",
    file: "agent-explore.yml",
    name: "Agent Explore",
    job: "explore",
    workflow: "explore.yml",
    trigger: "issue-label",
    label: "agent:explore",
    permissions: { contents: "read", issues: "write", "pull-requests": "read" },
    toolchain: true,
    blurb: [
      "Thin caller: label an issue `agent:explore` → run the reusable `explore`",
      "workflow read-only → the sandcastle hooks post the exploration comment.",
      "",
      "Label events run the workflow on the DEFAULT branch, so this file must be on",
      "the default branch to fire.",
    ],
  },
  {
    verb: "implement",
    file: "agent-implement.yml",
    name: "Agent Implement",
    job: "implement",
    workflow: "implement.yml",
    trigger: "issue-label",
    label: "agent:implement",
    permissions: { contents: "write", issues: "write", "pull-requests": "write" },
    toolchain: true,
    blurb: [
      "Thin caller: label an issue `agent:implement` → run the reusable `implement`",
      "workflow → the agent builds the issue on an `agent/…` branch, the workflow",
      "pushes it, and the `implement-finalize` hook opens the draft PR.",
      "",
      "Label events run the workflow on the DEFAULT branch, so this file must be on",
      "the default branch to fire.",
    ],
  },
  {
    verb: "implement-pr",
    file: "agent-implement-pr.yml",
    name: "Agent Implement PR",
    job: "implement-pr",
    workflow: "implement-pr.yml",
    trigger: "pr-target-label",
    label: "agent:implement",
    permissions: { contents: "write", issues: "write", "pull-requests": "write" },
    toolchain: true,
    blurb: [
      "Thin caller: label an open PR `agent:implement` → run the reusable",
      "`implement-pr` workflow → the agent addresses review feedback and commits, the",
      "workflow pushes, and the `implement-pr-finalize` hook posts threaded replies.",
      "Distinguished from the issue-triggered `agent:implement` by the trigger event.",
    ],
  },
  {
    verb: "review-pr",
    file: "agent-review-pr.yml",
    name: "Agent Review PR",
    job: "review-pr",
    workflow: "review-pr.yml",
    trigger: "pr-target-label",
    label: "agent:review-pr",
    permissions: { contents: "read", issues: "write", "pull-requests": "write" },
    toolchain: true,
    blurb: [
      "Thin caller: label an open PR `agent:review-pr` → run the reusable `review-pr`",
      "workflow read-only → the `review-pr-finalize` hook posts the review.",
    ],
  },
  {
    verb: "update-branch",
    file: "agent-update-branch.yml",
    name: "Agent Update Branch",
    job: "update-branch",
    workflow: "update-branch.yml",
    trigger: "pr-target-label",
    label: "agent:update-branch",
    permissions: { contents: "write", issues: "write", "pull-requests": "write" },
    toolchain: true,
    blurb: [
      "Thin caller: label an open PR `agent:update-branch` → run the reusable",
      "`update-branch` workflow → the agent merges the base branch in, the workflow",
      "pushes, and the `update-branch-finalize` hook posts the outcome.",
    ],
  },
  {
    verb: "implement-spec",
    file: "agent-implement-spec-kickoff.yml",
    name: "Agent Implement spec (kickoff)",
    job: "kickoff",
    workflow: "implement-spec.yml",
    trigger: "issue-label",
    label: "agent:implement-spec",
    permissions: { contents: "write", issues: "write", "pull-requests": "write" },
    with: { mode: "kickoff" },
    toolchain: false,
    blurb: [
      "Thin caller: label a spec issue `agent:implement-spec` → run the reusable",
      "`implement-spec` orchestrator in kickoff mode → it cuts the spec branch and",
      "dispatches the first tracer-bullet. The advance side is a separate caller",
      "(on PR-merge).",
    ],
  },
  {
    verb: "implement-spec",
    file: "agent-implement-spec-advance.yml",
    name: "Agent Implement spec (advance)",
    job: "advance",
    workflow: "implement-spec.yml",
    trigger: "pr-merge",
    label: null,
    permissions: { contents: "write", issues: "write", "pull-requests": "write" },
    with: { mode: "advance" },
    toolchain: false,
    blurb: [
      "Thin caller: when a tracer-bullet PR merges into a spec branch, run the reusable",
      "`implement-spec` orchestrator in advance mode → it closes the merged slice and",
      "dispatches the next, or opens the final spec→default PR. Plain `pull_request`",
      "(not `_target`): advance runs no PR-head code, only `gh` orchestration, and",
      "slice PRs are internal so the event carries secrets.",
    ],
  },
];

// The callers a selection of verbs implies, in catalog order.
export function callersFor(verbs: readonly Verb[]): readonly CallerSpec[] {
  return CALLERS.filter((caller) => verbs.includes(caller.verb));
}

// The trigger labels a selection of verbs implies — deduplicated, because
// `implement` and `implement-pr` deliberately share `agent:implement` (they are told
// apart by the trigger event, not the label).
//
// STATE labels (`agent:in-progress`, `agent:review`, `agent:blocked`) and the
// `agent:local` run marker are deliberately absent: the hooks create those on first
// use, so creating them here would only duplicate a step that already works.
export function labelsFor(verbs: readonly Verb[]): readonly string[] {
  const labels = callersFor(verbs)
    .map((caller) => caller.label)
    .filter((label): label is string => label !== null);
  return [...new Set(labels)];
}

// The secrets a selection of verbs needs, and why. Reported, never written: the
// installer reads and writes no secret material, and `AGENT_PAT` cannot be minted
// without a human in the GitHub UI.
export interface SecretRequirement {
  readonly name: string;
  readonly required: boolean;
  readonly why: string;
}

export function secretsFor(verbs: readonly Verb[]): readonly SecretRequirement[] {
  const secrets: SecretRequirement[] = [
    {
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      // Every verb runs an agent. The orchestrator does not, but it dispatches verbs
      // that do, so a repo with only `implement-spec` enabled still needs this.
      required: true,
      why: "every agent run authenticates with it",
    },
  ];
  if (verbs.includes("implement-spec")) {
    secrets.push({
      name: "AGENT_PAT",
      required: true,
      why: "spec slice and final PRs must be authored by a real collaborator",
    });
  }
  return secrets;
}

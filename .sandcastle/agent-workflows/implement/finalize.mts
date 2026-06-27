// `implement-finalize` hook. Open the draft PR for the pushed `agent/…` branch
// with the tracker cross-reference (`Closes #N`). PR *creation* is a hook (not
// the central workflow) because the cross-ref is tracker-aware (ADR-0001,
// Decision 7). The PR targets `BASE` — a PRD branch for a stacked tracer-bullet,
// the default branch otherwise (the workflow resolves the fallback).
import { required, capture } from "../shared/process.mts";

const number = required("ISSUE_NUMBER");
const title = required("ISSUE_TITLE");
const branch = required("BRANCH");
const base = process.env.BASE;

const body = `Automated by the agent-implement workflow for #${number}.\n\nCloses #${number}`;
const args = ["pr", "create", "--draft", "--head", branch, "--title", title, "--body", body];
if (base) args.push("--base", base);
capture("gh", args);
console.log(`Issue #${number}: opened draft PR from ${branch} → ${base || "(default)"}.`);

// `explore-fetch-spec` hook. Materialize the issue (with its comments) to
// $SPEC_FILE so the read-only exploration prompt can inline it. The central
// workflow does no tracker reads (ADR-0001, Decision 7); this hook is that read.
import { writeFileSync } from "node:fs";
import { required, capture } from "../shared/process.mts";

const issueNumber = required("ISSUE_NUMBER");
const specFile = required("SPEC_FILE");

writeFileSync(specFile, capture("gh", ["issue", "view", issueNumber, "--comments"]));
console.log(`Issue #${issueNumber}: wrote spec to ${specFile}.`);

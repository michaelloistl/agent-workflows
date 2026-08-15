// Where the RUNNING PACKAGE VERSION comes from: the manifest of the exact package copy this
// module was loaded from, not the consuming repo's dependency range, a git ref or a remote
// release (issue #121). The read lives here rather than inline in `run.mts` so the path that
// joins the manifest to the footer is a function a test can call — the footer's own fallback
// is `version unknown`, which would otherwise hide a broken link rather than report it.
//
// The dispatch half of the pair: it touches the filesystem, and `frame.mts` next door stays
// pure and decides only what counts as a version.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { packageVersion, type RunningVersion } from "./frame.mts";

// Every failure is unknown rather than fatal — missing file, unreadable bytes, unparseable
// JSON, no version in it: a damaged manifest costs the footer its number, never the operator
// their view. Call it ONCE, at process startup: a `--watch` left open across a `yarn install`
// keeps the version of the code it is actually still running.
export function runningVersion(): RunningVersion {
  try {
    const path = fileURLToPath(new URL("../../package.json", import.meta.url));
    return packageVersion(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

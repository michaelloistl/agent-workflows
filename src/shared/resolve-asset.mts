import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// Override-resolution for prompt/asset files (issue #31).
//
// The packaged default sits next to the entrypoint that uses it
// (`import.meta.dirname`). A consuming repo may override it by dropping a file
// at the matching relative path under its own
// `.sandcastle/agent-workflows/<verb-dir>/` — that local copy wins. The rule is
// uniform with the dispatcher's entrypoint resolution: anything in the override
// dir wins, else the packaged default.
//
// `<verb-dir>` is derived from the entrypoint's own directory name (e.g. the
// `review` dir backs the `review-pr` verb), so the override path a consumer
// writes matches the layout they'd see in the package.
export function resolveAsset(entrypointDir: string, filename: string): string {
  const verbDir = basename(entrypointDir);
  const override = resolve(
    process.cwd(),
    ".sandcastle",
    "agent-workflows",
    verbDir,
    filename,
  );
  return existsSync(override) ? override : join(entrypointDir, filename);
}

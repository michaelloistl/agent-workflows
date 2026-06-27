import { run, Output, type PromptArgs } from "@ai-hero/sandcastle";
import {
  claudeAgent,
  hostSandbox,
  HEAD_STRATEGY,
  COMPLETION_SIGNAL,
} from "./agent.mts";
import type { StandardSchema } from "./json.mts";

// The run-with-extraction pattern shared by the agent-workflow entrypoints.
//
// Structured output has to come from its own single-iteration run, separate from
// the open-ended work pass (an `output` extraction can't ride along with the
// multi-iteration loop the work pass needs). So extraction is always a SECOND
// run: the first pass does the open-ended work (read-only exploration) and writes
// its findings to a notes file on disk; the second pass reads that file back and
// emits one validated `{ tag }` object, which sandcastle parses and validates
// against `schema`.
//
// We hand context to the extraction pass through that notes file rather than by
// resuming the work pass's Claude session. Note that resume DOES work under
// noSandbox — claudeCode always carries sessionStorage and the session JSONL
// persists on the runner, so `resumeSession` would find it on the host. The file
// handoff is a deliberate choice: the extraction pass gets a small, clean,
// deterministic input instead of replaying the whole exploration transcript, and
// the two passes stay decoupled if session capture ever changes.

export interface RunWithExtractionOptions<T> {
  // Label prefix for log output; each pass appends its own suffix.
  readonly name: string;
  // Prompt file for the first (work) pass.
  readonly workPromptFile: string;
  // Prompt file for the second (extraction) pass. Must contain the `<tag>`
  // literal sandcastle requires when an `output` definition is set.
  readonly extractPromptFile: string;
  // Placeholder values substituted into both prompt files.
  readonly promptArgs: PromptArgs;
  // Iteration cap for the work pass (the extraction pass is always single-shot).
  readonly workIterations?: number;
  // XML tag wrapping the JSON the extraction pass emits.
  readonly tag: string;
  // Standard Schema the extracted JSON is validated against.
  readonly schema: StandardSchema<T>;
}

export interface RunWithExtractionResult<T> {
  // The validated structured output from the extraction pass.
  readonly output: T;
  // Commits across both passes — expected to be empty for read-only workflows,
  // so callers can assert nothing was written.
  readonly commits: ReadonlyArray<{ sha: string }>;
}

export async function runWithExtraction<T>(
  options: RunWithExtractionOptions<T>,
): Promise<RunWithExtractionResult<T>> {
  const base = {
    agent: claudeAgent(),
    sandbox: hostSandbox(),
    branchStrategy: HEAD_STRATEGY,
    completionSignal: COMPLETION_SIGNAL,
    promptArgs: options.promptArgs,
    // Stream the agent's output to the Actions step log (default is a file
    // under .sandcastle/logs/, which vanishes on the ephemeral runner).
    logging: { type: "stdout" as const },
  };

  const work = await run({
    ...base,
    name: `${options.name}-work`,
    promptFile: options.workPromptFile,
    maxIterations: options.workIterations ?? 3,
  });

  const extraction = await run({
    ...base,
    name: `${options.name}-extract`,
    promptFile: options.extractPromptFile,
    maxIterations: 1,
    output: Output.object({ tag: options.tag, schema: options.schema }),
  });

  return {
    output: extraction.output,
    commits: [...work.commits, ...extraction.commits],
  };
}

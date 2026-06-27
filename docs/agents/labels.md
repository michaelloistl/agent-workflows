# Agent Labels

This repo drives its agent fleet through an `agent:*` label vocabulary. Two
kinds exist: **trigger labels** a human applies to start a run, and **state
labels** the fleet sets and clears to track a run's progress. Humans never
touch the state labels.

## Trigger labels

A human-applied `agent:<verb>` label on an issue or PR starts a workflow.

| Label                | Applied to | Starts                                            |
| -------------------- | ---------- | ------------------------------------------------- |
| `agent:explore`      | issue      | a read-only `explore` run that investigates and reports back |
| `agent:implement`    | issue / PR | an `implement` run that builds the change (issue) or an `implement-pr` run that revises the PR (open PR) |
| `agent:review-pr`    | open PR    | a `review-pr` run that reviews the pull request   |
| `agent:update-branch`| open PR    | an `update-branch` run that brings the branch up to date |

## State labels

A label the fleet sets and clears, never a human. The `<verb>-status` hook owns
every transition; for Linear repos the equivalent is a Linear state.

| Label                | Meaning                                           |
| -------------------- | ------------------------------------------------- |
| `agent:in-progress`  | a run has started and is working                  |
| `agent:review`       | the run succeeded and is awaiting human review (`implement` only) |
| `agent:blocked`      | the run failed or was aborted; a comment explains why and links the run |

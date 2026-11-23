#!/usr/bin/env bash
# The self-hosted GitHub runner's job-start hook (ACTIONS_RUNNER_HOOK_JOB_STARTED, set by install-github-runner.sh).
# It runs on the server before every job, outside anything a workflow file controls, and fails the job unless it is
# .github/workflows/ship.yml from master, started by a push to master of this repository. So a pull request (from a
# fork or not, approved or not) that edits a workflow to target this runner never gets a step to run here.
# Fails closed: a missing or unexpected value rejects the job.
set -u
repo="${LINKORD_RUNNER_REPO:-}"
reject() {
  echo "runner-guard: rejected ($1). This runner only ships pushes to master of ${repo:-<unset>}."
  exit 1
}
[ -n "$repo" ] || reject "LINKORD_RUNNER_REPO is unset in the runner's .env"
[ "${GITHUB_REPOSITORY:-}" = "$repo" ] || reject "repository ${GITHUB_REPOSITORY:-?}"
[ "${GITHUB_EVENT_NAME:-}" = push ] || reject "event ${GITHUB_EVENT_NAME:-?}"
[ "${GITHUB_REF:-}" = refs/heads/master ] || reject "ref ${GITHUB_REF:-?}"
[ "${GITHUB_WORKFLOW_REF:-}" = "$repo/.github/workflows/ship.yml@refs/heads/master" ] ||
  reject "workflow ${GITHUB_WORKFLOW_REF:-?}"
[ -z "${GITHUB_HEAD_REF:-}" ] || reject "pull request head ${GITHUB_HEAD_REF}"
echo "runner-guard: push to master of $repo (${GITHUB_SHA:0:9}), accepted."

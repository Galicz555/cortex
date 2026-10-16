#!/bin/sh
# Commits what a run changed in vault/, one commit per run, so `git log vault` shows each run's
# effect and a bad synthesis can be reverted. Runs after success and failure alike: a crashed
# run's partial notes are worth seeing too. Only vault/ is committed; nothing else is touched.
set -eu
cd "$(dirname "$0")/.."
run=$1
# A checkout that ignores vault/ (the public one) keeps no vault history.
if git check-ignore -q vault; then
  exit 0
fi
git add -A vault
if git diff --cached --quiet -- vault; then
  exit 0
fi
git commit --quiet --no-verify -m "docs: vault after the $run run of $(date +%F)" -- vault

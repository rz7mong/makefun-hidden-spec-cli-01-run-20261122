# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rz7mong/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rz7mong/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for make.fun bounty **hidden-spec-cli-01-run-20261122** — "Build mend, one patch tool for every AI edit format" ($100 USDC, 10 places paid).

## Run

`main.ts` (Node 22, no dependencies) applies a patch to a tree of text files: `node main.ts [options] [PATCH]`, patch from stdin when absent or `-`.

Four formats, auto-detected or chosen with `--format=`: unified diff, SEARCH/REPLACE blocks, V4A, JSON edits. Matching at three tiers (exact, trailing-whitespace, indentation), `--strict` for tier 0 only, `--check` for a dry run. Practice: 100/100, score 1000.

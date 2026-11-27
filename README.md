# Diff — a faster drop-in for makefun-diff 1.0.0 (v2)

[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/Huntter12/diff-speed-01-entry-v2/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/Huntter12/diff-speed-01-entry-v2/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)

Entry for [Diff two texts faster, 27 November 2026](https://make.fun/bounty/diff-speed-01-run-20261126) on [make.fun](https://make.fun). Second entry (Force_Last): replaces the v1 entry, which used a plain hashed-line Myers.

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly the
answer makefun-diff 1.0.0 returns for `{ old, new }` — the same Myers greedy
search (common prefix, then common suffix, furthest point per diagonal, deletion
wins on ties, no edge pruning, full snakes) and the same patch format — but
faster: lines are hashed to integers once, then the work is split by certified
unique-anchor runs, and the exact greedy Myers runs only on the gaps between
them.

1. **Anchor runs.** A line occurring exactly once in each text is a unique
   match. A maximal run of at least two consecutive unique matches on one
   diagonal is a candidate anchor — but only when it is uncontested and
   certified. A run is contested when any other run crosses it (earlier in
   one text, later in the other): no alignment can match both, and choosing
   by run weight alone is wrong, because the gap matches on either side can
   outweigh a small weight difference (a block of lines moved past another
   block). Contested runs are dropped and their region is decided by the
   exact gap search. A surviving run is certified by a crossing count: with
   chain neighbours ending at (px, py) and starting at (nx, ny), any path
   that skips the run can gain matches only inside the two crossing
   rectangles, so if C is the sum over line values of the smaller of the two
   sides' counts there, R > C puts the run on every shortest path, hence on
   the greedy path. Adjacent pairs of runs are certified the same way, as
   one unit: each run alone can pass while the pair is jointly outvoted by
   repeated lines. Runs failing a check are dropped, the check repeats until
   a pass drops nothing, and the gap search decides their regions. Single
   unique matches (runs of length 1) are not anchors: two equally short
   scripts can disagree about them, and the greedy tie-break decides.
2. **Exact greedy Myers on the gaps.** The same search as v1 (Int32Array
   diagonals, V snapshots + backtrack with the reference's exact tie-break)
   runs only on the gaps between anchor runs, never on the whole text, so
   the D^2 diagonal walk collapses to a sum over gaps. If no anchor run
   exists the whole middle is one gap and the module behaves like v1.

`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

Measured on the kit's practice set (4 cases, ~21k–32k lines each): byte-exact
answers on all 4 cases, ~2.9x less CPU time than v1 in-process (median, 7
reps) and ~6.6x less than the house baseline makefun-diff 1.0.0. Exactness
was also checked by differential fuzzing against the reference: 400
generator-drawn cases and 1500 adversarial small cases (swaps, block moves
including tiny spans, repeated-line runs, CRLF flips, bare endings), all
exact.

## How to run

```sh
MAKEFUN_INPUT_DIR=<input dir> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts
```

Node 22 or later, nothing to install. No network, no clock reads, no
randomness: two executions write byte-identical outputs.

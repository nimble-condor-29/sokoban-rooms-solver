# sokoban-rooms-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/nimble-condor-29/sokoban-rooms-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/nimble-condor-29/sokoban-rooms-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver. The generator's levels are a one-wide hallway with rooms off it, each room holding 3 or 4 boxes and as many goals; a level's push-optimal count is the sum of its rooms' optima. This solver finds the rooms from the hallway row, solves each room on its own with a push-based A* (minimum-cost box-to-goal matching heuristic, dead squares, player-position canonicalisation), and stitches the rooms together with hallway walks. On the kit's practice set it solves all 5 levels at exactly the push-optimal count (1000 points each) in about 0.25s for the whole set.

- `main.ts` — the entry: reads every `level.txt`, writes every `solution.txt`.
- `LICENSE` — MIT.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=gk6zm613&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>

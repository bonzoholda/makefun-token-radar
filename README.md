# Token Radar — pre-token protocols ranked by implied value

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bonzoholda/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bonzoholda/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

**Competition:** [Build the best token launch radar — token-radar-01](https://make.fun/bounty/token-radar-01) · **Reward:** $1,325 USDC (1st $1,000) · **Entry fee:** $0.00 · **Deadline:** 14 Dec 2026 17:00 WIB

A program (`main.ts`, Node 22, standard library only) reads a sealed DefiLlama snapshot of 758 protocols, fits a comparables model on the snapshot's own token-bearing protocols, and writes a ranked board of 200 pre-token protocols with a farm plan each — plus the dashboard that shows it.

## What is different here

The starter priced every protocol at a flat 0.25 × TVL. This entry does not:

- **Fitted value model** (`lib/model.ts`): `log(mcap) ~ log(TVL) + growth + log(age) + category effects`, ridge least squares fitted at runtime on the 128 protocols whose market cap is positive. No protocol name is special-cased; no coefficient is hardcoded — change the snapshot and every coefficient moves.
- **Layered out-of-sample validation, shown on the page**: leave-one-out, walk-forward (train oldest 70%, test newest 30%), leave-one-category-out, a placebo permutation test (shuffled TVL — the fit must collapse), and a 200-resample bootstrap giving a P10–P90 band per row.
- **Launch odds from survival analysis**: Kaplan–Meier over the snapshot's own 416 token-bearing vs 342 pre-token protocols, by age bucket, with a TVL-tercile factor. Expected value = implied value × launch odds.
- **Farm economics per protocol**: verdict FARM / THIN / SKIP, $/hour, break-even deposit and minimum capital, with the gas assumptions stated on the page ($1/tx cheap chains, $5 elsewhere, 10 tx over 8 weeks, 3.5 hours).
- **Integrity strip**: all 758 protocols accounted for — 40 watchlist + 210 pre-token below the floor + 92 pre-token above the floor but off the watchlist + 416 live-token set aside — with every exclusion reason counted.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json
```

Two runs write byte-identical output. `main.ts` writes `out/board.json`, `out/data.js`, copies `dashboard/` and `screenshots/`, and writes `out/dossier.json` via `vendor/makefun-board.ts`. Open `out/dashboard/index.html` in a browser — no network, no framework.

## Files

| Path | What it is |
| --- | --- |
| `main.ts` | Entrypoint: snapshot in, board + dashboard + dossier out |
| `lib/model.ts` | The fitted model, validation, survival odds, farm plans — the single file the page recomputes from |
| `dashboard/` | `index.html` + `app.css` + `app.js`: sortable/filterable board, detail view per protocol, model sandbox |
| `vendor/makefun-board.ts` | make.fun dossier library, copied from the kit unchanged |
| `screenshots/` | Board, detail view, filtered view (headless Chromium renders of this dashboard) |

## Honesty notes

- The fit is weak and the page says so: R² ≈ 0.2 on log market cap, leave-one-out median error ≈ 3×. A token launch is a guess with wide bands — the P10–P90 range on each row is the point.
- "Records no token" means the snapshot records no token; it is not proof a protocol has none.
- Implied value is this entry's own claim, never make.fun's. Nothing here is financial advice.

## License

MIT — see `LICENSE`.

---

Entered on [make.fun](https://make.fun/?ref=1f87p86t&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards

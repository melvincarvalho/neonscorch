#!/usr/bin/env bash
# Duels as theorems — deterministic artillery matches + ballistics mechanism proofs:
#   solution: the exact aim-solver must WIN a 3-round duel vs the canon AI (noisy solver)
#   null: a gunner who fires straight up must LOSE
#   ablate-wind: a solver that ignores wind must LOSE (wind compensation is load-bearing)
#   mech-*: physics proven in isolation — closed-form parabola, wind ordering, crater bite,
#           dirt pile, undermine-and-fall, MIRV split, napalm downhill flow, solver accuracy
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="${CHROME:-chromium}"
run() {
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --virtual-time-budget=120000 --dump-dom \
    "file://$DIR/index.html?verify=$1" 2>/dev/null | grep -o 'VERIFY:{[^<]*' | head -1
}
for m in solution null ablate-wind mech-parabola mech-wind mech-crater mech-dirt mech-fall mech-mirv mech-napalm mech-solver mech-determinism mech-napalm-flight mech-dirt-flight mech-shield mech-roller mech-deathshead; do
  run "$m"
done

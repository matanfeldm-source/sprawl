/* Every move the engine produces must be legal:
   placements on existing empty squares, growth edge-adjacent and not
   onto a square that already exists. Corner contact does not count. */
const { R, E, start, playGame } = require('./harness');
const W = E.WEIGHTS;

let checked = 0, bad = [];
for (let g = 0; g < 8; g++) {
  const cells = start();
  let turn = 'X';
  for (let t = 0; t < 14; t++) {
    const w = t % 2 ? W.hard : W.master;
    const r = E.search(cells, turn, w.ms, w.depth, w);
    if (!r.best) break;
    if (!R.legalPlacement(cells, r.best.p)) bad.push(`placement ${r.best.p}`);
    cells[r.best.p] = turn;
    if (R.lineAt(cells, r.best.p, turn)) break;
    checked++;
    if (!R.legalGrowth(cells, r.best.g)) bad.push(`growth ${r.best.g}`);
    cells[r.best.g] = null;
    turn = R.other(turn);
  }
}
console.log(`legality: ${checked} turns checked, ${bad.length} illegal`);
if (bad.length) { console.log(bad.slice(0, 10)); process.exit(1); }

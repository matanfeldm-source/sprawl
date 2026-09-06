/* Diagnostic, not a pass/fail test. Prints reached depth, node counts and
   branching factor per turn — the numbers that exposed the engine spending
   its whole budget at depth 1. */
const { R, E, start } = require('./harness');
const w = E.WEIGHTS.master;
const cells = start();
let turn = 'X';
for (let t = 0; t < 10; t++) {
  const t0 = Date.now();
  const r = E.search(cells, turn, w.ms, w.depth, w);
  const dt = Date.now() - t0;
  const branch = E.turnMoves(cells, turn, w).length;
  const rate = dt ? Math.round(r.nodes / dt * 1000).toLocaleString() : 'n/a';
  console.log(`turn ${t + 1} ${turn}: depth ${r.depth}/${w.depth}  ${r.nodes.toLocaleString()} nodes  ${dt}ms  (${rate}/s)  branching ${branch}  eval ${r.score}`);
  if (!r.best) break;
  cells[r.best.p] = turn;
  if (R.lineAt(cells, r.best.p, turn)) { console.log(`  ${turn} wins`); break; }
  cells[r.best.g] = null;
  turn = R.other(turn);
}

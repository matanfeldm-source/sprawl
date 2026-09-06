/* Sanity check on playing strength: the engine should beat a greedy
   opponent that plays the open-two fork exploit on sight. */
const { R, E, start } = require('./harness');
const W = E.WEIGHTS;

function greedy(cells) {
  const t = R.threatCells(cells, 'X');
  if (t.length) return { p: t[0], g: null };
  const block = R.threatCells(cells, 'O');
  const picks = block.length ? [block[0]] : R.opens(cells);
  let best = null, bs = -1e9;
  for (const p of picks) {
    cells[p] = 'X';
    for (const g of R.slots(cells)) {
      cells[g] = null;
      const a = E.scan(cells, 'X'), b = E.scan(cells, 'O');
      const v = a.t * 500 + a.s * 40 + a.p * 3 - b.t * 600 - b.s * 30;
      delete cells[g];
      if (v > bs) { bs = v; best = { p, g }; }
    }
    cells[p] = null;
  }
  return best;
}

for (const style of ['easy', 'medium', 'hard', 'master']) {
  const w = W[style];
  let engineWins = 0, greedyWins = 0, unfinished = 0;
  for (let i = 0; i < 20; i++) {
    const cells = start();
    let turn = 'X', done = false;
    for (let t = 0; t < 40 && !done; t++) {
      let place, grow;
      if (turn === 'X') { const m = greedy(cells); place = m.p; grow = m.g; }
      else { const r = E.search(cells, turn, w.ms, w.depth, w); place = r.best.p; grow = r.best.g; }
      cells[place] = turn;
      if (R.lineAt(cells, place, turn)) {
        turn === 'X' ? greedyWins++ : engineWins++; done = true; break;
      }
      if (!grow || !R.legalGrowth(cells, grow)) grow = R.slots(cells)[0];
      cells[grow] = null;
      turn = R.other(turn);
    }
    if (!done) unfinished++;
  }
  console.log(`${style}: engine ${engineWins} - greedy ${greedyWins} (unfinished ${unfinished})`);
}

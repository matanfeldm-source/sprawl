/* Shared helpers for the node tests. Engine and rules load directly as
   modules; no DOM and no HTML scraping needed. */
const R = require('../src/rules.js');
const E = require('../src/engine.js');

function start() {
  return { '0,0': null, '1,0': null, '0,1': null, '1,1': null };
}

/* Plays one full turn for `turn` using the given weights. Mutates cells.
   Returns {place, grow, won}. */
function playTurn(cells, turn, w) {
  const r = E.search(cells, turn, w.ms, w.depth, w);
  const place = r.best ? r.best.p : R.opens(cells)[0];
  cells[place] = turn;
  if (R.lineAt(cells, place, turn)) return { place, grow: null, won: true };
  let grow = r.best && r.best.g;
  if (!grow || !R.legalGrowth(cells, grow)) grow = R.slots(cells)[0];
  cells[grow] = null;
  return { place, grow, won: false };
}

function playGame(wx, wo, maxTurns = 40) {
  const cells = start();
  let turn = 'X';
  const log = [];
  for (let t = 0; t < maxTurns; t++) {
    const w = turn === 'X' ? wx : wo;
    const mv = playTurn(cells, turn, w);
    log.push({ turn, ...mv });
    if (mv.won) return { winner: turn, log, cells };
    turn = R.other(turn);
  }
  return { winner: null, log, cells };
}

module.exports = { R, E, start, playTurn, playGame };

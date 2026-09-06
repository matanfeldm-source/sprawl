/* Sprawl rules.

   A position is a plain object mapping "x,y" -> null | "X" | "O".
   A key present with value null is an empty square that exists on the board.
   A key that is absent is not part of the board at all.

   Turn structure: the player to move places a mark on an existing empty
   square, then grows the board by adding one new empty square edge-adjacent
   to any existing square. Three in a row in any of the four directions wins.

   Consequence worth remembering: each turn removes one empty square and adds
   one, so there are always exactly four empty squares on the board. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SprawlRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // Line directions: right, down, and the two diagonals.
  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  // Adjacency for growth: edges only. Corners do NOT connect.
  var NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function k(x, y) { return x + ',' + y; }
  function parse(s) { var p = s.split(','); return [+p[0], +p[1]]; }
  function other(m) { return m === 'X' ? 'O' : 'X'; }

  function fresh() {
    return {
      cells: { '0,0': null, '1,0': null, '0,1': null, '1,1': null },
      turn: 'X', phase: 'place', over: false, line: []
    };
  }

  function clone(s) {
    var c = { cells: {}, turn: s.turn, phase: s.phase, over: s.over, line: s.line.slice() };
    for (var i in s.cells) c.cells[i] = s.cells[i];
    return c;
  }

  /* Squares that may be added this turn: absent squares sharing an edge with
     an existing square. */
  function slots(cells) {
    var out = [], seen = {};
    for (var key in cells) {
      var p = parse(key);
      for (var i = 0; i < 4; i++) {
        var nk = k(p[0] + NB[i][0], p[1] + NB[i][1]);
        if (!(nk in cells) && !seen[nk]) { seen[nk] = 1; out.push(nk); }
      }
    }
    return out;
  }

  function opens(cells) {
    var o = [];
    for (var key in cells) if (cells[key] === null) o.push(key);
    return o;
  }

  /* If `mark` occupies `key`, returns the winning line through it, else null. */
  function lineAt(cells, key, mark) {
    var p = parse(key), x = p[0], y = p[1];
    for (var i = 0; i < 4; i++) {
      var line = [key];
      for (var s = -1; s <= 1; s += 2) {
        for (var n = 1; n < 3; n++) {
          var nk = k(x + DIRS[i][0] * n * s, y + DIRS[i][1] * n * s);
          if (cells[nk] === mark) line.push(nk); else break;
        }
      }
      if (line.length >= 3) return line;
    }
    return null;
  }

  /* Empty squares where `mark` would complete three in a row right now. */
  function threatCells(cells, mark) {
    var out = [], op = opens(cells);
    for (var i = 0; i < op.length; i++) {
      cells[op[i]] = mark;
      if (lineAt(cells, op[i], mark)) out.push(op[i]);
      cells[op[i]] = null;
    }
    return out;
  }

  function legalPlacement(cells, key) {
    return (key in cells) && cells[key] === null;
  }

  function legalGrowth(cells, key) {
    if (key in cells) return false;
    var p = parse(key);
    for (var i = 0; i < 4; i++) {
      if (k(p[0] + NB[i][0], p[1] + NB[i][1]) in cells) return true;
    }
    return false;
  }

  return {
    DIRS: DIRS, NB: NB, k: k, parse: parse, other: other,
    fresh: fresh, clone: clone, slots: slots, opens: opens,
    lineAt: lineAt, threatCells: threatCells,
    legalPlacement: legalPlacement, legalGrowth: legalGrowth
  };
});

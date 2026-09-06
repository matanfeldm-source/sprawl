# Sprawl

Tic-tac-toe on a board that grows. Two players, four bot difficulties, a
search engine to play against, an analysis panel, and online play against
a friend or a random opponent.

Open `index.html` in a browser. No build step. Everything loads from the
filesystem, though `npm run serve` gives you a local server if you'd rather
(online play needs `http://` or `https://`, not `file://`, since Web Workers
and WebRTC both require it).

The core game (rules, engine, UI, analysis) has zero dependencies. Online
play is the one exception: it loads [Trystero](https://github.com/dmotz/trystero)
from a CDN at runtime for serverless WebRTC — see **Online play** below.

## Rules

1. The board starts as four squares in a 2x2 block, all empty.
2. On your turn, place your mark in any empty square that already exists.
3. Then grow the board: add one new empty square **edge-to-edge** against any
   existing square. Corners do not connect.
4. Three of your marks in a line — horizontal, vertical or diagonal on the
   underlying integer grid — wins.

Each turn fills one square and adds one, so there are always exactly four
empty squares. The board grows, the choice never does. There is no draw by
exhaustion: the board never fills up.

## Layout

```
index.html          markup only
src/rules.js        rules on the "x,y" -> null|"X"|"O" representation
src/engine.js       search: flat board, zobrist TT, alpha-beta
src/worker.js       runs the engine in a Web Worker (search never blocks the page)
src/online.js       serverless WebRTC play via Trystero (link invites + matchmaking)
src/ui.js           rendering, input, bot turns, analysis panel, online wiring
src/styles.css
test/harness.js     shared test helpers
test/legal.test.js  every engine move must be legal
test/strength.test.js  engine vs a greedy fork-seeking opponent (master's 8s/move budget makes a full run take several minutes)
test/probe.js       diagnostic: depth, node rate, branching per turn
tools/solver.py     depth-limited forced-win search (python)
```

`rules.js` and `engine.js` are UMD, so the same files serve the browser and
`require()` in node. That is why the tests import the real modules instead of
scraping a bundle.

## The engine

Positions are held in a flat `Int8Array` indexed by `(y+24)*48 + (x+24)`, with
`0` absent, `1` empty, `2` X, `3` O. A line check is pointer arithmetic.

- **Turn-level search.** A move is a placement *and* a growth together. They
  cannot be chosen separately: a good placement paired with a careless growth
  loses the game.
- **Plain alpha-beta, no transposition table.** There used to be a
  Zobrist-hashed TT here. It's gone — see "The transposition table bug" below
  for why, but the short version is it was caught returning provably wrong
  position values, and a correct-but-slower engine beats a fast-but-wrong one.
- **Influence map.** Two `Int16Array`s track proximity to each side's marks,
  maintained incrementally, used to rank growth candidates without scanning
  the board.
- **Forced-block generation.** When the opponent has a live winning square, the
  only placements generated are the blocks.
- **Jitter.** The root picks randomly among moves within a few points of best,
  so the same position does not always give the same game. Never applied when
  something is forced.

The search itself runs inside a Web Worker (`src/worker.js`), so bot thinking
and live analysis never freeze the page — that's what makes the Master tier's
deeper, slower search viable in a UI at all. Without a TT, node throughput and
reachable depth are both a fair bit lower than earlier builds claimed; run
`npm run probe` for current numbers on your machine rather than trusting a
number written down here.

### Difficulty tiers

Five presets in `WEIGHTS`, from a bot you're meant to beat to one built to
grind out the strongest line the search can find:

| tier        | depth | time budget | jitter | feel |
|-------------|-------|-------------|--------|------|
| easy        | 2     | 150ms       | 5000   | picks near-randomly among non-losing turns |
| medium      | 4     | 450ms       | 120    | plays soundly but wanders off the top line |
| hard        | 6     | 1100ms      | 4      | the old default: strong, occasional variation |
| master      | 9     | 8000ms      | 0      | always the engine's best move, single-threaded |
| grandmaster | 14    | 15000ms     | 0      | same search, spread across multiple Workers |

Grandmaster is Master's identical search, just not run on one thread. See
"Parallel search (Grandmaster)" below for how — it's a real architectural
difference, not just bigger numbers in the weights table.

Master's time budget looks large next to the others, and it's not for show:
without a transposition table (see "The transposition table bug" below),
this engine needs roughly 5x the nodes to go one ply deeper once the board
has any real size to it, and that extra ply routinely *flips* the
evaluation, not just refines it — measured directly on a real midgame
position, depth 5 called it +31.62 and depth 6 called the same position
-28.44. A cheaper Master would just be a slower Hard.

`jitter` is what actually produces the difficulty gradient: the root picks
randomly among moves within `jitter` points of the best score, so a large
jitter (easy) makes the shallow, fast search pick an essentially arbitrary
non-losing turn, while `jitter: 0` (master) always plays the single best
line. Depth and time budget move independently — easy is also just not
looking very far ahead. Tunable fields per tier: `depth`, `ms`, `cap`
(growth candidates per node), `mine`, `pot`, `theirs`, `tpot`, `jitter`.

Live analysis (the "Analysis" panel) always searches at `WEIGHTS.master`
regardless of which bot tier you're playing against, since its job is to
show the objectively best move, not to match the opponent's strength.

**A pitfall worth recording:** a killer-move ordering heuristic was tried
here and reverted. It didn't corrupt the search — same depth reached, same
minimax score — but the coarse heuristic eval plateaus at many exactly-equal
scores in the early game, and the different node-visit order changed *which*
equally-scored move won the tie-break at the root. Measured result: the
tuned `hard` tier dropped from 17-3 to 9-11 against the greedy test opponent
with everything else unchanged. Move-ordering heuristics are supposed to be
neutral for the final answer under full alpha-beta — they are, for the
score, but not for tie-breaks when the evaluation is coarse. If you
reintroduce one, verify with `test/strength.test.js`, not by reasoning about
the code.

### Parallel search (Grandmaster)

After the transposition table turned out unsafe twice (see "Bugs worth not
reintroducing" below), the remaining lever for real strength that doesn't
touch shared-cache correctness at all is parallelism: `search()` in
`src/engine.js` takes two extra optional arguments, `part` and `parts`. Pass
them and it filters its own root move list down to `root[i] where i % parts
=== part` before searching — every other-Nth move, in other words — then
runs its normal, completely unmodified iterative-deepening alpha-beta on
just that slice.

`src/ui.js` uses this by spawning a pool of Workers (`ensurePool()`, sized to
`navigator.hardwareConcurrency`, capped at 8) and giving each one a distinct
`part` covering the same `parts` total. Because each Worker is a fully
separate JS engine instance — its own copy of every module-level variable in
`engine.js`, including the board arrays — there is no shared cache, no shared
anything, between them. Searching fewer root moves per depth iteration means
each worker's own iterative deepening reaches further before the shared time
budget runs out; `searchParallel()`'s `combine()` picks which worker's result
to actually play.

**A forced win at any depth beats a non-winning result at any depth,
checked first — before comparing depth at all.** This one shipped briefly:
the first version of `combine()` compared reached-depth as the primary key
(deeper = more thorough = better, which is the right instinct for two
*non-winning* estimates). But a partition that finds a forced win stops
iterating immediately once it does — `Math.abs(score)>=WINV` breaks the
loop, because there is nothing left to prove — so a winning partition
reports a *shallow* depth almost by definition, while a partition with no
winning move in its slice keeps iterating deeper and deeper with an
ordinary heuristic score. Depth-first comparison picked the deeper, merely
decent, non-winning partition over the shallow, absolutely-winning one. A
player reported Grandmaster failing to take a real forced win; the exact
position reproduced it immediately when partitioned by hand — two of four
partitions correctly found a mate in 2, the other two reached depth 6
without one, and the old `combine()` chose the depth-6 result. Fixed by
checking for `score >= WIN` across all results *before* the depth/score
comparison and always preferring a proven win, breaking ties among wins by
score (faster mates first). If `combine()` is touched again, verify with a
case that has this exact shape — one partition wins shallow, another
searches deep without winning — not just cases where all partitions agree.

### Redundant-work elimination

After three failed attempts at adding new search mechanisms (the
transposition table, twice; the threat-extension; the move-ordering sort —
all documented above and in `src/engine.js`'s inline comments), the thing
that actually worked was removing work the engine was already doing twice.

`genTurn(me,cap)` used to call `openList()` up to three times per invocation
(once inside `threatList(me)`, again inside `threatList(you)` if the first
found nothing, a third time directly as the forced-block fallback if the
second found nothing too — all three the common case) and called
`slotList()` once per placement candidate via `growOptions()`, even though
`slotList()`'s result only depends on which cells *exist* (`CL`), not which
existing cell currently holds a mark — so it's identical across every
placement candidate tried within one `genTurn` call. Both are now computed
once per `genTurn` invocation and threaded down via optional parameters
(`threatList(m,o)`, `growOptions(me,cap,sl)`) that default to computing
their own list when called standalone, so `growCands()` and other external
callers are unaffected.

Unlike the reverted move-ordering sort, this changes *how many times*
identical work happens, not *what order* anything happens in — verified with
an exact array-order equivalence check (not just final-move equivalence)
against the pre-change behavior across a batch of real self-played
positions, in addition to the usual TT-bug and parallel-combine reproduction
cases. Measured result on the fixed benchmark position: node throughput up
roughly 17-20% at the same reached depth (`~3.2-3.3M` → `~3.8M` nodes in an
identical 5s budget) — more thorough coverage at the same depth rather than
an extra ply, since this position's depth-6-to-7 jump needs far more than a
20% budget increase to clear. `test/legal.test.js` passes clean, and
`test/strength.test.js` came back easy 3-17, medium 13-7, hard 14-6,
master 19-1 — no regression, and master's result is as strong as any
measured this session.

A follow-up attempt to merge `scanIdx()`'s two per-side passes (called
twice per `evalIdx()`, at every leaf) into one combined pass was tried the
same way and reverted. The correctness argument held up — a 25-position
equivalence check including deliberately dense mixed-mark positions found
zero discrepancies — but the throughput measurement didn't: five paired
benchmark runs gave old-faster in four, new-faster in one, averaging to a
wash (old≈3,498,342 vs new≈3,485,465 nodes). The first single measurement
taken showed a promising ~7% gain; a second one flatly contradicted it.
This is now the third time a "provably correctness-neutral" change to a
hot path in this file didn't survive contact with a real benchmark (the
move-ordering sort was the second) — always run a comparison more than
once before trusting it, a single run is not a measurement.

## What the search says about the game

Not solved, and not solvable by exhaustive search: with no full board the game
tree is infinite, so a real answer needs a proof, not enumeration.

`tools/solver.py` runs a depth-limited perfect-play search. Results so far:

- X has **no forced win within 2, 3 or 4 placements**.
- Depth 5 is out of reach in python. Node counts grow about 43x per turn.
- A defender that only blocks threats and grows far away **loses on move 3**:
  `python3 tools/solver.py naive` reproduces the line.

The pattern that decides games is the **open two**: two marks in a line with
both extension squares reachable. Unlike normal tic-tac-toe you can
manufacture the second end yourself with your growth move, so an open two is
lethal the moment it appears.

Two reasons it's hard to settle:

- The tree is infinite, and perfect play may simply continue forever.
- Strategy stealing fails. That argument normally rules out a second-player
  win because a spare move never hurts — but here your growth is compulsory
  and can hand the opponent exactly the square they needed.

Next step if you want to push it: rewrite `solver.py` with bitboards and a
transposition table to reach 6–7 placements, and separately try for a pairing
argument on the defensive side.

## Online play

There is no backend and nothing to host: `src/online.js` connects two
browsers directly over WebRTC using [Trystero](https://github.com/dmotz/trystero),
loaded at runtime from `esm.sh` via a dynamic `import()`. Trystero brokers
the initial handshake through free public WebTorrent trackers (no account,
no API key); once the two peers find each other, gameplay traffic goes
peer-to-peer, not through any third party.

Two flows share the same connection code (`attach()` in `online.js`):

- **Invite link** (`hostLink`/`joinLink`): the host generates a random room
  code and a `?room=` URL. Whoever opens that URL joins the same named room.
  Host is always X.
- **Random match** (`findMatch`): both sides join one shared, fixed-name
  lobby room. The first peer you see there is who you pair with — host/guest
  is decided deterministically by comparing peer IDs (`selfId < otherId`),
  so both sides agree without an extra negotiation message — and both then
  leave the lobby for a room name derived from the sorted pair of IDs.

Once a room is joined, gameplay is authority-free: both sides start from the
same deterministic `fresh()` board, and every local `place()`/`grow()`/
`reset()` broadcasts itself over the room's `mv` action; the receiving side
replays the exact same function with a `fromRemote` flag so it doesn't
re-broadcast. There's no server reconciling state — if the two boards ever
disagreed there'd be nothing to detect or fix it, which is acceptable for a
casual game between two consenting browsers but wouldn't fly for anything
adversarial.

**Known limitations, by design given no hosting:**

- Matchmaking only pairs with the *first* peer seen in the lobby. If three
  or more people search at once, a race can leave someone hanging — they'll
  hit the 25s timeout and can just search again.
- No TURN server, only the trackers' default STUN. Two peers behind
  restrictive/symmetric NATs may simply fail to connect. There's no
  fallback for this short of paying for TURN relay.
- It depends on a third-party CDN (`esm.sh`) and third-party public
  trackers being reachable. `online.js` fails soft — the game still works
  fully offline in every other mode if that load fails.

**Not yet verified end-to-end.** This was built and code-reviewed but tested
from a sandboxed browser automation environment, where two tabs could each
individually reach the signaling infrastructure (WebSocket to trackers
opened fine; `RTCPeerConnection` gathered real host and STUN candidates)
but never completed a peer handshake — with two independent Trystero
strategies (`torrent` trackers and `nostr` relays), both with matching
explicit config on both sides. That points at something specific to that
sandbox (likely a proxy or NAT policy blocking actual P2P media/data flow
while allowing plain WebSocket and ICE gathering through) rather than a bug
in this code, but it means **the online feature has not been confirmed
working between two real browsers.** Test it from two actual devices (or
two normal browser windows on the open internet) before trusting it; if it
still doesn't connect there, the next things to check are the tracker list
in `online.js` (`TRACKERS` — currently `tracker.openwebtorrent.com`,
`tracker.webtorrent.dev`, `tracker.btorrent.xyz`, the first two confirmed
reachable during this build) for staleness, and whether `trackerRedundancy`
needs raising further.

## Bugs worth not reintroducing

Each of these shipped and had to be found by measurement, not by reading:

- **Search corrupting the live board.** A timeout threw an exception that
  unwound the stack without undoing trial moves. The bot then played on a
  position containing squares that did not exist. Fixed by searching a copy.
- **Corner growth.** One direction array was used for both line scanning and
  adjacency. Lines include diagonals, adjacency must not. The engine offered
  corner-connected growth for several builds. `test/legal.test.js` exists
  because of this.
- **Influence map not rebuilt on load.** Move ordering silently scored every
  candidate zero, so the ordering did nothing.
- **Depth claimed vs depth reached.** The engine was advertised at depth 3 and
  was actually finishing depth 1. `test/probe.js` prints the real numbers.
- **The transposition table bug.** The most serious one, and worth the long
  version because the short version ("the TT was buggy, we removed it") won't
  stop someone from re-adding one the same way.

  It was found by playing against Master and winning with a completely
  standard tactic: place next to an existing mark, then use the growth move
  to open a *second* completion square, so the resulting open two can't be
  blocked. Master let it happen, and — this was the tell — a *fresh* search
  of the exact position it had just misjudged immediately found the correct,
  game-losing refutation. Same engine, same weights, same depth budget,
  different answer. That's not a horizon effect (which would make a deeper
  search *agree* with the shallow one, just later); it's a sign the search is
  returning a different value for the same position depending on what else
  it had already visited in that call.

  The trail: disabling the TT outright made the engine consistent and correct
  at every depth tested. Re-enabling just the exact-value fast path
  (`if(e.f===0) return e.v`) reintroduced the bug on its own — so far, so
  consistent with "the exact-value cache is the problem." But re-enabling
  just the bound-flagged (fail-high/fail-low) half, initially, *also* looked
  clean: correct at depth 6-7 with a few seconds of budget, on both the old
  broken hash and the fixed one. That result did not generalize. Reintroduced
  properly and re-checked at depth 9 with an 8-second budget, the
  bound-only version reproduced the *identical* wrong answer (`place 0,0`,
  score -70) — despite never once trusting a value as exact. So the earlier
  "clean" result for the bound-only path was a false negative from not
  testing deep enough, not evidence the mechanism is sound. Whatever is
  actually wrong here isn't isolated to the exact-value flag specifically;
  something about combining *any* cross-node value caching with this
  engine's specific search structure (most likely the root's progressive-
  alpha scheme in `search()`, which never re-searches a move with a full
  window after it improves alpha) is unsound in a way that only shows up
  with enough depth/nodes for it to matter. This was not fully diagnosed —
  the honest state is "don't reintroduce a TT here without finding the
  actual mechanism first," not "here's the safe subset."

  Zobrist hashing is fundamentally a bet that two different positions won't
  collide to the same key. The generator backing that bet was a xorshift32
  PRNG (`r^=r<<13;r^=r>>>17;r^=r<<5`), and xorshift is *linear over GF(2)* —
  it has no multiplication or other non-linear mixing step. Zobrist hashing
  combines its outputs with XOR, which is also linear over GF(2). Combine a
  linear generator with a linear combining step and small sets of table
  entries can land on identical XOR sums far more often than the ~1-in-4-
  billion a 32-bit hash implies; a direct instrumented check found real
  collisions between genuinely different board positions, not merely a rare
  edge case. A position that was a proven forced win (worth 1,000,000)
  collided with an unrelated leaf position, and whichever one got cached
  first silently answered for the other from then on.

  The fix in `src/engine.js`: the generator is now splitmix32-style
  (multiplicative, non-linear — `Math.imul` plus xor-shifts), and the key is
  built from *two* independently-seeded 32-bit hashes concatenated into one
  string, giving roughly 64 bits of collision resistance instead of 32. That
  alone wasn't enough to trust the cache again, and the second attempt above
  confirms it shouldn't have been — so the transposition table stays removed.
  See the bullet above. If someone reintroduces a TT, the reproduction case
  is: from a fresh 4-square board, X plays place `1,1` grow `2,1`; O (any
  tier) must not choose anything other than blocking `0,1` or `2,1` outright
  — every other reply is a proven loss within a few plies, confirmed by an
  independent `E.search()` call on the resulting position. **Test this at a
  real depth and time budget** (depth 9, several seconds — not depth 6-7 in
  under a second, which looked clean both times and wasn't). If the live
  search's own answer disagrees with the independent check, the cache is
  lying again.

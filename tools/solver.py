import sys, time, json
sys.setrecursionlimit(200000)

DIRS = [(1,0),(0,1),(1,1),(1,-1)]
NB = [(1,0),(-1,0),(0,1),(0,-1)]

def transforms(pts):
    for a,b,c,d in ((1,0,0,1),(-1,0,0,1),(1,0,0,-1),(-1,0,0,-1),
                    (0,1,1,0),(0,-1,1,0),(0,1,-1,0),(0,-1,-1,0)):
        yield [((a*x+b*y, c*x+d*y), m) for (x,y),m in pts]

def canon(cells, turn, budget):
    best = None
    items = list(cells.items())
    for t in transforms(items):
        mnx = min(p[0][0] for p in t); mny = min(p[0][1] for p in t)
        s = tuple(sorted((p[0][0]-mnx, p[0][1]-mny, p[1]) for p in t))
        if best is None or s < best: best = s
    return (best, turn, budget)

def slots(cells):
    out = set()
    for (x,y) in cells:
        for dx,dy in NB:
            p = (x+dx,y+dy)
            if p not in cells: out.add(p)
    return out

def near(cells, p, mark, r=2):
    x,y = p
    for (ax,ay),m in cells.items():
        if m == mark and abs(ax-x) <= r and abs(ay-y) <= r: return True
    return False

def growth_moves(cells, mark):
    """Relevant growths: anything within reach of the grower's own marks,
    plus a couple of representative 'dump' cells far from everything."""
    s = slots(cells)
    local = [p for p in s if near(cells, p, mark, 2) or near(cells, p, 3-mark, 2)]
    far = [p for p in s if p not in local]
    far.sort()
    return local + far[:2]

def opens(cells):
    return [p for p,m in cells.items() if m == 0]

def wins_at(cells, p, m):
    x,y = p
    for dx,dy in DIRS:
        n = 1
        for s in (1,-1):
            for i in (1,2):
                if cells.get((x+dx*i*s, y+dy*i*s)) == m: n += 1
                else: break
        if n >= 3: return True
    return False

def threats(cells, m):
    return [p for p in opens(cells) if _would_win(cells, p, m)]

def _would_win(cells, p, m):
    cells[p] = m
    r = wins_at(cells, p, m)
    cells[p] = 0
    return r

START = {(0,0):0,(1,0):0,(0,1):0,(1,1):0}
NODES = 0
DEADLINE = 0
class Timeout(Exception): pass

def can_force(cells, me, budget, memo):
    """me to move, place phase. True if me forces a win in <= budget placements."""
    global NODES
    NODES += 1
    if not (NODES & 0x3FFFF) and time.time() > DEADLINE: raise Timeout()
    if budget <= 0: return False
    key = canon(cells, me, budget)
    hit = memo.get(key)
    if hit is not None: return hit
    opp = 3 - me
    op = opens(cells)
    # order: immediate wins, then cells that build
    op.sort(key=lambda p: -sum(1 for (ax,ay),mm in cells.items()
                               if mm == me and abs(ax-p[0]) <= 2 and abs(ay-p[1]) <= 2))
    for p in op:
        cells[p] = me
        if wins_at(cells, p, me):
            cells[p] = 0
            memo[key] = True
            return True
        if budget > 1:
            for g in growth_moves(cells, me):
                cells[g] = 0
                safe = not opp_survives(cells, opp, me, budget-1, memo)
                del cells[g]
                if safe:
                    cells[p] = 0
                    memo[key] = True
                    return True
        cells[p] = 0
    memo[key] = False
    return False

def opp_survives(cells, opp, me, budget, memo):
    """opp to move (place). True if opp has a reply avoiding me's forced win."""
    for p in opens(cells):
        cells[p] = opp
        if wins_at(cells, p, opp):
            cells[p] = 0
            return True
        for g in growth_moves(cells, opp):
            cells[g] = 0
            ok = not can_force(cells, me, budget, memo)
            del cells[g]
            if ok:
                cells[p] = 0
                return True
        cells[p] = 0
    return False

def bound_search(maxb):
    for b in range(2, maxb+1):
        global NODES, DEADLINE
        NODES = 0
        DEADLINE = time.time() + 3000
        t0 = time.time()
        try:
            r = can_force(dict(START), 1, b, {})
        except Timeout:
            print(f"budget {b}: TIMEOUT after {NODES:,} nodes", flush=True); return
        print(f"X forced win within {b} placements: {r}  ({NODES:,} nodes, {time.time()-t0:.1f}s)", flush=True)

# ---- test: does the naive "block threats, dump growth far away" defence hold? ----
def dump_cell(cells):
    s = sorted(slots(cells))
    best, bd = None, -1
    for p in s:
        d = min(max(abs(p[0]-x), abs(p[1]-y)) for (x,y),m in cells.items() if m)
        if d > bd: bd, best = d, p
    return best if best else s[0]

def attacker_wins_vs_naive(cells, budget, memo):
    """X to move. Defender O plays: block a threat if any (else a blocking-ish
    cell adjacent to X), and always grow far away."""
    if budget <= 0: return False
    key = (canon(cells,1,budget))
    if key in memo: return memo[key]
    for p in opens(cells):
        cells[p] = 1
        if wins_at(cells, p, 1):
            cells[p] = 0; memo[key] = True; return True
        if budget > 1:
            for g in growth_moves(cells, 1):
                cells[g] = 0
                th = threats(cells, 1)
                if len(th) >= 2:
                    del cells[g]; cells[p] = 0; memo[key] = True; return True
                if th: blk = th[0]
                else:
                    cand = [c for c in opens(cells) if near(cells, c, 1, 1)]
                    blk = cand[0] if cand else opens(cells)[0]
                cells[blk] = 2
                if wins_at(cells, blk, 2):
                    win = False
                else:
                    d = dump_cell(cells)
                    cells[d] = 0
                    win = attacker_wins_vs_naive(cells, budget-1, memo)
                    del cells[d]
                cells[blk] = 0
                del cells[g]
                if win:
                    cells[p] = 0; memo[key] = True; return True
        cells[p] = 0
    memo[key] = False
    return False

if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "naive":
        for b in range(3, 9):
            t0 = time.time()
            r = attacker_wins_vs_naive(dict(START), b, {})
            print(f"X beats block-and-dump defence in <= {b} placements: {r}  ({time.time()-t0:.1f}s)", flush=True)
            if r: break
    else:
        bound_search(int(sys.argv[2]))

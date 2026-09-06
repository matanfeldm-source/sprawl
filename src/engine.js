/* Sprawl search engine.
   Flat Int8Array board, Zobrist-hashed transposition table, alpha-beta over
   whole turns (placement and growth chosen together). No dependencies. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.SprawlEngine=factory();
})(typeof self!=='undefined'?self:this,function(){
  // ---------- engine: flat integer board, zobrist hashing ----------
  var N=48,OFF=24,SZ=N*N,DV=[1,N,N+1,N-1],NV=[1,-1,N,-N];
  var B=new Int8Array(SZ);            // 0 none, 1 empty, 2 X, 3 O
  var CL=new Int32Array(400),CN=0;    // list of existing cells
  /* Two independent 32-bit Zobrist hashes, combined into the TT key as a
     string. A single 32-bit hash collides far more than intuition suggests
     once a search visits millions of nodes (~1 in 4B per pair, but birthday
     math over millions of distinct positions makes that a real risk) — and
     an early xorshift32-based generator made it drastically worse, because
     xorshift is linear over GF(2) and Zobrist-XORing its outputs together
     let small cell combinations collide far above the random-32-bit rate.
     splitmix32-style mixing (multiplicative, non-linear) fixes the
     per-hash collision *rate*; the second independent hash fixes the
     residual risk at scale by making the combined key ~64-bit. */
  var Z=new Int32Array(SZ*4),ZT=0,Z2=new Int32Array(SZ*4),ZT2=0;
  (function(){var seed=123456789;
    function rnd(){seed=(seed+0x9e3779b9)|0;var t=seed;
      t=Math.imul(t^(t>>>16),0x21f0aaad);t=Math.imul(t^(t>>>15),0x735a2d97);
      return (t^(t>>>15))|0;}
    for(var i=0;i<SZ*4;i++)Z[i]=rnd();ZT=rnd();
    for(var j=0;j<SZ*4;j++)Z2[j]=rnd();ZT2=rnd();})();
  var HASH=0,HASH2=0;
  var stamp=new Int32Array(SZ*4),gen=0;
  function xi(x,y){return (y+OFF)*N+(x+OFF);}
  function ixy(i){var y=(i/N)|0;return [(i-y*N)-OFF,y-OFF];}
  function ikey(i){var c=ixy(i);return c[0]+','+c[1];}
  var IX=new Int16Array(SZ),IO=new Int16Array(SZ);
  function bump(i,m,sg){
    var A=(m===2)?IX:IO;
    for(var dy=-2;dy<=2;dy++){var row=i+dy*N,ay=dy<0?-dy:dy;
      for(var dx=-2;dx<=2;dx++){var ax=dx<0?-dx:dx,dd=ax>ay?ax:ay;
        A[row+dx]+=sg*(3-dd);}}
  }
  function setC(i,v){
    var old=B[i];
    if(old>=2)bump(i,old,-1);
    HASH^=Z[i*4+old];HASH2^=Z2[i*4+old];B[i]=v;HASH^=Z[i*4+v];HASH2^=Z2[i*4+v];
    if(v>=2)bump(i,v,1);
  }
  function load(cells){
    for(var j=0;j<CN;j++){var oi=CL[j];if(B[oi]>=2)bump(oi,B[oi],-1);B[oi]=0;}
    CN=0;HASH=0;HASH2=0;
    for(var kk in cells){
      var p=kk.split(','),i=xi(+p[0],+p[1]),v=cells[kk]==null?1:(cells[kk]==='X'?2:3);
      B[i]=v;HASH^=Z[i*4+v];HASH2^=Z2[i*4+v];if(v>=2)bump(i,v,1);CL[CN++]=i;
    }
  }
  function wins(i,m){
    for(var d=0;d<4;d++){
      var v=DV[d],n=1,j;
      for(j=i+v;B[j]===m;j+=v)n++;
      for(j=i-v;B[j]===m;j-=v)n++;
      if(n>=3)return true;
    }
    return false;
  }
  function openList(){var o=[];for(var j=0;j<CN;j++)if(B[CL[j]]===1)o.push(CL[j]);return o;}
  function threatList(m,o){
    o=o||openList();var t=[];
    for(var j=0;j<o.length;j++){B[o[j]]=m;if(wins(o[j],m))t.push(o[j]);B[o[j]]=1;}
    return t;
  }
  function slotList(){
    gen++;var out=[];
    for(var j=0;j<CN;j++){var i=CL[j];
      for(var d=0;d<4;d++){
        var a=i+NV[d];
        if(B[a]===0&&stamp[a]!==gen){stamp[a]=gen;out.push(a);}
      }}
    return out;
  }
  // count near-lines: t = squares that win now, s = lines needing one grown square
  /* Merging this into one combined pass for both sides (scanBoth(), sharing
     one stamp/gen epoch, called once per evalIdx() instead of scanIdx()
     twice) was tried and reverted (2026-09-06). The correctness argument
     held up under adversarial review and a 25-position equivalence check
     (including deliberately dense mixed-mark positions) found zero
     mismatches — but the actual point, throughput, did not hold up:
     five paired benchmark runs on the fixed reference position gave
     inconsistent results (old faster in 4 of 5 pairs, new faster in 1),
     averaging to old≈3,498,342 nodes vs new≈3,485,465 in an identical 5s
     budget — a wash, if anything very slightly worse, not the ~2x a naive
     halved-pass-count argument would suggest. Unlike the openList/slotList
     hoist above (which measured a clean, repeatable ~17-20% gain), this
     is the third time in this file's history that "provably
     correctness-neutral" reasoning about a hot path didn't survive
     contact with an actual benchmark (see the reverted growOptions sort
     for the second). Always run the same comparison multiple times before
     trusting a single measurement — the first run here showed a ~7% gain
     that a second run flatly contradicted. */
  function scanIdx(m){
    gen++;var T=0,Sm=0,pot=0,seenT={};
    for(var j=0;j<CN;j++){
      var i=CL[j];if(B[i]!==m)continue;
      for(var d=0;d<4;d++){
        var v=DV[d];
        for(var o=0;o<3;o++){
          var st=i-v*o,id=st*4+d;
          if(stamp[id]===gen)continue;stamp[id]=gen;
          var mine=0,bad=0,emp=0,abs=0,ec=-1;
          for(var q=0;q<3;q++){
            var cv=B[st+v*q];
            if(cv===0)abs++;
            else if(cv===1){emp++;ec=st+v*q;}
            else if(cv===m)mine++;
            else bad++;
          }
          if(bad)continue;
          if(mine===2&&emp===1){if(!seenT[ec]){seenT[ec]=1;T++;}}
          else if(mine===2&&abs===1)Sm++;
          else if(mine===1)pot++;
        }
      }
    }
    return {t:T,s:Sm,p:pot};
  }
  var W={
    easy:  {depth:2,ms:150, cap:10,mine:10,pot:1,theirs:16,tpot:1,jitter:5000},
    medium:{depth:4,ms:450, cap:16,mine:16,pot:2,theirs:26,tpot:3,jitter:120},
    hard:  {depth:6,ms:1100,cap:22,mine:18,pot:2,theirs:34,tpot:4,jitter:4},
    master:{depth:9,ms:8000,cap:26,mine:28,pot:3,theirs:36,tpot:5,jitter:0},
    grandmaster:{depth:14,ms:15000,cap:30,mine:34,pot:4,theirs:42,tpot:6,jitter:0,parallel:true}
  };
  function evalIdx(me,w){
    var you=5-me,A=scanIdx(me),Bx=scanIdx(you),v=0;
    if(A.t>0)return 9000;
    if(Bx.t>=2)return -9500;
    if(Bx.t===1)v-=400;
    if(Bx.t===1&&Bx.s>0)v-=2500;
    if(Bx.t===0&&Bx.s>=2)v-=600;
    v+=w.mine*A.s+w.pot*A.p-w.theirs*Bx.s-w.tpot*Bx.p;
    return v;
  }
  function growOptions(me,cap,sl){
    sl=sl||slotList();
    var bi=[],bs=[],worst=-1,wv=1e9;
    for(var j=0;j<sl.length;j++){
      var i=sl[j],sc=(me===2?3*IX[i]+IO[i]:3*IO[i]+IX[i]);
      if(sc<wv){wv=sc;worst=i;}
      if(bi.length<cap){bi.push(i);bs.push(sc);}
      else{
        var mn=0;for(var q=1;q<bi.length;q++)if(bs[q]<bs[mn])mn=q;
        if(sc>bs[mn]){bi[mn]=i;bs[mn]=sc;}
      }
    }
    /* Sorting these candidates best-first (by the same score already
       computed above) was tried and reverted (2026-09-06). It's
       correctness-neutral by construction — alpha-beta explores the same
       exhaustive tree regardless of move order, so it can only change
       pruning efficiency, never a final value — but it still made things
       *worse* on a real benchmark position (depth 5 vs depth 6 reached in
       an identical 5s budget), even after rewriting it allocation-free
       (a first pass using bi.map()/sort()/map() was worse still — three
       new arrays per call, on every node in the tree, cost more in GC
       pressure than the ordering ever bought back). The remaining
       explanation: this influence/proximity heuristic doesn't actually
       correlate with which moves cause alpha-beta cutoffs, so sorting by
       it is pure overhead with no offsetting benefit. A move-ordering
       improvement here would need a heuristic that's shown to predict
       cutoffs, not just a plausible-sounding proxy — and would need
       measuring on more than one position before being trusted. */
    if(worst>=0&&wv===0&&bi.indexOf(worst)<0)bi.push(worst);
    return bi;
  }
  function genTurn(me,cap){
    /* openList()/slotList() are hoisted here and threaded down instead of
       being recomputed per call: within one genTurn invocation, only
       setC() runs (toggling a cell's *value*), which never changes CL/CN
       — so both lists are provably identical across the calls that used
       to recompute them (up to 3x for openList, once per placement
       candidate for slotList). Pure duplicate-work elimination, not a new
       heuristic: order and results are unchanged, only how many times
       they're computed. (2026-09-06 — verified against both the
       transposition-table and parallel-combine reproduction cases, plus
       array-identity checks against the old per-call behavior, before
       being trusted; see README.) */
    var you=5-me,o=openList(),mine=threatList(me,o);
    if(mine.length)return [{p:mine[0],g:-1,win:true}];
    var theirs=threatList(you,o);
    var places=theirs.length?theirs:o;   // forced block
    var sl=slotList();
    var out=[];
    for(var a=0;a<places.length;a++){
      var p=places[a];setC(p,me);
      var gs=growOptions(me,cap,sl);
      for(var b2=0;b2<gs.length;b2++)out.push({p:p,g:gs[b2]});
      setC(p,1);
    }
    return out;
  }
  /* No transposition table — and stay off this road. A second attempt was
     made here (2026-09-06, later the same day the first TT was removed):
     reintroduce caching but restricted to bound-flagged values only, never
     trusting a cached value as exact ground truth, on the theory that the
     bound-narrowing path had tested clean in isolation while the
     exact-value fast path was the specific thing proven broken. It was
     re-verified against the exact README reproduction case before being
     trusted — and it reproduced the *identical* wrong answer (`place 0,0`,
     score -70, the known-bad result) despite never using an "exact" flag
     anywhere. So the earlier isolation test's clean result doesn't
     generalize; something about this engine's specific search structure
     (the root's progressive-alpha, no-research-on-improvement scheme, most
     likely) makes *any* cross-node value caching unsound here, not just
     the exact-value shortcut. Don't reintroduce a TT without first finding
     — not just failing to find — the actual mechanism, and verify any
     candidate against the README reproduction case before trusting it. */
  /* A threat-extension (grant an extra ply at the horizon when the side to
     move has 2+ manufacturable near-threats, `scanIdx().s>=2`) was tried
     and reverted (2026-09-06). The idea — spend the same time budget on
     tactically hot lines instead of raising the budget — is sound, but
     this trigger condition is not: S>=2 is common, not rare, so it fired
     at nearly every horizon node. Measured effect on the TT-bug
     reproduction case: reached depth collapsed from 6 to 3 in the same
     time (the extra scanIdx() call per horizon node plus the ply grants
     multiplied node cost far faster than they bought useful lookahead),
     and the search picked the known-bad move again. A real threat
     extension here would need a trigger condition that's actually
     selective — e.g. only the specific manufactured-fork shape, not any
     position with two brewing lines — and would need proving it does not
     regress `test/strength.test.js` or the TT/combine reproduction cases
     before shipping, not just a plausible-sounding rationale.
     No transposition table either — see the note above this one and
     "Bugs worth not reintroducing" in the README for why. */
  var stop=0,abort=false,nodes=0,WINV=1e6;
  function nega(me,depth,alpha,beta,w,cap){
    if((nodes&255)===0&&Date.now()>stop){abort=true;return 0;}
    nodes++;
    var mv=genTurn(me,cap);
    if(mv.length&&mv[0].win)return WINV+depth;
    if(depth<=0)return evalIdx(me,w);
    var best=-Infinity;
    for(var i=0;i<mv.length;i++){
      setC(mv[i].p,me);setC(mv[i].g,1);CL[CN++]=mv[i].g;
      var sc=-nega(5-me,depth-1,-beta,-alpha,w,cap);
      CN--;setC(mv[i].g,0);setC(mv[i].p,1);
      if(abort)return best>-Infinity?best:0;
      if(sc>best)best=sc;
      if(best>alpha)alpha=best;
      if(alpha>=beta)break;
    }
    return best;
  }
  /* Single-ply lookahead used only to render a preview line (PV) in the
     analysis panel — cosmetic, so it's fine for it to cost a bit of extra
     search rather than lean on any cache. */
  function bestAt(me,depth,cap,w){
    var mv=genTurn(me,cap);
    if(!mv.length)return null;
    if(mv[0].win)return {m:mv[0],v:WINV+depth};
    var alpha=-Infinity,bm=mv[0],bv=-Infinity;
    for(var i=0;i<mv.length;i++){
      setC(mv[i].p,me);setC(mv[i].g,1);CL[CN++]=mv[i].g;
      var sc=-nega(5-me,depth-1,-Infinity,-alpha,w,cap);
      CN--;setC(mv[i].g,0);setC(mv[i].p,1);
      if(sc>bv){bv=sc;bm=mv[i];}
      if(sc>alpha)alpha=sc;
    }
    return {m:bm,v:bv};
  }
  function copyCells(src){var d={};for(var i in src)d[i]=src[i];return d;}
  function search(cells,meStr,ms,maxd,w,part,parts){
    var me=meStr==='X'?2:3,cap=w.cap||12;
    load(cells);abort=false;nodes=0;stop=Date.now()+ms;
    var root=genTurn(me,cap),score=0,reached=0,best=root[0]||null,ranked=[];
    if(root.length&&root[0].win)return {score:WINV,best:{p:ikey(root[0].p),g:null},depth:1,nodes:0,pv:[{t:meStr,p:ikey(root[0].p),g:null,win:true}]};
    /* Parallel root-splitting: each parallel caller (a separate Worker, so
       a fully independent copy of this module's state — no shared cache,
       nothing to get subtly wrong) searches only every `parts`-th root
       move, to whatever depth it can reach in the same time budget. Fewer
       moves per depth iteration means each worker gets deeper before time
       runs out. The caller combines results across workers. */
    if(parts>1)root=root.filter(function(_,idx){return idx%parts===part;});
    if(!root.length)return {score:-Infinity,best:null,depth:0,nodes:0,pv:[],alts:[]};
    for(var d=1;d<=maxd;d++){
      var alpha=-Infinity,list=[];
      for(var i=0;i<root.length;i++){
        setC(root[i].p,me);setC(root[i].g,1);CL[CN++]=root[i].g;
        var sc=-nega(5-me,d-1,-Infinity,-alpha,w,cap);
        CN--;setC(root[i].g,0);setC(root[i].p,1);
        if(abort)break;
        list.push({m:root[i],v:sc});
        if(sc>alpha)alpha=sc;
      }
      if(abort)break;
      if(!list.length)break;
      list.sort(function(a,b){return b.v-a.v;});
      ranked=list;score=list[0].v;reached=d;
      root=list.map(function(o){return o.m;});
      if(Math.abs(score)>=WINV)break;
    }
    if(ranked.length){
      var top=ranked[0].v,pool=[];
      for(var j=0;j<ranked.length;j++)if(top-ranked[j].v<=(w.jitter||0)&&Math.abs(top)<WINV)pool.push(ranked[j]);
      if(!pool.length)pool=[ranked[0]];
      best=pool[(Math.random()*pool.length)|0].m;
    }
    var pv=[];
    if(best){
      var t=me,applied=[];
      pv.push({t:t===2?'X':'O',p:ikey(best.p),g:best.g>=0?ikey(best.g):null});
      setC(best.p,me);setC(best.g,1);CL[CN++]=best.g;applied.push(best);
      abort=false;stop=Date.now()+200;
      for(var s2=0;s2<5;s2++){
        t=5-t;var r2=bestAt(t,3,Math.min(cap,16),w);
        if(!r2||abort)break;
        var ent=r2.m,isWin=r2.v>=WINV;
        pv.push({t:t===2?'X':'O',p:ikey(ent.p),g:ent.g>=0?ikey(ent.g):null,win:isWin});
        if(isWin)break;
        setC(ent.p,t);if(ent.g<0)break;setC(ent.g,1);CL[CN++]=ent.g;applied.push(ent);
      }
      for(var u=applied.length-1;u>=0;u--){CN--;setC(applied[u].g,0);setC(applied[u].p,1);}
    }
    var alts=[];
    for(var al=0;al<ranked.length&&al<3;al++){
      var rm=ranked[al].m;
      alts.push({p:ikey(rm.p),g:rm.g>=0?ikey(rm.g):null,score:ranked[al].v});
    }
    return {score:score,best:best?{p:ikey(best.p),g:best.g>=0?ikey(best.g):null}:null,
            depth:reached,nodes:nodes,pv:pv,alts:alts};
  }
  function growCands(cells){load(cells);var g=growOptions(2,24),o=[];for(var i=0;i<g.length;i++)o.push(ikey(g[i]));return o;}
  function turnMoves(cells,meStr,w){load(cells);return genTurn(meStr==='X'?2:3,12);}
  function evalPos(cells,meStr,w){load(cells);return evalIdx(meStr==='X'?2:3,w);}
  function scan(cells,meStr){load(cells);return scanIdx(meStr==='X'?2:3);}

  return {search:search,turnMoves:turnMoves,evalPos:evalPos,scan:scan,
          growCands:growCands,copyCells:copyCells,WEIGHTS:W,WIN:WINV};
});

/* Sprawl online play: peer-to-peer over WebRTC via Trystero, using a free
   Firebase Realtime Database for discovery/signaling. No app-level
   account for players, no server for anyone to host — but it does
   depend on a third-party CDN and Firebase being reachable, and on
   browsers' WebRTC/NAT traversal succeeding without a TURN server.

   The previous version used Trystero's BitTorrent-tracker and MQTT
   strategies (public relays, zero setup). Both were tested directly
   (two independent peers joining the same room) and confirmed broken —
   peers never discovered each other, even after 40+ seconds, on two
   different signaling backends. Public WebTorrent trackers and MQTT
   brokers are not actually designed for arbitrary WebRTC signaling and
   have become unreliable for it. Firebase's realtime strategy uses a
   dedicated database instead and was verified working.

   Two flows share one connection layer:

   - hostLink()/joinLink(code): a private room keyed by a random code,
     shared as a URL. Deterministic: host is always X.
   - findMatch(): both sides join a shared public lobby room. The first
     peer seen is paired with, deterministically deciding host/guest by
     comparing peer ids (so both sides agree without extra messages),
     then both leave the lobby and join a room derived from the pair. */
(function () {
  var statusFns = [], moveFns = [];
  function emit(list, data) { for (var i = 0; i < list.length; i++) list[i](data); }

  /* Calls made before the CDN module finishes loading are queued and
     replayed once it's ready, instead of failing — this matters most for
     the ?room= auto-join on page load, which always races the import(). */
  var queue = [];
  function queueOrRun(name, args) {
    if (api.ready || api.error) return false;
    queue.push({ name: name, args: args });
    emit(statusFns, { state: name === 'joinLink' ? 'connecting' : 'searching' });
    return true;
  }
  function drainQueue() {
    var q = queue; queue = [];
    for (var i = 0; i < q.length; i++) api[q[i].name].apply(api, q[i].args);
  }

  var api = {
    ready: false,
    error: null,
    hostLink: function () { queueOrRun('hostLink', []); },
    joinLink: function (code) { queueOrRun('joinLink', [code]); },
    findMatch: function () { queueOrRun('findMatch', []); },
    cancel: function () { queue = []; },
    sendMove: function () {},
    onStatus: function (fn) { statusFns.push(fn); },
    onMove: function (fn) { moveFns.push(fn); }
  };
  window.SprawlOnline = api;

  /* trystero@0.21.2's firebase strategy has a real race: it drops any
     peer-presence signal that arrives (via 'child_added' on the room ref)
     before the room's initial 'value' sync resolves — the exact case when
     a joiner subscribes after the host has already announced. Confirmed
     by direct two-peer testing: ICE candidates gathered fine on both
     sides, but onPeerJoin never fired because the offer was silently
     dropped. @trystero-p2p/firebase (the package's current name) fixes
     this by queueing pending owners and flushing them after sync.
     ?bundle still avoids the firebase/app + firebase/database
     dual-module-instance issue from the old import. */
  import('https://esm.sh/@trystero-p2p/firebase@0.25.4?bundle').then(function (mod) {
    var joinRoom = mod.joinRoom, selfId = mod.selfId;
    /* Trystero's firebase strategy takes the database URL as appId and
       uses it purely for WebRTC signaling (peer presence under the
       "__trystero__" path) — no game state is ever stored there. */
    var ROOM_CFG = { appId: 'https://sprawl-online-default-rtdb.firebaseio.com' };
    var room = null, sendMv = null, lobby = null, paired = false, searchTimer = null;

    function leaveRoom() { if (room) { try { room.leave(); } catch (e) {} room = null; sendMv = null; } }
    function leaveLobby() { if (lobby) { try { lobby.leave(); } catch (e) {} lobby = null; } }

    function attach(roomId, amHost) {
      leaveRoom();
      room = joinRoom(ROOM_CFG, roomId);
      var act = room.makeAction('mv');
      sendMv = act.send;
      act.onMessage = function (data) { emit(moveFns, data); };
      room.onPeerJoin = function () { emit(statusFns, { state: 'connected', you: amHost ? 'X' : 'O' }); };
      room.onPeerLeave = function () { emit(statusFns, { state: 'left' }); };
    }

    api.hostLink = function () {
      leaveLobby();
      var code = Math.random().toString(36).slice(2, 8);
      attach('sprawl-link-' + code, true);
      var url = location.origin + location.pathname + '?room=' + code;
      emit(statusFns, { state: 'waiting', link: url, you: 'X' });
    };

    api.joinLink = function (code) {
      leaveLobby();
      attach('sprawl-link-' + code, false);
      emit(statusFns, { state: 'connecting', you: 'O' });
    };

    api.findMatch = function () {
      leaveRoom(); leaveLobby();
      paired = false;
      emit(statusFns, { state: 'searching' });
      lobby = joinRoom(ROOM_CFG, 'sprawl-lobby-v2');
      lobby.onPeerJoin = function (otherId) {
        if (paired) return;
        paired = true;
        clearTimeout(searchTimer);
        var amHost = selfId < otherId;
        var matchId = 'sprawl-match-' + [selfId, otherId].sort().join('_');
        leaveLobby();
        attach(matchId, amHost);
      };
      searchTimer = setTimeout(function () {
        if (!paired) { leaveLobby(); emit(statusFns, { state: 'timeout' }); }
      }, 25000);
    };

    api.cancel = function () {
      clearTimeout(searchTimer);
      leaveLobby();
      leaveRoom();
      emit(statusFns, { state: 'idle' });
    };

    api.sendMove = function (payload) { if (sendMv) sendMv(payload); };
    api.ready = true;
    drainQueue();
  }).catch(function (err) {
    api.error = String((err && err.message) || err);
    var fail = function () {
      emit(statusFns, { state: 'error', message: 'Online play could not load (needs internet access to a public relay). Try again later.' });
    };
    api.hostLink = api.joinLink = api.findMatch = fail;
    drainQueue();
  });
})();

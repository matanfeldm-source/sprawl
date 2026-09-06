/* Sprawl online play: peer-to-peer over WebRTC via Trystero, using free
   public WebTorrent trackers for discovery/signaling. No account, no
   server for anyone to host — but it does depend on a third-party CDN
   and public relay being reachable, and on browsers' WebRTC/NAT traversal
   succeeding without a TURN server. Two flows share one connection layer:

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

  import('https://esm.sh/trystero@0.21.2/torrent').then(function (mod) {
    var joinRoom = mod.joinRoom, selfId = mod.selfId;
    var APP_ID = 'sprawl-ttt-v2';
    /* Connect to several public trackers redundantly rather than trusting
       Trystero's internal random pick of two — any single dead tracker
       (they come and go) shouldn't be able to strand a rendezvous. */
    var TRACKERS = [
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.webtorrent.dev',
      'wss://tracker.btorrent.xyz'
    ];
    var ROOM_CFG = { appId: APP_ID, trackerUrls: TRACKERS, trackerRedundancy: TRACKERS.length };
    var room = null, sendMv = null, lobby = null, paired = false, searchTimer = null;

    function leaveRoom() { if (room) { try { room.leave(); } catch (e) {} room = null; sendMv = null; } }
    function leaveLobby() { if (lobby) { try { lobby.leave(); } catch (e) {} lobby = null; } }

    function attach(roomId, amHost) {
      leaveRoom();
      room = joinRoom(ROOM_CFG, roomId);
      var act = room.makeAction('mv');
      sendMv = act[0];
      act[1](function (data) { emit(moveFns, data); });
      room.onPeerJoin(function () { emit(statusFns, { state: 'connected', you: amHost ? 'X' : 'O' }); });
      room.onPeerLeave(function () { emit(statusFns, { state: 'left' }); });
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
      lobby.onPeerJoin(function (otherId) {
        if (paired) return;
        paired = true;
        clearTimeout(searchTimer);
        var amHost = selfId < otherId;
        var matchId = 'sprawl-match-' + [selfId, otherId].sort().join('_');
        leaveLobby();
        attach(matchId, amHost);
      });
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

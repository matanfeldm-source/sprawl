/* Runs the engine off the main thread so deep search never freezes the page. */
importScripts('rules.js', 'engine.js');
var E = SprawlEngine;
onmessage = function (ev) {
  var d = ev.data;
  var r = E.search(d.cells, d.turn, d.ms, d.depth, d.w, d.part, d.parts, d.mem);
  postMessage({ id: d.id, result: r });
};

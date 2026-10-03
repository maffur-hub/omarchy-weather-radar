import QtQuick
import "../lib/TileMath.js" as TileMath
import "../lib/Strikes.js" as Strikes

// The live lightning dots drawn over the radar map.
//
// True live strikes streamed from LightningMaps' WebSocket by the panel, not a
// server-rendered tile: the old live tile layer is dead (it answers every
// location, zoom and T with the same empty transparent image). Each strike is
// projected into the viewport and drawn as a small dot coloured by its age, so
// a storm's newest strokes read amber and its older ones darken towards red.
//
// Modelled on ui/OverlayCanvas.qml. Repaints whenever the strike buffer or the
// view changes, driven by `revision` plus the geometry-change handlers, and is
// faded out while the loop rests on a past frame (see `lit`).
Canvas {
  id: root

  // [{id, t, lat, lon}], mutated in place by Panel.qml's feed; `revision`
  // carries the change signal because the array identity does not.
  property var strikes: []
  property var revision: 0
  property real centerLatitude: 0
  property real centerLongitude: 0
  property int zoom: 7
  // Whether to paint at all: the panel fades the canvas while the loop is not
  // on the newest frame, where the strikes did not happen.
  property bool lit: true

  onRevisionChanged: requestPaint()
  onLitChanged: requestPaint()
  onWidthChanged: requestPaint()
  onHeightChanged: requestPaint()

  function project(lat, lon) {
    return TileMath.projectToViewport(lat, lon,
      root.centerLatitude, root.centerLongitude, root.zoom, root.width, root.height)
  }

  onPaint: {
    var ctx = getContext("2d")
    ctx.reset()
    if (!lit) return

    var now = Date.now()
    for (var i = 0; i < root.strikes.length; i++) {
      var strike = root.strikes[i]
      if (!strike) continue

      // The age palette comes from Strikes.js, the same source the panel's
      // legend reads, so the dots and the key cannot disagree.
      var age = now - strike.t
      var colour = Strikes.colorForAge(age)
      if (!colour) continue

      var p = project(strike.lat, strike.lon)
      if (!isFinite(p.x) || !isFinite(p.y)) continue
      // A strike just off the edge is not worth a canvas operation; the margin
      // keeps a dot whose radius reaches back in from popping at the seam.
      if (p.x < -8 || p.x > root.width + 8 || p.y < -8 || p.y > root.height + 8) continue

      ctx.beginPath()
      ctx.arc(p.x, p.y, 2.5, 0, 2 * Math.PI)
      ctx.fillStyle = colour
      ctx.fill()
    }
  }
}

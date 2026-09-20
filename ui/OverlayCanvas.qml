import QtQuick
import "../lib/TileMath.js" as TileMath

// The wind vectors and pressure contours drawn over the radar map.
//
// Both are computed by the panel from a single Open-Meteo grid covering the
// view (see lib/Overlay.js) and handed to this canvas, which projects each
// point into the viewport and paints. It repaints whenever the data is
// replaced or the view moves, driven by `revision`.
Canvas {
  id: root

  // The parsed grid: [{ latitude, longitude, windSpeed, windDirection, pressure }].
  property var points: []
  // Isobars: [{ level, path: [[lat, lon], ...] }].
  property var isobars: []
  property bool showWind: false
  property bool showSynoptic: false

  property real centerLatitude: 0
  property real centerLongitude: 0
  property int zoom: 7

  // Changed whenever the data or the view moves, so the painting re-runs.
  property var revision: 0

  property color foreground: "#ffffff"
  property color accent: "#7aa2f7"
  property real windScale: 1

  onPointsChanged: requestPaint()
  onIsobarsChanged: requestPaint()
  onShowWindChanged: requestPaint()
  onShowSynopticChanged: requestPaint()
  onRevisionChanged: requestPaint()
  onWidthChanged: requestPaint()
  onHeightChanged: requestPaint()
  onCenterLatitudeChanged: requestPaint()
  onCenterLongitudeChanged: requestPaint()
  onZoomChanged: requestPaint()

  onPaint: {
    var ctx = getContext("2d")
    ctx.reset()
    if (!showWind && !showSynoptic) return

    if (showSynoptic) drawIsobars(ctx)
    if (showWind) drawWind(ctx)
  }

  function project(lat, lon) {
    return TileMath.projectToViewport(lat, lon,
      root.centerLatitude, root.centerLongitude, root.zoom, root.width, root.height)
  }

  function drawIsobars(ctx) {
    ctx.strokeStyle = root.foreground
    ctx.lineWidth = 1
    ctx.globalAlpha = 0.5
    ctx.lineJoin = "round"
    for (var i = 0; i < root.isobars.length; i++) {
      var bar = root.isobars[i]
      var path = bar.path
      if (!path || path.length < 2) continue
      ctx.beginPath()
      var start = project(path[0][0], path[0][1])
      ctx.moveTo(start.x, start.y)
      for (var j = 1; j < path.length; j++) {
        var p = project(path[j][0], path[j][1])
        ctx.lineTo(p.x, p.y)
      }
      ctx.stroke()

      // A small level label at the middle of the line, so the squiggles say
      // what pressure they are.
      var mid = project(path[Math.floor(path.length / 2)][0], path[Math.floor(path.length / 2)][1])
      ctx.font = "9px sans-serif"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillStyle = root.foreground
      ctx.globalAlpha = 0.85
      ctx.fillText(String(bar.level), mid.x, mid.y)
      ctx.globalAlpha = 0.5
    }
    ctx.globalAlpha = 1
  }

  function drawWind(ctx) {
    // Arrow points downwind; the API reports the direction the wind comes from.
    ctx.strokeStyle = root.accent
    ctx.fillStyle = root.accent
    ctx.lineWidth = 1.5
    ctx.lineCap = "round"
    for (var i = 0; i < root.points.length; i++) {
      var pt = root.points[i]
      if (pt.windSpeed < 0) continue
      var from = project(pt.latitude, pt.longitude)
      var heading = (pt.windDirection + 180) * Math.PI / 180
      var len = Math.min(36, 4 + pt.windSpeed * root.windScale)
      var tx = from.x + Math.sin(heading) * len
      var ty = from.y - Math.cos(heading) * len

      ctx.globalAlpha = 0.85
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(tx, ty)
      ctx.stroke()

      // Arrowhead at the downwind end.
      var spread = 0.6
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(tx + Math.sin(heading + Math.PI - spread) * 5, ty - Math.cos(heading + Math.PI - spread) * 5)
      ctx.moveTo(tx, ty)
      ctx.lineTo(tx + Math.sin(heading + Math.PI + spread) * 5, ty - Math.cos(heading + Math.PI + spread) * 5)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }
}
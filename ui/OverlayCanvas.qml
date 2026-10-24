import QtQuick
import "../lib/TileMath.js" as TileMath

// The wind vectors and pressure contours drawn over the radar map.
//
// Both are computed by the panel from Open-Meteo readings (see lib/Overlay.js)
// and handed to this canvas, which projects each point into the viewport and
// paints. The wind comes from a grid covering the view; the isobars come from a
// much wider synoptic region, so most of each contour is off-canvas and the
// canvas simply clips it. It repaints whenever the data is replaced or the view
// moves, driven by `revision`.
Canvas {
  id: root

  // The parsed grid: [{ latitude, longitude, windSpeed, windDirection, pressure }].
  property var points: []
  // Isobars: [{ level, label, path: [{ lat, lon }, ...] }].
  property var isobars: []
  // Pressure centres: [{ lat, lon, kind: "H" | "L", pressure }].
  property var extrema: []
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
  onExtremaChanged: requestPaint()
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

    if (showSynoptic) {
      // Lines first, then every label, then the centres: a label drawn as its
      // contour is painted would have a later contour run through it, and the
      // H/L discs sit above both.
      var lines = drawIsobars(ctx)
      drawIsobarLabels(ctx, lines)
      drawExtrema(ctx)
    }
    if (showWind) drawWind(ctx)
  }

  function project(lat, lon) {
    return TileMath.projectToViewport(lat, lon,
      root.centerLatitude, root.centerLongitude, root.zoom, root.width, root.height)
  }

  // Draws the contours and hands back what the labels need: the visible run of
  // projected points and that run's drawn length, so a label is placed by
  // distance along the part of the line actually on screen and a short
  // fragment is not labelled.
  function drawIsobars(ctx) {
    var lines = []

    ctx.lineJoin = "round"
    ctx.lineCap = "round"
    for (var i = 0; i < root.isobars.length; i++) {
      var bar = root.isobars[i]
      var path = bar.path
      if (!path || path.length < 2) continue

      // Project once: the same points feed the path, its length and every label
      // position, and projecting again for a label could land it a pixel off
      // the line it names.
      var points = []
      for (var j = 0; j < path.length; j++) {
        points.push(project(path[j].lat, path[j].lon))
      }

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (var k = 1; k < points.length; k++) {
        ctx.lineTo(points[k].x, points[k].y)
      }

      // A dark halo under the contour, then the line itself: radar colours run
      // from pale blue to deep red, and a thin white line alone disappears over
      // the lighter echoes.
      ctx.strokeStyle = "rgba(0,0,0,0.6)"
      ctx.lineWidth = 3.5
      ctx.globalAlpha = 0.45
      ctx.stroke()

      ctx.strokeStyle = root.foreground
      ctx.lineWidth = 1
      // High enough to read over a radar echo without turning the map into a
      // wireframe when a deep low fills it with contours.
      ctx.globalAlpha = 0.75
      ctx.stroke()

      var text = (bar.label !== undefined && bar.label !== null && String(bar.label) !== "")
        ? String(bar.label) : String(bar.level)
      // The contour runs well beyond the canvas when the pressure field covers
      // a synoptic region, so only the parts on screen may carry a label: a
      // label placed along the whole path can be mostly off-canvas and get
      // rejected by the margin test, leaving nothing on the visible stretch.
      var runs = visibleRuns(points)
      for (var n = 0; n < runs.length; n++) {
        lines.push({ label: text, points: runs[n], length: pathLength(runs[n]) })
      }
    }
    ctx.globalAlpha = 1
    return lines
  }

  // The runs of a projected contour that lie inside the canvas, with a small
  // margin so a label near the border still has its knockout box on screen. A
  // run breaks where the path leaves; a run of one point has no length to
  // place a label along.
  function visibleRuns(points) {
    var runs = []
    var run = []
    var pad = 8
    for (var i = 0; i < points.length; i++) {
      var p = points[i]
      var inside = isFinite(p.x) && isFinite(p.y)
        && p.x >= -pad && p.x <= root.width + pad
        && p.y >= -pad && p.y <= root.height + pad
      if (inside) {
        run.push(p)
      } else if (run.length > 0) {
        if (run.length >= 2) runs.push(run)
        run = []
      }
    }
    if (run.length >= 2) runs.push(run)
    return runs
  }

  // One number per contour is not enough: it can land off the edge of the
  // view, under an H or L disc, or on a short fragment where it names nothing.
  // A long contour therefore carries up to three, spaced by distance and moved
  // along the line until each one finds a clear spot. They are drawn after all
  // the lines, so the knockout behind one really does hide the contour it sits
  // on rather than being overpainted by the next line.
  function drawIsobarLabels(ctx, lines) {
    if (!lines || lines.length === 0) return

    ctx.font = "bold 10px sans-serif"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"

    // Everything a label may not cover. The H/L discs get a 36 px square so a
    // label never touches the disc edge; the bottom-left corner belongs to the
    // HOME reading card and the recentre button.
    var taken = []
    for (var e = 0; e < root.extrema.length; e++) {
      var centre = project(root.extrema[e].lat, root.extrema[e].lon)
      if (!isFinite(centre.x) || !isFinite(centre.y)) continue
      taken.push({ x: centre.x - 18, y: centre.y - 18, w: 36, h: 36 })
    }
    taken.push({ x: 0, y: root.height - 100, w: 190, h: 100 })
    // The attribution line runs along the bottom edge; a knockout box there
    // reads as an underline through the credits.
    taken.push({ x: 0, y: root.height - 18, w: root.width, h: 18 })

    // Where each value has already been read, and how many times: a contour
    // split into several visible runs would otherwise label itself once per
    // run and repeat the number across the map.
    var placed = []
    var counts = {}

    var offsets = [0, -0.12, 0.12, -0.24, 0.24]
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (!line.points || line.points.length < 2 || line.length < 60) continue
      if ((counts[line.label] || 0) >= 3) continue

      var boxWidth = ctx.measureText(line.label).width + 9
      var boxHeight = 14
      var count = Math.min(3, Math.max(1, Math.round(line.length / 200)))
      for (var n = 0; n < count; n++) {
        // The budget is checked per label rather than per line: a level that
        // arrives as several runs would otherwise spend three each and tile
        // the map with one number.
        if ((counts[line.label] || 0) >= 3) break
        var ideal = (n + 0.5) / count
        for (var o = 0; o < offsets.length; o++) {
          var fraction = Math.max(0.02, Math.min(0.98, ideal + offsets[o]))
          var at = pointAlong(line.points, line.length * fraction)
          var box = {
            x: at.x - boxWidth / 2,
            y: at.y - boxHeight / 2,
            w: boxWidth,
            h: boxHeight
          }

          // Two readings of the same pressure a few centimetres apart say
          // nothing new; try the next offset along the line instead.
          if (crowdsSameValue(line.label, at, placed)) continue

          // Inside the canvas with a margin, and clear of everything already
          // placed. The first candidate that manages both is the label's spot.
          if (box.x < 4 || box.y < 4 || box.x + box.w > root.width - 4
              || box.y + box.h > root.height - 4) continue
          if (intersectsAny(box, taken)) continue

          ctx.fillStyle = "rgba(0,0,0,0.72)"
          ctx.globalAlpha = 0.92
          roundedRect(ctx, box.x, box.y, box.w, box.h, 3)
          ctx.fill()

          ctx.fillStyle = root.foreground
          ctx.globalAlpha = 0.95
          ctx.fillText(line.label, at.x, at.y)

          taken.push(box)
          placed.push({ label: line.label, x: at.x, y: at.y })
          counts[line.label] = (counts[line.label] || 0) + 1
          break
        }
      }
    }
    ctx.globalAlpha = 1
  }

  function intersectsAny(box, taken) {
    for (var i = 0; i < taken.length; i++) {
      var other = taken[i]
      if (box.x < other.x + other.w && box.x + box.w > other.x
          && box.y < other.y + other.h && box.y + box.h > other.y) return true
    }
    return false
  }

  // Whether a label with this value would land too close to one already
  // placed. The threshold is about a fifth of the canvas width, far enough
  // that two readings of one isobar read as separate branches and not as a
  // stutter.
  function crowdsSameValue(label, at, placed) {
    for (var i = 0; i < placed.length; i++) {
      if (placed[i].label !== label) continue
      var dx = placed[i].x - at.x
      var dy = placed[i].y - at.y
      if (dx * dx + dy * dy < 120 * 120) return true
    }
    return false
  }

  // The drawn length of a projected polyline, in pixels.
  function pathLength(points) {
    var total = 0
    for (var i = 1; i < points.length; i++) {
      var dx = points[i].x - points[i - 1].x
      var dy = points[i].y - points[i - 1].y
      total += Math.sqrt(dx * dx + dy * dy)
    }
    return total
  }

  // The point a pixel distance along the line. Clamped, because a rounded
  // fraction can land a hair past the end; the last point is the answer there.
  function pointAlong(points, distance) {
    var total = pathLength(points)
    var target = Math.max(0, Math.min(total, distance))
    var walked = 0
    for (var i = 1; i < points.length; i++) {
      var dx = points[i].x - points[i - 1].x
      var dy = points[i].y - points[i - 1].y
      var segment = Math.sqrt(dx * dx + dy * dy)
      if (segment <= 0) continue
      if (walked + segment >= target) {
        var t = (target - walked) / segment
        return { x: points[i - 1].x + dx * t, y: points[i - 1].y + dy * t }
      }
      walked += segment
    }
    return { x: points[points.length - 1].x, y: points[points.length - 1].y }
  }

  // Canvas has no rounded-rectangle path primitive, and a label's knockout is
  // the one place a square corner would show against a curve.
  function roundedRect(ctx, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height / 2)
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + width - r, y)
    ctx.quadraticCurveTo(x + width, y, x + width, y + r)
    ctx.lineTo(x + width, y + height - r)
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
    ctx.lineTo(x + r, y + height)
    ctx.quadraticCurveTo(x, y + height, x, y + height - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
  }

  function drawExtrema(ctx) {
    // The pressure centres, as synoptic charts mark them: an H or an L with a
    // dark disc behind it so the letter reads over the radar beneath, and the
    // sampled pressure under the letter so the chart says how deep the centre
    // is without opening another view. A thin ring keeps the disc's edge from
    // dissolving into a dark echo.
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    for (var i = 0; i < root.extrema.length; i++) {
      var ex = root.extrema[i]
      var p = project(ex.lat, ex.lon)
      if (!isFinite(p.x) || !isFinite(p.y)) continue
      var value = ex.pressure
      var hasValue = typeof value === "number" && isFinite(value)
      var radius = hasValue ? 14 : 12

      ctx.fillStyle = "rgba(0,0,0,0.4)"
      ctx.beginPath()
      ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI)
      ctx.fill()

      ctx.strokeStyle = "rgba(255,255,255,0.22)"
      ctx.lineWidth = 1
      ctx.stroke()

      ctx.fillStyle = root.foreground
      if (hasValue) {
        ctx.font = "bold 13px sans-serif"
        ctx.fillText(ex.kind, p.x, p.y - 5)
        ctx.font = "9px sans-serif"
        ctx.fillText(String(Math.round(value)), p.x, p.y + 6)
      } else {
        ctx.font = "bold 16px sans-serif"
        ctx.fillText(ex.kind, p.x, p.y)
      }
    }
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
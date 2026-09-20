import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Overlay.js" as Overlay
import "../lib/coast.js" as Coast

// The Aurora Australis tab: a polar view of the southern hemisphere with the
// NOAA OVATION aurora probability grid under the coastlines, a marker for the
// viewer's location, a Kp chart of the observed history and forecast, and a
// line of solar readings. Together these are the aurora's two questions —
// where the oval is, and what is driving it — answered by NOAA SWPC.
//
// The projection is azimuthal equidistant about the south pole, exactly the
// one the aurora is read on: radius is linear in colatitude, the 0 meridian
// points down, and east runs counter-clockwise when viewed from below the
// pole. The view is mirrored from the north-pole view, which is how a
// southern-hemisphere aurora is normally drawn.
Column {
  id: root

  property var cells: []           // [{ lat, lon, p }] from OVATION
  property string observedTime: ""
  property real kpNow: NaN
  property real kpPeak: NaN
  property var kpRows: []          // [{ t, kp, kind }] for the chart
  property real solarWind: NaN     // km/s
  property real magBt: NaN         // nT
  property real magBz: NaN         // nT
  property real solarFlux: NaN     // s.f.u.
  property string flareClass: ""   // e.g. "C1.2"

  // The viewer, as { latitude, longitude }, or null to omit the marker.
  property var site: null

  property color foreground: "#ffffff"
  property color accent: "#7aa2f7"

  readonly property real minLat: -25
  readonly property bool hasKp: isFinite(kpNow) || isFinite(kpPeak)

  // Kp at which the aurora reaches this location on the horizon, for the
  // chart's reference line, or 0 to omit it (never within the forecast range).
  readonly property real visibleAtKp: {
    if (!site) return 0
    var absMlat = Math.abs(Overlay.geomagLat(site.latitude, site.longitude))
    var kp = (63.5 - absMlat) / 2.06
    return kp > 0 && kp <= 9 ? kp : 0
  }

  // A short line about what the sky is doing: the current Kp, whether the
  // oval reaches this location, and the forecast peak.
  readonly property string status: {
    if (!hasKp) return "Loading Kp…"
    var bits = []
    if (isFinite(kpNow)) bits.push("Kp " + Overlay.formatKp(kpNow))
    if (isFinite(kpPeak)) bits.push("forecast peak Kp " + Overlay.formatKp(kpPeak))
    if (site) {
      var absMlat = Math.abs(Overlay.geomagLat(site.latitude, site.longitude))
      var k = isFinite(kpNow) ? kpNow : kpPeak
      var edge = 66.5 - 2.06 * k
      if (absMlat >= edge) bits.push("the oval is overhead here")
      else if (absMlat >= edge - 3) bits.push("visible on the southern horizon")
      else bits.push("not visible from here at this Kp")
    }
    return bits.join(" · ")
  }

  onCellsChanged: map.requestPaint()
  onSiteChanged: map.requestPaint()

  // One line of what is actually driving the oval right now, or a placeholder
  // while the first readings are on their way.
  readonly property string solarLine: {
    var bits = []
    if (isFinite(solarWind)) bits.push("solar wind " + Math.round(solarWind) + " km/s")
    if (isFinite(magBt) || isFinite(magBz)) {
      if (isFinite(magBz)) bits.push("Bz " + magBz.toFixed(1) + " nT")
      else bits.push("Bt " + magBt.toFixed(1) + " nT")
    }
    if (isFinite(solarFlux)) bits.push("F10.7 " + Math.round(solarFlux))
    if (flareClass !== "") bits.push("flare " + flareClass)
    return bits.length > 0 ? bits.join(" · ") : "Loading solar activity…"
  }

  spacing: Style.space(8)

  // Header: title and the live reading.
  Row {
    width: parent.width
    spacing: Style.space(8)

    Text {
      id: auroraTitle
      textFormat: Text.PlainText
      text: "AURORA AUSTRALIS"
      color: root.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      font.bold: true
      opacity: 0.7
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width - (auroraTitle.width + parent.spacing * 2)
      text: root.status
      color: root.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
      anchors.verticalCenter: parent.verticalCenter
      opacity: 0.85
    }
  }

  // The polar map.
  Canvas {
    id: map
    width: parent.width
    height: Style.space(280)

    readonly property real radius: Math.max(1, Math.min(width, height) / 2 - 2)
    readonly property real span: 90 - Math.abs(root.minLat)

    function project(lon, lat) {
      var r = radius * (90 - (-1) * lat) / span
      var a = (lon - 180) * Math.PI / 180
      return { x: width / 2 + (-1) * r * Math.sin(a), y: height / 2 + r * Math.cos(a) }
    }

    function inView(lat) { return (-1) * lat >= Math.abs(root.minLat) }

    onWidthChanged: requestPaint()
    onHeightChanged: requestPaint()

    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      var cx = width / 2
      var cy = height / 2

      // Latitude rings, every 15 degrees from 75°S in.
      ctx.strokeStyle = root.foreground
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.35
      for (var l = 75; l >= Math.abs(root.minLat); l -= 15) {
        ctx.beginPath()
        ctx.arc(cx, cy, map.radius * (90 - l) / map.span, 0, 2 * Math.PI)
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.moveTo(cx, cy - map.radius); ctx.lineTo(cx, cy + map.radius)
      ctx.moveTo(cx - map.radius, cy); ctx.lineTo(cx + map.radius, cy)
      ctx.stroke()
      ctx.globalAlpha = 1

      // Aurora probability as soft dots, the way OVATION's independent 1-degree
      // cells read honestly.
      var dot = Math.max(2, map.radius / map.span * 1.7)
      ctx.fillStyle = root.accent
      for (var i = 0; i < root.cells.length; i++) {
        var c = root.cells[i]
        if (!map.inView(c.lat)) continue
        ctx.globalAlpha = Math.max(0.1, Math.min(0.9, Math.pow(Math.min(c.p, 60) / 60, 0.6)))
        var p = map.project(c.lon, c.lat)
        ctx.beginPath()
        ctx.arc(p.x, p.y, dot / 2, 0, 2 * Math.PI)
        ctx.fill()
      }
      ctx.globalAlpha = 1

      // Coastlines over the aurora.
      var lines = Coast.forHemisphere(-1)
      ctx.strokeStyle = root.foreground
      ctx.lineWidth = 1
      ctx.lineJoin = "round"
      ctx.globalAlpha = 0.8
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j]
        ctx.beginPath()
        for (var k = 0; k < line.length; k++) {
          var q = map.project(line[k][0], line[k][1])
          if (k === 0) ctx.moveTo(q.x, q.y)
          else ctx.lineTo(q.x, q.y)
        }
        ctx.stroke()
      }
      ctx.globalAlpha = 1

      // You are here.
      if (root.site && map.inView(root.site.latitude)) {
        var s = map.project(root.site.longitude, root.site.latitude)
        ctx.strokeStyle = root.foreground
        ctx.fillStyle = root.foreground
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(s.x, s.y, Math.max(4, dot * 1.5), 0, 2 * Math.PI)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(s.x, s.y, Math.max(1.5, dot * 0.35), 0, 2 * Math.PI)
        ctx.fill()
      }
    }
  }

  // The Kp chart: observed history running into NOAA's three-day forecast,
  // with the storm threshold and the Kp this location needs before there is
  // anything to look for. The same shape the space weather plugin drew.
  KpChart {
    id: kpChart
    width: parent.width
    height: Style.space(110)
    rows: root.kpRows
    visibleAtKp: root.visibleAtKp
    barColor: root.foreground
    forecastColor: Qt.darker(root.foreground, 1.6)
    gridColor: Qt.darker(root.foreground, 1.6)
    labelColor: Qt.darker(root.foreground, 1.6)
    fontFamily: Style.font.family
    timePattern: "HH:mm"
  }

  // The solar readings that drive the oval: wind speed, the magnetic field
  // (Bz negative opens the door), the 10.7 cm flux, and the latest flare.
  Text {
    textFormat: Text.PlainText
    width: parent.width
    text: root.solarLine
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    elide: Text.ElideRight
    opacity: 0.85
  }

  Text {
    textFormat: Text.PlainText
    width: parent.width
    text: root.observedTime !== ""
      ? "OVATION forecast · " + root.observedTime + " · NOAA SWPC"
      : "OVATION forecast · NOAA SWPC"
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption * 0.8
    opacity: 0.4
  }
}
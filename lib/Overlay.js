// The optional map overlays: wind vectors, sea-level pressure contours and
// the aurora, plus the satellite imagery layer. Everything here is a pure
// function over plain values, so the networking and the canvas stay thin and
// the parts that are easy to get subtly wrong — a grid that does not cover the
// view, an isobar that stops mid-cell, the OVATION grid parsed wrong — are
// pinned by test/overlay.test.js.
//
// Three free, keyless feeds, each bounded the same way the rest of the plugin
// bounds what it collects whole into the shell:
//
//   - Wind and pressure come from Open-Meteo, the same provider the forecasts
//     already use. A view-sized grid of points is asked for in one request,
//     each point answering with current wind speed and direction and mean sea
//     level pressure.
//   - The aurora comes from NOAA SWPC's OVATION model, the 1-degree global
//     grid of aurora probabilities published every few minutes.
//   - Satellite imagery comes from NASA GIBS (MODIS Terra true colour), a Web
//     Mercator XYZ tile source like RainViewer's, so it drops straight into a
//     TileLayer.

.pragma library

.import "RadarModel.js" as RadarModel
.import "TileMath.js" as TileMath

// ---------------------------------------------------------------------------
// Wind and pressure grid
// ---------------------------------------------------------------------------

var GRID_URL = "https://api.open-meteo.com/v1/forecast"
var GRID_MAX_POINTS = 150
var GRID_MAX_BYTES = 262144
var GRID_TIMEOUT_SEC = 20

// The rectangle of the world the viewport covers, so the grid can be built to
// cover exactly what the map shows rather than a fixed box that stops lining
// up as the view moves.
function viewBounds(lat, lon, zoom, width, height) {
  if (!isFinite(lat) || !isFinite(lon) || !isFinite(zoom)) return null
  var tl = TileMath.unprojectFromViewport(0, 0, lat, lon, zoom, Math.max(1, width), Math.max(1, height))
  var br = TileMath.unprojectFromViewport(width, height, lat, lon, zoom, Math.max(1, width), Math.max(1, height))
  if (!tl || !br) return null
  return {
    latMin: br.latitude,
    latMax: tl.latitude,
    lonMin: tl.longitude,
    lonMax: br.longitude
  }
}

// A column/row shape that matches the viewport's aspect and stays under the
// request ceiling. A 150-point ceiling keeps the response to a few tens of
// kilobytes and the isobars from being sampled too coarsely to mean anything.
function gridShape(width, height) {
  var w = Math.max(1, width)
  var h = Math.max(1, height)
  var cols = Math.max(4, Math.min(20, Math.round(Math.sqrt(GRID_MAX_POINTS * w / h))))
  var rows = Math.max(3, Math.min(16, Math.round(cols * h / w)))
  while (cols * rows > GRID_MAX_POINTS) {
    if (cols >= rows) cols--
    else rows--
  }
  return { cols: Math.max(2, cols), rows: Math.max(2, rows) }
}

// A regular lat/lon grid over the bounds, row-major: row 0 is the north edge,
// column 0 the west edge, so index r*cols+c. The panel needs the same shape
// back to rebuild the grid, so this ordering is part of the contract.
function gridPoints(bounds, cols, rows) {
  if (!bounds || !isWhole(bounds.latMin) || cols < 2 || rows < 2) return []
  var pts = []
  var dLat = rows > 1 ? (bounds.latMax - bounds.latMin) / (rows - 1) : 0
  var dLon = cols > 1 ? (bounds.lonMax - bounds.lonMin) / (cols - 1) : 0
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      pts.push({
        latitude: TileMath.clampLatitude(bounds.latMax - dLat * r),
        longitude: TileMath.wrapLongitude(bounds.lonMin + dLon * c)
      })
    }
  }
  return pts
}

function isWhole(value) {
  return typeof value === "number" && isFinite(value)
}

// One request for the whole grid. `current` answers with the moment's wind and
// pressure; nothing else is asked for, so the response is the grid and nothing
// more.
function gridUrl(points) {
  if (!points || points.length === 0 || points.length > GRID_MAX_POINTS) return ""
  var lats = []
  var lons = []
  for (var i = 0; i < points.length; i++) {
    var p = points[i]
    if (!isWhole(p.latitude) || !isWhole(p.longitude)) return ""
    lats.push(p.latitude.toFixed(4))
    lons.push(p.longitude.toFixed(4))
  }
  return GRID_URL + "?latitude=" + lats.join(",") + "&longitude=" + lons.join(",")
    + "&current=wind_speed_10m,wind_direction_10m,pressure_msl"
}

function gridCommand(points) {
  var url = gridUrl(points)
  return url === "" ? [] : RadarModel.fetchCommand(url, GRID_TIMEOUT_SEC, GRID_MAX_BYTES)
}

// Open-Meteo answers one object per requested point, in the order asked. A
// point whose readings are missing is dropped rather than drawn as a zero
// vector or a contour hole the caller has to wonder about.
function parseGrid(raw) {
  var text = String(raw || "").trim()
  if (text === "") return null
  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!Array.isArray(data)) return null

  var out = []
  for (var i = 0; i < data.length; i++) {
    var row = data[i]
    var cur = row && row.current
    if (!cur) continue
    var lat = parseFloat(row.latitude)
    var lon = parseFloat(row.longitude)
    if (!isFinite(lat) || !isFinite(lon)) continue
    var speed = parseFloat(cur.wind_speed_10m)
    var direction = parseFloat(cur.wind_direction_10m)
    var pressure = parseFloat(cur.pressure_msl)
    // A point with nothing usable is dropped rather than drawn as a zero
    // vector or a hole the caller has to wonder about.
    var hasWind = isFinite(speed) && speed >= 0
    var hasPressure = isFinite(pressure) && pressure > 0
    if (!hasWind && !hasPressure) continue
    out.push({
      latitude: lat,
      longitude: lon,
      windSpeed: hasWind ? speed : -1,
      windDirection: isFinite(direction) ? direction : 0,
      pressure: hasPressure ? pressure : 0
    })
  }
  return out.length > 0 ? out : null
}

// ---------------------------------------------------------------------------
// Sea-level pressure contours ("synoptic")
// ---------------------------------------------------------------------------

// A regular grid rebuilt from the row-major points, so the marching squares
// below can index by row and column. A point with no pressure reads as a hole
// that no contour may cross.
function pressureGrid(points, cols, rows) {
  if (!points || points.length !== cols * rows || cols < 2 || rows < 2) return null
  var latAt = []
  var lonAt = []
  var value = []
  for (var r = 0; r < rows; r++) {
    var row = []
    for (var c = 0; c < cols; c++) {
      var p = points[r * cols + c]
      if (!p) return null
      if (c === 0) lonAt.push(p.longitude)
      row.push(isWhole(p.pressure) && p.pressure > 0 ? p.pressure : null)
    }
    latAt.push(points[r * cols].latitude)
    value.push(row)
  }
  return { cols: cols, rows: rows, latAt: latAt, lonAt: lonAt, value: value }
}

// Isobars for one level: the connected polylines where the field equals it.
//
// Marching squares over the grid. Each cell whose corners straddle the level
// yields one or two straight segments between interpolated edge crossings; the
// segments are then joined into chains by shared endpoints, so a contour that
// crosses a few cells draws as one line rather than as dashes. Saddle cells —
// two diagonal corners above the level — pair their four crossings one way
// rather than the other, which is the standard ambiguity and matters only for
// how a contour looks, not for where it lies.
function contourLevel(grid, level) {
  var hCross = []
  var vCross = []
  var rows = grid.rows
  var cols = grid.cols

  for (var r = 0; r < rows; r++) {
    var hrow = []
    for (var c = 0; c < cols - 1; c++) {
      hrow.push(crossPoint(grid.latAt[r], grid.lonAt[c], grid.value[r][c],
        grid.latAt[r], grid.lonAt[c + 1], grid.value[r][c + 1], level))
    }
    hCross.push(hrow)
  }
  for (var rr = 0; rr < rows - 1; rr++) {
    var vrow = []
    for (var cc = 0; cc < cols; cc++) {
      vrow.push(crossPoint(grid.latAt[rr], grid.lonAt[cc], grid.value[rr][cc],
        grid.latAt[rr + 1], grid.lonAt[cc], grid.value[rr + 1][cc], level))
    }
    vCross.push(vrow)
  }

  // A segment is two endpoint keys; an endpoint key names an edge crossing, so
  // two segments sharing an endpoint share a coordinate exactly.
  var segments = []
  for (var rr2 = 0; rr2 < rows - 1; rr2++) {
    for (var cc2 = 0; cc2 < cols - 1; cc2++) {
      if (grid.value[rr2][cc2] === null || grid.value[rr2][cc2 + 1] === null
          || grid.value[rr2 + 1][cc2] === null || grid.value[rr2 + 1][cc2 + 1] === null) continue

      // The edges of this cell that the level crosses. A field that varies
      // along one axis crosses the two edges parallel to the other, so the
      // opposite-edge pairs belong here as much as the adjacent ones.
      var crossings = []
      if (hCross[rr2][cc2]) crossings.push(hCross[rr2][cc2])        // top
      if (vCross[rr2][cc2 + 1]) crossings.push(vCross[rr2][cc2 + 1]) // right
      if (hCross[rr2 + 1][cc2]) crossings.push(hCross[rr2 + 1][cc2]) // bottom
      if (vCross[rr2][cc2]) crossings.push(vCross[rr2][cc2])        // left

      if (crossings.length === 2) {
        segments.push({ a: crossings[0], b: crossings[1] })
      } else if (crossings.length === 4) {
        // Saddle. Pair the crossings so the contour does not self-intersect.
        var aHigh = grid.value[rr2][cc2] > level
        var dHigh = grid.value[rr2 + 1][cc2 + 1] > level
        if (aHigh === dHigh) { segments.push({ a: crossings[0], b: crossings[1] }); segments.push({ a: crossings[2], b: crossings[3] }) }
        else { segments.push({ a: crossings[0], b: crossings[3] }); segments.push({ a: crossings[1], b: crossings[2] }) }
      }
    }
  }

  return joinSegments(segments)
}

// Where a level crosses an edge, interpolated linearly. null when the two ends
// do not straddle it, or when either end is missing.
function crossPoint(lat1, lon1, v1, lat2, lon2, v2, level) {
  if (v1 === null || v2 === null) return null
  if ((v1 < level && v2 < level) || (v1 > level && v2 > level)) return null
  if (v1 === v2) return null
  var t = (level - v1) / (v2 - v1)
  return { lat: lat1 + (lat2 - lat1) * t, lon: lon1 + (lon2 - lon1) * t }
}

// Join segments into polylines by shared endpoint. Each edge crossing belongs
// to at most two cells, so endpoints pair up naturally; the two ends of a line
// that reaches the grid edge have nothing to join to and become the polyline's
// ends.
function joinSegments(segments) {
  var adj = {}
  function key(p) { return p.lat.toFixed(4) + "," + p.lon.toFixed(4) }
  for (var i = 0; i < segments.length; i++) {
    for (var e = 0; e < 2; e++) {
      var k = key(segments[i][e === 0 ? "a" : "b"])
      if (!adj[k]) adj[k] = []
      adj[k].push(i)
    }
  }

  var used = {}
  var chains = []
  for (var s = 0; s < segments.length; s++) {
    if (used[s]) continue
    used[s] = true
    var chain = [segments[s].a, segments[s].b]
    // Grow from the head, then the tail.
    var head = segments[s].a
    var tail = segments[s].b
    var grew = true
    while (grew) {
      grew = false
      var n = neighbors(adj, key(head), used)
      if (n !== null && n !== s) {
        used[n] = true
        var next = segments[n].a === head ? segments[n].b : segments[n].a
        chain.unshift(next)
        head = next
        grew = true
      }
      var t = neighbors(adj, key(tail), used)
      if (t !== null && t !== s) {
        used[t] = true
        var prev = segments[t].a === tail ? segments[t].b : segments[t].a
        chain.push(prev)
        tail = prev
        grew = true
      }
    }
    chains.push(chain)
  }
  return chains
}

function neighbors(adj, k, used) {
  var list = adj[k]
  if (!list) return null
  for (var i = 0; i < list.length; i++) {
    if (!used[list[i]]) return list[i]
  }
  return null
}

// The isobars of a grid, at `step` hPa intervals across its range, each drawn
// as one or more polylines of [lat, lon] points.
function isobars(points, cols, rows, step) {
  var grid = pressureGrid(points, cols, rows)
  if (!grid || !isWhole(step) || step <= 0) return []
  var lo = Infinity
  var hi = -Infinity
  for (var r = 0; r < grid.rows; r++) {
    for (var c = 0; c < grid.cols; c++) {
      var v = grid.value[r][c]
      if (v === null) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  if (lo === Infinity || hi - lo < step) return []
  var out = []
  var level = Math.ceil(lo / step) * step
  for (; level <= hi + 0.001; level += step) {
    var chains = contourLevel(grid, level)
    for (var i = 0; i < chains.length; i++) {
      if (chains[i].length >= 2) out.push({ level: Math.round(level), path: chains[i] })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Satellite imagery
// ---------------------------------------------------------------------------

// NASA GIBS serves MODIS Terra true colour in Web Mercator as a standard XYZ
// pyramid at every zoom up to 9, which is exactly the tile scheme and range
// this map uses. `default/default` asks GIBS for the best available frame, so
// there is no date to compute. The layer is a once-or-twice-daily overpass
// composite, not a live feed — it is a picture of the clouds as they were,
// which is what a satellite layer means on a map.
function satelliteTileUrl(zoom, x, y) {
  if (!RadarModel.isTileCoord(zoom, x, y)) return ""
  return "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/default/GoogleMapsCompatible_Level9/"
    + zoom + "/" + y + "/" + x + ".jpeg"
}

// ---------------------------------------------------------------------------
// Aurora
// ---------------------------------------------------------------------------

var OVATION_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json"
var OVATION_MAX_BYTES = 1048576
var OVATION_TIMEOUT_SEC = 30
var KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json"
var KP_MAX_BYTES = 65536
var KP_TIMEOUT_SEC = 20
var SOLAR_WIND_URL = "https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json"
var SOLAR_MAG_URL = "https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json"
var SOLAR_FLUX_URL = "https://services.swpc.noaa.gov/products/summary/10cm-flux.json"
var FLARE_URL = "https://services.swpc.noaa.gov/json/goes/primary/xray-flares-latest.json"
var SOLAR_MAX_BYTES = 16384
var SOLAR_TIMEOUT_SEC = 15

var MAX_AURORA_CELLS = 3000

function ovationCommand() {
  return RadarModel.fetchCommand(OVATION_URL, OVATION_TIMEOUT_SEC, OVATION_MAX_BYTES)
}

function kpCommand() {
  return RadarModel.fetchCommand(KP_URL, KP_TIMEOUT_SEC, KP_MAX_BYTES)
}

function solarCommand() {
  return RadarModel.fetchCommand(SOLAR_WIND_URL, SOLAR_TIMEOUT_SEC, SOLAR_MAX_BYTES)
}

function magCommand() {
  return RadarModel.fetchCommand(SOLAR_MAG_URL, SOLAR_TIMEOUT_SEC, SOLAR_MAX_BYTES)
}

function fluxCommand() {
  return RadarModel.fetchCommand(SOLAR_FLUX_URL, SOLAR_TIMEOUT_SEC, SOLAR_MAX_BYTES)
}

function flareCommand() {
  return RadarModel.fetchCommand(FLARE_URL, SOLAR_TIMEOUT_SEC, SOLAR_MAX_BYTES)
}

// The OVATION grid is 65,160 [lon, lat, probability] rows; the southern half
// that matters here is a few tens of thousands of them. Parsed whole, then
// filtered to the hemisphere and downsampled so a map never holds more than a
// few thousand dots.
function parseOvation(raw, maxCells) {
  var text = String(raw || "").trim()
  if (text === "") return null
  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!data || !Array.isArray(data.coordinates)) return null

  var limit = isWhole(maxCells) && maxCells > 0 ? Math.floor(maxCells) : MAX_AURORA_CELLS
  var candidates = []
  for (var i = 0; i < data.coordinates.length; i++) {
    var row = data.coordinates[i]
    if (!row || row.length < 3) continue
    var lon = parseFloat(row[0])
    var lat = parseFloat(row[1])
    var p = parseFloat(row[2])
    if (!isFinite(lat) || lat > -30) continue   // southern hemisphere, poleward of 30°S
    if (!isFinite(lon)) continue
    if (!isFinite(p) || p < 2) continue
    candidates.push({ lat: lat, lon: lon, p: p })
  }
  if (candidates.length === 0) return null

  var out = []
  if (candidates.length <= limit) {
    out = candidates
  } else {
    var stride = Math.ceil(candidates.length / limit)
    for (var j = 0; j < candidates.length && out.length < limit; j += stride) {
      out.push(candidates[j])
    }
  }
  return {
    cells: out,
    observedTime: String(data["Observation Time"] || "")
  }
}

// Kp now (the latest observed three-hour block), the highest NOAA expects in
// the next three days, and the full row list for the chart: observed history
// running into the forecast, each a 3-hour block.
function parseKp(raw) {
  var text = String(raw || "").trim()
  if (text === "") return null
  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!Array.isArray(data) || data.length === 0) return null

  var nowKp = NaN
  var peakForecast = NaN
  var latestObservedAt = ""
  var rows = []
  for (var i = 0; i < data.length; i++) {
    var row = data[i]
    if (!row) continue
    var kp = parseFloat(row.kp)
    if (!isFinite(kp)) continue
    var t = new Date(String(row.time_tag || ""))
    if (isNaN(t.getTime())) continue
    var kind = row.observed === "predicted" ? "predicted" : "observed"
    rows.push({ t: t, kp: kp, kind: kind })
    if (row.observed === "observed") {
      if (!isFinite(nowKp)) nowKp = kp
      latestObservedAt = String(row.time_tag || "")
    } else if (row.observed === "predicted") {
      if (!isFinite(peakForecast) || kp > peakForecast) peakForecast = kp
    }
  }
  if (rows.length === 0) return null
  return { rows: rows, nowKp: nowKp, peakForecast: peakForecast, observedAt: latestObservedAt }
}

// Solar activity readings, one value each, so the aurora tab can say what the
// solar wind is doing rather than only what the oval predicts.
function parseSolarWind(raw) {
  return parseFirstValue(raw, "proton_speed")
}

function parseMagField(raw) {
  var text = String(raw || "").trim()
  if (text === "") return null
  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!Array.isArray(data) || !data[0]) return null
  var bt = parseFloat(data[0].bt)
  var bz = parseFloat(data[0].bz_gsm)
  if (!isFinite(bt) || !isFinite(bz)) return null
  return { bt: bt, bz: bz }
}

function parseSolarFlux(raw) {
  return parseFirstValue(raw, "flux")
}

function parseLatestFlare(raw) {
  var text = String(raw || "").trim()
  if (text === "") return null
  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!Array.isArray(data) || !data[0]) return null
  var cls = String(data[0].current_class || data[0].begin_class || data[0].max_class || "").trim()
  return cls === "" ? null : { flareClass: cls.slice(0, 12) }
}

// The first element of a single-object summary feed, read as a number.
function parseFirstValue(raw, key) {
  var text = String(raw || "").trim()
  if (text === "") return null
  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!Array.isArray(data) || !data[0]) return null
  var value = parseFloat(data[0][key])
  return isFinite(value) ? value : null
}

// ---------------------------------------------------------------------------
// Aurora reading
// ---------------------------------------------------------------------------

// Centred-dipole southern geomagnetic pole, the antipode of the IGRF-14
// dipole north pole (80.7, -72.7). The oval edge formula below is in these
// coordinates — the same pair the NOAA viewline tables are built on — so the
// two have to agree here.
var GEOMAG_POLE_LAT = -80.7
var GEOMAG_POLE_LON = 107.3

// Centred-dipole geomagnetic latitude for a geographic position, in degrees.
function geomagLat(lat, lon) {
  var p = lat * Math.PI / 180
  var l = (lon - GEOMAG_POLE_LON) * Math.PI / 180
  var pp = GEOMAG_POLE_LAT * Math.PI / 180
  var s = Math.sin(p) * Math.sin(pp) + Math.cos(p) * Math.cos(pp) * Math.cos(l)
  return Math.asin(Math.max(-1, Math.min(1, s))) * 180 / Math.PI
}

// Kp comes in thirds (4.33, 4.67); show the decimal only when there is one.
function formatKp(kp) {
  var k = Number(kp)
  if (!isFinite(k)) return "--"
  return (Math.abs(k - Math.round(k)) < 0.05) ? String(Math.round(k)) : k.toFixed(1)
}
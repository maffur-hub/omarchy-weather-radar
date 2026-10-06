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
//   - Satellite imagery comes from NASA GIBS: geostationary imagers (GOES and
//     Himawari) supply the live layer, and polar true colour (MODIS Terra/Aqua
//     and VIIRS) is the fallback. Web Mercator XYZ tile sources like
//     RainViewer's, so they drop straight into a TileLayer.

.pragma library

.import "ImageCache.js" as ImageCache
.import "RadarModel.js" as RadarModel
.import "TileMath.js" as TileMath
.import "Solar.js" as Solar

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
//
// The grid is generated row-major (row 0 is the north edge, column 0 the west
// edge), so a row shares its latitude and a column shares its longitude: the
// latitude table is one entry per row, the longitude table one per column.
function pressureGrid(points, cols, rows) {
  if (!points || points.length !== cols * rows || cols < 2 || rows < 2) return null
  var latAt = []
  var lonAt = []
  var value = []
  for (var c = 0; c < cols; c++) {
    var p0 = points[c]
    if (!p0) return null
    lonAt.push(p0.longitude)
  }
  for (var r = 0; r < rows; r++) {
    var row = []
    for (var c2 = 0; c2 < cols; c2++) {
      var p = points[r * cols + c2]
      if (!p) return null
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

// The synoptic layer's contours, at a step chosen for the view rather than a
// fixed number. A fixed 4 hPa looks right over a continent but leaves a local
// viewport empty on a calm day, where the whole map sits inside one or two
// hPa. The step is a power of two that puts about six contours across the
// range actually present, so the layer always has something to draw.
function synopticIsobars(points, cols, rows) {
  var grid = pressureGrid(points, cols, rows)
  if (!grid) return []
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
  if (lo === Infinity || hi - lo < 0.5) return []
  var step = Math.pow(2, Math.round(Math.log2((hi - lo) / 6)))
  step = Math.max(0.5, Math.min(8, step))
  return isobars(points, cols, rows, step)
}

// The pressure centres the map labels H and L: cells strictly greater (or
// strictly less) than all eight neighbours. Strict is the point — a cell on
// the flat plain next to a real low is above that low but equal to the plain
// around it, and is not a centre, so only a genuine peak or trough labels.
function pressureExtrema(points, cols, rows) {
  var grid = pressureGrid(points, cols, rows)
  if (!grid) return []

  var out = []
  for (var r = 1; r < grid.rows - 1; r++) {
    for (var c = 1; c < grid.cols - 1; c++) {
      var v = grid.value[r][c]
      if (v === null) continue
      var isMax = true
      var isMin = true
      var broken = false
      for (var dr = -1; dr <= 1; dr++) {
        for (var dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue
          var n = grid.value[r + dr][c + dc]
          if (n === null) { broken = true; break }
          if (v <= n) isMax = false
          if (v >= n) isMin = false
        }
        if (broken) break
      }
      if (broken) continue
      if (isMax) out.push({ lat: grid.latAt[r], lon: grid.lonAt[c], kind: "H" })
      else if (isMin) out.push({ lat: grid.latAt[r], lon: grid.lonAt[c], kind: "L" })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Satellite imagery
// ---------------------------------------------------------------------------

// NASA GIBS serves satellite imagery in Web Mercator as standard XYZ tiles,
// keyless and without an account. Two kinds are used here:
//
//   - Geostationary imagers (GOES-East, GOES-West, Himawari-9) photograph the
//     same hemisphere every ten minutes. They are the live, gap-free layer:
//     one full-disk picture with no swaths missing, refreshed as the frames
//     turn over. GOES carries GeoColor, true colour by day and multispectral
//     infrared by night. GIBS has no true-colour Himawari, so Himawari is
//     shown as its visible band by day and its clean infrared band by night.
//   - Polar orbiters (MODIS Terra/Aqua, VIIRS Suomi-NPP/NOAA-20) see the whole
//     Earth, but only in swaths, and a single sensor's daily composite has
//     gaps painted opaque black. They carry the true colour and the sharpest
//     resolution — down to 250 m at their deepest zoom — so they are stacked
//     on top, each with its black made transparent, leaving one sensor's gaps
//     to be filled by another.
//
// The polar stack is drawn over the geostationary layer rather than instead of
// it, and the day before's composite is drawn under the current day's: a swath
// gap in one falls through to the next, and finally to the live full disk, so
// no wedge of missing data is left showing. See ui/SatelliteLayer.qml.

// Every tile source the overlay can ask for. The matrix set, format and
// deepest zoom are properties of the GIBS layer, not choices; past maxZoom the
// layer is upscaled (TileLayer.sourceZoom). `live` sources take a per-frame
// cache-buster so a still-open map picks up the next ten-minute frame; `mask`
// sources are polar composites whose black gaps the shader turns transparent.
var SATELLITE_SOURCES = {
  "GOES-East_ABI_GeoColor": { matrix: "GoogleMapsCompatible_Level7", format: "png", maxZoom: 7, mask: false, live: true },
  "GOES-West_ABI_GeoColor": { matrix: "GoogleMapsCompatible_Level7", format: "png", maxZoom: 7, mask: false, live: true },
  "Himawari_AHI_Band3_Red_Visible_1km": { matrix: "GoogleMapsCompatible_Level7", format: "png", maxZoom: 7, mask: false, live: true },
  "Himawari_AHI_Band13_Clean_Infrared": { matrix: "GoogleMapsCompatible_Level6", format: "png", maxZoom: 6, mask: false, live: true },
  "MODIS_Terra_CorrectedReflectance_TrueColor": { matrix: "GoogleMapsCompatible_Level9", format: "jpeg", maxZoom: 9, mask: true, live: false },
  "MODIS_Aqua_CorrectedReflectance_TrueColor": { matrix: "GoogleMapsCompatible_Level9", format: "jpeg", maxZoom: 9, mask: true, live: false },
  "VIIRS_SNPP_CorrectedReflectance_TrueColor": { matrix: "GoogleMapsCompatible_Level9", format: "jpeg", maxZoom: 9, mask: true, live: false },
  "VIIRS_NOAA20_CorrectedReflectance_TrueColor": { matrix: "GoogleMapsCompatible_Level9", format: "jpeg", maxZoom: 9, mask: true, live: false }
}

// The polar fallback, bottom-to-top: the last is drawn on top. Every one is a
// daily composite, so none is more current than another.
var SATELLITE_SENSORS = [
  "MODIS_Aqua_CorrectedReflectance_TrueColor",
  "VIIRS_SNPP_CorrectedReflectance_TrueColor",
  "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
  "MODIS_Terra_CorrectedReflectance_TrueColor"
]

// A geostationary disk reaches about 81 degrees from its subpoint; past that
// the view is too oblique to be useful. The usable limit is set a little
// tighter.
var SATELLITE_DISK_DEG = 78

// The three imagers the map can lock onto, with the band each uses by day and
// night. GOES GeoColor already folds the night infrared in, so both are the
// same layer there.
var GEOSTATIONARY_SENSORS = [
  { subpoint: -75.2, day: "GOES-East_ABI_GeoColor", night: "GOES-East_ABI_GeoColor" },
  { subpoint: -137.2, day: "GOES-West_ABI_GeoColor", night: "GOES-West_ABI_GeoColor" },
  { subpoint: 140.7, day: "Himawari_AHI_Band3_Red_Visible_1km", night: "Himawari_AHI_Band13_Clean_Infrared" }
]

// The solar position and the day/night answer now live in Solar.js, which the
// weather glyphs use too — two copies would be two clocks to drift apart.

// The nearest geostationary imager whose disk holds the view, or null when
// none does and the polar fallback is all that is left.
function geostationaryFor(latitude, longitude) {
  var best = null
  var bestDistance = SATELLITE_DISK_DEG
  for (var i = 0; i < GEOSTATIONARY_SENSORS.length; i++) {
    var sensor = GEOSTATIONARY_SENSORS[i]
    var distance = Solar.angularDistanceDeg(latitude, longitude, 0, sensor.subpoint)
    if (distance < bestDistance) {
      best = sensor
      bestDistance = distance
    }
  }
  return best
}

// The layers the map should draw for a view and a moment: the live
// geostationary picture when a disk reaches the view, the whole polar stack on
// top of it. Each entry is what ui/SatelliteLayer.qml needs to draw one layer,
// and `time` is the GIBS slot it draws for.
//
// The polar stack carries the sharp true colour, so it goes on top; its black
// swath gaps are made transparent and fall through first to the day before's
// composite and then to the live full disk beneath. `fillDate` is that
// previous day as "YYYY-MM-DD" in UTC, or "" for no fill layer.
function satelliteLayers(latitude, longitude, daytime, fillDate) {
  var layers = []
  var sensor = geostationaryFor(latitude, longitude)
  if (sensor) {
    var layer = daytime ? sensor.day : sensor.night
    var source = SATELLITE_SOURCES[layer]
    layers.push({ sensor: layer, time: "default", maxZoom: source.maxZoom, mask: source.mask })
  }
  if (typeof fillDate === "string" && fillDate !== "") {
    for (var f = 0; f < SATELLITE_SENSORS.length; f++) {
      var before = SATELLITE_SOURCES[SATELLITE_SENSORS[f]]
      layers.push({ sensor: SATELLITE_SENSORS[f], time: fillDate, maxZoom: before.maxZoom, mask: before.mask })
    }
  }
  for (var i = 0; i < SATELLITE_SENSORS.length; i++) {
    var fallback = SATELLITE_SOURCES[SATELLITE_SENSORS[i]]
    layers.push({ sensor: SATELLITE_SENSORS[i], time: "default", maxZoom: fallback.maxZoom, mask: fallback.mask })
  }
  return layers
}

// One tile of one sensor for one time slot. `time` is "default" for the
// current composite or a UTC date "YYYY-MM-DD" for a fixed day. `frame` is a
// cache-buster for the live geostationary layers only: their URL is otherwise
// identical, so Qt would serve a cached tile, and the panel hands a value that
// changes with the ten-minute bucket instead. A dated polar tile needs no
// buster, and an unknown sensor is no tile, the same way an out-of-range
// coordinate is.
function satelliteTileUrlFor(sensor, time, zoom, x, y, frame) {
  if (!RadarModel.isTileCoord(zoom, x, y)) return ""
  var source = SATELLITE_SOURCES[sensor]
  if (!source) return ""
  var slot = (typeof time === "string" && time !== "") ? time : "default"
  var url = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" + sensor
    + "/default/" + slot + "/" + source.matrix + "/" + zoom + "/" + y + "/" + x + "." + source.format
  if (source.live && slot === "default") url += "?frame=" + (frame === undefined ? "0" : frame)
  return url
}

// The polar primary alone, for a caller with room for one layer.
function satelliteTileUrl(zoom, x, y) {
  return satelliteTileUrlFor(SATELLITE_SENSORS[SATELLITE_SENSORS.length - 1], "default", zoom, x, y)
}

// A satellite tile as a fetch job, for the out-of-process cache: the GIBS URL
// and the cache key it is stored under. null for any sensor, slot or coordinate
// that is not one to ask for, and for a URL ImageCache will not let near a
// process — the caller then has no job and loads nothing rather than a remote
// URL.
//
// The frame cache-buster is folded into the key only where the URL carries it,
// the live geostationary layers: a dated polar tile ignores the buster, so
// putting it in the key would fetch the same immutable tile again every ten
// minutes.
function satelliteTileJob(sensor, time, zoom, x, y, frame) {
  if (!RadarModel.isTileCoord(zoom, x, y)) return null
  var source = SATELLITE_SOURCES[sensor]
  if (!source) return null
  var slot = (typeof time === "string" && time !== "") ? time : "default"
  var live = source.live && slot === "default"
  if (live && !(typeof frame === "number" && isFinite(frame) && Math.floor(frame) === frame && frame >= 0)) {
    return null
  }
  var url = satelliteTileUrlFor(sensor, time, zoom, x, y, frame)
  if (url === "") return null
  var key = ImageCache.satelliteKey(sensor, slot, live ? frame : 0, zoom, x, y)
  if (key === "" || !ImageCache.isImageUrl(url)) return null
  return { key: key, url: url }
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
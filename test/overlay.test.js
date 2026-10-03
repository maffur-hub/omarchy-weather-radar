const { test } = require("node:test")
const assert = require("node:assert")
const { loadLibrary, TileMath, RadarModel, Solar } = require("./load.js")

const Overlay = loadLibrary("Overlay.js", { RadarModel, TileMath, Solar })

// ------------------------------------------------------------------- grid

test("the view bounds cover the viewport around a centre", () => {
  const b = Overlay.viewBounds(-35.26, 149.14, 7, 560, 320)
  assert.ok(b.latMin < -35.26 && b.latMax > -35.26, JSON.stringify(b))
  assert.ok(b.lonMin < 149.14 && b.lonMax > 149.14, JSON.stringify(b))
  // A wider viewport covers a wider span of longitude.
  const b2 = Overlay.viewBounds(-35.26, 149.14, 7, 1120, 320)
  assert.ok(b2.lonMax - b2.lonMin > b.lonMax - b.lonMin)
})

test("the grid shape respects the point ceiling and the aspect", () => {
  const wide = Overlay.gridShape(560, 320)
  assert.ok(wide.cols > wide.rows, `${wide.cols}x${wide.rows}`)
  assert.ok(wide.cols * wide.rows <= Overlay.GRID_MAX_POINTS)
  const tall = Overlay.gridShape(320, 560)
  assert.ok(tall.rows > tall.cols, `${tall.cols}x${tall.rows}`)
  assert.ok(tall.cols * tall.rows <= Overlay.GRID_MAX_POINTS)
})

test("gridPoints fills the shape row-major and stays in range", () => {
  const b = Overlay.viewBounds(-35.26, 149.14, 7, 560, 320)
  const shape = Overlay.gridShape(560, 320)
  const pts = Overlay.gridPoints(b, shape.cols, shape.rows)
  assert.strictEqual(pts.length, shape.cols * shape.rows)
  assert.strictEqual(pts[0].latitude, b.latMax)          // north edge first
  assert.ok(pts[pts.length - 1].latitude <= b.latMax)
  for (const p of pts) {
    assert.ok(p.latitude >= -85.1 && p.latitude <= 85.1)
    assert.ok(p.longitude >= -180 && p.longitude <= 180)
  }
})

test("the grid request is bounded and made by the library", () => {
  const b = Overlay.viewBounds(-35.26, 149.14, 7, 560, 320)
  const shape = Overlay.gridShape(560, 320)
  const pts = Overlay.gridPoints(b, shape.cols, shape.rows)
  const command = Overlay.gridCommand(pts)
  assert.strictEqual(command[0], "curl")
  assert.ok(command.includes("--max-filesize"), "no size limit")
  assert.ok(command.includes("--max-time"), "no time limit")
  const bytes = Number(command[command.indexOf("--max-filesize") + 1])
  assert.ok(bytes > 0 && bytes <= 1024 * 1024)
  // Too many points is not a request at all.
  const huge = []
  for (let i = 0; i < Overlay.GRID_MAX_POINTS + 1; i++) huge.push({ latitude: 0, longitude: 0 })
  assert.deepStrictEqual(Overlay.gridCommand(huge), [])
})

test("a grid response parses into points with readings", () => {
  const raw = JSON.stringify([
    { latitude: -35.2, longitude: 149.1, current: { wind_speed_10m: 17.6, wind_direction_10m: 302, pressure_msl: 1016.8 } },
    { latitude: -35.4, longitude: 149.3, current: { wind_speed_10m: 5, wind_direction_10m: 10, pressure_msl: 1012 } }
  ])
  const pts = Overlay.parseGrid(raw)
  assert.strictEqual(pts.length, 2)
  assert.strictEqual(pts[0].windSpeed, 17.6)
  assert.strictEqual(pts[0].windDirection, 302)
  assert.strictEqual(pts[0].pressure, 1016.8)
  // A point with nothing usable is dropped, not drawn as a zero.
  const bad = JSON.stringify([
    { latitude: -35.2, longitude: 149.1, current: {} }
  ])
  assert.deepStrictEqual(Overlay.parseGrid(bad), null)
  // A point with wind but no pressure is kept for the wind layer alone.
  const windOnly = Overlay.parseGrid(JSON.stringify([
    { latitude: -35.2, longitude: 149.1, current: { wind_speed_10m: 10, wind_direction_10m: 90 } }
  ]))
  assert.strictEqual(windOnly.length, 1)
  assert.strictEqual(windOnly[0].pressure, 0)
  assert.strictEqual(Overlay.parseGrid(""), null)
  assert.strictEqual(Overlay.parseGrid("not json"), null)
})

// ------------------------------------------------------------------ isobars

// A grid with a pressure field rising from 1000 at the top to 1020 at the
// bottom. 1010 must be crossed by a contour roughly halfway down.
function risingGrid(cols, rows, from, to) {
  const pts = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = rows > 1 ? from + (to - from) * r / (rows - 1) : from
      pts.push({ latitude: 50 - r, longitude: -50 + c, pressure: v })
    }
  }
  return pts
}

test("isobars place a contour where the field crosses the level", () => {
  const pts = risingGrid(6, 6, 1000, 1020)
  const bars = Overlay.isobars(pts, 6, 6, 4)
  const levels = bars.map(b => b.level)
  assert.ok(levels.includes(1012), `levels: ${levels}`)
  // Every point of the 1012 contour must sit between the 1000 and 1020 rows.
  const c12 = bars.filter(b => b.level === 1012)
  assert.ok(c12.length > 0)
  for (const bar of c12) {
    for (const p of bar.path) {
      assert.ok(p.lat > 40 && p.lat < 50, `lat ${p.lat} out of the crossed band`)
      assert.ok(Number.isFinite(p.lon), `lon ${p.lon} not finite`)
      assert.ok(p.lon > -51 && p.lon < -44, `lon ${p.lon} out of the grid`)
    }
  }
})

test("a flat field has no isobars", () => {
  const pts = risingGrid(6, 6, 1012, 1012)
  assert.deepStrictEqual(Overlay.isobars(pts, 6, 6, 4), [])
})

test("the adaptive synoptic step draws on a calm day", () => {
  // Only 2 hPa across the whole grid: a fixed 4 hPa step would draw nothing.
  const pts = risingGrid(6, 6, 1013, 1015)
  assert.deepStrictEqual(Overlay.isobars(pts, 6, 6, 4), [])
  const bars = Overlay.synopticIsobars(pts, 6, 6)
  assert.ok(bars.length > 0, "adaptive step found no contours")
  assert.ok(bars.length <= 12, "adaptive step should not over-populate")
})

test("pressure extrema label the high and low centres", () => {
  const pts = []
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      let v = 1010
      if (r === 2 && c === 2) v += 5   // high
      if (r === 4 && c === 4) v -= 5   // low
      pts.push({ latitude: 50 - r, longitude: -50 + c, pressure: v })
    }
  }
  const ex = Overlay.pressureExtrema(pts, 6, 6)
  const highs = ex.filter(e => e.kind === "H")
  const lows = ex.filter(e => e.kind === "L")
  assert.strictEqual(highs.length, 1, JSON.stringify(ex))
  assert.strictEqual(lows.length, 1, JSON.stringify(ex))
  assert.strictEqual(highs[0].lat, 48)   // row 2
  assert.strictEqual(highs[0].lon, -48)  // col 2
  assert.strictEqual(lows[0].lat, 46)    // row 4
})

test("a monotonic field has no pressure centres to label", () => {
  const pts = risingGrid(6, 6, 1000, 1020)
  assert.deepStrictEqual(Overlay.pressureExtrema(pts, 6, 6), [])
})

test("an adjacent unequal pair of highs labels only the higher one", () => {
  const pts = []
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      let v = 1010
      if (r === 2 && c === 2) v += 5   // the true high
      if (r === 2 && c === 3) v += 4   // a shoulder, not a centre
      pts.push({ latitude: 50 - r, longitude: -50 + c, pressure: v })
    }
  }
  const ex = Overlay.pressureExtrema(pts, 6, 6)
  assert.strictEqual(ex.filter(e => e.kind === "H").length, 1, JSON.stringify(ex))
})

test("a missing reading keeps contours out of its cell", () => {
  const pts = risingGrid(6, 6, 1000, 1020)
  pts[3 * 6 + 3].pressure = null   // one hole in the middle
  const bars = Overlay.isobars(pts, 6, 6, 4)
  assert.ok(bars.length > 0)
})

// ---------------------------------------------------------------- satellite

test("a satellite tile is a GIBS Web Mercator request at the map's zoom", () => {
  const url = Overlay.satelliteTileUrl(7, 117, 77)
  assert.strictEqual(url,
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/default/GoogleMapsCompatible_Level9/7/77/117.jpeg")
  assert.strictEqual(Overlay.satelliteTileUrl(7, 128, 0), "")
})

test("every composite sensor is a GIBS Web Mercator request", () => {
  assert.ok(Overlay.SATELLITE_SENSORS.length >= 2, "the composite needs more than one sensor")
  for (const sensor of Overlay.SATELLITE_SENSORS) {
    assert.match(sensor, /^[A-Za-z0-9_]+_CorrectedReflectance_TrueColor$/, sensor)
    const url = Overlay.satelliteTileUrlFor(sensor, "default", 7, 117, 77)
    assert.strictEqual(url,
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" + sensor
      + "/default/default/GoogleMapsCompatible_Level9/7/77/117.jpeg")
    // A fixed day draws from that day's slot instead of default.
    const dated = Overlay.satelliteTileUrlFor(sensor, "2026-10-02", 7, 117, 77)
    assert.strictEqual(dated,
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" + sensor
      + "/default/2026-10-02/GoogleMapsCompatible_Level9/7/77/117.jpeg")
  }
  assert.strictEqual(Overlay.satelliteTileUrlFor("VIIRS_SNPP_CorrectedReflectance_TrueColor", "default", 7, 128, 0), "")
  assert.strictEqual(Overlay.satelliteTileUrlFor("not_a_sensor", "default", 7, 0, 0), "")
})

test("the satellite stacks the polar composite over the nearest geostationary disk", () => {
  // Australia: Himawari underneath, the polar composite above it. Daytime uses
  // the visible band, night the clean infrared.
  const auDay = Overlay.satelliteLayers(-25, 133, true, "2026-10-02")
  assert.strictEqual(auDay[0].sensor, "Himawari_AHI_Band3_Red_Visible_1km")
  assert.strictEqual(auDay[0].mask, false)
  assert.strictEqual(auDay[0].maxZoom, 7)
  // The day before fills first, then today's composite sits on top.
  const fill = auDay.slice(1, 1 + Overlay.SATELLITE_SENSORS.length)
  const today = auDay.slice(1 + Overlay.SATELLITE_SENSORS.length)
  assert.ok(fill.every(l => l.time === "2026-10-02" && l.mask === true), JSON.stringify(fill))
  assert.ok(today.every(l => l.time === "default" && l.mask === true), JSON.stringify(today))
  assert.deepStrictEqual(today.map(l => l.sensor), Overlay.SATELLITE_SENSORS)

  const auNight = Overlay.satelliteLayers(-25, 133, false)
  assert.strictEqual(auNight[0].sensor, "Himawari_AHI_Band13_Clean_Infrared")
  assert.strictEqual(auNight[0].maxZoom, 6)
  // Without a fill date only the current composite is stacked.
  assert.strictEqual(auNight.length, 1 + Overlay.SATELLITE_SENSORS.length)

  // The Americas.
  assert.strictEqual(Overlay.satelliteLayers(40, -74, true)[0].sensor, "GOES-East_ABI_GeoColor")
  assert.strictEqual(Overlay.satelliteLayers(34, -118, true)[0].sensor, "GOES-West_ABI_GeoColor")

  // Europe is out of reach of every disk: the polar stack alone, still in two
  // days so the gaps fill.
  const fallback = Overlay.satelliteLayers(51, 0, true, "2026-10-02")
  assert.strictEqual(fallback.length, 2 * Overlay.SATELLITE_SENSORS.length)
  assert.ok(fallback.every(l => l.mask === true), JSON.stringify(fallback))
  assert.ok(fallback.slice(0, Overlay.SATELLITE_SENSORS.length).every(l => l.time === "2026-10-02"))
  assert.ok(fallback.slice(Overlay.SATELLITE_SENSORS.length).every(l => l.time === "default"))
})

test("the subsolar point tracks the hour and the season", () => {
  const noon = Solar.subsolarPoint(Date.UTC(2026, 9, 3, 12))
  assert.ok(Math.abs(noon.longitude) < 5, "subsolar longitude " + noon.longitude)
  const june = Solar.subsolarPoint(Date.UTC(2026, 5, 21, 12))
  assert.ok(june.latitude > 22 && june.latitude < 24.5, "june declination " + june.latitude)
  const december = Solar.subsolarPoint(Date.UTC(2026, 11, 21, 12))
  assert.ok(december.latitude < -22 && december.latitude > -24.5, "december declination " + december.latitude)
  assert.strictEqual(Solar.isDaytime(-25, 133, Date.UTC(2026, 9, 3, 9)), true)
  assert.strictEqual(Solar.isDaytime(-25, 133, Date.UTC(2026, 9, 3, 19)), false)
})

test("live layers carry a frame cache-buster and polar layers do not", () => {
  const live = Overlay.satelliteTileUrlFor("Himawari_AHI_Band3_Red_Visible_1km", "default", 7, 117, 77, 12345)
  assert.strictEqual(live,
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band3_Red_Visible_1km/default/default/GoogleMapsCompatible_Level7/7/77/117.png?frame=12345")
  const infrared = Overlay.satelliteTileUrlFor("Himawari_AHI_Band13_Clean_Infrared", "default", 6, 55, 36, 9)
  assert.strictEqual(infrared,
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band13_Clean_Infrared/default/default/GoogleMapsCompatible_Level6/6/36/55.png?frame=9")
  const polar = Overlay.satelliteTileUrlFor("MODIS_Terra_CorrectedReflectance_TrueColor", "default", 7, 117, 77, 12345)
  assert.strictEqual(polar,
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/default/GoogleMapsCompatible_Level9/7/77/117.jpeg")
  // A dated polar tile ignores the cache-buster.
  const dated = Overlay.satelliteTileUrlFor("MODIS_Terra_CorrectedReflectance_TrueColor", "2026-10-02", 7, 117, 77, 12345)
  assert.ok(!dated.includes("frame="), dated)
  assert.strictEqual(Overlay.satelliteTileUrlFor("not_a_sensor", "default", 7, 0, 0, 1), "")
})

// ------------------------------------------------------------------ aurora

test("OVATION parses into bounded southern cells", () => {
  const coords = []
  // A full-ish grid including northern cells that must be filtered out.
  for (let lat = -90; lat <= 90; lat++) {
    for (let lon = 0; lon < 360; lon += 15) {
      coords.push([lon, lat, lat < -50 ? 40 : 1])
    }
  }
  const raw = JSON.stringify({
    "Observation Time": "2026-09-20T05:40:00Z",
    coordinates: coords
  })
  const data = Overlay.parseOvation(raw, 100)
  assert.ok(data.cells.length > 0 && data.cells.length <= 100)
  assert.ok(data.cells.every(c => c.lat <= -30), "northern cells leaked through")
  assert.strictEqual(data.observedTime, "2026-09-20T05:40:00Z")
  assert.strictEqual(Overlay.parseOvation("", 100), null)
})

test("Kp parsing takes the latest observed, the forecast peak, and the rows", () => {
  const raw = JSON.stringify([
    { time_tag: "2026-09-20T03:00:00", kp: 2, observed: "observed" },
    { time_tag: "2026-09-20T06:00:00", kp: 3, observed: "observed" },
    { time_tag: "2026-09-20T09:00:00", kp: 4.33, observed: "predicted" },
    { time_tag: "2026-09-20T12:00:00", kp: 5, observed: "predicted" }
  ])
  const data = Overlay.parseKp(raw)
  assert.strictEqual(data.nowKp, 2)
  assert.strictEqual(data.peakForecast, 5)
  assert.strictEqual(data.rows.length, 4)
  assert.strictEqual(data.rows[0].kind, "observed")
  assert.strictEqual(data.rows[3].kind, "predicted")
  assert.ok(data.rows[0].t instanceof Date)
  assert.strictEqual(Overlay.parseKp("[]"), null)
})

test("solar readings parse from the summary feeds", () => {
  assert.strictEqual(Overlay.parseSolarWind('[{"proton_speed": 403}]'), 403)
  assert.deepStrictEqual(Overlay.parseMagField('[{"bt": 5, "bz_gsm": -3}]'), { bt: 5, bz: -3 })
  assert.strictEqual(Overlay.parseSolarFlux('[{"flux": 97}]'), 97)
  assert.deepStrictEqual(Overlay.parseLatestFlare('[{"current_class": "B4.0"}]'), { flareClass: "B4.0" })
  assert.strictEqual(Overlay.parseSolarWind(""), null)
  assert.strictEqual(Overlay.parseSolarWind("[]"), null)
  assert.strictEqual(Overlay.parseLatestFlare("not json"), null)
})

test("geomagnetic latitude measures from the dipole reference pole", () => {
  // The function reports angular distance from the pole it is given, so the
  // pole itself reads +90 and the antipode -90.
  assert.ok(Math.abs(Overlay.geomagLat(Overlay.GEOMAG_POLE_LAT, Overlay.GEOMAG_POLE_LON) - 90) < 1)
  assert.ok(Math.abs(Overlay.geomagLat(-Overlay.GEOMAG_POLE_LAT, Overlay.GEOMAG_POLE_LON + 180) + 90) < 1)
  // Canberra sits around 43 degrees of geomagnetic latitude — the band the
  // oval reaches on a moderate Kp — so a sanity check pins the constant
  // against a place that is actually used.
  const canberra = Math.abs(Overlay.geomagLat(-35.26, 149.14))
  assert.ok(canberra > 40 && canberra < 48, `Canberra mlat ${canberra}`)
})

test("Kp formats whole numbers without a decimal", () => {
  assert.strictEqual(Overlay.formatKp(3), "3")
  assert.strictEqual(Overlay.formatKp(4.33), "4.3")
  assert.strictEqual(Overlay.formatKp(NaN), "--")
})
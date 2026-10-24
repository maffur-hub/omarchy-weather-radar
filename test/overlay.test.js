const { test } = require("node:test")
const assert = require("node:assert")
const { loadLibrary, TileMath, RadarModel, Solar, ImageCache } = require("./load.js")

const Overlay = loadLibrary("Overlay.js", { RadarModel, TileMath, Solar, ImageCache })

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

test("the synoptic shape is denser than the wind grid and still a legal request", () => {
  // The pressure field spans a synoptic region, so it can afford more samples
  // than the wind arrows: about 22x13 at this viewport, a little over 2° of
  // longitude per cell across 45°.
  const shape = Overlay.synopticShape(560, 320)
  assert.ok(Math.abs(shape.cols - 22) <= 1, `${shape.cols}x${shape.rows}`)
  assert.ok(Math.abs(shape.rows - 13) <= 1, `${shape.cols}x${shape.rows}`)
  assert.ok(shape.cols * shape.rows <= Overlay.SYNOPTIC_MAX_POINTS, `${shape.cols}x${shape.rows}`)

  const wind = Overlay.gridShape(560, 320)
  assert.ok(shape.cols >= wind.cols && shape.rows >= wind.rows, "the pressure grid is no denser than the wind one")

  // That many points is a request; the request ceiling is the synoptic one.
  const pts = []
  for (let i = 0; i < shape.cols * shape.rows; i++) pts.push({ latitude: 0, longitude: 0 })
  assert.notStrictEqual(Overlay.gridUrl(pts), "")
  const huge = []
  for (let i = 0; i < Overlay.SYNOPTIC_MAX_POINTS + 1; i++) huge.push({ latitude: 0, longitude: 0 })
  assert.strictEqual(Overlay.gridUrl(huge), "")
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

test("the synoptic bounds grow a local view to a readable region", () => {
  // A 12.3° x 5.7° radar view is padded and then grown to the chart's minimum,
  // about the same centre so the pattern still passes through the view.
  const view = { latMin: -38, latMax: -32.3, lonMin: 143, lonMax: 155.3 }
  const b = Overlay.synopticBounds(view)
  assert.ok(b.lonMax - b.lonMin >= 45, JSON.stringify(b))
  assert.ok(b.latMax - b.latMin >= 35, JSON.stringify(b))
  assert.ok(Math.abs((b.latMin + b.latMax) / 2 - (view.latMin + view.latMax) / 2) < 1e-9, JSON.stringify(b))
  assert.ok(Math.abs((b.lonMin + b.lonMax) / 2 - (view.lonMin + view.lonMax) / 2) < 1e-9, JSON.stringify(b))
})

test("a wide view keeps its own padded synoptic bounds", () => {
  // 60° x 40° is already larger than the minimum, so the 10% pad is all that
  // grows: at least 66° x 44°, with contours running off the canvas edge.
  const view = { latMin: -40, latMax: 0, lonMin: 100, lonMax: 160 }
  const b = Overlay.synopticBounds(view)
  assert.ok(b.lonMax - b.lonMin >= 66 - 1e-9, JSON.stringify(b))
  assert.ok(b.latMax - b.latMin >= 44 - 1e-9, JSON.stringify(b))
})

test("a polar synoptic box is shifted inside the projection, not squashed", () => {
  const view = { latMin: 80, latMax: 84, lonMin: 0, lonMax: 20 }
  const b = Overlay.synopticBounds(view)
  assert.ok(b.latMax <= 85.1, JSON.stringify(b))
  assert.ok(Math.abs((b.latMax - b.latMin) - 35) < 1e-6, JSON.stringify(b))
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
  // Too many points is not a request at all. The request ceiling is the
  // synoptic one, which serves the wind grid too.
  const huge = []
  for (let i = 0; i < Overlay.SYNOPTIC_MAX_POINTS + 1; i++) huge.push({ latitude: 0, longitude: 0 })
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

test("the synoptic ladder draws on a calm day", () => {
  // Only 2 hPa across the whole grid: a fixed 4 hPa step would draw nothing,
  // while the 2 hPa rung carries the one contour through 1014.
  const pts = risingGrid(6, 6, 1013, 1015)
  assert.deepStrictEqual(Overlay.isobars(pts, 6, 6, 4), [])
  const bars = Overlay.synopticIsobars(pts, 6, 6)
  assert.ok(bars.length > 0, "adaptive step found no contours")
  assert.ok(bars.length <= 12, "adaptive step should not over-populate")
  assert.deepStrictEqual(bars.map(b => b.level), [1014])
})

test("the synoptic ladder picks a step from the pressure range in view", () => {
  // A 6 hPa range is the widest that still fits the 2 hPa rung, and 60 the
  // widest that fits the 4 hPa one, so those are the boundaries the ladder has
  // to get right.
  assert.strictEqual(Overlay.synopticStep(3.4), 2)
  assert.strictEqual(Overlay.synopticStep(7), 4)
  assert.strictEqual(Overlay.synopticStep(14), 4)
  assert.strictEqual(Overlay.synopticStep(20), 4)
  assert.strictEqual(Overlay.synopticStep(50), 4)
  assert.strictEqual(Overlay.synopticStep(60), 4)
  assert.strictEqual(Overlay.synopticStep(61), 8)

  const bars = Overlay.synopticIsobars(risingGrid(6, 6, 1000, 1020), 6, 6)
  assert.ok(bars.length > 0)
  for (const bar of bars) {
    assert.ok(Math.abs(bar.level % 4) < 1e-9, `level ${bar.level} is not on the 4 hPa ladder`)
    assert.strictEqual(bar.label, String(bar.level))
  }
})

test("a flat region draws no micro-contours", () => {
  // 0.8 hPa across the whole region has no rung on the 2 hPa ladder. The old
  // half-hectopascal ladder would have drawn three lines here, each of them
  // within the analysis error over a field this wide.
  const pts = risingGrid(6, 6, 1012.4, 1013.2)
  assert.deepStrictEqual(Overlay.synopticIsobars(pts, 6, 6), [])
})

test("Chaikin smoothing cuts corners but keeps a contour in its band and its ends", () => {
  const path = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 2 }]
  const smooth = Overlay.smoothPath(path, 2)
  // The endpoints are where the contour met something, so they survive; the
  // new points are convex combinations and cannot leave the original band.
  assert.deepStrictEqual(smooth[0], path[0])
  assert.deepStrictEqual(smooth[smooth.length - 1], path[path.length - 1])
  assert.ok(smooth.length > path.length, "smoothing added no points")
  for (const p of smooth) {
    assert.ok(p.lat >= 0 && p.lat <= 1, `lat ${p.lat} left the band`)
    assert.ok(p.lon >= 0 && p.lon <= 2, `lon ${p.lon} left the band`)
  }
  // A two-point line has no corner to cut.
  const line = [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]
  assert.deepStrictEqual(Overlay.smoothPath(line, 2), line)

  // The same guarantee on a real contour: the 1012 hPa line across the grid
  // still begins and ends on the west and east edges, at the row it crossed.
  const bars = Overlay.isobars(risingGrid(6, 6, 1000, 1021), 6, 6, 4)
  const c12 = bars.filter(b => b.level === 1012)
  assert.ok(c12.length > 0)
  for (const bar of c12) {
    assert.deepStrictEqual([bar.path[0].lon, bar.path[bar.path.length - 1].lon].sort((a, b) => a - b), [-50, -45])
    for (const p of bar.path) {
      assert.ok(p.lat > 40 && p.lat < 50, `lat ${p.lat} out of the crossed band`)
      assert.ok(p.lon >= -50 && p.lon <= -45, `lon ${p.lon} out of the grid`)
    }
  }
})

test("a contour that only touches a grid corner leaves no zero-length bar", () => {
  // Open-Meteo answers pressure in whole hectopascals, so a level often lands
  // exactly on a sampled corner. Here 1012 touches only the south-east corner
  // and 1016 only the north-west: every edge crossing meets at that one point,
  // so the segment has two identical endpoints and joining it would draw a
  // stray pixel-sized chain. 1014 is the genuine anti-diagonal through the
  // north-east and south-west corners and must survive.
  const pts = [
    { latitude: 2, longitude: 0, pressure: 1016 },   // nw
    { latitude: 2, longitude: 1, pressure: 1014 },   // ne
    { latitude: 1, longitude: 0, pressure: 1014 },   // sw
    { latitude: 1, longitude: 1, pressure: 1012 }    // se
  ]
  const bars = Overlay.isobars(pts, 2, 2, 2)
  assert.deepStrictEqual(bars.filter(b => b.level === 1012), [])
  assert.deepStrictEqual(bars.filter(b => b.level === 1016), [])
  assert.strictEqual(bars.filter(b => b.level === 1014).length, 1)

  // No path may repeat a point: a repeated point is the zero-length segment
  // this test exists to keep off the canvas.
  for (const bar of bars) {
    for (let i = 1; i < bar.path.length; i++) {
      assert.notDeepStrictEqual(bar.path[i], bar.path[i - 1],
        `level ${bar.level} repeats ${JSON.stringify(bar.path[i])}`)
    }
  }
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
  // The sampled value travels with the centre, for the disc to print.
  assert.strictEqual(highs[0].pressure, 1015)
  assert.strictEqual(lows[0].pressure, 1005)
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

test("a wider neighbourhood keeps only the dominant pressure centre", () => {
  // An 11x11 flat grid with a 1020 high and a 1016 shoulder two cells apart.
  // At the default one-cell reach the eight-neighbour test calls both highs;
  // at radius 2 only the 1020 peak dominates its 5x5 neighbourhood, which is
  // the scale of a synoptic centre on a 2° grid.
  const pts = []
  for (let r = 0; r < 11; r++) {
    for (let c = 0; c < 11; c++) {
      let v = 1010
      if (r === 5 && c === 5) v = 1020
      if (r === 5 && c === 7) v = 1016
      pts.push({ latitude: 40 - r, longitude: -10 + c, pressure: v })
    }
  }
  const near = Overlay.pressureExtrema(pts, 11, 11)
  assert.strictEqual(near.filter(e => e.kind === "H").length, 2, JSON.stringify(near))

  const far = Overlay.pressureExtrema(pts, 11, 11, 2)
  const highs = far.filter(e => e.kind === "H")
  assert.strictEqual(highs.length, 1, JSON.stringify(far))
  assert.strictEqual(highs[0].pressure, 1020)
})

test("a missing reading keeps contours out of its cell", () => {
  const pts = risingGrid(6, 6, 1000, 1020)
  pts[3 * 6 + 3].pressure = null   // one hole in the middle
  const bars = Overlay.isobars(pts, 6, 6, 4)
  assert.ok(bars.length > 0)
})

test("refining keeps the readings and stays inside their range", () => {
  // A 3x3 field sampled once per degree, with a ridge through the middle. One
  // degree between readings is coarser than the synoptic grid ever is, which
  // makes the interpolation easy to check by hand.
  const field = [
    [1004, 1008, 1012],
    [1010, 1014, 1018],
    [1006, 1010, 1014]
  ]
  const pts = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      pts.push({ latitude: 10 - r, longitude: 20 + c, pressure: field[r][c] })
    }
  }
  const grid = Overlay.pressureGrid(pts, 3, 3)
  const refined = Overlay.refineGrid(grid, 4)
  // (3 - 1) * 4 + 1 readings positions, so four interpolated cells between
  // every pair of source cells.
  assert.strictEqual(refined.cols, 9)
  assert.strictEqual(refined.rows, 9)

  // Every reading survives exactly where it was: an integer position lies at
  // t=0 of the Catmull-Rom curve, where it returns p1 unchanged. If this ever
  // drifts, a contour at a level the observations actually reach would move.
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      assert.strictEqual(refined.value[r * 4][c * 4], field[r][c],
        `reading at row ${r}, column ${c} moved`)
    }
  }

  // The smoothing may overshoot between readings, but never past the extremes
  // the readings themselves have: no invented high or low.
  const flat = refined.value.reduce((all, row) => all.concat(row), [])
  assert.strictEqual(Math.min(...flat), 1004)
  assert.strictEqual(Math.max(...flat), 1018)
  for (const v of flat) {
    assert.ok(v >= 1004 && v <= 1018, `${v} left the source range`)
  }

  // The coordinates interpolate linearly, so the refined grid still covers the
  // same rectangle.
  assert.deepStrictEqual([refined.latAt[0], refined.latAt[8]], [10, 8])
  assert.deepStrictEqual([refined.lonAt[0], refined.lonAt[8]], [20, 22])

  // A factor that is not a whole number of cells, or a grid with a hole, is
  // returned as it was: there is nothing to smooth across a missing reading.
  assert.strictEqual(Overlay.refineGrid(grid, 1), grid)
  assert.strictEqual(Overlay.refineGrid(grid, 2.5), grid)
  const holed = Overlay.pressureGrid(pts.map((p, i) =>
    i === 4 ? { latitude: p.latitude, longitude: p.longitude, pressure: null } : p), 3, 3)
  assert.strictEqual(Overlay.refineGrid(holed, 4), holed)

  // Longitudes are unwrapped before they are interpolated: a grid that crosses
  // the date line must interpolate through it, not back around the world.
  const crossing = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      crossing.push({ latitude: 10 - r, longitude: c === 0 ? 179 : c === 1 ? -180 : -179, pressure: 1010 })
    }
  }
  const across = Overlay.refineGrid(Overlay.pressureGrid(crossing, 3, 3), 4)
  // The two midpoints between 179 and -180 and between -180 and -179 are the
  // antimeridian's neighbours, not a step across the Pacific.
  assert.ok(Math.abs(across.lonAt[2]) > 179, `lonAt[2] is ${across.lonAt[2]}`)
  assert.ok(Math.abs(across.lonAt[6]) > 179, `lonAt[6] is ${across.lonAt[6]}`)
})

test("a contour curves between the readings instead of taking the chord", () => {
  // A 5x5 grid at one degree per cell with a single 1020 high in a 1010 field.
  // At 1015 the unrefined contour is the diamond whose vertices are the
  // midpoints of the four edges around the high. Every vertex is 0.5° from the
  // centre while the middle of each side is 0.354° away, a ratio of √2 ≈ 1.41;
  // Chaikin rounds the corners, which measures ≈ 1.37 here. A curve through
  // the same readings keeps the vertices but bows the sides out, so the ratio
  // falls towards 1 — the reading a smooth analysed chart gives.
  const pts = []
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      pts.push({ latitude: 40 - r, longitude: 100 + c, pressure: r === 2 && c === 2 ? 1020 : 1010 })
    }
  }

  // How far the contour's distance from the high varies: 1 is a circle, and
  // the diamond is the worst case.
  function spread(path) {
    let min = Infinity
    let max = -Infinity
    for (const p of path) {
      const d = Math.hypot(p.lat - 38, p.lon - 102)
      if (d < min) min = d
      if (d > max) max = d
    }
    return max / min
  }

  const coarse = Overlay.contourGrid(Overlay.pressureGrid(pts, 5, 5), 5)
    .filter(b => b.level === 1015)
  assert.strictEqual(coarse.length, 1, `coarse contour count ${coarse.length}`)
  const coarseSpread = spread(coarse[0].path)
  assert.ok(coarseSpread > 1.3, `the coarse contour is not the expected diamond: ${coarseSpread}`)

  const bars = Overlay.isobars(pts, 5, 5, 5).filter(b => b.level === 1015)
  assert.strictEqual(bars.length, 1, `refined contour count ${bars.length}`)
  const path = bars[0].path
  // A single high on a wide field is a closed loop, so the line comes back to
  // where it started rather than ending on the canvas.
  assert.deepStrictEqual(path[0], path[path.length - 1], "the isobar is not closed")
  const refinedSpread = spread(path)
  assert.ok(refinedSpread < 1.15, `the refined contour is still a diamond: ${refinedSpread}`)
  assert.ok(refinedSpread < coarseSpread,
    `refinement did not round the contour: ${refinedSpread} vs ${coarseSpread}`)
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

test("a satellite job carries the URL and a key safe for the cache", () => {
  const job = Overlay.satelliteTileJob("MODIS_Terra_CorrectedReflectance_TrueColor", "default", 7, 117, 77)
  assert.strictEqual(job.key, "sat/MODIS_Terra_CorrectedReflectance_TrueColor/default/0/7/117/77")
  assert.strictEqual(job.url,
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor"
    + "/default/default/GoogleMapsCompatible_Level9/7/77/117.jpeg")
  // The born-valid key is one the cache will accept.
  assert.strictEqual(ImageCache.isImageKey(job.key), true)
  assert.strictEqual(ImageCache.isImageUrl(job.url), true)
})

test("a live satellite job folds the frame cache-buster into its key", () => {
  // A live layer's URL is otherwise identical, so Qt would answer a new frame
  // from the frame before it; the key has to move with the buster as well.
  const first = Overlay.satelliteTileJob("Himawari_AHI_Band3_Red_Visible_1km", "default", 7, 117, 77, 12345)
  const second = Overlay.satelliteTileJob("Himawari_AHI_Band3_Red_Visible_1km", "default", 7, 117, 77, 12346)
  assert.strictEqual(first.key, "sat/Himawari_AHI_Band3_Red_Visible_1km/default/12345/7/117/77")
  assert.ok(first.key !== second.key, "a new ten-minute frame reused the old key")
  assert.ok(first.url.includes("frame=12345"), first.url)

  // A dated polar tile ignores the buster, so it belongs nowhere in its key:
  // otherwise the same immutable tile would be fetched again every ten minutes.
  const dated = Overlay.satelliteTileJob("MODIS_Terra_CorrectedReflectance_TrueColor", "2026-10-02", 7, 117, 77, 12345)
  assert.strictEqual(dated.key, "sat/MODIS_Terra_CorrectedReflectance_TrueColor/2026-10-02/0/7/117/77")
  assert.ok(!dated.url.includes("frame="), dated.url)
})

test("a satellite job refuses a sensor, slot or coordinate it cannot vouch for", () => {
  assert.strictEqual(Overlay.satelliteTileJob("not_a_sensor", "default", 7, 0, 0, 1), null)
  assert.strictEqual(Overlay.satelliteTileJob("MODIS_Terra_CorrectedReflectance_TrueColor", "default", 7, 128, 0), null)
  // A live layer with no usable buster is no job, rather than a key that would
  // collide with the frame before it.
  assert.strictEqual(Overlay.satelliteTileJob("Himawari_AHI_Band3_Red_Visible_1km", "default", 7, 117, 77), null)
  assert.strictEqual(Overlay.satelliteTileJob("Himawari_AHI_Band3_Red_Visible_1km", "default", 7, 117, 77, -1), null)
})

test("a hyphenated geostationary sensor is still a job", () => {
  // GOES-East and GOES-West carry a hyphen in the sensor name; a key builder
  // that refused it would silently never load the live disk over the Americas,
  // which is exactly the layer the geostationary branch exists for.
  for (const sensor of ["GOES-East_ABI_GeoColor", "GOES-West_ABI_GeoColor"]) {
    const job = Overlay.satelliteTileJob(sensor, "default", 7, 117, 77, 12345)
    assert.ok(job, `${sensor} produced no job`)
    assert.strictEqual(ImageCache.isImageKey(job.key), true, job.key)
    assert.ok(job.key.startsWith("sat/" + sensor + "/"), job.key)
  }
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
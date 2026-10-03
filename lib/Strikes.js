// Live lightning strikes, as the panel keeps them.
//
// The "live" layer used to be a LightningMaps raster tile (`t=5`). That server
// layer is dead: it answers with one identical empty transparent tile for every
// location, zoom and T. True live strikes now arrive over LightningMaps' own
// WebSocket, streamed one stroke per line by tools/live-strikes.mjs and folded
// into a bounded buffer here. The archive tile layer still covers the
// zoomed-out view and is the fallback whenever the stream cannot run.
//
// Everything here is a pure function over plain values, so the parsing, the
// subscription box and the pruning are pinned by test/strikes.test.js without
// a socket, a WebSocket, or a running shell. The live palette lives here too,
// in one place, so the dots drawn by ui/StrikeLayer.qml and the panel's legend
// cannot drift apart.

.pragma library

// One hour of strikes, matching what the old live tile layer carried. The
// archive covers two hours; the live dots cover one, because that is the window
// they mean.
var WINDOW_MS = 60 * 60 * 1000

// The hard ceiling on the buffer. A busy storm can deliver thousands of strokes
// an hour, and this array is mutated in place inside the process that draws the
// bar: past the cap the oldest are dropped from the front rather than allowed
// to grow without bound.
var MAX_STRIKES = 6000

// The subscription box is home plus and minus this many degrees. Wide enough
// that panning near home keeps strikes on screen, narrow enough that one
// connection is not listening to a hemisphere.
var PAD_DEGREES = 20

// The longest helper line accepted. A strike line is under eighty bytes, so a
// cap an order of magnitude above that refuses a stream gone wrong without ever
// cutting a real message.
var MAX_LINE = 512

// The live dot palette: six ten-minute bands, newest amber through to dark red.
// These are the exact colours the panel's live legend shows, kept here so the
// key and the dots are one source.
var LIVE_BANDS = [
  { age: "0–10", minutes: 10, colour: "#fab40a" },
  { age: "10–20", minutes: 20, colour: "#f0960a" },
  { age: "20–30", minutes: 30, colour: "#e6780a" },
  { age: "30–40", minutes: 40, colour: "#dc6e0a" },
  { age: "40–50", minutes: 50, colour: "#d25a0a" },
  { age: "50–60", minutes: 60, colour: "#c8460a" }
]

// The box to subscribe to, as [latN, lonE, latS, lonW]. Latitude clamps to ±85
// — the Web Mercator edge, past which the feed has no map either — and
// longitude to ±180. A home that is not a coordinate is nobody's home: return
// the whole world so the feed still runs rather than sending NaN in the
// subscription and being ignored.
function boundsFor(lat, lon) {
  var latitude = parseFloat(lat)
  var longitude = parseFloat(lon)
  if (!isFinite(latitude) || !isFinite(longitude)) return [85, 180, -85, -180]

  return [
    Math.min(85, latitude + PAD_DEGREES),
    Math.min(180, longitude + PAD_DEGREES),
    Math.max(-85, latitude - PAD_DEGREES),
    Math.max(-180, longitude - PAD_DEGREES)
  ]
}

// The argv to run the helper with. Built here rather than at the call site so
// the bounds can never be assembled into the wrong order, and so the panel
// never names an external command itself.
function command(scriptPath, bounds) {
  if (typeof scriptPath !== "string" || scriptPath === "") return []
  if (!bounds || bounds.length !== 4) return []
  for (var i = 0; i < 4; i++) if (!isFinite(Number(bounds[i]))) return []

  return ["node", scriptPath,
    String(bounds[0]), String(bounds[1]), String(bounds[2]), String(bounds[3])]
}

// The first line the helper sends, once its socket is open: the subscription
// was accepted. Until this arrives no strike can have come, so the panel uses
// it to mark the stream live.
function isReady(line) {
  if (typeof line !== "string") return false
  var data
  try { data = JSON.parse(line) } catch (e) { return false }
  return !!data && data.ready === true
}

// One strike line → {id, t, lat, lon}, or null if it is not one. Rejects a line
// over the cap before parsing it, a non-object, a non-finite or out-of-range
// coordinate, and a missing id — which may be any JSON value, but has to be
// present to dedupe against.
function parseLine(line) {
  if (typeof line !== "string" || line.length > MAX_LINE) return null

  var data
  try { data = JSON.parse(line) } catch (e) { return null }
  if (!data || typeof data !== "object") return null

  var t = Number(data.t)
  var lat = Number(data.lat)
  var lon = Number(data.lon)
  if (!isFinite(t) || !isFinite(lat) || !isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  if (data.id === undefined) return null

  return { id: data.id, t: t, lat: lat, lon: lon }
}

// Add a strike unless its id is already held, which the feed repeats across
// reconnects and overlapping messages. Returns whether the buffer changed.
function add(buffer, strike) {
  if (!strike) return false
  for (var i = 0; i < buffer.length; i++) if (buffer[i].id === strike.id) return false
  buffer.push(strike)
  return true
}

// Drop strokes past the window, then whatever is over the cap, oldest first.
// Returns whether anything was removed, which is what repaints the dots.
function prune(buffer, nowMs) {
  var removed = false
  for (var i = buffer.length - 1; i >= 0; i--) {
    if (nowMs - buffer[i].t > WINDOW_MS) {
      buffer.splice(i, 1)
      removed = true
    }
  }
  while (buffer.length > MAX_STRIKES) {
    buffer.shift()
    removed = true
  }
  return removed
}

// The colour of the first band the age falls into, or null for an age outside
// the hour the live layer covers — which the caller skips rather than painting.
function colorForAge(ageMs) {
  if (!isFinite(ageMs) || ageMs < 0 || ageMs > 60 * 60000) return null
  for (var i = 0; i < LIVE_BANDS.length; i++) {
    if (LIVE_BANDS[i].minutes * 60000 >= ageMs) return LIVE_BANDS[i].colour
  }
  return null
}

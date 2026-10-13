// The persisted log of the Bureau gauge's own hourly rainfall, built by
// sampling its "since 9am" counter while the machine is awake.
//
// The counter is a running total from 9am local, reset at the next 9am, and
// the observations API is asked for it every ten minutes. Differencing two
// readings recovers what fell between them — so an hour the machine was awake
// for gets a measured value, and the model's hourly shape only has to cover
// the hours it slept through. Those measured hours lead buildRainHours: an
// hour already measured is exact, and only the remainder of its window's
// Bureau total is spread across the rest.
//
// Two things stop a difference from becoming a measurement. A gap longer than
// twenty minutes is a machine that slept — the observation cadence is ten, so
// a jump that wide cannot be attributed to one hour without inventing where
// the rain fell. And a counter that drops, or a 9am day key that changed, is
// the reset: the new reading restarts from zero and the old one says nothing
// about the hour between them. Both leave the hour to the model's shape.
//
// The state is plain JSON: a schema number, the key of the place it belongs
// to (so a log left by another location is thrown away rather than read), the
// last sample taken, and the hours measured so far. Everything here is a pure
// function over plain values and never throws on malformed input, so a
// hand-edited or half-written file reads as an empty log rather than as a
// crash.

.pragma library

var LOG_SCHEMA = 1

// Ten minutes is the observation cadence; a gap longer than twice that is a
// machine that was asleep, and the counter's jump cannot be pinned to an hour.
var MAX_SAMPLE_GAP_MS = 20 * 60 * 1000

// The DWO rows the charts walk back over reach nine days, so a little more
// than that is kept; every drawn day then has its measured hours behind it.
var KEEP_DAYS = 10

// Where the log is kept, or "" when there is nowhere to keep it — the same
// guard latchFilePath holds to. An unset home reads as null, and a path built
// from it would be relative to wherever the shell was started, creating a
// directory named "null" rather than a state file.
function logFilePath(home) {
  if (typeof home !== "string" || home.charAt(0) !== "/" || /[\x00-\x1f]/.test(home)) return ""
  return home.replace(/\/+$/, "") + "/.local/state/omarchy/weather-radar-rain.json"
}

// A shallow copy of an hours map holding only finite numbers, so a malformed
// entry cannot poison the accumulation it is later added to.
function copyHours(hours) {
  var out = {}
  if (!hours || typeof hours !== "object" || Array.isArray(hours)) return out
  for (var key in hours) {
    if (!Object.prototype.hasOwnProperty.call(hours, key)) continue
    var value = hours[key]
    if (typeof value === "number" && isFinite(value)) out[key] = value
  }
  return out
}

// The stored text as a log, or null for anything that is not one. A schema
// this build does not know, a missing key, or hours that are not a map each
// read as no log at all rather than as data to trust. `hours` is copied so no
// caller holds the parsed object's own map.
function parseLog(text) {
  var parsed = null
  try { parsed = JSON.parse(String(text || "")) } catch (e) { parsed = null }
  if (!parsed || typeof parsed !== "object") return null
  if (parsed.schema !== LOG_SCHEMA) return null
  if (typeof parsed.key !== "string") return null
  if (!(parsed.last === null || (parsed.last && typeof parsed.last === "object"))) return null
  if (!parsed.hours || typeof parsed.hours !== "object" || Array.isArray(parsed.hours)) return null
  return {
    schema: LOG_SCHEMA,
    key: parsed.key,
    last: parsed.last,
    hours: copyHours(parsed.hours)
  }
}

// A log with nothing in it, for a place that has none yet.
function emptyLog(key) {
  return { schema: LOG_SCHEMA, key: key, last: null, hours: {} }
}

// Whether a log belongs to this place. One for somewhere else is thrown away
// rather than read, because its hours describe a gauge this one is not.
function matches(state, key) {
  return !!state && typeof state === "object" && state.schema === LOG_SCHEMA && state.key === key
}

// The state after one sample. The first sample is a baseline, not a delta:
// nothing is known about where the counter stood before it, so no hour can be
// credited. Every later sample is differenced against the last when the pair
// is close enough in time to belong to one hour and both readings sit under
// the same 9am day; otherwise the hour is left to the model. The baseline
// moves to the sample either way, so the next difference is measured from the
// reading most recently seen.
function recordSample(state, sample) {
  var source = (state && typeof state === "object") ? state : {}
  var result = {
    schema: LOG_SCHEMA,
    key: typeof source.key === "string" ? source.key : "",
    last: (source.last && typeof source.last === "object") ? source.last : null,
    hours: copyHours(source.hours)
  }

  // An absent or non-finite sample is not a reading: the log is handed back
  // unchanged apart from the copy of its hours. Both readings must be real
  // numbers — Number(null) is 0, so a coerced field would read as a reading
  // the caller never took.
  if (!sample || typeof sample !== "object") return result
  if (typeof sample.atMs !== "number" || !isFinite(sample.atMs)) return result
  if (typeof sample.since9am !== "number" || !isFinite(sample.since9am)) return result
  if (typeof sample.dayKey !== "string" || sample.dayKey === "") return result
  if (typeof sample.hourKey !== "string" || sample.hourKey === "") return result
  var atMs = sample.atMs
  var since9am = sample.since9am

  var last = result.last
  if (!last || !isFinite(Number(last.atMs)) || !isFinite(Number(last.since9am))) {
    // No usable baseline to difference against, so this sample only records
    // where the counter stands.
    result.last = { atMs: atMs, since9am: since9am, dayKey: sample.dayKey }
    return result
  }

  var lastAt = Number(last.atMs)
  var lastSince = Number(last.since9am)

  // A clock that went backwards is not a gap to measure: the sample is not
  // adopted and the old baseline is kept, so a corrected clock cannot corrupt
  // the hours around it.
  if (atMs < lastAt) return result

  var gap = atMs - lastAt
  if (sample.dayKey === last.dayKey && gap >= 0 && gap <= MAX_SAMPLE_GAP_MS
      && since9am >= lastSince) {
    var delta = since9am - lastSince
    if (delta > 0) {
      // A running sum of tenths is not exact in binary — 0.2 + 0.1 lands on
      // 0.30000000000000004 — and the chart prints a tenth, so each
      // accumulation is pinned there, the same rounding every other
      // millimetre in the plugin passes through.
      var sum = (result.hours[sample.hourKey] || 0) + delta
      result.hours[sample.hourKey] = Math.round(sum * 10) / 10
    }
  }

  result.last = { atMs: atMs, since9am: since9am, dayKey: sample.dayKey }
  return result
}

// The measured hours alone, for buildRainHours. A bad state yields nothing,
// and the baseline is never handed out.
function measuredHours(state) {
  if (!state || typeof state !== "object") return {}
  var hours = state.hours
  if (!hours || typeof hours !== "object" || Array.isArray(hours)) return {}
  return hours
}

// The state with only its most recent `keepDays` dates kept. The dates are the
// first ten characters of every hour key, sorted as strings — an ISO day sorts
// as it reads — and the oldest are dropped, so the file cannot grow without
// bound across a long-running session. No date arithmetic, so no timezone can
// shift which day is which.
function prune(state, keepDays) {
  var source = (state && typeof state === "object") ? state : {}
  var keep = Math.floor(Number(keepDays))
  if (!isFinite(keep) || keep < 0) keep = 0

  var hours = copyHours(source.hours)
  var dates = []
  for (var key in hours) {
    if (!Object.prototype.hasOwnProperty.call(hours, key)) continue
    var date = key.substring(0, 10)
    if (dates.indexOf(date) === -1) dates.push(date)
  }
  dates.sort()

  var drop = {}
  for (var i = 0; i < dates.length - keep; i++) drop[dates[i]] = true

  var kept = {}
  for (var hour in hours) {
    if (!Object.prototype.hasOwnProperty.call(hours, hour)) continue
    if (!drop[hour.substring(0, 10)]) kept[hour] = hours[hour]
  }
  return {
    schema: LOG_SCHEMA,
    key: typeof source.key === "string" ? source.key : "",
    last: (source.last && typeof source.last === "object") ? source.last : null,
    hours: kept
  }
}

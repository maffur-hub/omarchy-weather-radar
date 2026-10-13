const { test } = require("node:test")
const assert = require("node:assert")
const { loadLibrary } = require("./load.js")

const RainLog = loadLibrary("RainLog.js")

const KEY = "33.88,151.21|Sydney"
const DAY = "2026-10-13"
const HOUR = DAY + "T05"

// ------------------------------------------------------------ where it is kept

test("the log lives in this plugin's own state directory", () => {
  assert.strictEqual(RainLog.logFilePath("/home/matt"),
    "/home/matt/.local/state/omarchy/weather-radar-rain.json")
})

test("a trailing slash does not double the separator", () => {
  assert.strictEqual(RainLog.logFilePath("/home/matt///"),
    "/home/matt/.local/state/omarchy/weather-radar-rain.json")
})

test("a home that is not an absolute path gets no file", () => {
  for (const bad of [null, undefined, "", "home/matt", 42, {}, "/home/\u0001matt"]) {
    assert.strictEqual(RainLog.logFilePath(bad), "", JSON.stringify(bad) || String(bad))
  }
})

// ------------------------------------------------------------ reading it back

test("a written log reads back as the same log", () => {
  const log = RainLog.recordSample(RainLog.emptyLog(KEY), {
    atMs: 1788735000000, since9am: 0.4, dayKey: DAY, hourKey: HOUR
  })
  assert.deepStrictEqual(RainLog.parseLog(JSON.stringify(log)), log)
})

test("anything that is not this log reads as no log at all", () => {
  for (const bad of ["", "not json", "null", JSON.stringify({ schema: 2, key: KEY, last: null, hours: {} }),
                     JSON.stringify({ schema: 1, key: KEY, last: null }),
                     JSON.stringify({ schema: 1, key: KEY, last: null, hours: [] }),
                     JSON.stringify({ schema: 1, key: 7, last: null, hours: {} })]) {
    assert.strictEqual(RainLog.parseLog(bad), null, bad)
  }
})

test("the parsed hours are a copy, not the parsed object's own map", () => {
  const parsed = RainLog.parseLog(JSON.stringify(RainLog.emptyLog(KEY)))
  parsed.hours[HOUR] = 9
  assert.deepStrictEqual(RainLog.emptyLog(KEY).hours, {})
})

// ------------------------------------------------------------ whose log it is

test("a log matches the place whose key it carries", () => {
  assert.strictEqual(RainLog.matches(RainLog.emptyLog(KEY), KEY), true)
})

test("a log for another place, or none at all, does not match", () => {
  assert.strictEqual(RainLog.matches(RainLog.emptyLog(KEY), "other"), false)
  assert.strictEqual(RainLog.matches(null, KEY), false)
})

// ------------------------------------------------------------ taking a sample

function sample(atMs, since9am, dayKey, hourKey) {
  return { atMs: atMs, since9am: since9am, dayKey: dayKey || DAY, hourKey: hourKey || HOUR }
}

test("the first sample is a baseline, not a delta", () => {
  const after = RainLog.recordSample(RainLog.emptyLog(KEY), sample(1000, 0.4))
  assert.deepStrictEqual(after.hours, {})
  assert.deepStrictEqual(after.last, { atMs: 1000, since9am: 0.4, dayKey: DAY })
})

test("a second sample credits its delta to the hour it names", () => {
  const first = RainLog.recordSample(RainLog.emptyLog(KEY), sample(1000, 0.4))
  const second = RainLog.recordSample(first, sample(1000 + 600000, 0.7))
  assert.deepStrictEqual(second.hours, { [HOUR]: 0.3 })
})

test("deltas within the same hour accumulate", () => {
  let log = RainLog.recordSample(RainLog.emptyLog(KEY), sample(0, 1.0))
  log = RainLog.recordSample(log, sample(600000, 1.2))
  log = RainLog.recordSample(log, sample(1200000, 1.3))
  assert.deepStrictEqual(log.hours, { [HOUR]: 0.3 })
})

test("a gap wider than the cadence allows is a machine that slept", () => {
  const first = RainLog.recordSample(RainLog.emptyLog(KEY), sample(0, 1.0))
  const slept = RainLog.recordSample(first, sample(RainLog.MAX_SAMPLE_GAP_MS + 1, 3.0))
  assert.deepStrictEqual(slept.hours, {})
})

test("crossing the 9am reset records nothing for the hour between", () => {
  const first = RainLog.recordSample(RainLog.emptyLog(KEY), sample(0, 5.0, DAY))
  const reset = RainLog.recordSample(first, sample(600000, 0.2, "2026-10-14"))
  assert.deepStrictEqual(reset.hours, {})
})

test("a counter that went backwards records nothing", () => {
  const first = RainLog.recordSample(RainLog.emptyLog(KEY), sample(0, 1.0))
  const down = RainLog.recordSample(first, sample(600000, 0.5))
  assert.deepStrictEqual(down.hours, {})
})

test("an unchanged counter adds no entry", () => {
  const first = RainLog.recordSample(RainLog.emptyLog(KEY), sample(0, 1.0))
  const same = RainLog.recordSample(first, sample(600000, 1.0))
  assert.deepStrictEqual(same.hours, {})
})

test("the state handed in is never mutated", () => {
  const state = RainLog.emptyLog(KEY)
  RainLog.recordSample(state, sample(1000, 0.4))
  RainLog.recordSample(state, sample(2000, 0.9))
  assert.deepStrictEqual(state, { schema: 1, key: KEY, last: null, hours: {} })
})

test("a clock that went backwards is not adopted as a baseline", () => {
  const first = RainLog.recordSample(RainLog.emptyLog(KEY), sample(5000, 1.0))
  const back = RainLog.recordSample(first, sample(1000, 1.5))
  assert.deepStrictEqual(back.last, { atMs: 5000, since9am: 1.0, dayKey: DAY })
  assert.deepStrictEqual(back.hours, {})
})

test("a malformed sample leaves the log as it stood", () => {
  const first = RainLog.recordSample(RainLog.emptyLog(KEY), sample(0, 1.0))
  for (const bad of [null, {}, sample(NaN, 1.0), sample(0, null), sample(0, 1.0, ""), sample(0, 1.0, DAY, "")]) {
    assert.deepStrictEqual(RainLog.recordSample(first, bad), first, JSON.stringify(bad) || String(bad))
  }
})

// ------------------------------------------------------------ pruning it down

test("only the newest dates are kept", () => {
  let log = RainLog.emptyLog(KEY)
  let at = 0
  for (const day of ["10", "11", "12", "13", "14"]) {
    log = RainLog.recordSample(log, sample(at, 0, "2026-10-" + day, "2026-10-" + day + "T05"))
    at += 600000
    log = RainLog.recordSample(log, sample(at, 0.5, "2026-10-" + day, "2026-10-" + day + "T05"))
    at += 600000
  }
  const kept = RainLog.prune(log, 2)
  assert.deepStrictEqual(Object.keys(kept.hours).sort(),
    ["2026-10-13T05", "2026-10-14T05"])
  assert.strictEqual(kept.key, KEY)
})

// ------------------------------------------------------------ what leads the model

test("a bad state yields no measured hours", () => {
  for (const bad of [null, undefined, {}, "x", { hours: [] }]) {
    assert.deepStrictEqual(RainLog.measuredHours(bad), {})
  }
})

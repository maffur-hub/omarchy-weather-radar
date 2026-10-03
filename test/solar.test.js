const { test } = require("node:test")
const assert = require("node:assert")
const { Solar } = require("./load.js")

// The clock at the configured coordinate decides; `is_day` is only the
// fallback when there is no coordinate to compute from. The instants are UTC
// so the terminator is the same wherever the suite runs.

test("a coordinate decides day or night from the clock, not the reading", () => {
  // Central Australia, 19:00 UTC: the small hours of the next day there, so
  // night even while the reading still says day.
  assert.strictEqual(Solar.nighttime(-25, 133, true, Date.UTC(2026, 9, 3, 19)), true)
  // 09:00 UTC: mid-afternoon there, so day even while the reading says night.
  assert.strictEqual(Solar.nighttime(-25, 133, false, Date.UTC(2026, 9, 3, 9)), false)
})

test("without a coordinate the reading's own flag is all there is", () => {
  assert.strictEqual(Solar.nighttime(NaN, NaN, true, Date.UTC(2026, 9, 3, 12)), false)
  assert.strictEqual(Solar.nighttime(NaN, NaN, false, Date.UTC(2026, 9, 3, 12)), true)
})

const { test } = require("node:test")
const assert = require("node:assert")
const { loadLibrary } = require("./load.js")

// The live lightning layer's pure half: the subscription box, the helper argv,
// the line parser and the bounding of the buffer. See lib/Strikes.js for what
// each of these stands in for.
const Strikes = loadLibrary("Strikes.js")

// ------------------------------------------------------------------ bounds

test("the subscription box is home padded, north-east-south-west", () => {
  assert.deepStrictEqual(Strikes.boundsFor(40, 20), [60, 40, 20, 0])
})

test("the subscription box clamps to the projection's edges", () => {
  // Latitude stops at the Web Mercator edge; longitude wraps at the date line.
  assert.deepStrictEqual(Strikes.boundsFor(80, 175), [85, 180, 60, 155])
  assert.deepStrictEqual(Strikes.boundsFor(-80, -175), [-60, -155, -85, -180])
})

test("a home that is not a coordinate falls back to the whole world", () => {
  assert.deepStrictEqual(Strikes.boundsFor(NaN, 20), [85, 180, -85, -180])
  assert.deepStrictEqual(Strikes.boundsFor(40, "x"), [85, 180, -85, -180])
  assert.deepStrictEqual(Strikes.boundsFor(null, null), [85, 180, -85, -180])
})

// ------------------------------------------------------------------ command

test("the helper command is node with the script and the four bounds in order", () => {
  assert.deepStrictEqual(Strikes.command("/p/live-strikes.mjs", [60, 40, 20, 0]),
    ["node", "/p/live-strikes.mjs", "60", "40", "20", "0"])
})

test("a command that cannot be built is empty rather than half-built", () => {
  assert.deepStrictEqual(Strikes.command("", [1, 2, 3, 4]), [])
  assert.deepStrictEqual(Strikes.command("/p/x.mjs", null), [])
  assert.deepStrictEqual(Strikes.command("/p/x.mjs", [1, 2, 3]), [])
  assert.deepStrictEqual(Strikes.command("/p/x.mjs", [1, 2, 3, "x"]), [])
})

// ------------------------------------------------------------------ parsing

test("only the helper's first line is the ready line", () => {
  assert.strictEqual(Strikes.isReady('{"ready":true,"p":[60,40,20,0]}'), true)
  assert.strictEqual(Strikes.isReady('{"ready":false}'), false)
  assert.strictEqual(Strikes.isReady('{"t":1,"lat":0,"lon":0,"id":1}'), false)
  assert.strictEqual(Strikes.isReady("not json"), false)
  assert.strictEqual(Strikes.isReady(42), false)
})

test("a strike line parses to its four fields", () => {
  assert.deepStrictEqual(
    Strikes.parseLine('{"t":1000,"lat":-23.5,"lon":-46.6,"id":7}'),
    { id: 7, t: 1000, lat: -23.5, lon: -46.6 })
  // The id may be any JSON value; extra fields on the line are ignored.
  assert.deepStrictEqual(
    Strikes.parseLine('{"t":1,"lat":0,"lon":0,"id":"a","src":4}'),
    { id: "a", t: 1, lat: 0, lon: 0 })
})

test("a line that is not a strike is refused", () => {
  assert.strictEqual(Strikes.parseLine("not json"), null)
  assert.strictEqual(Strikes.parseLine(42), null)
  assert.strictEqual(Strikes.parseLine('{"t":"x","lat":0,"lon":0,"id":1}'), null)
  assert.strictEqual(Strikes.parseLine('{"t":1,"lat":91,"lon":0,"id":1}'), null)
  assert.strictEqual(Strikes.parseLine('{"t":1,"lat":0,"lon":181,"id":1}'), null)
  // No id, nothing to dedupe against.
  assert.strictEqual(Strikes.parseLine('{"t":1,"lat":0,"lon":0}'), null)
  // Over the cap, refused before it is parsed.
  assert.strictEqual(Strikes.parseLine("x".repeat(Strikes.MAX_LINE + 1)), null)
})

// ------------------------------------------------------------------ buffer

test("a strike is added once and its id deduped", () => {
  const buffer = []
  assert.strictEqual(Strikes.add(buffer, { id: 1, t: 1, lat: 0, lon: 0 }), true)
  assert.strictEqual(Strikes.add(buffer, { id: 1, t: 2, lat: 1, lon: 1 }), false)
  assert.strictEqual(Strikes.add(buffer, { id: 2, t: 3, lat: 0, lon: 0 }), true)
  assert.strictEqual(buffer.length, 2)
  assert.strictEqual(Strikes.add(buffer, null), false)
})

test("prune drops strikes older than the window", () => {
  const now = 10 * 60 * 60 * 1000
  const buffer = [
    { id: 1, t: now - Strikes.WINDOW_MS - 1, lat: 0, lon: 0 },
    { id: 2, t: now - 1000, lat: 0, lon: 0 }
  ]
  assert.strictEqual(Strikes.prune(buffer, now), true)
  assert.deepStrictEqual(buffer.map(s => s.id), [2])
  // Nothing left to remove, so nothing changed.
  assert.strictEqual(Strikes.prune(buffer, now), false)
})

test("prune trims the buffer to the hard cap, oldest first", () => {
  const now = 10 * 60 * 60 * 1000
  const buffer = []
  for (let i = 0; i < Strikes.MAX_STRIKES + 10; i++) {
    buffer.push({ id: i, t: now, lat: 0, lon: 0 })
  }
  assert.strictEqual(Strikes.prune(buffer, now), true)
  assert.strictEqual(buffer.length, Strikes.MAX_STRIKES)
  assert.strictEqual(buffer[0].id, 10)
})

// ------------------------------------------------------------------ palette

test("the colour bands follow age and stop at an hour", () => {
  const bands = Strikes.LIVE_BANDS
  for (let i = 0; i < bands.length; i++) {
    const firstInBand = i === 0 ? 0 : bands[i - 1].minutes * 60000 + 1
    assert.strictEqual(Strikes.colorForAge(firstInBand), bands[i].colour, bands[i].age)
    assert.strictEqual(Strikes.colorForAge(bands[i].minutes * 60000), bands[i].colour, bands[i].age)
  }
  assert.strictEqual(Strikes.colorForAge(60 * 60000 + 1), null)
  assert.strictEqual(Strikes.colorForAge(-1), null)
})

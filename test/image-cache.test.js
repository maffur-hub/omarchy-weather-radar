const { test } = require("node:test")
const assert = require("node:assert")
const { ImageCache } = require("./load.js")

const DIR = "/home/someone/.cache/omarchy/plugins/eduardodallecort.weather-radar/images"
const SAT = "sat/MODIS_Terra_CorrectedReflectance_TrueColor/default/0/7/117/77"
const SAT_URL = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/default/GoogleMapsCompatible_Level9/7/77/117.jpeg"
const LGT = "lgt/7/117/77/1791003600_1791010800"
const LGT_URL = "https://tiles.lightningmaps.org/?x=117&y=77&z=7&s=256&from=2026-10-03T05:00:00.000Z&to=2026-10-03T07:00:00.000Z"
const COV = "cov/-23.0000/-46.0000"
const COV_URL = "https://tilecache.rainviewer.com/v2/coverage/0/256/7/-23.0/-46.0/0/0_0.png"

// ------------------------------------------------------------------ where the cache lives

test("the cache lives under XDG's cache directory, or under home without one", () => {
  assert.strictEqual(ImageCache.cacheDir("/home/someone", ""), DIR)
  assert.strictEqual(ImageCache.cacheDir("/home/someone", undefined), DIR)
  assert.strictEqual(ImageCache.cacheDir("/home/someone", "/var/cache/someone"),
    "/var/cache/someone/omarchy/plugins/eduardodallecort.weather-radar/images")
  assert.strictEqual(ImageCache.cacheDir("/home/someone/", ""), DIR)
})

test("a relative or missing home gives no cache rather than a relative one", () => {
  // The directory is what `rm -rf` is pointed at. Relative to whatever the
  // shell's working directory happens to be is not somewhere to point it.
  assert.strictEqual(ImageCache.cacheDir("", ""), "")
  assert.strictEqual(ImageCache.cacheDir(undefined, undefined), "")
  assert.strictEqual(ImageCache.cacheDir("home/someone", ""), "")
  assert.strictEqual(ImageCache.cacheDir("/home/someone", "relative/cache"), DIR)
})

test("only a directory ending in the plugin's own image cache is accepted", () => {
  assert.strictEqual(ImageCache.isCacheDir(DIR), true)
  for (const bad of ["/", "/home/someone", "/home/someone/.cache",
                     "/omarchy/plugins/eduardodallecort.weather-radar/images",
                     "/home/someone/../../omarchy/plugins/eduardodallecort.weather-radar/images",
                     "/home/some\none/.cache/omarchy/plugins/eduardodallecort.weather-radar/images",
                     DIR + "/", DIR + "/..", "relative" + DIR, null, 42]) {
    assert.strictEqual(ImageCache.isCacheDir(bad), false, String(bad))
  }
})

test("a cache path that would break a file:// URL gives no cache", () => {
  for (const home of ["/home/we#ird", "/home/pc%41", "/home/why?"]) {
    assert.strictEqual(ImageCache.cacheDir(home, ""), "", home)
  }
})

// ------------------------------------------------------------------ names

test("a namespaced key of safe segments is accepted", () => {
  assert.strictEqual(ImageCache.isImageKey(SAT), true)
  assert.strictEqual(ImageCache.isImageKey(LGT), true)
  assert.strictEqual(ImageCache.isImageKey(COV), true)
})

test("a key that could climb out of the cache or is not namespaced is refused", () => {
  for (const bad of ["", null, 42, "../etc/passwd", "sat/../x", "sat/a/./b",
                     "evil/x", "sat//x", "sat/a b/x", "sat/a/b#c",
                     SAT.split("/").map(() => "x".repeat(300)).join("/")]) {
    assert.strictEqual(ImageCache.isImageKey(bad), false, String(bad))
  }
})

test("a satellite key names its sensor, slot, frame and tile", () => {
  assert.strictEqual(ImageCache.satelliteKey("Himawari_AHI_Band3_Red_Visible_1km", "default", 12345, 7, 117, 77),
    "sat/Himawari_AHI_Band3_Red_Visible_1km/default/12345/7/117/77")
  assert.strictEqual(ImageCache.satelliteKey("MODIS_Terra_CorrectedReflectance_TrueColor", "2026-10-02", 0, 7, 117, 77),
    "sat/MODIS_Terra_CorrectedReflectance_TrueColor/2026-10-02/0/7/117/77")
  // A sensor name that is not a name, a slot that is not a date or "default",
  // an out-of-range frame and a coordinate off the grid each give no key.
  assert.strictEqual(ImageCache.satelliteKey("bad/name", "default", 0, 7, 1, 1), "")
  assert.strictEqual(ImageCache.satelliteKey("SENSOR", "not a slot", 0, 7, 1, 1), "")
  assert.strictEqual(ImageCache.satelliteKey("SENSOR", "default", -1, 7, 1, 1), "")
  assert.strictEqual(ImageCache.satelliteKey("SENSOR", "default", 0, 7, 128, 0), "")
})

test("a time-bucketed key ages from its bucket and others do not", () => {
  const now = 1791014400000
  // LGT's window ends an hour before now, so it is that old.
  assert.strictEqual(ImageCache.keyAgeMs(LGT, now), 3600000)
  // A window that just closed is fresh however old its start is.
  assert.strictEqual(ImageCache.keyAgeMs("lgt/7/1/1/1791007200_1791014400", now), 0)
  // The live satellite frame is a ten-minute bucket index.
  assert.strictEqual(ImageCache.keyAgeMs("sat/SENSOR/default/2985024/7/1/1", now), 0)
  // A dated polar tile and the coverage mask carry no bucket.
  assert.strictEqual(ImageCache.keyAgeMs(SAT, now), -1)
  assert.strictEqual(ImageCache.keyAgeMs(COV, now), -1)
  assert.strictEqual(ImageCache.keyAgeMs("not a key", now), -1)
})

test("the stale set is the stored keys past the age, and the count has a ceiling", () => {
  const now = 1791014400000
  const stored = {}
  stored[LGT] = true
  stored[SAT] = true
  stored["lgt/7/1/1/1791007200_1791014400"] = true  // just-closed window, still fresh
  assert.deepStrictEqual(ImageCache.staleKeys(stored, now), [LGT])
  assert.strictEqual(ImageCache.isOverLimit(ImageCache.MAX_IMAGES_ON_DISK), false)
  assert.strictEqual(ImageCache.isOverLimit(ImageCache.MAX_IMAGES_ON_DISK + 1), true)
  assert.strictEqual(ImageCache.isOverLimit(-1), false)
})

// ------------------------------------------------------------------ URLs

test("only https on the allow-listed hosts is an image URL", () => {
  assert.strictEqual(ImageCache.isImageUrl(SAT_URL), true)
  assert.strictEqual(ImageCache.isImageUrl(LGT_URL), true)
  assert.strictEqual(ImageCache.isImageUrl(COV_URL), true)
})

test("a URL on any other origin, or one a shell would misread, is refused", () => {
  const bad = [
    "http://gibs.earthdata.nasa.gov/x.png",
    "https://evil.com/x.png",
    "https://x.gibs.earthdata.nasa.gov.evil.com/x.png",
    "https://rainviewer.com.attacker.com/x.png",
    "https://gibs.earthdata.nasa.gov/a b.png",
    "https://gibs.earthdata.nasa.gov/a\tb.png",
    "https://gibs.earthdata.nasa.gov/a\\b.png",
    "https://gibs.earthdata.nasa.gov/a\"b.png",
    "https://gibs.earthdata.nasa.gov/a'b.png",
    "https://gibs.earthdata.nasa.gov/a#b.png",
    "https://gibs.earthdata.nasa.gov/../x.png",
    "https://gibs.earthdata.nasa.gov/",
    "gibs.earthdata.nasa.gov/x.png",
    "https://gibs.earthdata.nasa.gov/" + "x".repeat(1100),
    "",
    null,
  ]
  for (const url of bad) assert.strictEqual(ImageCache.isImageUrl(url), false, String(url))
})

// ------------------------------------------------------------------ the fetch command

test("the fetch command carries a ceiling on bytes and time, and writes only whole images", () => {
  const command = ImageCache.fetchCommand(DIR, [{ key: SAT, url: SAT_URL }])
  assert.strictEqual(command[0], "curl")
  assert.ok(command.includes("-fs"), "an HTTP error would be saved as an image")
  assert.ok(command.includes("--remove-on-error"), "a cut transfer would leave part of a file")
  assert.ok(command.includes("--globoff"), "curl would expand the URL into more of them")
  assert.strictEqual(command[command.indexOf("--proto") + 1], "=https")
  const bytes = Number(command[command.indexOf("--max-filesize") + 1])
  const seconds = Number(command[command.indexOf("--max-time") + 1])
  assert.ok(bytes > 0 && bytes <= 1024 * 1024, `caps at ${bytes} bytes`)
  assert.ok(seconds > 0 && seconds <= 30, `waits up to ${seconds}s`)
  // Each URL is followed by where it goes, and every destination is inside the
  // cache under a key this plugin built.
  const outputs = command.map((arg, i) => arg === "-o" ? command[i + 1] : null).filter(Boolean)
  assert.deepStrictEqual(outputs, [DIR + "/" + SAT])
})

test("the fetch command refuses a directory, a key or a URL it cannot vouch for", () => {
  assert.deepStrictEqual(ImageCache.fetchCommand("/tmp", [{ key: SAT, url: SAT_URL }]), [])
  assert.deepStrictEqual(ImageCache.fetchCommand(DIR, []), [])
  assert.deepStrictEqual(ImageCache.fetchCommand(DIR, [{ key: "../../x", url: SAT_URL }]), [])
  assert.deepStrictEqual(ImageCache.fetchCommand(DIR, [{ key: SAT, url: "file:///etc/passwd" }]), [])
  assert.deepStrictEqual(ImageCache.fetchCommand(DIR, [{ key: SAT, url: "https://evil.com/x.png" }]), [])
})

test("a batch never holds more transfers than a batch is allowed", () => {
  const jobs = []
  for (let i = 0; i < ImageCache.BATCH_SIZE * 3; i++) {
    jobs.push({ key: "sat/SENSOR/default/0/7/" + i + "/0", url: SAT_URL })
  }
  const command = ImageCache.fetchCommand(DIR, jobs)
  assert.strictEqual(command.filter(arg => arg === "-o").length, ImageCache.BATCH_SIZE)
})

// ------------------------------------------------------------------ what curl reports

test("curl's report is read back as the images that arrived and the ones that did not", () => {
  const jobs = [
    { key: "sat/SENSOR/default/0/7/0/0" },
    { key: "sat/SENSOR/default/0/7/1/0" },
    { key: "sat/SENSOR/default/0/7/2/0" },
    { key: "sat/SENSOR/default/0/7/3/0" },
  ]
  const report = [
    `0 200 ${DIR}/${jobs[0].key}`,
    `22 429 ${DIR}/${jobs[1].key}`,
    `63 200 ${DIR}/${jobs[2].key}`,
    "",
  ].join("\n")
  const result = ImageCache.parseFetchReport(report, DIR, jobs)
  assert.deepStrictEqual(result.arrived, [jobs[0].key])
  assert.deepStrictEqual(result.failed, [
    { key: jobs[1].key, status: 429 },
    { key: jobs[2].key, status: 200 },
    // Not in the report at all: the process died, and nothing it left is trusted.
    { key: jobs[3].key, status: 0 },
  ])
})

test("a report line naming a file outside the cache is ignored", () => {
  const result = ImageCache.parseFetchReport("0 200 /tmp/" + SAT + "\n", DIR, [{ key: SAT }])
  assert.deepStrictEqual(result.arrived, [])
})

test("a redirect's body is reported as written but not as an image", () => {
  const other = "sat/SENSOR/default/0/7/1/0"
  const report = `0 302 ${DIR}/${SAT}\n22 429 ${DIR}/${other}\n`
  const result = ImageCache.parseFetchReport(report, DIR, [{ key: SAT }, { key: other }])
  assert.deepStrictEqual(result.arrived, [])
  assert.deepStrictEqual(result.written, [SAT])
  assert.deepStrictEqual(result.failed.map(f => f.status), [302, 429])
})

test("a write curl could not make is reported, with or without a file name", () => {
  assert.strictEqual(ImageCache.parseFetchReport(`23 200 ${DIR}/${SAT}\n`, DIR, [{ key: SAT }]).cannotWrite, true)
  assert.strictEqual(ImageCache.parseFetchReport("23 000 \n", DIR, [{ key: SAT }]).cannotWrite, true)
  assert.strictEqual(ImageCache.parseFetchReport(`0 200 ${DIR}/${SAT}\n`, DIR, [{ key: SAT }]).cannotWrite, false)
})

// ------------------------------------------------------------------ what leaves the cache

test("cleaning deletes named keys inside the cache and nothing else", () => {
  assert.deepStrictEqual(ImageCache.cleanCommand(DIR, [SAT, LGT]),
    ["rm", "-rf", "--", DIR + "/" + SAT, DIR + "/" + LGT])
  assert.deepStrictEqual(ImageCache.cleanCommand(DIR, null), ["rm", "-rf", "--", DIR])
  assert.deepStrictEqual(ImageCache.cleanCommand(DIR, ["..", SAT + "/../../x", "evil/x", ""]), [])
  assert.deepStrictEqual(ImageCache.cleanCommand(DIR, []), [])
  assert.deepStrictEqual(ImageCache.cleanCommand("/home/someone", null), [])
  assert.deepStrictEqual(ImageCache.cleanCommand("/", [SAT]), [])
})

test("an image is loaded from its file once it is on disk, and from nothing before", () => {
  const url = "file://" + DIR + "/" + SAT
  assert.strictEqual(ImageCache.imageSourceFor(url, true), url)
  assert.strictEqual(ImageCache.imageSourceFor(url, false), "")
})

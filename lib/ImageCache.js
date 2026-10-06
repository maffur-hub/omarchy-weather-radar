// Remote overlay images kept on disk, fetched out of process.
//
// Qt's image loader fetches an https:// source inside the process that owns the
// bar, the panels and the lock screen, and inside OpenSSL while it loads the CA
// bundle it can segfault the compositor (Omarchy issue #8026). No remote URL may
// therefore ever reach an Image.source or a Canvas.loadImage. Radar tiles
// already avoid it through lib/TileCache.js; this is the same pipeline for the
// other three rasters the map draws — the NASA GIBS satellite layers, the
// LightningMaps archive tile and the RainViewer coverage mask.
//
// curl fetches each image straight into this cache, so the bytes never pass
// through the shell until Qt decodes a file:// path at the size it asked for.
// Every name on disk is built here from numbers and an allow-listed host, never
// from anything a server sent unchecked, and every command that writes or
// deletes is built here too, where the checks on those names live.
//
// The retry and backoff behaviour is not duplicated: this imports TileCache and
// reuses its isHeld, retryDelayMs and isWaiting, so an image that fails waits
// exactly as long as a tile that fails does.

.pragma library

.import "TileCache.js" as TileCache
.import "RadarModel.js" as RadarModel

// A satellite tile is a photograph of weather, not a radar palette: the true
// colour JPEGs and the geostationary PNGs run larger than a rain tile. Measured
// against the GIBS endpoints, a 256 px true-colour tile is tens of kilobytes;
// half a megabyte is a wide margin that still bounds what one tile can put on
// disk.
var IMAGE_MAX_BYTES = 524288

// How many images the cache holds before it starts over. The satellite overlay
// is a stack of up to nine layers of a handful of tiles each, so a few hundred
// keys cover a morning of looking around; at the byte ceiling above this bounds
// the directory at a few hundred megabytes whatever a server sends. Past it,
// the cache is emptied and refilled with what the map on screen wants.
var MAX_IMAGES_ON_DISK = 1024
var IMAGE_TIMEOUT_SEC = 20

// One process per batch, a few transfers at once inside it. A satellite layer
// of a panel-sized view is a handful of tiles, so a batch keeps one layer's
// worth of images in flight rather than one process per tile.
var BATCH_SIZE = 8
var PARALLEL_TRANSFERS = 4

// Keys that carry a time bucket — the lightning archive window and the live
// geostationary frame — are dropped once they are this old. The count cap above
// still bounds everything; this keeps a long session from holding frames whose
// moment has long passed.
var IMAGE_MAX_AGE_MS = 30 * 60 * 1000

// The directory the cache lives in must end here. Anything this module deletes
// is inside it, so the check below is what stands between a bad value and
// `rm -rf` on somewhere else.
var CACHE_SUFFIX = "/omarchy/plugins/eduardodallecort.weather-radar/images"

function isWhole(value, min, max) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value
    && value >= min && value <= max
}

// Exactly TileCache's guard: absolute, ending in this plugin's images directory,
// with none of the characters that would end or escape the file:// URL the
// images are loaded from.
function isCacheDir(dir) {
  if (typeof dir !== "string" || dir.charAt(0) !== "/") return false
  if (dir.length > 512 || dir.length <= CACHE_SUFFIX.length) return false
  if (dir.slice(-CACHE_SUFFIX.length) !== CACHE_SUFFIX) return false
  if (/[\x00-\x1f#%?]/.test(dir)) return false
  return dir.split("/").indexOf("..") === -1
}

// Where the cache lives: XDG's cache directory when it is set to something
// absolute, the conventional one under home otherwise.
function cacheDir(home, xdgCacheHome) {
  var base = typeof xdgCacheHome === "string" && xdgCacheHome.charAt(0) === "/"
    ? xdgCacheHome.replace(/\/+$/, "")
    : (typeof home === "string" && home.charAt(0) === "/" ? home.replace(/\/+$/, "") + "/.cache" : "")
  if (base === "") return ""
  var dir = base + CACHE_SUFFIX
  return isCacheDir(dir) ? dir : ""
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
//
// Every key is a slash-joined set of segments of letters, digits, dots,
// underscores and hyphens, under one of three namespaces:
//
//   sat/<sensor>/<slot>/<frame>/<zoom>/<x>/<y>
//   lgt/<zoom>/<x>/<y>/<fromSec>_<toSec>
//   cov/<lat>/<lon>
//
// The rules are checked on the way in and again by isImageKey on anything
// offered to a command, so a value that did not come from a builder here cannot
// become a path. No segment may be empty, "." or "..", and the whole key is
// length-capped, so nothing can climb out of the cache directory.

var KEY_PREFIXES = { sat: true, lgt: true, cov: true }
var KEY_SEGMENT = /^[A-Za-z0-9._-]+$/

function isImageKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 256) return false
  var parts = key.split("/")
  if (parts.length < 2 || KEY_PREFIXES[parts[0]] !== true) return false
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === "" || parts[i] === "." || parts[i] === "..") return false
    if (!KEY_SEGMENT.test(parts[i])) return false
  }
  return true
}

// The lightning archive key. The window is bucketed in seconds, so every tile of
// one refresh shares a key and the server's image for that window. RadarModel
// builds this one itself (it is where the lightning host lives, and it cannot
// import this module back without a cycle), so the shape here is the contract
// isImageKey enforces.
//
// The coverage mask key is the location with bounded decimals rather than a
// time: there is one logical mask per place.

// The satellite key. The frame cache-buster is included where the URL includes
// it — for the live geostationary layers only — so a new ten-minute frame is a
// new key rather than a cached Qt image of the frame before it.
function satelliteKey(sensor, slot, frame, zoom, x, y) {
  // The hyphen is load-bearing: GOES-East and GOES-West carry one in the sensor
  // name, and a builder that refused it would silently never load the live disk
  // over the Americas.
  if (typeof sensor !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sensor)) return ""
  if (typeof slot !== "string" || !/^(?:default|[0-9]{4}-[0-9]{2}-[0-9]{2})$/.test(slot)) return ""
  if (!isWhole(frame, 0, 99999999999)) return ""
  if (!RadarModel.isTileCoord(zoom, x, y)) return ""
  return "sat/" + sensor + "/" + slot + "/" + frame + "/" + zoom + "/" + x + "/" + y
}

// True when a key is past its time bucket. Keys with no bucket — a dated polar
// tile, the coverage mask — answer -1, so the count cap is what bounds them.
// The lightning window is aged from its end, not its start: its start is two
// hours in the past by construction, and ageing from that would make every
// freshly fetched tile look stale at once.
function keyAgeMs(key, nowMs) {
  if (!isImageKey(key)) return -1
  var parts = key.split("/")
  if (parts[0] === "lgt" && parts.length === 5) {
    var window = parts[4].split("_")
    var to = Number(window[1])
    return isFinite(to) && to > 0 ? Math.max(0, nowMs - to * 1000) : -1
  }
  if (parts[0] === "sat" && parts.length === 7) {
    var frame = Number(parts[3])
    // The live frame is a ten-minute bucket index; 0 is the "no buster" of a
    // dated polar tile, which has no moment of its own to age from.
    return isFinite(frame) && frame > 0 ? Math.max(0, nowMs - frame * 600000) : -1
  }
  return -1
}

// The keys that are both present and past IMAGE_MAX_AGE_MS.
function staleKeys(stored, nowMs) {
  var stale = []
  for (var key in stored) {
    var age = keyAgeMs(key, nowMs)
    if (age >= 0 && age > IMAGE_MAX_AGE_MS) stale.push(key)
  }
  return stale
}

function isOverLimit(count) {
  return isWhole(count, 0, 1e9) && count > MAX_IMAGES_ON_DISK
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// The two fixed hosts, and RainViewer's tile host space. The coverage URL's
// host arrives in the manifest; parseManifest already requires it to be an
// https origin, and the check here requires it again, plus a RainViewer name,
// so no other origin is ever fetched even if a manifest were spoofed.
var IMAGE_HOSTS = {
  "gibs.earthdata.nasa.gov": true,
  "tiles.lightningmaps.org": true
}

// A URL is an https origin on the allow-list, then a path: at most 1024
// characters, with no control character, whitespace, backslash, quote or `#`
// that could confound the shell or the file:// URL the image is loaded from.
// `#` is refused because curl would cut the request at it while Qt would not.
function isImageUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 1024) return false
  if (/[\x00-\x20\x7f"'\\#]/.test(url)) return false
  if (url.indexOf("..") !== -1) return false
  if (url.indexOf("https://") !== 0) return false
  var rest = url.slice("https://".length)
  var slash = rest.indexOf("/")
  // There must be an origin and a path after it.
  if (slash <= 0 || slash >= rest.length - 1) return false
  var authority = rest.slice(0, slash)
  var host = authority.replace(/:[0-9]{1,5}$/, "")
  if (IMAGE_HOSTS[host] === true) return true
  // The RainViewer coverage host, checked against the same origin rule the
  // manifest parser uses before it is trusted for its own tiles.
  return RadarModel.isRainViewerHost(host) && RadarModel.isTileHost("https://" + authority)
}

// One curl for a batch of images, each written to its place in the cache.
// `-f` turns an HTTP error into a failed transfer instead of an error page
// saved as an image, and `--remove-on-error` deletes whatever a failed or
// oversized transfer had written, so a file on disk is always a whole response.
// `--globoff` stops curl from reading brackets or braces in a URL as a list of
// URLs to fetch, which is how one job could become millions of transfers.
//
// The report curl prints is one line per job, in this format and with these
// paths, so its size is set here rather than by the server.
function fetchCommand(dir, jobs) {
  if (!isCacheDir(dir) || !jobs || jobs.length === 0) return []
  var command = ["curl", "-fs", "--globoff", "--proto", "=https",
                 "--max-time", String(IMAGE_TIMEOUT_SEC),
                 "--max-filesize", String(IMAGE_MAX_BYTES),
                 "--parallel", "--parallel-max", String(PARALLEL_TRANSFERS),
                 "--create-dirs", "--remove-on-error",
                 "-w", "%{exitcode} %{http_code} %{filename_effective}\\n"]
  var transfers = 0
  for (var i = 0; i < jobs.length && transfers < BATCH_SIZE; i++) {
    if (!isImageKey(jobs[i].key) || !isImageUrl(jobs[i].url)) continue
    command.push(jobs[i].url, "-o", dir + "/" + jobs[i].key)
    transfers++
  }
  return transfers > 0 ? command : []
}

// What curl reported, as the keys that arrived and the ones that did not. A job
// missing from the report counts as failed: the process was killed, or never
// ran, and nothing it may have left behind is trusted. `written` lists every
// key curl reported as transferred whatever the status, because a redirect
// leaves its body on disk.
function parseFetchReport(text, dir, jobs) {
  var arrived = {}
  var written = {}
  var status = {}
  var cannotWrite = false
  var lines = String(text || "").split("\n")
  var prefix = dir + "/"
  for (var i = 0; i < lines.length; i++) {
    // curl's exit 23 is a write it could not make: a full disk, or a directory
    // it may not create. It can come with no file name at all.
    if (/^23 /.test(lines[i])) cannotWrite = true
    var match = /^(\d+) (\d{3}) (.+)$/.exec(lines[i])
    if (!match || match[3].indexOf(prefix) !== 0) continue
    var key = match[3].slice(prefix.length)
    if (!isImageKey(key)) continue
    status[key] = Number(match[2])
    if (match[1] === "0") written[key] = true
    if (match[1] === "0" && match[2] === "200") arrived[key] = true
  }
  var result = { arrived: [], failed: [], written: [], cannotWrite: cannotWrite }
  for (var j = 0; j < (jobs || []).length; j++) {
    var k = jobs[j].key
    if (written[k]) result.written.push(k)
    if (arrived[k]) result.arrived.push(k)
    else result.failed.push({ key: k, status: status[k] || 0 })
  }
  return result
}

// Delete the whole cache when no keys are named, or the named keys. The paths
// are rebuilt from checked keys and a checked directory; there is no form of
// call that deletes outside the cache.
function cleanCommand(dir, keys) {
  if (!isCacheDir(dir)) return []
  if (!keys) return ["rm", "-rf", "--", dir]
  var command = ["rm", "-rf", "--"]
  var targets = 0
  for (var i = 0; i < keys.length; i++) {
    if (!isImageKey(keys[i])) continue
    command.push(dir + "/" + keys[i])
    targets++
  }
  return targets > 0 ? command : []
}

// ---------------------------------------------------------------------------
// What the layer loads
// ---------------------------------------------------------------------------

// Where an image is loaded from: its file once it is on disk, "" otherwise. ""
// draws nothing and asks Qt for nothing, which is the only safe answer while a
// remote URL is still being fetched out of process.
function imageSourceFor(fileUrl, onDisk) {
  return onDisk ? fileUrl : ""
}

// The earliest moment a wanted image's retry runs out, or 0 for none, so the
// service can wake then rather than on its next heartbeat.
function nextImageWake(retries, wanted, now) {
  var earliest = 0
  for (var key in retries) {
    var retry = retries[key]
    if (!wanted[key] || retry.gaveUp === true || !TileCache.isHeld(retry.at, now)) continue
    if (earliest === 0 || retry.at < earliest) earliest = retry.at
  }
  return earliest
}

// The Bureau of Meteorology side of the plugin: the severe-weather warning
// product and the NSW/ACT district forecast, both pinned to the products an
// Ainslie reader cares about rather than geocoded from a coordinate. BOM
// publishes one XML product per warning type and one per state forecast, so
// the ACT is not a place to look up — it is a block inside the New South
// Wales forecast (NSW_PW017) and a handful of district names a warning must
// name before it concerns this location.
//
// Everything here is a pure function over the XML string curl collected. The
// shell has no DOMParser, so the parsing is a deliberate tag scan rather than
// a tree: find the element, take its inner text, strip tags and decode the
// five XML entities plus the typographic ones BOM actually uses. Malformed
// input returns null or empty fields and never throws — a dropped reading
// must not blank the panel it feeds.
//
// Products are hugely wider than what is read here: warning.xml carries a
// base64 radar image several times the size of every text field combined, and
// a forecast lists a dozen towns per district. The scanners below touch only
// the fields named in the contract, and every element helper takes the first
// match, which is also the guard against the duplicate
// forecast_icon_code/air_temperature_maximum/precis BOM prints in each
// location period.
//
// One product can hold several <warning> blocks (one per hazard) and one
// forecast district holds one <forecast-period> per day. If the product has
// no <warning> at all the parser still returns a valid product with an empty
// list, so the caller can tell "checked, nothing current" from "could not
// read the answer".
//
// Product reference: https://www.bom.gov.au/catalogue/data-feeds.shtml

.pragma library

// ---------------------------------------------------------------------------
// Endpoints and cadence
// ---------------------------------------------------------------------------

// The severe thunderstorm warning product for New South Wales, which is the
// one that covers the ACT. BOM publishes other warning types under their own
// IDs; this is the storm product the plugin was written for.
var WARNING_URL = "https://www.bom.gov.au/fwo/IDN21033.xml"

// The NSW/ACT public forecast, which carries the ACT in the NSW_PW017 block.
var FORECAST_URL = "https://www.bom.gov.au/fwo/IDN11022.xml"

// Both answers are collected whole into the process that runs the bar, so
// the request carries a ceiling on bytes as well as on time. The warning
// product measures about 130 KB — mostly a base64 image the parser never
// reads — and the ceiling leaves headroom for a busier day. The forecast is
// smaller, but a state's worth of districts is still wider than it looks.
var BOM_TIMEOUT_SEC = 20
var WARNING_MAX_BYTES = 524288
var FORECAST_MAX_BYTES = 262144

// The Bureau answers a request whose User-Agent does not carry a
// Mozilla-compatible token with a 403, so the commands send one. It is a
// plain identifying string rather than a spoofed browser build: enough to be
// served, honest about what is asking. The other hosts this plugin calls
// (Open-Meteo, RainViewer, LightningMaps) serve curl's default, so the header
// is added here rather than in the shared fetchCommand, where it would change
// every stream the plugin makes.
var BOM_USER_AGENT = "Mozilla/5.0 (compatible; weather-radar-omarchy/0.4)"

// Warnings are reissued as storms move and are worth asking after often; a
// forecast changes on the agency's routine cycle, so asking more often than
// that only re-fetches the same words. Both numbers live here beside the
// products they re-ask for rather than at a timer's call site, where the
// request and the interval that repeats it could drift apart.
var WARNING_REFRESH_MS = 10 * 60 * 1000
var FORECAST_REFRESH_MS = 30 * 60 * 1000

// The Bureau's own app API — the observations behind the BOM Weather app — is
// a JSON answer for a 6-character geohash, and the only BOM endpoint that
// reports what a gauge actually measured. It is not a published, supported API
// (every response carries a copyright notice), so it is asked only for
// locations it can answer for and its absence is tolerated rather than treated
// as dry weather.
var OBSERVATION_URL_BASE = "https://api.weather.bom.gov.au/v1/locations"

// Observations update roughly every ten minutes, so the warning cadence is
// already as often as the number changes.
var OBSERVATION_REFRESH_MS = 10 * 60 * 1000

// The observations answer is about 1 KB; the ceiling leaves generous room.
var OBSERVATION_MAX_BYTES = 65536

var DWO_URL_BASE = "https://www.bom.gov.au/climate/dwo"
// The ACT/Canberra DWO product and the station it draws from. Pinned for the
// same reason the warning and forecast products are: the Bureau publishes
// daily observations per station, not per coordinate.
var DWO_PRODUCT = "2801"
var DWO_STATION_BOM_ID = "070351"
// A month of daily observations is a few kilobytes; the ceiling leaves room.
var DWO_MAX_BYTES = 524288

// Australia's rough extent. The Bureau answers only for its own stations, so a
// location outside this box is never asked about: the request would come back
// all nulls, and a null read as "no rain" would be a measurement nobody made.
var AUSTRALIA_LAT_MIN = -45.0
var AUSTRALIA_LAT_MAX = -9.0
var AUSTRALIA_LON_MIN = 112.0
var AUSTRALIA_LON_MAX = 154.0

var GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"

// The districts a warning must name before it concerns this location. Ainslie
// is in the ACT, and the bordering districts are watched for the same storm:
// a cell over the Snowy Mountains or the Southern Tablelands is one that can
// reach Canberra before the next product is issued.
var HOME_DISTRICTS = ["Australian Capital Territory", "Southern Tablelands",
                      "Snowy Mountains", "South West Slopes"]

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// The one place each request is built, so no call site can leave a ceiling
// off — the same contract fetchCommand gives every other stream this plugin
// collects whole into the shell, plus the User-Agent the Bureau insists on.
function bomCommand(url, maxBytes) {
  return ["curl", "-fsS", "--globoff", "--proto", "=https",
          "--max-time", String(BOM_TIMEOUT_SEC),
          "--max-filesize", String(maxBytes),
          "-A", BOM_USER_AGENT,
          url]
}

function warningCommand() { return bomCommand(WARNING_URL, WARNING_MAX_BYTES) }
function forecastCommand() { return bomCommand(FORECAST_URL, FORECAST_MAX_BYTES) }

// The 6-character geohash for a coordinate: the key the Bureau's API is
// addressed by. Six characters is what that API requires — a shorter string is
// rejected outright — so the loop is bounded to that length rather than taking
// a precision argument nothing would vary. Returns "" for anything that is not
// a point on the globe.
function geohash(latitude, longitude) {
  var lat = parseFloat(latitude)
  var lon = parseFloat(longitude)
  if (!isFinite(lat) || !isFinite(lon)) return ""
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return ""

  var latRange = [-90, 90]
  var lonRange = [-180, 180]
  var hash = ""
  var bit = 0
  var value = 0
  var even = true
  while (hash.length < 6) {
    var mid
    if (even) {
      mid = (lonRange[0] + lonRange[1]) / 2
      if (lon >= mid) { value = (value << 1) | 1; lonRange[0] = mid }
      else { value = value << 1; lonRange[1] = mid }
    } else {
      mid = (latRange[0] + latRange[1]) / 2
      if (lat >= mid) { value = (value << 1) | 1; latRange[0] = mid }
      else { value = value << 1; latRange[1] = mid }
    }
    even = !even
    bit++
    if (bit === 5) { hash += GEOHASH_BASE32.charAt(value); bit = 0; value = 0 }
  }
  return hash
}

function isAustralia(latitude, longitude) {
  var lat = parseFloat(latitude)
  var lon = parseFloat(longitude)
  if (!isFinite(lat) || !isFinite(lon)) return false
  return lat >= AUSTRALIA_LAT_MIN && lat <= AUSTRALIA_LAT_MAX
    && lon >= AUSTRALIA_LON_MIN && lon <= AUSTRALIA_LON_MAX
}

function observationUrl(latitude, longitude) {
  if (!isAustralia(latitude, longitude)) return ""
  var hash = geohash(latitude, longitude)
  if (hash === "") return ""
  return OBSERVATION_URL_BASE + "/" + hash + "/observations"
}

function observationCommand(latitude, longitude) {
  var url = observationUrl(latitude, longitude)
  if (url === "") return []
  return bomCommand(url, OBSERVATION_MAX_BYTES)
}

// The DWO file for a month, or "" for a month that does not exist. The Bureau
// names the file by the same YYYYMM it files it under, zero-padded.
function dwoUrl(year, month) {
  var y = parseInt(year, 10)
  var m = parseInt(month, 10)
  if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) return ""
  var stamp = String(y) + (m < 10 ? "0" : "") + String(m)
  return DWO_URL_BASE + "/" + stamp + "/text/IDCJDW" + DWO_PRODUCT + "." + stamp + ".csv"
}

function dwoCommand(year, month) {
  var url = dwoUrl(year, month)
  if (url === "") return []
  return bomCommand(url, DWO_MAX_BYTES)
}

// ---------------------------------------------------------------------------
// Text scanning
// ---------------------------------------------------------------------------

// The five standard XML entities, and the handful of typographic ones BOM's
// prose actually uses. Decoded last, &amp; is left until after &lt;/&gt; so a
// literal "&amp;lt;" — an author who meant to print the characters "&lt;" —
// does not become a stray "<".
function decodeEntities(text) {
  if (text === null || text === undefined) return ""
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&amp;/g, "&")
}

// Strip tags first, then decode, so an escaped "&lt;b&gt;" in the source
// prints as text rather than being read back as a real tag. Indentation and
// newlines inside a <text> block carry no meaning once the tags are gone, so
// every whitespace run collapses to a single space.
function cleanText(text) {
  if (text === null || text === undefined) return ""
  return decodeEntities(String(text).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

// The inner text of the first `<tag ...>...</tag>`, optionally narrowed to a
// `<text type="...">`. Returns "" when the element is absent, which is the
// same answer a present-but-empty element gives — callers treat both as a
// dropped reading rather than as a value.
function elementText(xml, tag, type) {
  var source = String(xml || "")
  if (source === "") return ""
  var pattern = "<" + tag + "[^>]*"
  if (type !== undefined && type !== null && type !== "") {
    pattern += "type=\"" + type + "\"[^>]*"
  }
  var match = new RegExp(pattern + ">([\\s\\S]*?)</" + tag + ">").exec(source)
  if (!match) return ""
  return cleanText(match[1])
}

// A named attribute off an opening tag. Decoded and trimmed, because BOM
// quotes descriptions verbatim and an attribute value may carry entities.
function attribute(tag, name) {
  var match = new RegExp("\\b" + name + "=\"([^\"]*)\"").exec(String(tag || ""))
  if (!match) return ""
  return decodeEntities(match[1]).trim()
}

// The whole `<area ...>...</area>` whose opening tag names `aac`. The scanner
// assumes no area nests another area, which holds for both products: a
// district area contains forecast-periods, and a region area contains
// districts, never the reverse. A self-closing area has no body and returns
// "" here.
function areaBlock(xml, aac) {
  var source = String(xml || "")
  var open = new RegExp("<area(?=[\\s>])[^>]*\\baac=\"" + aac + "\"[^>]*>").exec(source)
  if (!open) return ""
  if (open[0].charAt(open[0].length - 2) === "/") return ""
  var start = open.index
  var close = source.indexOf("</area>", start + open[0].length)
  if (close < 0) return ""
  return source.substring(start, close + "</area>".length)
}

// The first `<tag ...>...</tag>` body, for containers that never nest
// themselves. Used for <area-list>, which is the only place a warning's
// districts are named.
function elementBlock(xml, tag) {
  var source = String(xml || "")
  var open = new RegExp("<" + tag + "(?=[\\s>])[^>]*>").exec(source)
  if (!open) return ""
  var start = open.index
  var closing = "</" + tag + ">"
  var close = source.indexOf(closing, start + open[0].length)
  if (close < 0) return ""
  return source.substring(start, close + closing.length)
}

// Every `<warning>...</warning>` block, in document order. The lookahead
// keeps `<warning-info>` and `</warning>` from being read as openings; each
// block is the slice from its opening tag to its matching close.
function warningBlocks(xml) {
  var source = String(xml || "")
  var blocks = []
  var pattern = /<warning(?=[\s>])[^>]*>/g
  var match
  while ((match = pattern.exec(source)) !== null) {
    var start = match.index
    var close = source.indexOf("</warning>", start + match[0].length)
    if (close < 0) {
      blocks.push(source.substring(start))
      break
    }
    blocks.push(source.substring(start, close + "</warning>".length))
    pattern.lastIndex = close + "</warning>".length
  }
  return blocks
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

// The districts named in a warning's <area-list>. Only public-district
// entries name a forecast district; the region wrapper around them spells
// "New South Wales" and is not one, so it is skipped by type. A description
// with no type at all is kept, since a narrower feed may drop the attribute
// while still naming the district.
function warningAreas(warningXml) {
  var areas = []
  var list = elementBlock(warningXml, "area-list")
  if (list === "") return areas
  var pattern = /<area(?=[\s>])[^>]*>/g
  var match
  while ((match = pattern.exec(list)) !== null) {
    var type = attribute(match[0], "type")
    if (type !== "" && type !== "public-district") continue
    var description = attribute(match[0], "description")
    if (description !== "") areas.push(description)
  }
  return areas
}

// The phenomena a hazard names, drawn from the hazard's own text rather than
// the summary, which prefixes the same list with "for". The summary is the
// fallback when a feed omits the hazard text.
function warningPhenomena(warningXml) {
  var text = elementText(warningXml, "text", "warning_phenomena")
  if (text !== "") return text
  var summary = elementText(warningXml, "text", "warning_phenomena_summary")
  return summary.replace(/^for\s+/i, "")
}

// The BOM warning product, in the shape the panel draws.
//
// `raw` is the XML text curl collected. The product-level fields — the
// identifier, the issue and expiry times, the phase — are copied onto every
// warning because they describe the product that carried it. Returns null on
// empty or unparseable input so the caller keeps its previous state rather
// than blanking the panel on one bad response, and never throws.
function parseWarnings(raw) {
  var xml = String(raw || "")
  if (xml.replace(/\s+/g, "") === "") return null
  // A product carries <product>, and a bare warning fragment carries
  // <warning>; anything else is not a BOM answer at all.
  if (xml.indexOf("<product") < 0 && xml.indexOf("<warning") < 0) return null

  var id = elementText(xml, "identifier")
  var phase = elementText(xml, "phase")
  // The issue time, kept in the zone BOM wrote it in. The local copy is the
  // human-facing one; the sent time is the fallback when it is missing.
  var issuedAt = elementText(xml, "issue-time-local")
  if (issuedAt === "") issuedAt = elementText(xml, "sent-time")
  var expiry = elementText(xml, "expiry-time")
  var expiresAt = elementText(xml, "validity-end-time-local")

  var blocks = warningBlocks(xml)
  var warnings = []
  for (var i = 0; i < blocks.length; i++) {
    warnings.push({
      id: id,
      title: elementText(blocks[i], "text", "warning_title"),
      phenomena: warningPhenomena(blocks[i]),
      areas: warningAreas(blocks[i]),
      issuedAt: issuedAt,
      expiresAt: expiresAt,
      advice: elementText(blocks[i], "text", "warning_advice")
    })
  }

  return {
    issuedAt: issuedAt,
    phase: phase,
    expiry: expiry,
    warnings: warnings
  }
}

// True when a warning names a district this location sits in or beside. The
// comparison is trimmed and case-insensitive because BOM's capitalisation is
// not something the reader should have to match.
function warningConcernsHome(warning) {
  if (!warning || !Array.isArray(warning.areas)) return false
  for (var i = 0; i < warning.areas.length; i++) {
    var area = String(warning.areas[i] || "").trim().toLowerCase()
    for (var j = 0; j < HOME_DISTRICTS.length; j++) {
      if (area === HOME_DISTRICTS[j].toLowerCase()) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

// The forecast days inside one district area, in document order. The date is
// the local day the period opens on; the text is the long forecast
// paragraph, with the day's fire-danger and UV notes carried alongside when
// the feed prints them. elementText takes the first of each type, which is
// the guard against the duplicate elements a location period repeats.
function forecastDays(areaXml) {
  var days = []
  var pattern = /<forecast-period(?=[\s>])[^>]*>/g
  var match
  while ((match = pattern.exec(areaXml)) !== null) {
    var start = match.index
    var close = areaXml.indexOf("</forecast-period>", start + match[0].length)
    if (close < 0) break
    var period = areaXml.substring(start, close + "</forecast-period>".length)
    days.push({
      date: attribute(match[0], "start-time-local").substring(0, 10),
      text: elementText(period, "text", "forecast"),
      uv: elementText(period, "text", "uv_alert"),
      fireDanger: elementText(period, "text", "fire_danger")
    })
    pattern.lastIndex = close + "</forecast-period>".length
  }
  return days
}

// The BOM district forecast, in the shape the panel draws. The words that
// answer "what will it do here" live in the NSW_PW017 block — the Australian
// Capital Territory public district — so a product without that block still
// parses, with an empty day list, rather than reading a neighbouring
// district's forecast as this one's. Returns null only when the input is not
// a forecast at all.
function parseForecast(raw) {
  var xml = String(raw || "")
  if (xml.trim() === "") return null

  var issuedAt = elementText(xml, "issue-time-local")
  var synoptic = elementText(xml, "text", "synoptic_situation")
  var uv = elementText(xml, "text", "uv_alert")
  var area = areaBlock(xml, "NSW_PW017")

  // Nothing recognised anywhere in the string: not a BOM product.
  if (issuedAt === "" && synoptic === "" && uv === "" && area === "") return null

  return {
    issuedAt: issuedAt,
    days: area === "" ? [] : forecastDays(area),
    synoptic: synoptic,
    uv: uv
  }
}

// A field is kept only when it is a real finite number. The API writes null for
// anything a station did not report, and null must not become 0.
function observationNumber(value) {
  return (typeof value === "number" && isFinite(value)) ? value : null
}

// The gauge reading the app API returns, in the shape the tab draws. `raw` is
// the JSON text curl collected. Returns null when the input is not a JSON
// object carrying a `data` object — a dropped or non-BOM answer, which the
// caller keeps its previous reading across — and never throws. Every field is
// nullable: a geohash with no station nearby answers with a data object whose
// fields are all null, which reads as "no observation" rather than as zero.
function parseObservations(raw) {
  var record = null
  try { record = JSON.parse(String(raw || "")) } catch (e) { record = null }
  if (!record || typeof record !== "object") return null
  if (!record.data || typeof record.data !== "object") return null

  var data = record.data
  var meta = (record.metadata && typeof record.metadata === "object") ? record.metadata : {}
  var station = (data.station && typeof data.station === "object") ? data.station : null
  // The API reports a station's distance in metres (7066 for a station seven
  // kilometres away); the tab draws kilometres, so the conversion happens once,
  // here, where the unit is known rather than at a label that would otherwise
  // print 7066 km.
  var stationMetres = station ? observationNumber(station.distance) : null

  return {
    observationTime: typeof meta.observation_time === "string" ? meta.observation_time : null,
    rainSince9am: observationNumber(data.rain_since_9am),
    temp: observationNumber(data.temp),
    feelsLike: observationNumber(data.temp_feels_like),
    humidity: observationNumber(data.humidity),
    gust: (data.gust && typeof data.gust === "object")
      ? observationNumber(data.gust.speed_kilometre) : null,
    station: station ? {
      name: typeof station.name === "string" ? station.name : "",
      bomId: typeof station.bom_id === "string" ? station.bom_id : "",
      distanceKm: stationMetres === null ? null : stationMetres / 1000
    } : null
  }
}

// ---------------------------------------------------------------------------
// Daily Weather Observations
// ---------------------------------------------------------------------------

// A single CSV line split on commas, honouring double-quoted fields (the
// title lines contain commas inside quotes). Quotes are dropped from the
// values. Pure and never throws.
function csvFields(line) {
  var text = String(line || "")
  var fields = []
  var field = ""
  var quoted = false
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i)
    if (quoted) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') { field += '"'; i++ }
        else quoted = false
      } else field += ch
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ",") {
      fields.push(field); field = ""
    } else field += ch
  }
  fields.push(field)
  return fields
}

// One date as the file writes it ("2026-10-1") as an ISO day ("2026-10-01"),
// so it can be matched against Open-Meteo's daily rows. "" for anything else.
function dwoDate(value) {
  var parts = String(value || "").trim().split("-")
  if (parts.length !== 3) return ""
  var y = parseInt(parts[0], 10)
  var m = parseInt(parts[1], 10)
  var d = parseInt(parts[2], 10)
  if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return ""
  if (m < 1 || m > 12 || d < 1 || d > 31) return ""
  return String(y) + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d
}

// The Bureau's DWO product parsed to per-day rainfall. Returns null when the
// input is not a DWO file at all, and never throws. A day whose rainfall is
// blank is kept with null, which reads as "not reported" rather than as zero.
function parseDwo(raw) {
  var text = String(raw || "")
  if (text.indexOf("Daily Weather Observations") < 0) return null

  var lines = text.split(/\r?\n/)
  var header = null
  var dateIndex = -1
  var rainIndex = -1
  for (var i = 0; i < lines.length; i++) {
    var fields = csvFields(lines[i])
    if (fields.indexOf("Date") >= 0 && fields.indexOf("Rainfall (mm)") >= 0) {
      header = lines[i]
      dateIndex = fields.indexOf("Date")
      rainIndex = fields.indexOf("Rainfall (mm)")
      break
    }
  }
  if (dateIndex < 0 || rainIndex < 0) return null

  var stationName = ""
  var stationId = ""
  for (var s = 0; s < lines.length; s++) {
    var drawn = /Observations were drawn from (.+?) \{station (\d+)\}/.exec(lines[s])
    if (drawn) { stationName = drawn[1]; stationId = drawn[2]; break }
  }

  var days = []
  for (var r = 0; r < lines.length; r++) {
    if (lines[r] === header) {
      for (var k = r + 1; k < lines.length; k++) {
        var row = csvFields(lines[k])
        if (row.length <= rainIndex) continue
        var date = dwoDate(row[dateIndex])
        if (date === "") continue
        var raw_mm = String(row[rainIndex] || "").trim()
        var mm = raw_mm === "" ? null : (isFinite(parseFloat(raw_mm)) ? parseFloat(raw_mm) : null)
        days.push({ date: date, mm: mm })
      }
      break
    }
  }
  if (days.length === 0) return null
  return { days: days, stationName: stationName, stationId: stationId }
}

const { test } = require("node:test")
const assert = require("node:assert")
const { loadLibrary } = require("./load.js")

const Bom = loadLibrary("Bom.js")

// Trimmed from the real IDN21033 severe-thunderstorm product: one warning
// block, with the base64 radar image and the comments the feed prints
// between elements dropped. It keeps every field the parser reads — the
// product identifier, issue/expiry times, phase, the warning text, the SES
// advice, and the <area-list> whose district names are what makes a warning
// concern this location.
const WARNING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<product version="1.7">
    <amoc>
        <identifier>IDN21033</identifier>
        <issue-time-utc>2026-10-03T00:43:03Z</issue-time-utc>
        <issue-time-local tz="EST">2026-10-03T10:43:03+10:00</issue-time-local>
        <sent-time>2026-10-03T00:43:03Z</sent-time>
        <expiry-time>2026-10-03T05:43:01Z</expiry-time>
        <validity-bgn-time-local tz="EST">2026-10-03T10:43:01+10:00</validity-bgn-time-local>
        <validity-end-time-local tz="EST">2026-10-03T15:43:00+10:00</validity-end-time-local>
        <phase>NEW</phase>
    </amoc>
    <warning>
        <warning-info>
            <text type="warning_title">
                <p>Severe Thunderstorm Warning</p>
            </text>
            <text type="warning_area_summary">
                <p>parts of Snowy Mountains, South West Slopes and Australian Capital Territory Forecast Districts.</p>
            </text>
            <text type="warning_phenomena_summary">
                <p>for DAMAGING WINDS, LARGE HAILSTONES and HEAVY RAINFALL</p>
            </text>
            <text type="issued_at">
                <p>Issued at 10:43 am Saturday, 3 October 2026.</p>
            </text>
            <text type="warning_advice">
                <p>The State Emergency Service advises that people should:</p>
                <p>* Keep clear of creeks and storm drains.</p>
                <p>For emergency help in flood and storms, ring the SES on 132 500.</p>
            </text>
        </warning-info>
        <area aac="NSW_FA001" description="New South Wales" type="region">
            <hazard index="1" phase="NEW" type="STW" severity="STD">
                <area-list>
                    <area aac="NSW_PW013" phase="NEW" description="South West Slopes" type="public-district"/>
                    <area aac="NSW_PW010" phase="NEW" description="Snowy Mountains" type="public-district"/>
                    <area aac="NSW_PW017" phase="NEW" description="Australian Capital Territory" type="public-district"/>
                </area-list>
                <text type="warning_phenomena">
                    <p>DAMAGING WINDS, LARGE HAILSTONES and HEAVY RAINFALL</p>
                </text>
            </hazard>
        </area>
    </warning>
</product>`

// The same product with every home district renamed: a warning for the
// Hunter must not read as one for Ainslie.
const HUNTER_XML = WARNING_XML
  .replace(/Australian Capital Territory/g, "Hunter")
  .replace(/Snowy Mountains/g, "Hunter")
  .replace(/South West Slopes/g, "Hunter")

// Trimmed from the real IDN11022 NSW/ACT forecast: the NSW_PW017 district
// with two forecast-periods, plus the region block that carries the synoptic
// situation. The first day's text is the agent's own, with an "&amp;"
// substituted for one "and" so decoding has something to prove.
const FORECAST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<product version="1.7">
    <amoc>
        <identifier>IDN11022</identifier>
        <issue-time-local tz="EST">2026-10-03T11:07:16+10:00</issue-time-local>
        <phase>UPD</phase>
    </amoc>
    <forecast>
        <area aac="NSW_FA001" description="New South Wales" type="region">
            <forecast-period start-time-local="2026-10-03T11:07:17+10:00" end-time-local="2026-10-03T11:07:17+10:00">
                <text type="synoptic_situation">A high pressure system over the Tasman Sea is heading eastwards, extending a ridge over eastern Australia.</text>
            </forecast-period>
        </area>
        <area aac="NSW_PW017" description="Australian Capital Territory" type="public-district" parent-aac="NSW_FA001">
            <forecast-period index="0" start-time-local="2026-10-03T00:00:00+10:00" end-time-local="2026-10-04T00:00:00+10:00">
                <text type="forecast">Cloudy. High chance of showers &amp; a thunderstorm. Winds north to northwesterly 15 to 25 km/h becoming light in the evening. Daytime maximum temperatures between 16 and 20.</text>
                <text type="fire_danger">Australian Capital Territory: No Rating</text>
                <text type="uv_alert">Sun protection 8:40am to 3:00pm, UV Index predicted to reach 7 [High]</text>
            </forecast-period>
            <forecast-period index="1" start-time-local="2026-10-04T00:00:00+10:00" end-time-local="2026-10-05T00:00:00+11:00">
                <text type="forecast">Partly cloudy. Slight chance of a shower, most likely in the afternoon. Light winds becoming west to northwesterly 20 to 30 km/h in the morning.</text>
            </forecast-period>
        </area>
    </forecast>
</product>`

// The same forecast with the ACT district absent, so seconds are read from a
// product that parsed but carries no home forecast.
const NO_AREA_XML = FORECAST_XML.replace(/NSW_PW017/g, "NSW_PW999")

// ------------------------------------------------------------------ requests

test("the warning request is a bounded, secure curl command", () => {
  const command = Bom.warningCommand()
  assert.strictEqual(command[0], "curl")
  assert.ok(command.includes("-fsS"), "an error page would parse as data")
  assert.ok(command.includes("--max-time"), "no time limit")
  assert.ok(command.includes("--max-filesize"), "no size limit")
  assert.strictEqual(command[command.indexOf("-A") + 1], Bom.BOM_USER_AGENT,
    "the Bureau rejects a request without its User-Agent")
  assert.strictEqual(command[command.length - 1], Bom.WARNING_URL)
  assert.ok(command[command.length - 1].startsWith("https://"), "not secure")
  const seconds = Number(command[command.indexOf("--max-time") + 1])
  const bytes = Number(command[command.indexOf("--max-filesize") + 1])
  assert.ok(seconds > 0 && seconds <= 30, `waits up to ${seconds}s`)
  assert.ok(bytes > 0 && bytes <= 1024 * 1024, `caps at ${bytes} bytes`)
})

test("the forecast request is a bounded, secure curl command", () => {
  const command = Bom.forecastCommand()
  assert.strictEqual(command[0], "curl")
  assert.ok(command.includes("-fsS"), "an error page would parse as data")
  assert.ok(command.includes("--max-time"), "no time limit")
  assert.ok(command.includes("--max-filesize"), "no size limit")
  assert.strictEqual(command[command.indexOf("-A") + 1], Bom.BOM_USER_AGENT,
    "the Bureau rejects a request without its User-Agent")
  assert.strictEqual(command[command.length - 1], Bom.FORECAST_URL)
  assert.ok(command[command.length - 1].startsWith("https://"), "not secure")
})

test("the refresh cadences sit beside the products they re-ask for", () => {
  assert.strictEqual(Bom.WARNING_REFRESH_MS, 10 * 60 * 1000)
  assert.strictEqual(Bom.FORECAST_REFRESH_MS, 30 * 60 * 1000)
})

// ---------------------------------------------------------------- warnings

test("a warning product parses into its districts, advice and phase", () => {
  const product = Bom.parseWarnings(WARNING_XML)
  assert.strictEqual(product.phase, "NEW")
  assert.strictEqual(product.expiry, "2026-10-03T05:43:01Z")
  assert.strictEqual(product.warnings.length, 1)

  const warning = product.warnings[0]
  assert.strictEqual(warning.id, "IDN21033")
  assert.strictEqual(warning.title, "Severe Thunderstorm Warning")
  assert.strictEqual(warning.phenomena,
    "DAMAGING WINDS, LARGE HAILSTONES and HEAVY RAINFALL")
  assert.deepStrictEqual(warning.areas,
    ["South West Slopes", "Snowy Mountains", "Australian Capital Territory"])
  assert.strictEqual(warning.issuedAt, "2026-10-03T10:43:03+10:00")
  assert.strictEqual(warning.expiresAt, "2026-10-03T15:43:00+10:00")
  assert.ok(warning.advice.includes(
    "For emergency help in flood and storms, ring the SES on 132 500."),
    warning.advice)
  // The <p> tags are gone and the paragraphs read as one sentence stream.
  assert.ok(!warning.advice.includes("<p>"), warning.advice)
})

test("a warning naming a home district concerns this location", () => {
  const warning = Bom.parseWarnings(WARNING_XML).warnings[0]
  assert.strictEqual(Bom.warningConcernsHome(warning), true)
})

test("a warning naming only other districts does not concern this location", () => {
  const warning = Bom.parseWarnings(HUNTER_XML).warnings[0]
  assert.deepStrictEqual(warning.areas, ["Hunter", "Hunter", "Hunter"])
  assert.strictEqual(Bom.warningConcernsHome(warning), false)
})

test("warningConcernsHome is case-insensitive and trims", () => {
  assert.strictEqual(Bom.warningConcernsHome(
    { areas: ["  snowy mountains  "] }), true)
  assert.strictEqual(Bom.warningConcernsHome({ areas: ["Hunter"] }), false)
  assert.strictEqual(Bom.warningConcernsHome(null), false)
})

test("a product with no warning blocks is valid but empty", () => {
  const product = Bom.parseWarnings(
    "<product><amoc><identifier>IDN21033</identifier><phase>CANCELLED</phase>" +
    "<expiry-time>2026-10-03T05:43:01Z</expiry-time></amoc></product>")
  assert.strictEqual(product.phase, "CANCELLED")
  assert.deepStrictEqual(product.warnings, [])
})

test("unusable warning input parses to null rather than throwing", () => {
  assert.strictEqual(Bom.parseWarnings(""), null)
  assert.strictEqual(Bom.parseWarnings("not xml"), null)
  assert.strictEqual(Bom.parseWarnings(null), null)
})

// ---------------------------------------------------------------- forecast

test("the ACT forecast parses its issue time, days and synoptic situation", () => {
  const forecast = Bom.parseForecast(FORECAST_XML)
  assert.strictEqual(forecast.issuedAt, "2026-10-03T11:07:16+10:00")
  assert.strictEqual(forecast.days.length, 2)
  assert.ok(forecast.synoptic.includes("high pressure system"), forecast.synoptic)

  assert.strictEqual(forecast.days[0].date, "2026-10-03")
  assert.ok(forecast.days[0].text.includes("showers"), forecast.days[0].text)
  assert.ok(forecast.days[0].text.includes("Winds"), forecast.days[0].text)
  assert.ok(forecast.days[0].fireDanger.includes("No Rating"),
    forecast.days[0].fireDanger)
  assert.ok(forecast.days[0].uv.includes("UV Index"), forecast.days[0].uv)

  assert.strictEqual(forecast.days[1].date, "2026-10-04")
  // Each period is its own day; the notes are empty when the feed omits them.
  assert.strictEqual(forecast.days[1].fireDanger, "")
  assert.strictEqual(forecast.days[1].uv, "")
})

test("XML entities in the forecast text decode to their characters", () => {
  const day = Bom.parseForecast(FORECAST_XML).days[0]
  assert.ok(day.text.includes("showers & a thunderstorm"), day.text)
  assert.ok(!day.text.includes("&amp;"), day.text)
})

test("a forecast with the ACT area absent parses to no days", () => {
  const forecast = Bom.parseForecast(NO_AREA_XML)
  assert.notStrictEqual(forecast, null)
  assert.deepStrictEqual(forecast.days, [])
  assert.strictEqual(forecast.issuedAt, "2026-10-03T11:07:16+10:00")
})

test("unusable forecast input parses to null rather than throwing", () => {
  assert.strictEqual(Bom.parseForecast(""), null)
  assert.strictEqual(Bom.parseForecast("not xml"), null)
  assert.strictEqual(Bom.parseForecast(null), null)
})

// ------------------------------------------------------------ observations

test("the geohash is the six-character key the Bureau's API is addressed by", () => {
  // Independently known vectors: Ainslie matches the Bureau's own location
  // key, and the northern point is the Wikipedia geohash worked example,
  // truncated to the six characters the API requires.
  assert.strictEqual(Bom.geohash(-35.26255, 149.1437), "r3dp3u")
  assert.strictEqual(Bom.geohash(57.64911, 10.40744), "u4pruy")
  assert.strictEqual(Bom.geohash(0, 0), "s00000")
  // Nothing that is not a point on the globe has a hash at all.
  assert.strictEqual(Bom.geohash(NaN, 0), "")
})

test("the Australia box admits the continent and nothing beside it", () => {
  assert.strictEqual(Bom.isAustralia(-35.26255, 149.1437), true)
  assert.strictEqual(Bom.isAustralia(-36.85, 174.76), false)
  assert.strictEqual(Bom.isAustralia(NaN, 0), false)
})

test("an observation URL is built only for a location the Bureau can answer for", () => {
  assert.strictEqual(Bom.observationUrl(-35.26255, 149.1437),
    "https://api.weather.bom.gov.au/v1/locations/r3dp3u/observations")
  assert.strictEqual(Bom.observationUrl(-36.85, 174.76), "")
})

test("the observation request is a bounded, secure curl command", () => {
  const command = Bom.observationCommand(-35.26255, 149.1437)
  assert.strictEqual(command[0], "curl")
  assert.ok(command.includes("-fsS"), "an error page would parse as data")
  assert.ok(command.includes("--max-time"), "no time limit")
  assert.ok(command.includes("--max-filesize"), "no size limit")
  assert.ok(command.includes("--globoff"), "curl would expand the URL")
  assert.strictEqual(command[command.indexOf("-A") + 1], Bom.BOM_USER_AGENT)
  assert.strictEqual(command[command.length - 1],
    "https://api.weather.bom.gov.au/v1/locations/r3dp3u/observations")
  assert.strictEqual(command[command.indexOf("--max-filesize") + 1],
    String(Bom.OBSERVATION_MAX_BYTES))
  // A location outside the Bureau's reach is no request at all.
  assert.deepStrictEqual(Bom.observationCommand(-36.85, 174.76), [])
})

test("an observation parses into its gauge reading and station", () => {
  const observation = Bom.parseObservations(JSON.stringify({
    metadata: { observation_time: "2026-10-12T12:10:00Z" },
    data: {
      rain_since_9am: 3.6,
      temp: 16.3,
      temp_feels_like: 16.2,
      humidity: 98,
      gust: { speed_kilometre: 15 },
      station: { bom_id: "070351", name: "Canberra", distance: 7066 }
    }
  }))
  assert.strictEqual(observation.rainSince9am, 3.6)
  assert.strictEqual(observation.observationTime, "2026-10-12T12:10:00Z")
  assert.strictEqual(observation.station.name, "Canberra")
  // The API's `distance` is metres; the parser reports kilometres.
  assert.strictEqual(observation.station.distanceKm, 7.066)
})

test("unusable observation input parses to null rather than throwing", () => {
  assert.strictEqual(Bom.parseObservations(""), null)
  assert.strictEqual(Bom.parseObservations("not json"), null)
  assert.strictEqual(Bom.parseObservations('{"metadata":{}}'), null)
})

test("a station that reported nothing reads as no observation, never as zero", () => {
  const observation = Bom.parseObservations(JSON.stringify({
    metadata: {},
    data: { rain_since_9am: null, station: null }
  }))
  assert.strictEqual(observation.rainSince9am, null)
  assert.strictEqual(observation.station, null)
})

test("the observation cadence sits beside the endpoint it re-asks for", () => {
  assert.ok(Bom.OBSERVATION_REFRESH_MS > 0)
})

test("the observation parses from the verified live shape", () => {
  const observation = Bom.parseObservations('{"metadata":{"observation_time":"2026-10-12T12:10:00Z"},"data":{"rain_since_9am":3.6,"temp":16.3,"temp_feels_like":16.2,"humidity":98,"gust":{"speed_kilometre":15},"station":{"bom_id":"070351","name":"Canberra","distance":7066}}}')
  assert.strictEqual(observation.rainSince9am, 3.6)
  assert.strictEqual(observation.station.name, "Canberra")
  // The API's `distance` is metres; the parser reports kilometres.
  assert.strictEqual(observation.station.distanceKm, 7.066)
  assert.strictEqual(observation.observationTime, "2026-10-12T12:10:00Z")
})

// ------------------------------------------------- daily weather observations

// Trimmed from the real DWO CSV the plugin fetches: the quoted title lines
// (commas inside quotes), the station line the parser names the product by,
// the header, and a handful of daily rows. One row reports no rainfall, which
// the parser must keep as "not reported" rather than reading as a dry day.
const DWO_CSV = [
  '"Daily Weather Observations for Canberra, Australian Capital Territory for October 2026"',
  '"Copyright 2003 Commonwealth Bureau of Meteorology"',
  '"Observations were drawn from Canberra Airport {station 070351}"',
  ',"Date","Minimum temperature (C)","Maximum temperature (C)","Rainfall (mm)","Evaporation (mm)",,,"Wind direction","Wind speed (km/h)","Time of max wind gust"',
  ",2026-10-10,9.6,23.1,6.2,,,WNW,44,12:03",
  ",2026-10-11,10.1,22.0,,,",
  ",2026-10-12,11.2,21.0,0.0,,,"
].join("\n")

test("a DWO URL is named by the zero-padded month and the pinned product", () => {
  assert.strictEqual(Bom.dwoUrl(2026, 10),
    "https://www.bom.gov.au/climate/dwo/202610/text/IDCJDW2801.202610.csv")
  assert.strictEqual(Bom.dwoUrl(2026, 3),
    "https://www.bom.gov.au/climate/dwo/202603/text/IDCJDW2801.202603.csv")
  // A month that does not exist is no request at all.
  assert.strictEqual(Bom.dwoUrl(2026, 13), "")
  assert.strictEqual(Bom.dwoUrl("abc", 1), "")
})

test("the DWO request is a bounded, secure curl command", () => {
  const command = Bom.dwoCommand(2026, 10)
  assert.strictEqual(command[0], "curl")
  assert.ok(command.includes("-fsS"), "an error page would parse as data")
  assert.ok(command.includes("--max-time"), "no time limit")
  assert.ok(command.includes("--max-filesize"), "no size limit")
  assert.ok(command.includes("--globoff"), "curl would expand the URL")
  assert.strictEqual(command[command.indexOf("-A") + 1], Bom.BOM_USER_AGENT)
  assert.strictEqual(command[command.indexOf("--max-filesize") + 1],
    String(Bom.DWO_MAX_BYTES))
  assert.strictEqual(command[command.length - 1], Bom.dwoUrl(2026, 10))
  assert.deepStrictEqual(Bom.dwoCommand(2026, 13), [])
})

test("a CSV line splits on commas with quoted fields kept whole", () => {
  assert.deepStrictEqual(Bom.csvFields('a,"b,c",d'), ["a", "b,c", "d"])
  assert.deepStrictEqual(Bom.csvFields(""), [""])
  assert.deepStrictEqual(Bom.csvFields(null), [""])
})

test("the DWO product parses to per-day rainfall and its station", () => {
  const dwo = Bom.parseDwo(DWO_CSV)
  assert.strictEqual(dwo.stationName, "Canberra Airport")
  assert.strictEqual(dwo.stationId, "070351")
  assert.strictEqual(dwo.days.length, 3)
  assert.deepStrictEqual(dwo.days[0], { date: "2026-10-10", mm: 6.2 })
  // A blank rainfall cell is "not reported", kept null rather than zero.
  assert.strictEqual(dwo.days[1].date, "2026-10-11")
  assert.strictEqual(dwo.days[1].mm, null)
  assert.strictEqual(dwo.days[2].mm, 0)
})

test("unusable DWO input parses to null rather than throwing", () => {
  assert.strictEqual(Bom.parseDwo("not a dwo file"), null)
  assert.strictEqual(Bom.parseDwo(""), null)
  assert.strictEqual(Bom.parseDwo(null), null)
})

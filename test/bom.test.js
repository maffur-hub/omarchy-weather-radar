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

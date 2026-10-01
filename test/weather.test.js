const { test } = require("node:test")
const assert = require("node:assert")
const { loadLibrary, RadarModel } = require("./load.js")

const Weather = loadLibrary("Weather.js", { RadarModel })

// The fixture is anchored on the moment the response was taken, so every
// filter in the parser has a fixed line to be judged against: current.time
// is 19:00 on 2026-10-01, which is what "today" and "the current hour"
// mean throughout.
const NOW = "2026-10-01T19:00"
const TODAY = "2026-10-01"

// 14 daily rows, 2026-09-24 through 2026-10-07: a week behind today and a
// week ahead of it, so index 7 is today.
function dailyDates() {
  const out = []
  const start = Date.UTC(2026, 8, 24)
  for (let i = 0; i < 14; i++) {
    out.push(new Date(start + i * 86400000).toISOString().slice(0, 10))
  }
  return out
}

// 72 hourly rows, 2026-09-30T19:00 through 2026-10-03T18:00 — past_hours=24
// behind current.time with forecast_hours=48 in front of it.
function hourlyTimes() {
  const out = []
  const start = Date.UTC(2026, 8, 30, 19, 0, 0)
  for (let i = 0; i < 72; i++) {
    out.push(new Date(start + i * 3600000).toISOString().slice(0, 16))
  }
  return out
}

function fixture() {
  const dates = dailyDates()
  const times = hourlyTimes()
  const rainToday = times.map(time =>
    time.slice(0, 10) === TODAY && Number(time.slice(11, 13)) < 19 ? 0.2 : 0)

  return {
    latitude: -35.15,
    longitude: -149.13,
    elevation: 612,
    timezone: "Europe/Lisbon",
    timezone_abbreviation: "GMT+1",
    current_units: {},
    current: {
      time: NOW,
      interval: 900,
      temperature_2m: 16.9,
      apparent_temperature: 15.4,
      relative_humidity_2m: 71,
      precipitation: 0,
      weather_code: 3,
      wind_speed_10m: 14.3,
      wind_direction_10m: 357,
      wind_gusts_10m: 31.7,
      is_day: 0
    },
    hourly_units: {},
    hourly: {
      time: times,
      temperature_2m: times.map((_, i) => 9 + (i % 11)),
      apparent_temperature: times.map((_, i) => 8 + (i % 11)),
      precipitation: rainToday,
      precipitation_probability: times.map((_, i) => (i * 7) % 101),
      weather_code: times.map((_, i) => i % 5),
      wind_speed_10m: times.map((_, i) => 5 + (i % 20)),
      relative_humidity_2m: times.map((_, i) => 50 + (i % 40)),
      is_day: times.map(t => {
        const hour = Number(t.slice(11, 13))
        return hour >= 6 && hour < 21 ? 1 : 0
      })
    },
    daily_units: {},
    daily: {
      time: dates,
      // Today's full-day figure, forecast at midnight: the parser must
      // override it with the hours actually clocked.
      precipitation_sum: [0.0, 1.2, 0.0, 0.4, 3.1, 0.0, 2.0, 5.0,
                          0.8, 0.0, 1.5, 0.0, 0.0, 0.3],
      weather_code: dates.map((_, i) => i % 6),
      temperature_2m_max: dates.map((_, i) => 18 + (i % 6)),
      temperature_2m_min: dates.map((_, i) => 8 + (i % 5)),
      apparent_temperature_max: dates.map((_, i) => 17 + (i % 6)),
      apparent_temperature_min: dates.map((_, i) => 7 + (i % 5)),
      precipitation_probability_max: dates.map((_, i) => (i * 13) % 101),
      wind_speed_10m_max: dates.map((_, i) => 15 + i),
      wind_gusts_10m_max: dates.map((_, i) => 25 + i),
      sunrise: dates.map(d => d + "T07:12"),
      sunset: dates.map(d => d + "T18:45"),
      uv_index_max: dates.map((_, i) => 3 + (i % 7))
    }
  }
}

let parsedOnce = null
function parsed() {
  if (!parsedOnce) parsedOnce = Weather.parseWeather(JSON.stringify(fixture()))
  return parsedOnce
}

// ------------------------------------------------------------------ request

test("the weather request is bounded and asks for the whole window", () => {
  const command = Weather.weatherCommand(-35.15, 149.13)
  assert.strictEqual(command[0], "curl")
  assert.ok(command.includes("--max-time"), "no time limit")
  assert.ok(command.includes("--max-filesize"), "no size limit")
  assert.ok(command.includes("--globoff"), "curl would expand the URL")
  assert.ok(command.includes("-fsS"), "an error page would parse as data")

  const bytes = Number(command[command.indexOf("--max-filesize") + 1])
  const seconds = Number(command[command.indexOf("--max-time") + 1])
  assert.ok(bytes > 0 && bytes <= 1024 * 1024, `caps at ${bytes} bytes`)
  assert.ok(seconds > 0 && seconds <= 30, `waits up to ${seconds}s`)

  const url = command[command.length - 1]
  assert.ok(url.includes("latitude=-35.1500"), url)
  assert.ok(url.includes("longitude=149.1300"), url)
  assert.ok(url.includes("past_days=7"), url)
  assert.ok(url.includes("past_hours=24"), url)
  assert.ok(url.includes("forecast_days=7"), url)
  assert.ok(url.includes("forecast_hours=48"), url)
  assert.ok(url.includes("precipitation_unit=mm"), url)
  assert.ok(url.includes("daily=precipitation_sum"), url)
})

test("coordinates that are not numbers build no request at all", () => {
  assert.deepStrictEqual(Weather.weatherCommand(null, null), [])
  assert.deepStrictEqual(Weather.weatherCommand(NaN, 1), [])
  assert.strictEqual(Weather.weatherUrl("abc", 1), "")
})

// ------------------------------------------------------------------ parsing

test("unusable input parses to null rather than throwing", () => {
  assert.strictEqual(Weather.parseWeather(""), null)
  assert.strictEqual(Weather.parseWeather("not json"), null)
  assert.strictEqual(Weather.parseWeather(null), null)
})

test("the current reading parses with its description and direction", () => {
  const data = parsed()
  assert.strictEqual(data.current.temperature, 16.9)
  assert.strictEqual(data.current.description, "Overcast")
  assert.strictEqual(data.current.windDirection, 357)
  assert.strictEqual(data.current.isDay, false)
  assert.strictEqual(data.updatedAt, NOW)
})

test("the outlook runs from today for seven days", () => {
  const forecast = parsed().forecast
  assert.strictEqual(forecast.length, 7)
  assert.strictEqual(forecast[0].date, TODAY)
  assert.strictEqual(forecast[0].isToday, true)
  assert.strictEqual(forecast[1].date, "2026-10-02")
  assert.strictEqual(forecast[6].date, "2026-10-07")
})

test("the hourly strip opens on the current hour and runs 48 entries", () => {
  const hourly = parsed().hourly
  assert.strictEqual(hourly.length, 48)
  assert.strictEqual(hourly[0].time, "2026-10-01T19:00")
  assert.strictEqual(hourly[0].label, "19")
  assert.strictEqual(hourly[47].time, "2026-10-03T18:00")
  for (const hour of hourly) {
    assert.strictEqual(typeof hour.isDay, "boolean", hour.time)
  }
})

test("the rain chart covers the seven days ending today", () => {
  const rain = parsed().rain
  assert.strictEqual(rain.days.length, 7)
  assert.strictEqual(rain.days[0].date, "2026-09-25")
  assert.strictEqual(rain.days[6].date, TODAY)
  // Today's bar is the hours clocked so far (19 x 0.2), not the 5.0 mm
  // full-day figure the daily row forecasts.
  assert.strictEqual(rain.todayMm, 3.8)
  assert.strictEqual(rain.last7Mm, 10.5)
  assert.strictEqual(rain.maxMm, 3.8)
  assert.strictEqual(rain.days[6].mm, 3.8)
  assert.strictEqual(rain.days[6].isToday, true)
})

// --------------------------------------------------------------- semantics

test("WMO codes read back in words", () => {
  assert.strictEqual(Weather.describeCode(0), "Clear sky")
  assert.strictEqual(Weather.describeCode(95), "Thunderstorm")
  assert.strictEqual(Weather.describeCode(1234), "Unknown")
})

test("wind directions label onto the sixteen-point compass", () => {
  assert.strictEqual(Weather.windDirectionLabel(0), "N")
  assert.strictEqual(Weather.windDirectionLabel(90), "E")
  assert.strictEqual(Weather.windDirectionLabel(180), "S")
  assert.strictEqual(Weather.windDirectionLabel(270), "W")
  assert.strictEqual(Weather.windDirectionLabel(357), "N")
  assert.strictEqual(Weather.windDirectionLabel(NaN), "")
})

// ------------------------------------------------------------------- glyphs

test("every weather icon is exactly one codepoint", () => {
  // A `\u` escape consumes exactly four hex digits, so writing any of these
  // that way yields a different glyph followed by a stray digit. Nothing
  // reports it; the icon is simply wrong.
  const names = ["ICON_SUN", "ICON_MOON", "ICON_PARTLY_DAY", "ICON_PARTLY_NIGHT",
                 "ICON_CLOUD", "ICON_FOG_DAY", "ICON_FOG_NIGHT",
                 "ICON_SHOWERS_DAY", "ICON_SHOWERS_NIGHT",
                 "ICON_SLEET_DAY", "ICON_SLEET_NIGHT", "ICON_SLEET",
                 "ICON_THUNDER", "ICON_RAIN", "ICON_SNOW"]
  for (const name of names) {
    assert.strictEqual(Array.from(Weather[name]).length, 1, name)
  }
})

test("codes pick the glyph the tab draws for them", () => {
  assert.strictEqual(Weather.iconForCode(0, false), Weather.ICON_SUN)
  assert.strictEqual(Weather.iconForCode(0, true), Weather.ICON_MOON)
  assert.strictEqual(Weather.iconForCode(3, false), Weather.ICON_CLOUD)
  assert.strictEqual(Weather.iconForCode(95, false), Weather.ICON_THUNDER)
  assert.strictEqual(Weather.iconForCode(71, false), Weather.ICON_SNOW)
  assert.strictEqual(Weather.iconForCode(61, false), Weather.ICON_RAIN)
})

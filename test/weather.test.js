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

// The fixture with fields moved, so a test can put rain where it needs it
// without a second fixture builder.
function parsedWith(move) {
  const data = fixture()
  move(data)
  return Weather.parseWeather(JSON.stringify(data))
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

test("the hourly list asks only for the fields the strip draws", () => {
  const url = Weather.weatherUrl(-35.15, 149.13)
  const hourly = url.match(/&hourly=([^&]*)/)[1]
  assert.strictEqual(hourly,
    "temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,is_day")
  // Humidity and wind are still asked for — off the current reading, where
  // the tab reads them.
  const current = url.match(/&current=([^&]*)/)[1]
  assert.ok(current.includes("relative_humidity_2m"), current)
  assert.ok(current.includes("wind_speed_10m"), current)
})

test("the refresh cadence is a constant beside the window it re-asks for", () => {
  assert.strictEqual(Weather.WEATHER_REFRESH_MS, 30 * 60 * 1000)
})

test("the cache path is built only from an absolute home", () => {
  assert.strictEqual(Weather.weatherCachePath("/home/someone"),
    "/home/someone/.local/state/omarchy/weather-radar-weather.json")
  assert.strictEqual(Weather.weatherCachePath("/home/someone/"),
    "/home/someone/.local/state/omarchy/weather-radar-weather.json")
  // An unset home reads as null, and "null/.local/..." would be a path
  // relative to wherever the shell happened to start.
  for (const home of [undefined, null, "", "null", "relative/home", "/home/a\nb"]) {
    assert.strictEqual(Weather.weatherCachePath(home), "", String(home))
  }
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

test("every hourly entry carries its date, weekday and midnight flag", () => {
  const hourly = parsed().hourly
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  for (const hour of hourly) {
    assert.strictEqual(hour.date, hour.time.substring(0, 10), hour.time)
    assert.strictEqual(hour.weekday,
      names[new Date(hour.date + "T12:00:00").getDay()], hour.time)
    assert.strictEqual(hour.isMidnight,
      hour.time.substring(11, 16) === "00:00", hour.time)
  }
  assert.strictEqual(hourly[0].date, TODAY)
  assert.strictEqual(hourly[0].weekday, "Thu")
  assert.strictEqual(hourly[0].isMidnight, false)
  // The first midnight inside the strip, one row per hour after 23:00.
  assert.strictEqual(hourly[5].time, "2026-10-02T00:00")
  assert.strictEqual(hourly[5].date, "2026-10-02")
  assert.strictEqual(hourly[5].weekday, "Fri")
  assert.strictEqual(hourly[5].isMidnight, true)
})

test("the next-hours sums count only hours still ahead and skip dropped readings", () => {
  const rain = parsedWith(data => {
    data.hourly.precipitation[23] = 9.9   // 18:00, already past
    data.hourly.precipitation[24] = 9.9   // 19:00, the current hour
    data.hourly.precipitation[25] = 1.0   // 20:00, the first future hour
    data.hourly.precipitation[26] = 0.5   // 21:00
    data.hourly.precipitation[27] = null  // 22:00, dropped by the provider
    data.hourly.precipitation[28] = 0.4   // 23:00
    data.hourly.precipitation[37] = 0.6   // the twelfth counted future hour
    data.hourly.precipitation[40] = 0.3   // past the twelfth, inside the 24th
  }).rain
  // The dropped reading does not consume one of the twelve: with it
  // skipped, the twelfth counted hour is 08:00 tomorrow and its 0.6 mm
  // belongs to both totals, while the 0.3 mm at 11:00 falls past the
  // twelfth and inside the twenty-fourth. The 9.9 mm sitting on past and
  // current hours reaches neither.
  assert.strictEqual(rain.next12Mm, 2.5)
  assert.strictEqual(rain.next24Mm, 2.8)
})

test("nextStart is the first future hour that reaches a tenth of a millimetre", () => {
  const rain = parsedWith(data => {
    data.hourly.precipitation[25] = 0.05  // the first future hour, too little
    data.hourly.precipitation[26] = null  // dropped, so never a candidate
    data.hourly.precipitation[27] = 0.14  // the first to reach 0.1
  }).rain
  assert.deepStrictEqual(rain.nextStart, {
    time: "2026-10-01T22:00",
    label: "22:00",
    weekday: "Thu",
    dayOffset: 0,
    mm: 0.1
  })
})

test("nextStart past midnight reads dayOffset 1 and the second day's weekday", () => {
  const rain = parsedWith(data => {
    // Nothing between now and midnight reaches the threshold.
    data.hourly.precipitation[29] = 0.7
  }).rain
  assert.deepStrictEqual(rain.nextStart, {
    time: "2026-10-02T00:00",
    label: "00:00",
    weekday: "Fri",
    dayOffset: 1,
    mm: 0.7
  })
})

test("nextStart stays null while no future hour reaches a tenth", () => {
  const rain = parsed().rain
  assert.strictEqual(rain.nextStart, null)
  assert.strictEqual(rain.next12Mm, 0)
  assert.strictEqual(rain.next24Mm, 0)
})

test("today so far off the hour adds the current 15-minute reading", () => {
  const rain = parsedWith(data => {
    data.current.time = "2026-10-01T19:30"
    data.current.precipitation = 0.4
    // The row at 19:00 covered 18:00-19:00 and is complete; the row at
    // 20:00 is a forecast of rain that has not fallen.
    data.hourly.precipitation[24] = 0.6
    data.hourly.precipitation[25] = 5.0
  }).rain
  // Nineteen complete rows (00:00-18:00 at 0.2), the completed 19:00 row,
  // and the 15 minutes since — but not the 5.0 mm forecast for 20:00.
  assert.strictEqual(rain.todayMm, 4.8)
})

test("today so far exactly on the hour does not add the current reading", () => {
  const rain = parsedWith(data => {
    data.current.precipitation = 0.4
    data.hourly.precipitation[24] = 0.6
  }).rain
  // The complete rows alone: at :00 the 15-minute window sits inside the
  // hourly row valid at 19:00, which the sum already counts.
  assert.strictEqual(rain.todayMm, 4.4)
})

test("the hourly history holds the last 24 completed hours, oldest first", () => {
  const rain = parsed().rain
  assert.strictEqual(rain.hours.length, 24)
  // The row valid at current.time covers the hour that just ended and is
  // complete; the extra row it contributes is exactly what the cap drops, so
  // the oldest kept hour is 09-30T20:00, not 09-30T19:00.
  assert.strictEqual(rain.hours[0].time, "2026-09-30T20:00")
  assert.strictEqual(rain.hours[0].hour, "20")
  assert.strictEqual(rain.hours[23].time, "2026-10-01T19:00")
  assert.strictEqual(rain.hours[23].hour, "19")
  // Nineteen complete hours of 0.2 mm today, nothing on the hours before
  // midnight.
  assert.strictEqual(rain.last24Mm, 3.8)
  assert.strictEqual(rain.maxHourMm, 0.2)
})

test("the hourly history never includes an hour still under way", () => {
  const rain = parsedWith(data => {
    data.hourly.precipitation[25] = 9.9   // 20:00, a forecast that has not fallen
  }).rain
  for (const entry of rain.hours) {
    assert.ok(entry.time <= "2026-10-01T19:00", entry.time)
  }
  assert.strictEqual(rain.hours[rain.hours.length - 1].mm, 0)
})

test("a dropped hourly reading stays null rather than reading as zero", () => {
  const rain = parsedWith(data => {
    data.hourly.precipitation[24] = null  // the completed 19:00 row
  }).rain
  assert.strictEqual(rain.hours[rain.hours.length - 1].mm, null)
  // The dropped row adds nothing; it is not counted as 0 or as any other
  // invented figure.
  assert.strictEqual(rain.last24Mm, 3.8)
})

// ------------------------------------------------- observed rainfall merge

// The Bureau's observed days correct the model's where it has them. The record
// below is the fixture's rain: seven days ending today (2026-10-01), with the
// modelled millimetres the test above pins.

test("with no observation the modelled rain is returned untouched", () => {
  const rain = parsed().rain
  assert.strictEqual(Weather.mergeObservedRain(rain, null), rain)
  // A map with nothing in it and no live reading is the same non-answer.
  assert.strictEqual(Weather.mergeObservedRain(rain, { days: {}, today: null }), rain)
})

test("observed days replace the modelled figure and are flagged", () => {
  const rain = parsed().rain
  const merged = Weather.mergeObservedRain(rain, {
    days: { "2026-09-25": 2.5, "2026-09-28": 0.2 },
    today: 4.4
  })

  assert.strictEqual(merged.days[0].date, "2026-09-25")
  assert.strictEqual(merged.days[0].mm, 2.5)
  assert.strictEqual(merged.days[0].observed, true)
  // An observed day that happens not to be today is not today.
  assert.strictEqual(merged.days[0].isToday, false)

  assert.strictEqual(merged.days[3].date, "2026-09-28")
  assert.strictEqual(merged.days[3].mm, 0.2)
  assert.strictEqual(merged.days[3].observed, true)

  // A day the Bureau did not report keeps the modelled value, flagged false.
  assert.strictEqual(merged.days[1].date, "2026-09-26")
  assert.strictEqual(merged.days[1].mm, 0)
  assert.strictEqual(merged.days[1].observed, false)

  // Today's DWO row is not among the observed days here, so the live "since
  // 9am" reading stands in for it.
  assert.strictEqual(merged.days[6].isToday, true)
  assert.strictEqual(merged.days[6].mm, 4.4)
  assert.strictEqual(merged.todayMm, 4.4)
  assert.strictEqual(merged.todayObserved, true)

  // The two totals are recomputed over the merged days: 2.5+0+0.4+0.2+0+2.0+4.4.
  assert.strictEqual(merged.last7Mm, 9.5)
  assert.strictEqual(merged.maxMm, 4.4)
  // The record carries observed days, so the tab can caption it as BOM's.
  assert.strictEqual(merged.observed, true)

  // The lookahead and hourly history are about a different window and pass
  // through unchanged.
  assert.strictEqual(merged.next12Mm, rain.next12Mm)
  assert.strictEqual(merged.next24Mm, rain.next24Mm)
  assert.strictEqual(merged.hours, rain.hours)
  assert.strictEqual(merged.last24Mm, rain.last24Mm)
})

test("today takes the Bureau's daily row once it is filed, not the live reading", () => {
  const rain = parsed().rain
  // The DWO row for the day ending 9am today is 5.0; the live reading since
  // 9am is 0.0. The Bureau's published daily total is the figure its history
  // carries, so it is what the chart's last bar and the totals must use — the
  // live reading is a different window and only stands in before the row exists.
  const merged = Weather.mergeObservedRain(rain, {
    days: { "2026-10-01": 5.0 },
    today: 0
  })
  assert.strictEqual(merged.days[6].date, "2026-10-01")
  assert.strictEqual(merged.days[6].isToday, true)
  assert.strictEqual(merged.days[6].mm, 5.0)
  assert.strictEqual(merged.days[6].observed, true)
  assert.strictEqual(merged.todayMm, 5.0)
  assert.strictEqual(merged.todayObserved, true)
  // last7 is the modelled 10.5 with today's 3.8 replaced by the observed 5.0.
  assert.strictEqual(merged.last7Mm, 11.7)
  assert.strictEqual(merged.maxMm, 5.0)
})

test("a missing live reading leaves today modelled and unobserved", () => {
  const rain = parsed().rain
  const merged = Weather.mergeObservedRain(rain, {
    days: { "2026-09-25": 2.5 },
    today: null
  })
  assert.strictEqual(merged.todayMm, 3.8)
  assert.strictEqual(merged.todayObserved, false)
  assert.strictEqual(merged.days[6].mm, 3.8)
  assert.strictEqual(merged.days[6].observed, false)
})

test("a blank observed day does not override the modelled figure", () => {
  const rain = parsed().rain
  const merged = Weather.mergeObservedRain(rain, {
    days: { "2026-09-26": null },
    today: null
  })
  assert.strictEqual(merged.days[1].date, "2026-09-26")
  assert.strictEqual(merged.days[1].mm, 0)
  assert.strictEqual(merged.days[1].observed, false)
})

test("mergeObservedRain tolerates a missing record", () => {
  assert.strictEqual(Weather.mergeObservedRain(null, { days: { "2026-09-25": 1 } }), null)
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

// Resolved by glyph name against the Nerd Fonts registry, the way
// test/glyphs.test.js pins its icons: Nerd Fonts renumbered its ranges
// between major versions, and the font holds a glyph at every position, so a
// coverage check confirms nothing while a codepoint remembered from a cheat
// sheet very often draws something else. The day and night forms are
// different glyphs, which is exactly the pair an off-by-one swap used to
// reverse.
const WEATHER_ICONS = {
  ICON_SUN: [0xE30D, "weather-day_sunny"],
  ICON_MOON: [0xE32B, "weather-night_clear"],
  ICON_PARTLY_DAY: [0xE302, "weather-day_cloudy"],
  ICON_PARTLY_NIGHT: [0xE32E, "weather-night_cloudy"],
  ICON_CLOUD: [0xE33D, "weather-cloud"],
  ICON_CLOUD_NIGHT: [0xE37E, "weather-night_alt_cloudy"],
  ICON_FOG_DAY: [0xE313, "weather-fog"],
  ICON_FOG_NIGHT: [0xE346, "weather-night_fog"],
  ICON_SHOWERS_DAY: [0xE308, "weather-day_rain"],
  ICON_SHOWERS_NIGHT: [0xE333, "weather-night_rain"],
  ICON_SLEET_DAY: [0xE30A, "weather-day_snow"],
  ICON_SLEET_NIGHT: [0xE327, "weather-night_alt_snow"],
  ICON_SLEET: [0xE3AD, "weather-sleet"],
  ICON_THUNDER: [0xE31D, "weather-thunderstorm"],
  ICON_RAIN: [0xE318, "weather-rain"],
  ICON_SNOW: [0xE31A, "weather-snow"]
}

test("every weather icon is exactly one codepoint", () => {
  // A `\u` escape consumes exactly four hex digits, so writing any of these
  // that way yields a different glyph followed by a stray digit. Nothing
  // reports it; the icon is simply wrong.
  for (const name of Object.keys(WEATHER_ICONS)) {
    assert.strictEqual(Array.from(Weather[name]).length, 1, name)
  }
})

test("every weather icon is the codepoint the registry gives for its name", () => {
  for (const [name, [codepoint, glyphName]] of Object.entries(WEATHER_ICONS)) {
    assert.strictEqual(Weather[name].codePointAt(0), codepoint,
      `${name} should be ${glyphName} at U+${codepoint.toString(16).toUpperCase()}`)
  }
})

test("codes pick the day or night glyph the tab draws for them", () => {
  assert.strictEqual(Weather.iconForCode(0, false), Weather.ICON_SUN)
  assert.strictEqual(Weather.iconForCode(0, true), Weather.ICON_MOON)
  assert.strictEqual(Weather.iconForCode(1, false), Weather.ICON_PARTLY_DAY)
  assert.strictEqual(Weather.iconForCode(2, true), Weather.ICON_PARTLY_NIGHT)
  assert.strictEqual(Weather.iconForCode(3, false), Weather.ICON_CLOUD)
  assert.strictEqual(Weather.iconForCode(3, true), Weather.ICON_CLOUD_NIGHT)
  assert.strictEqual(Weather.iconForCode(95, false), Weather.ICON_THUNDER)
  assert.strictEqual(Weather.iconForCode(71, false), Weather.ICON_SNOW)
  assert.strictEqual(Weather.iconForCode(61, false), Weather.ICON_RAIN)
})

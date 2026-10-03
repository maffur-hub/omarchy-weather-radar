// The point forecast and rainfall history behind the Weather tab: one
// location asked of Open-Meteo, parsed into everything the tab draws — the
// current reading, the hourly strip, the seven-day outlook, the week of
// rain behind it and the lookahead ahead of it (next12Mm and next24Mm over
// the hours still to come, nextStart for the first of them worth drawing).
// Everything here is a pure function over plain values, so the networking
// and the QML stay thin, and the parts that are easy to get subtly wrong —
// a strip that opens on an hour already past, "rain so far today" taken
// from a full-day figure the model wrote at dawn — are pinned by
// test/weather.test.js.
//
// One point, not the five samplePoints() spreads around a town. Those answer
// "could an alert fire here": a town is wider than the model's 8-10 km cell,
// so the samples exist to see where a stored coordinate lands inside it.
// This tab answers "what will it do here", and an average of five cells
// would be a reading for a place nobody lives in.
//
// The window is past_days=7 with past_hours=24 behind current.time, and
// forecast_days=7 with forecast_hours=48 in front of it. The past days are
// the daily rows the rain chart walks back over. The past hours are what
// makes "today so far" measurable: precipitation_sum for today is a
// full-day figure forecast at midnight, counting rain that has not fallen,
// while the hourly series up to current.time is the day as it actually
// went. The two overlap; asking for both costs a few kilobytes.
//
// Precipitation arrives in two shapes that answer different questions and
// must never be added blindly. An hourly row is the sum of the hour before
// it — the row at 19:00 covers 18:00-19:00 and is complete at 19:00 — so
// summing today's rows whose hour has arrived never overcounts. The current
// reading is the model's present 15-minute figure: it belongs in "today so
// far" at any minute past the hour, but exactly at :00 that window sits
// inside the hourly row the clock just completed, and adding it would count
// the same rain twice.
//
// Units are pinned rather than left to whatever the server's locale answers
// — celsius, mm, km/h — because a rainfall bar labelled in millimetres that
// was handed inches is wrong in a way no number in the chart reveals.
//
// API reference: https://open-meteo.com/en/docs

.pragma library

.import "RadarModel.js" as RadarModel

// ---------------------------------------------------------------------------
// Endpoint and window
// ---------------------------------------------------------------------------

// The same host the rest of the plugin forecasts from, so one provider
// answers the map, the alerts and this tab — a second provider would put
// two forecasts of the same afternoon on one screen.
var WEATHER_URL = "https://api.open-meteo.com/v1/forecast"

// Every response is collected whole into the process that owns the bar and
// the panels, so the request carries a ceiling on bytes as well as on time.
// Measured against the real endpoint at the widest window this tab asks
// for, the answer is roughly 4-10 KB; the ceiling leaves room for the
// window to grow and for a day with more weather in it than most.
var WEATHER_MAX_BYTES = 262144
var WEATHER_TIMEOUT_SEC = 20

// The window: a week of daily rows behind and ahead for the rain chart and
// the outlook, a day of hours behind current.time so "today so far" is
// observed rather than forecast, and two days of hours in front for the
// strip.
var PAST_DAYS = 7
var FORECAST_DAYS = 7
var PAST_HOURS = 24
var FORECAST_HOURS = 48

// The cadence the tab asks again on. Open-Meteo rebuilds its model every
// few hours; asking more often only re-fetches the same forecast, so the
// number lives here beside the window it re-asks for rather than at the
// timer's call site, where the request and the interval that repeats it
// could drift apart.
var WEATHER_REFRESH_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// One URL for one coordinate. parseFloat rather than Number because an unset
// location carries null and Number(null) is 0 — a guard built on it would
// admit the exact case it exists to reject and ask the API for a forecast
// off the coast of west Africa. parseFloat(null) and parseFloat("abc") are
// both NaN, which is what is meant. Anything else gets no request at all
// rather than one that cannot be answered.
function weatherUrl(latitude, longitude) {
  var lat = parseFloat(latitude)
  var lon = parseFloat(longitude)
  if (!isFinite(lat) || !isFinite(lon)) return ""

  return WEATHER_URL
    + "?latitude=" + lat.toFixed(4)
    + "&longitude=" + lon.toFixed(4)
    + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day"
    // Humidity and wind come off `current` above: the strip draws neither,
    // so hourly copies of them would widen the payload for rows nobody reads.
    + "&hourly=temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,is_day"
    // precipitation_sum leads the daily list because the rainfall chart is
    // what most of these rows exist for.
    + "&daily=precipitation_sum,weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset,uv_index_max"
    + "&timezone=auto"
    + "&past_days=" + PAST_DAYS + "&past_hours=" + PAST_HOURS
    + "&forecast_days=" + FORECAST_DAYS + "&forecast_hours=" + FORECAST_HOURS
    + "&temperature_unit=celsius&precipitation_unit=mm&wind_speed_unit=kmh"
}

// The one place the weather request is built, so no call site can leave a
// ceiling off — the same contract fetchCommand gives every other stream
// this plugin collects whole into the shell.
function weatherCommand(latitude, longitude) {
  var url = weatherUrl(latitude, longitude)
  if (url === "") return []
  return RadarModel.fetchCommand(url, WEATHER_TIMEOUT_SEC, WEATHER_MAX_BYTES)
}

// Where the tab's reading is kept between reloads, or "" when there is
// nowhere to keep it — the same guard latchFilePath holds to. An unset home
// reads as null, and "null/.local/..." would be a path relative to wherever
// the shell was started, where writing it would create a directory named
// "null". With no file the tab simply starts with nothing to show.
function weatherCachePath(home) {
  if (typeof home !== "string" || home.charAt(0) !== "/" || /[\x00-\x1f]/.test(home)) return ""
  return home.replace(/\/+$/, "") + "/.local/state/omarchy/weather-radar-weather.json"
}

// ---------------------------------------------------------------------------
// WMO weather codes
// ---------------------------------------------------------------------------

// The code list Open-Meteo reports (the WMO 4677 table), in the words a
// person would use. Anything outside it — a code added upstream, a
// malformed answer — reads as "Unknown" rather than as a guess.
var WMO_DESCRIPTIONS = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail"
}

function describeCode(code) {
  // A code the provider dropped is null, and Number(null) is 0 — which
  // would render a missing reading as a clear sky.
  if (code === null || code === undefined || code === "") return "Unknown"
  var n = Number(code)
  if (!isFinite(n)) return "Unknown"
  var text = WMO_DESCRIPTIONS[n]
  return text === undefined ? "Unknown" : text
}

// ---------------------------------------------------------------------------
// Weather glyphs
// ---------------------------------------------------------------------------

// Nerd Font "Weather Icons" codepoints, verified against the fonts Omarchy
// ships — the stock omarchy.weather panel draws these same ones. Built from
// codepoints rather than `\u` escapes like Glyphs.js: a `\u` escape consumes
// exactly four hex digits, so any of these written that way yields a
// different glyph followed by a stray digit, with nothing to report it.
var ICON_SUN = String.fromCodePoint(0xE32B)             // clear, day
var ICON_MOON = String.fromCodePoint(0xE30D)            // clear, night
var ICON_PARTLY_DAY = String.fromCodePoint(0xE32E)
var ICON_PARTLY_NIGHT = String.fromCodePoint(0xE302)
var ICON_CLOUD = String.fromCodePoint(0xE33D)
var ICON_FOG_DAY = String.fromCodePoint(0xE313)
var ICON_FOG_NIGHT = String.fromCodePoint(0xE346)
var ICON_SHOWERS_DAY = String.fromCodePoint(0xE308)
var ICON_SHOWERS_NIGHT = String.fromCodePoint(0xE333)
var ICON_SLEET_DAY = String.fromCodePoint(0xE30A)
var ICON_SLEET_NIGHT = String.fromCodePoint(0xE327)
var ICON_SLEET = String.fromCodePoint(0xE3AD)
var ICON_THUNDER = String.fromCodePoint(0xE31D)
var ICON_RAIN = String.fromCodePoint(0xE318)
var ICON_SNOW = String.fromCodePoint(0xE31A)

// The glyph a code draws. `night` picks the night variant where the two
// differ; a code nobody maps falls back to the plain cloud, which is what
// an unrecognised sky most often is on the way to being recognised.
function iconForCode(code, night) {
  if (code === null || code === undefined || code === "") return ICON_CLOUD
  var n = Number(code)
  if (!isFinite(n)) return ICON_CLOUD
  if (n === 0) return night ? ICON_MOON : ICON_SUN
  if (n === 1 || n === 2) return night ? ICON_PARTLY_NIGHT : ICON_PARTLY_DAY
  if (n === 3) return ICON_CLOUD
  if (n === 45 || n === 48) return night ? ICON_FOG_NIGHT : ICON_FOG_DAY
  if (n === 51 || n === 53 || n === 55 || n === 61 || n === 63 || n === 65
      || n === 80 || n === 81 || n === 82) return ICON_RAIN
  if (n === 56 || n === 57 || n === 66 || n === 67) return ICON_SLEET
  if (n === 71 || n === 73 || n === 75 || n === 77 || n === 85 || n === 86) return ICON_SNOW
  if (n === 95 || n === 96 || n === 99) return ICON_THUNDER
  return ICON_CLOUD
}

// ---------------------------------------------------------------------------
// Wind
// ---------------------------------------------------------------------------

// The sixteen-point compass, the way a wind is spoken about rather than the
// way it is plotted.
var COMPASS_16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]

function windDirectionLabel(degrees) {
  // parseFloat rather than Number for the same reason weatherUrl uses it:
  // a missing direction arrives as null, and Number(null) is 0 — which
  // would label calm air as a northerly.
  var deg = parseFloat(degrees)
  if (!isFinite(deg)) return ""
  var sector = Math.round(deg / 22.5) % 16
  if (sector < 0) sector += 16
  return COMPASS_16[sector]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// One decimal is what a millimetre of rain is worth on the chart; carrying
// the float past it lets 3.8000000000000003 disagree with the bar it drew.
function round1(value) {
  return Math.round(value * 10) / 10
}

// A reading a provider dropped is null in its JSON. Anything else arrives
// as a number or a numeric string; everything else reads as absent rather
// than as zero, since a missing temperature and a temperature of zero are
// different answers.
function numberValue(value) {
  if (value === null || value === undefined || value === "") return null
  var n = Number(value)
  return isFinite(n) ? n : null
}

function stringValue(value) {
  if (value === null || value === undefined) return ""
  return String(value)
}

function valueAt(list, index) {
  if (!Array.isArray(list) || index >= list.length) return undefined
  return list[index]
}

function numberAt(list, index) {
  return numberValue(valueAt(list, index))
}

function stringAt(list, index) {
  return stringValue(valueAt(list, index))
}

// A daily row names a date the Date constructor accepts, or it names
// nothing: an unparseable one would put a NaN weekday and a label that
// reads as garbage on the chart.
function weekdayOf(date) {
  var parsed = new Date(date + "T12:00:00")
  if (isNaN(parsed.getTime())) return ""
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parsed.getDay()]
}

// Open-Meteo's answer, in the shape the Weather tab draws.
//
// `raw` is the JSON text curl collected. Returns null on anything unusable
// so the caller keeps the previous state rather than blanking the tab on
// one bad response, and never throws on what a provider may have dropped.
function parseWeather(raw) {
  var text = String(raw || "")
  if (text.trim() === "") return null

  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!data || typeof data !== "object") return null

  var current = data.current
  if (!current || typeof current !== "object") return null
  var temperature = numberValue(current.temperature_2m)
  if (temperature === null) return null
  var daily = data.daily
  if (!daily || !Array.isArray(daily.time)) return null
  var hourList = (data.hourly && Array.isArray(data.hourly.time)) ? data.hourly : null

  // "Today" is the date of the newest reading, not this machine's clock:
  // the two disagree whenever the stored location is in another zone.
  var updatedAt = stringValue(current.time)
  var today = updatedAt.substring(0, 10)

  var weatherCode = numberValue(current.weather_code)
  var now = {
    time: updatedAt,
    temperature: temperature,
    apparentTemperature: numberValue(current.apparent_temperature),
    humidity: numberValue(current.relative_humidity_2m),
    precipitation: numberValue(current.precipitation),
    weatherCode: weatherCode,
    description: describeCode(weatherCode),
    windSpeed: numberValue(current.wind_speed_10m),
    windDirection: numberValue(current.wind_direction_10m),
    windGust: numberValue(current.wind_gusts_10m),
    isDay: Number(current.is_day) !== 0
  }

  // The strip opens on the current hour and runs the next two days. Hours
  // already past are left out rather than drawn as if they were still
  // ahead, and the comparison is safe because both sides are ISO strings
  // of the same shape.
  var hourly = []
  if (hourList) {
    for (var i = 0; i < hourList.time.length && hourly.length < FORECAST_HOURS; i++) {
      var time = stringAt(hourList.time, i)
      if (time === "" || time < updatedAt) continue
      var hourDate = time.substring(0, 10)
      var hourCode = numberAt(hourList.weather_code, i)
      hourly.push({
        time: time,
        date: hourDate,
        weekday: weekdayOf(hourDate),
        isMidnight: time.substring(11, 16) === "00:00",
        label: time.substring(11, 13),
        temperature: numberAt(hourList.temperature_2m, i),
        apparentTemperature: numberAt(hourList.apparent_temperature, i),
        precipitation: numberAt(hourList.precipitation, i),
        precipitationProbability: numberAt(hourList.precipitation_probability, i),
        weatherCode: hourCode,
        description: describeCode(hourCode),
        isDay: Number(valueAt(hourList.is_day, i)) !== 0
      })
    }
  }

  // The outlook: every daily row from today forward, seven of them, so the
  // tab never draws a day that is already behind it.
  var forecast = []
  for (var j = 0; j < daily.time.length && forecast.length < FORECAST_DAYS; j++) {
    var date = stringAt(daily.time, j)
    if (date === "" || date < today) continue
    var weekday = weekdayOf(date)
    if (weekday === "") continue
    var code = numberAt(daily.weather_code, j)
    forecast.push({
      date: date,
      label: date === today ? "Today" : weekday,
      weekday: weekday,
      weatherCode: code,
      description: describeCode(code),
      tempMax: numberAt(daily.temperature_2m_max, j),
      tempMin: numberAt(daily.temperature_2m_min, j),
      precipitationSum: numberAt(daily.precipitation_sum, j),
      precipitationProbability: numberAt(daily.precipitation_probability_max, j),
      windMax: numberAt(daily.wind_speed_10m_max, j),
      gustMax: numberAt(daily.wind_gusts_10m_max, j),
      sunrise: stringAt(daily.sunrise, j),
      sunset: stringAt(daily.sunset, j),
      uvMax: numberAt(daily.uv_index_max, j),
      isToday: date === today
    })
  }

  // Today's rain so far, summed from the two shapes Open-Meteo mixes.
  //
  // An hourly row is the preceding hour's total and is complete when its
  // own hour ticks over, so today's rows whose hour has arrived are added
  // and the row for the hour still under way — a forecast of rain that has
  // not fallen — is not. The daily precipitation_sum for today is a
  // full-day figure forecast at midnight, so it is used only when the
  // hourly series carries no row for today at all.
  var currentHourKey = updatedAt.substring(0, 13)
  var todayIndex = -1
  for (var d = 0; d < daily.time.length; d++) {
    if (stringAt(daily.time, d) === today) {
      todayIndex = d
      break
    }
  }

  var todayMm = 0
  var todayRows = 0
  var todaySum = 0
  if (hourList) {
    for (var h = 0; h < hourList.time.length; h++) {
      var hourTime = stringAt(hourList.time, h)
      if (hourTime.substring(0, 10) !== today) continue
      todayRows++
      // Compared at hour granularity: the row valid at the current hour
      // covers the hour that just ended and is complete, the row for the
      // hour under way is not. Summing rows whose hour has arrived never
      // overcounts, because each is a preceding-hour sum.
      if (hourTime.substring(0, 13) > currentHourKey) continue
      var fell = numberAt(hourList.precipitation, h)
      if (fell !== null) todaySum += fell
    }
  }
  if (todayRows > 0) {
    // The current reading is the model's 15-minute figure, and it joins the
    // total only when the clock is off the hour: at exactly :00 that window
    // sits inside the hourly row the clock just completed and is already
    // counted, so adding it would count the same rain twice. At any other
    // minute the 15 minutes have fallen after the last complete row and
    // cannot overlap it. A dropped reading adds nothing.
    if (updatedAt.substring(14, 16) !== "00"
        && now.precipitation !== null && isFinite(now.precipitation)) {
      todaySum += now.precipitation
    }
    todayMm = round1(todaySum)
  } else if (todayIndex >= 0) {
    var fallback = numberAt(daily.precipitation_sum, todayIndex)
    todayMm = round1(fallback === null ? 0 : fallback)
  }

  // The lookahead: rain still ahead of the current hour. The rows are
  // preceding-hour sums, so the hour under way already sits inside "today
  // so far" and counting it here would put the same millimetres on both
  // sides of the tab. A reading the provider dropped is skipped rather than
  // read as zero, and it does not consume one of the twelve or twenty-four.
  var next12 = 0
  var next24 = 0
  var aheadCount = 0
  var nextStart = null
  for (var n = 0; n < hourly.length; n++) {
    var ahead = hourly[n]
    if (ahead.time.substring(0, 13) <= currentHourKey) continue
    if (ahead.precipitation === null) continue
    if (aheadCount < 12) next12 += ahead.precipitation
    if (aheadCount < 24) next24 += ahead.precipitation
    aheadCount++
    // The first future hour worth naming: a tenth of a millimetre, the
    // smallest figure this tab treats as rain rather than as trace.
    if (nextStart === null && ahead.precipitation >= 0.1) {
      nextStart = {
        time: ahead.time,
        label: ahead.time.substring(11, 16),
        weekday: ahead.weekday,
        // 0 while the hour is still today, 1 for any hour after it — the
        // window is at most two days, so today-versus-later is all the
        // tab has anywhere to put it.
        dayOffset: ahead.date === today ? 0 : 1,
        mm: round1(ahead.precipitation)
      }
    }
  }

  // The chart's seven bars: the days ending today, walked back from it.
  // When today is not among the daily rows at all, the newest seven the
  // provider gave are drawn rather than nothing.
  var rainStart = 0
  var rainEnd = -1
  if (todayIndex >= 0) {
    rainStart = Math.max(0, todayIndex - (PAST_DAYS - 1))
    rainEnd = todayIndex
  } else {
    rainEnd = daily.time.length - 1
    rainStart = Math.max(0, rainEnd - (PAST_DAYS - 1))
  }

  var rainDays = []
  var last7 = 0
  var maxMm = 0
  for (var r = rainStart; r <= rainEnd; r++) {
    var day = stringAt(daily.time, r)
    if (day === "") continue
    var dayWeekday = weekdayOf(day)
    if (dayWeekday === "") continue
    var isToday = day === today
    var mm
    if (isToday) {
      mm = todayMm
    } else {
      var dayRain = numberAt(daily.precipitation_sum, r)
      mm = round1(dayRain === null ? 0 : dayRain)
    }
    rainDays.push({
      date: day,
      label: isToday ? "Today" : dayWeekday,
      weekday: dayWeekday,
      mm: mm,
      isToday: isToday
    })
    last7 += mm
    if (mm > maxMm) maxMm = mm
  }

  // The last day of completed hours, oldest first, for the history the tab
  // unfolds below the daily chart. A row is history once its own hour has
  // arrived: the row valid at currentHourKey covers the hour that just ended
  // and is complete, which is why the filter is at or before it. PAST_HOURS of
  // them are kept, and the row the current hour adds on top is why the cap is
  // load-bearing rather than incidental. A reading the provider dropped stays
  // null, so the chart can draw a gap rather than a measurement of zero.
  var history = []
  if (hourList) {
    for (var p = 0; p < hourList.time.length; p++) {
      var pastTime = stringAt(hourList.time, p)
      if (pastTime === "" || pastTime.substring(0, 13) > currentHourKey) continue
      var pastMm = numberAt(hourList.precipitation, p)
      history.push({
        time: pastTime,
        hour: pastTime.substring(11, 13),
        weekday: weekdayOf(pastTime.substring(0, 10)),
        isMidnight: pastTime.substring(11, 16) === "00:00",
        mm: pastMm === null ? null : round1(pastMm)
      })
    }
  }
  if (history.length > PAST_HOURS) history = history.slice(history.length - PAST_HOURS)

  var maxHourMm = 0
  var last24 = 0
  for (var q = 0; q < history.length; q++) {
    if (history[q].mm === null) continue
    last24 += history[q].mm
    if (history[q].mm > maxHourMm) maxHourMm = history[q].mm
  }

  return {
    timezone: stringValue(data.timezone),
    timezoneAbbreviation: stringValue(data.timezone_abbreviation),
    updatedAt: updatedAt,
    current: now,
    hourly: hourly,
    forecast: forecast,
    rain: {
      days: rainDays,
      todayMm: todayMm,
      last7Mm: round1(last7),
      maxMm: maxMm,
      next12Mm: round1(next12),
      next24Mm: round1(next24),
      nextStart: nextStart,
      hours: history,
      maxHourMm: round1(maxHourMm),
      last24Mm: round1(last24)
    }
  }
}

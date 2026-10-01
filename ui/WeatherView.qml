import QtQuick
import qs.Commons
import qs.Ui
import "../lib/Weather.js" as Weather

// The Weather tab: what it is doing outside now with the sun's hours and
// today's UV beneath it, the rainfall record the chart is drawn from with
// what is due next, the next 48 hours with the day boundaries marked, and
// the seven-day outlook. One request to Open-Meteo — the same service the
// overlays and the alert forecast already use — in the units the rest of the
// plugin asks in: degrees Celsius, millimetres, kilometres per hour.
//
// The service owns the fetch and hands over what it parsed; this draws that,
// and says only what it has. Every read of `weather` goes through `hasData`,
// a reading the service left out is omitted rather than printed as "null",
// and an error is never laid over a forecast already on screen — that stale
// answer still describes the place better than no answer at all.
Column {
  id: root

  property var weather: null
  property string locationName: ""
  property bool loading: false
  property bool failed: false
  property color foreground: "#ffffff"
  property color accent: "#7aa2f7"

  spacing: Style.space(8)

  readonly property bool hasData: weather !== null
  readonly property var current: hasData ? weather.current : null
  readonly property var today: (hasData && weather.forecast && weather.forecast.length > 0)
    ? weather.forecast[0] : null
  readonly property var rain: (hasData && weather.rain) ? weather.rain : null
  readonly property var hourly: (hasData && weather.hourly) ? weather.hourly : []
  readonly property var days: (hasData && weather.forecast) ? weather.forecast : []

  // JSON's null is not a number, and JavaScript's isFinite() cannot tell the
  // two apart — it reads null as 0 — so a reading has to be tested for being
  // one before anything rounds and prints it. Without that test an absent
  // temperature shows as 0°, which is a reading the service never took.
  function reading(value) { return typeof value === "number" && isFinite(value) }

  // One decimal, or nothing at all: the record is the point of the section,
  // and an invented 0.0 would be a measurement nobody made.
  function mmOf(value) { return reading(value) ? value.toFixed(1) + " mm" : "" }

  // A daily sun event arrives as a whole ISO instant in the location's own
  // zone — "2026-10-01T06:12". The date belongs to the row it was read from
  // and the place to the name above it, so only the clock is wanted here, and
  // anything that is not an instant at all reads as absent rather than being
  // printed as a time.
  function clockOf(stamp) {
    var text = String(stamp || "")
    var marker = text.indexOf("T")
    return marker >= 0 ? text.substring(marker + 1) : ""
  }

  function dayRange(day) {
    if (!day) return ""
    var high = reading(day.tempMax) ? Math.round(day.tempMax) + "°" : ""
    var low = reading(day.tempMin) ? Math.round(day.tempMin) + "°" : ""
    if (high !== "" && low !== "") return high + "/" + low
    return high !== "" ? high : low
  }

  // The service stamps its answer in the location's own time, as a whole ISO
  // minute — "2026-10-01T19:00". What the header wants is the moment; the
  // date is already implied by the forecast under it, and the place by the
  // name beside it.
  readonly property string updatedClock: {
    if (!hasData || !weather.updatedAt) return ""
    var stamp = String(weather.updatedAt)
    var marker = stamp.indexOf("T")
    return marker >= 0 ? stamp.substring(marker + 1) : stamp
  }

  // Where this is for and when it was asked. Only ever shown over a forecast
  // — see the placeholder below for the other half.
  readonly property string headerStatus: {
    var bits = []
    if (locationName !== "") bits.push(locationName)
    if (updatedClock !== "") bits.push("updated " + updatedClock)
    return bits.join(" · ")
  }

  // One line of what the weather is actually doing, assembled from the
  // readings that exist. Each is left out when the service had none, so the
  // line shortens rather than growing a gap where a number should be.
  readonly property string conditionsLine: {
    if (!current) return ""
    var bits = []
    if (reading(current.apparentTemperature))
      bits.push("Feels like " + Math.round(current.apparentTemperature) + "°")
    if (reading(current.humidity))
      bits.push(Math.round(current.humidity) + "% humidity")
    if (reading(current.windSpeed)) {
      var wind = Math.round(current.windSpeed) + " km/h"
      var direction = Weather.windDirectionLabel(current.windDirection)
      if (direction !== "") wind += " " + direction
      bits.push(wind)
    }
    if (reading(current.windGust))
      bits.push("gusts " + Math.round(current.windGust) + " km/h")
    if (today) {
      var high = reading(today.tempMax) ? "H " + Math.round(today.tempMax) + "°" : ""
      var low = reading(today.tempMin) ? "L " + Math.round(today.tempMin) + "°" : ""
      if (high !== "" && low !== "") bits.push(high + " / " + low)
      else if (high !== "") bits.push(high)
      else if (low !== "") bits.push(low)
    }
    return bits.join(" · ")
  }

  readonly property string nowDescription: {
    if (!current) return ""
    return current.description ? current.description : Weather.describeCode(current.weatherCode)
  }

  // The sun's own hours and today's UV, from the first forecast row. None of
  // the three is a live reading — they are fixed for the day — which is why
  // they are worth a line of their own rather than being folded into the
  // conditions above, where they would read as measurements taken now. Each is
  // left out when the service had none, so the line shortens rather than
  // growing a gap where a time should be.
  readonly property string sunLine: {
    if (!today) return ""
    var bits = []
    var rise = clockOf(today.sunrise)
    if (rise !== "") bits.push("Sunrise " + rise)
    var set = clockOf(today.sunset)
    if (set !== "") bits.push("Sunset " + set)
    if (reading(today.uvMax)) bits.push("UV " + Math.round(today.uvMax))
    return bits.join(" · ")
  }

  // The rain section's own sentence, over the chart: when the next shower is
  // due, and how much of it the next half-day carries. It is a claim about
  // the day ahead rather than about what has fallen, which is what the two
  // figures beside it are for — so it is read only from the fields that
  // carry it, and a record without them (an older cache, a hand-edited one)
  // says nothing rather than claiming a dry afternoon.
  readonly property string rainSummary: {
    if (!rain || rain.nextStart === undefined) return ""
    var text = rain.nextStart
      ? "Rain from " + rain.nextStart.label
        + (rain.nextStart.dayOffset ? " tomorrow" : "")
      : "No rain expected in the next 24 hours"
    if (rain.next12Mm > 0) text += " · " + mmOf(rain.next12Mm) + " in 12h"
    else if (rain.next24Mm > 0) text += " · " + mmOf(rain.next24Mm) + " in 24h"
    return text
  }

  // Header: the tab, then where this is for and when it was asked — or, with
  // nothing to show, the state instead, in the accent so it reads as a state
  // rather than as a reading. The two never show at once, so the panel has
  // exactly one line about its own condition.
  Row {
    width: parent.width
    spacing: Style.space(8)

    Text {
      id: weatherTitle
      textFormat: Text.PlainText
      text: "WEATHER"
      color: root.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      font.bold: true
      opacity: 0.7
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      visible: root.hasData
      textFormat: Text.PlainText
      width: parent.width - (weatherTitle.width + parent.spacing * 2)
      text: root.headerStatus
      color: root.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
      opacity: 0.85
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      visible: !root.hasData
      textFormat: Text.PlainText
      width: parent.width - (weatherTitle.width + parent.spacing * 2)
      text: root.loading ? "Loading forecast…" : (root.failed ? "Forecast unavailable" : "No forecast")
      color: root.accent
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
      anchors.verticalCenter: parent.verticalCenter
    }
  }

  // What it is doing outside right now: the glyph, the temperature and the
  // description beside it, then the readings that did not fit on the first
  // line. Each is omitted when the service had none.
  Row {
    visible: root.hasData && root.current !== null
    width: parent.width
    spacing: Style.space(12)

    Text {
      id: nowGlyph
      textFormat: Text.PlainText
      text: root.current ? Weather.iconForCode(root.current.weatherCode, !root.current.isDay) : ""
      color: root.foreground
      font.family: Style.font.family
      font.pixelSize: Style.space(34)
      anchors.verticalCenter: parent.verticalCenter
      opacity: 0.95
    }

    Column {
      width: parent.width - (nowGlyph.width + parent.spacing)
      spacing: Style.space(3)

      Row {
        spacing: Style.space(8)

        Text {
          textFormat: Text.PlainText
          text: (root.current && root.reading(root.current.temperature))
            ? Math.round(root.current.temperature) + "°" : ""
          visible: text !== ""
          color: root.foreground
          font.family: Style.font.family
          font.pixelSize: Style.space(34)
          font.bold: true
        }

        Text {
          textFormat: Text.PlainText
          text: root.nowDescription
          visible: text !== ""
          color: root.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          opacity: 0.8
          anchors.verticalCenter: parent.verticalCenter
        }
      }

      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: root.conditionsLine
        visible: text !== ""
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        opacity: 0.7
        elide: Text.ElideRight
      }

      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: root.sunLine
        visible: text !== ""
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        opacity: 0.55
        elide: Text.ElideRight
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Rain
  // ---------------------------------------------------------------------------

  PanelSeparator { width: parent.width; visible: root.hasData }

  PanelSectionHeader {
    visible: root.hasData
    text: "RAIN"
    foreground: root.foreground
    fontFamily: Style.font.family
  }

  // The two figures the bars cannot state on their own: what has fallen today
  // so far, and what the seven of them add up to.
  Row {
    id: rainStats
    visible: root.hasData && root.rain !== null
    width: parent.width
    spacing: Style.space(8)
    readonly property real cellWidth: (width - spacing) / 2

    Column {
      width: rainStats.cellWidth
      spacing: Style.space(2)

      Text {
        textFormat: Text.PlainText
        text: "Today so far"
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        opacity: 0.6
      }

      Text {
        textFormat: Text.PlainText
        text: root.rain ? root.mmOf(root.rain.todayMm) : ""
        visible: text !== ""
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.title
        font.bold: true
      }
    }

    Column {
      width: rainStats.cellWidth
      spacing: Style.space(2)

      Text {
        textFormat: Text.PlainText
        text: "Last 7 days"
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        opacity: 0.6
      }

      Text {
        textFormat: Text.PlainText
        text: root.rain ? root.mmOf(root.rain.last7Mm) : ""
        visible: text !== ""
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.title
        font.bold: true
      }
    }
  }

  Text {
    textFormat: Text.PlainText
    width: parent.width
    text: root.rainSummary
    visible: text !== ""
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    opacity: 0.7
    elide: Text.ElideRight
  }

  RainChart {
    visible: root.hasData && root.rain !== null
    width: parent.width
    height: Style.space(96)
    days: root.rain ? root.rain.days : []
    maxMm: root.rain ? root.rain.maxMm : 0
    barColor: root.foreground
    todayColor: root.accent
    labelColor: Qt.darker(root.foreground, 1.6)
    fontFamily: Style.font.family
    labelSize: Style.font.caption
  }

  Text {
    textFormat: Text.PlainText
    visible: root.hasData && root.rain !== null
    width: parent.width
    text: "Rainfall, last 7 days · Open-Meteo"
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption * 0.8
    opacity: 0.4
  }

  // ---------------------------------------------------------------------------
  // Next 48 hours
  // ---------------------------------------------------------------------------

  PanelSeparator { width: parent.width; visible: root.hasData }

  PanelSectionHeader {
    visible: root.hasData
    text: "NEXT 48 HOURS"
    foreground: root.foreground
    fontFamily: Style.font.family
  }

  // Forty-eight cells at any sensible font will not fit across the panel, so
  // the row scrolls rather than shrinking to something unreadable. Clipped,
  // because a cell half off the edge otherwise draws over the panel beside it.
  Flickable {
    id: hourlyFlick
    visible: root.hasData && root.hourly.length > 0
    width: parent.width
    height: Style.space(78)
    clip: true
    contentWidth: hourlyRow.width
    contentHeight: height
    boundsBehavior: Flickable.StopAtBounds

    Row {
      id: hourlyRow
      height: hourlyFlick.height

      Repeater {
        model: root.hourly

        delegate: Item {
          width: Style.space(38)
          height: hourlyRow.height

          Column {
            width: parent.width
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            // Midnight is where the strip crosses into a new day, and "00:00"
            // does not say which day it is now — the weekday does, in the
            // accent and bold so the boundary is legible at a glance rather
            // than counted out in hours. The cell keeps its width either way,
            // so nothing else in the row shifts under it.
            Text {
              textFormat: Text.PlainText
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              text: modelData.isMidnight
                ? (modelData.weekday || "")
                : (modelData.label ? modelData.label + ":00" : "")
              color: modelData.isMidnight ? root.accent : root.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: modelData.isMidnight === true
              opacity: 0.6
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              text: Weather.iconForCode(modelData.weatherCode, !modelData.isDay)
              color: root.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.display
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              text: root.reading(modelData.temperature)
                ? Math.round(modelData.temperature) + "°" : ""
              visible: text !== ""
              color: root.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            // Only a chance of rain worth seeing: a column of zeroes down the
            // row would say nothing and cost a line of height each.
            Text {
              textFormat: Text.PlainText
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              text: (root.reading(modelData.precipitationProbability)
                && modelData.precipitationProbability > 0)
                ? Math.round(modelData.precipitationProbability) + "%" : ""
              visible: text !== ""
              color: root.accent
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }
        }
      }
    }
  }

  Text {
    textFormat: Text.PlainText
    visible: root.hasData && root.hourly.length === 0
    width: parent.width
    text: "No hourly forecast"
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    opacity: 0.6
  }

  // ---------------------------------------------------------------------------
  // 7-day forecast
  // ---------------------------------------------------------------------------

  PanelSeparator { width: parent.width; visible: root.hasData }

  PanelSectionHeader {
    visible: root.hasData
    text: "7-DAY FORECAST"
    foreground: root.foreground
    fontFamily: Style.font.family
  }

  Column {
    visible: root.hasData && root.days.length > 0
    width: parent.width
    spacing: 0

    Repeater {
      model: root.days

      delegate: Row {
        id: dayRow
        width: parent.width
        height: Style.space(22)
        spacing: Style.space(6)
        opacity: modelData.isToday ? 1 : 0.75

        // Every column but the description is a fixed width, so the days line
        // up under one another however long each description runs — and the
        // ones that would hide keep their width, printing nothing instead.
        // Row skips an invisible item, which would drag every column after it
        // one place left on the days with no rain in them.
        readonly property real fixedWidth: Style.space(54) + Style.space(20)
          + Style.space(34) + Style.space(50) + Style.space(54) + spacing * 5

        Text {
          textFormat: Text.PlainText
          width: Style.space(54)
          anchors.verticalCenter: parent.verticalCenter
          text: modelData.label
          color: root.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          font.bold: modelData.isToday
        }

        Text {
          textFormat: Text.PlainText
          width: Style.space(20)
          anchors.verticalCenter: parent.verticalCenter
          horizontalAlignment: Text.AlignHCenter
          text: Weather.iconForCode(modelData.weatherCode, false)
          color: root.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.iconLarge
        }

        Text {
          textFormat: Text.PlainText
          width: Math.max(Style.space(40), dayRow.width - dayRow.fixedWidth)
          anchors.verticalCenter: parent.verticalCenter
          elide: Text.ElideRight
          text: modelData.description
            ? modelData.description : Weather.describeCode(modelData.weatherCode)
          color: root.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          textFormat: Text.PlainText
          width: Style.space(34)
          anchors.verticalCenter: parent.verticalCenter
          horizontalAlignment: Text.AlignRight
          text: (root.reading(modelData.precipitationProbability)
            && modelData.precipitationProbability > 0)
            ? Math.round(modelData.precipitationProbability) + "%" : ""
          color: root.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          opacity: 0.7
        }

        Text {
          textFormat: Text.PlainText
          width: Style.space(50)
          anchors.verticalCenter: parent.verticalCenter
          horizontalAlignment: Text.AlignRight
          text: root.mmOf(modelData.precipitationSum)
          color: root.accent
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          textFormat: Text.PlainText
          width: Style.space(54)
          anchors.verticalCenter: parent.verticalCenter
          horizontalAlignment: Text.AlignRight
          text: root.dayRange(modelData)
          color: root.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }
      }
    }
  }
}

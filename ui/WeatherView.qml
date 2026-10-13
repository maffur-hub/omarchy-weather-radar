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
  // The service decides day or night from the clock at the location; with no
  // service wired up this stays day, which is what an unlocated reading is.
  property bool night: false
  property bool loading: false
  property bool failed: false
  property color foreground: "#ffffff"
  property color accent: "#7aa2f7"

  // The Bureau's warnings for the districts this location sits in, the Bureau's
  // own daily paragraphs, and when that second answer was fetched. All three
  // arrive from the service; this draws them or leaves them out, and never
  // asks for them itself. The clock is the service's fetch time, not the
  // Open-Meteo one the header already carries, so the two can be told apart.
  property var warnings: []
  property var bomForecast: null
  property string bomUpdated: ""

  // The Bureau's observed rainfall for this location, when the location is one
  // the Bureau answers for. Drawn as its own figure because it measures a
  // different window and a different thing from Open-Meteo's modelled record:
  // what the nearest gauge saw since 9am, not what the model thinks fell since
  // midnight.
  property var bomObservation: null

  // Open-Meteo's rain record corrected by the Bureau's observed days, when the
  // service had an observation to correct with. Preferred over the modelled
  // record wherever both exist, so the two figures and the chart all speak for
  // the same set of days.
  property var observedRain: null

  // The refresh control asks the service to try the Bureau again; the answer
  // arrives back through the properties above.
  signal refreshRequested()

  spacing: Style.space(8)

  readonly property bool hasData: weather !== null
  readonly property var current: hasData ? weather.current : null
  readonly property var today: (hasData && weather.forecast && weather.forecast.length > 0)
    ? weather.forecast[0] : null
  readonly property var rain: observedRain
    ? observedRain
    : ((hasData && weather.rain) ? weather.rain : null)
  readonly property var hourly: (hasData && weather.hourly) ? weather.hourly : []
  readonly property var days: (hasData && weather.forecast) ? weather.forecast : []
  readonly property var hourlyHistory: (hasData && weather.rain && weather.rain.hours)
    ? weather.rain.hours : []
  property bool showHourlyHistory: false
  property bool showWarnings: false
  property int expandedDay: -1

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

  readonly property bool bomRainAvailable: bomObservation !== null && reading(bomObservation.rainSince9am)

  function bomStationLabel() {
    if (!bomObservation || !bomObservation.station) return "nearest BOM station"
    var name = String(bomObservation.station.name || "")
    if (name === "") return "nearest BOM station"
    if (reading(bomObservation.station.distanceKm))
      return name + ", " + Math.round(bomObservation.station.distanceKm) + " km"
    return name
  }

  // The gauge's own clock, in the machine's local time. An observation time the
  // API did not give — or one that does not parse — is left off rather than
  // printed as an invented time.
  readonly property string bomObsSource: {
    if (!bomRainAvailable) return ""
    var text = "BOM observation at " + bomStationLabel()
    if (bomObservation.observationTime) {
      var d = new Date(String(bomObservation.observationTime))
      if (!isNaN(d.getTime())) {
        var hh = d.getHours()
        var mm = d.getMinutes()
        text += " · " + (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm
      }
    }
    return text
  }

  // The warnings arrive as a list the service has already narrowed to this
  // location, but the property can still be absent, so the count is asked of
  // the property rather than read from it directly.
  function warningCount() { return root.warnings ? root.warnings.length : 0 }

  // A warning's expiry is a whole ISO instant in the location's own zone —
  // "2026-10-03T15:43:00+10:00" — where the row wants only the hour and
  // minute. clockOf keeps the offset, so the seconds are trimmed here; a
  // stamp that did not parse stays as it came rather than being cut blindly.
  function warningClock(stamp) {
    var t = clockOf(stamp)
    return t.length >= 5 ? t.substring(0, 5) : t
  }

  // The Bureau's own paragraph for a day, matched to the Open-Meteo row by
  // date. It is longer and human-written where the Open-Meteo row is a short
  // code description, so it earns the room the dropdown already has.
  function bomTextFor(day) {
    if (!root.bomForecast || !root.bomForecast.days || !day) return ""
    for (var i = 0; i < root.bomForecast.days.length; i++) {
      if (root.bomForecast.days[i].date === day.date) return root.bomForecast.days[i].text || ""
    }
    return ""
  }

  function dayRange(day) {
    if (!day) return ""
    var high = reading(day.tempMax) ? Math.round(day.tempMax) + "°" : ""
    var low = reading(day.tempMin) ? Math.round(day.tempMin) + "°" : ""
    if (high !== "" && low !== "") return high + "/" + low
    return high !== "" ? high : low
  }

  // The readings the day row has no space for — wind and its gusts, the UV
  // peak, and the sun's hours — as one line. Each is left out when the service
  // had none, so the line shortens rather than growing a gap, exactly as the
  // conditions line does.
  function daySummary(day) {
    if (!day) return ""
    var bits = []
    if (reading(day.windMax)) {
      var wind = "Wind " + Math.round(day.windMax) + " km/h"
      if (reading(day.gustMax)) wind += ", gusts " + Math.round(day.gustMax)
      bits.push(wind)
    }
    if (reading(day.uvMax)) bits.push("UV " + Math.round(day.uvMax))
    var rise = clockOf(day.sunrise)
    if (rise !== "") bits.push("Sunrise " + rise)
    var set = clockOf(day.sunset)
    if (set !== "") bits.push("Sunset " + set)
    return bits.join(" · ")
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
  // — see the placeholder below for the other half. The Bureau's own fetch is
  // a second, slower answer than Open-Meteo's, so its clock is appended as its
  // own labelled bite rather than folded into the "updated" one, which would
  // claim both answers arrived together.
  readonly property string headerStatus: {
    var bits = []
    if (locationName !== "") bits.push(locationName)
    if (updatedClock !== "") bits.push("updated " + updatedClock)
    if (bomUpdated !== "") bits.push("BOM " + bomUpdated)
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

  // What the chart's seven bars are drawn from. When the Bureau's observations
  // corrected some of the days, say so: the reader should know which source the
  // shape describes rather than assume the model wrote all of it.
  readonly property string rainSourceCaption: (root.rain && root.rain.observed === true)
    ? "Rainfall, last 7 days · BOM observed, split to calendar days"
    : "Rainfall, last 7 days · Open-Meteo"

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
      width: parent.width - (weatherTitle.width + refreshButton.width + parent.spacing * 2)
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
      width: parent.width - (weatherTitle.width + refreshButton.width + parent.spacing * 2)
      text: root.loading ? "Loading forecast…" : (root.failed ? "Forecast unavailable" : "No forecast")
      color: root.accent
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
      anchors.verticalCenter: parent.verticalCenter
    }

    // The refresh control: one glyph at the right end of the header, so a
    // second row is not spent on a single action. It asks the service to try
    // the Bureau again, and the new timestamp appears in the status beside it.
    Item {
      id: refreshButton
      width: refreshGlyph.implicitWidth
      height: refreshGlyph.implicitHeight
      anchors.verticalCenter: parent.verticalCenter

      Text {
        id: refreshGlyph
        textFormat: Text.PlainText
        text: "⟳"
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        opacity: 0.5
      }

      MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: root.refreshRequested()
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Warnings
  // ---------------------------------------------------------------------------

  // What the Bureau has issued for this location's districts, as one strip
  // between the header and the present conditions — a line the eye lands on
  // before the temperature. Collapsed until asked to open, because a warning
  // is a sentence rather than a reading: at rest it shows the first title and
  // how many more there are, and unfolds into each warning's own lines. The
  // long advice paragraph is left out on purpose; it is written for a
  // notification and would push the forecast off the bottom of a panel this
  // narrow. The field stays on the object for whoever wants it.
  Column {
    id: warningStrip
    visible: root.warningCount() > 0
    width: parent.width
    spacing: Style.space(2)

    Item {
      id: warningSummary
      width: parent.width
      height: Style.space(20)

      Row {
        id: warningHead
        anchors.left: parent.left
        anchors.right: warningMore.left
        anchors.rightMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(6)

        Text {
          id: warningGlyph
          textFormat: Text.PlainText
          text: Weather.iconForCode(95, false)
          color: root.accent
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          anchors.verticalCenter: parent.verticalCenter
        }

        Text {
          textFormat: Text.PlainText
          width: warningHead.width - (warningGlyph.width + warningHead.spacing)
          anchors.verticalCenter: parent.verticalCenter
          elide: Text.ElideRight
          text: root.warnings[0] ? (root.warnings[0].title || "") : ""
          color: root.accent
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }
      }

      // How many warnings the strip is holding back, and which way the click
      // will turn it; the two share one right-aligned label so the row keeps a
      // single anchor.
      Text {
        id: warningMore
        textFormat: Text.PlainText
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        text: (root.warningCount() > 1 ? "+" + (root.warningCount() - 1) + " more " : "")
          + (root.showWarnings ? "▾" : "▸")
        color: root.accent
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        opacity: 0.85
      }

      MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: root.showWarnings = !root.showWarnings
      }
    }

    Repeater {
      model: root.showWarnings ? root.warnings : []

      delegate: Column {
        width: parent.width
        spacing: Style.space(1)

        Text {
          textFormat: Text.PlainText
          width: parent.width
          wrapMode: Text.WordWrap
          text: modelData.title || ""
          visible: text !== ""
          color: root.accent
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          font.bold: true
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          wrapMode: Text.WordWrap
          text: modelData.phenomena || ""
          visible: text !== ""
          color: root.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          opacity: 0.75
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          wrapMode: Text.WordWrap
          text: (modelData.areas && modelData.areas.length > 0)
            ? "For " + modelData.areas.join(", ") : ""
          visible: text !== ""
          color: root.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          opacity: 0.65
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          text: modelData.expiresAt ? "until " + root.warningClock(modelData.expiresAt) : ""
          visible: text !== ""
          color: root.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          opacity: 0.65
        }
      }
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
      text: root.current ? Weather.iconForCode(root.current.weatherCode, root.night) : ""
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
        text: root.bomRainAvailable ? "Rain since 9am" : "Today so far"
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        opacity: 0.6
      }

      Text {
        textFormat: Text.PlainText
        // The live gauge reading, which is what "since 9am" means. The daily
        // chart's last bar is the Bureau's own total for the day ending 9am
        // (drawn from the DWO row), so the two measure different windows and
        // are read from different fields rather than one standing for both.
        text: root.bomRainAvailable
          ? root.mmOf(root.bomObservation.rainSince9am)
          : (root.rain ? root.mmOf(root.rain.todayMm) : "")
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
    visible: root.rain !== null && root.rain.observed === true
    text: root.bomObsSource !== "" ? root.bomObsSource : "BOM observed"
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption * 0.85
    opacity: 0.5
    elide: Text.ElideRight
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
    text: root.rainSourceCaption
    color: root.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption * 0.8
    opacity: 0.4
  }

  // The hourly history: the last day of completed hours, on its own row below
  // the daily chart and hidden until asked for. The seven daily bars answer
  // "which day was wet"; unfolding one of them into its hours is a second
  // question, worth the space only when someone is asking it.
  Item {
    id: hourlyHistoryToggle
    visible: root.hasData && root.hourlyHistory.length > 0
    width: parent.width
    height: Style.space(20)

    Row {
      anchors.fill: parent
      spacing: Style.space(6)

      Text {
        textFormat: Text.PlainText
        text: (root.showHourlyHistory ? "▾" : "▸") + "  Last 24 hours"
        color: root.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
        opacity: 0.85
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        textFormat: Text.PlainText
        text: root.rain ? root.mmOf(root.rain.last24Mm) : ""
        color: root.accent
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    MouseArea {
      anchors.fill: parent
      cursorShape: Qt.PointingHandCursor
      onClicked: root.showHourlyHistory = !root.showHourlyHistory
    }
  }

  HourlyRainChart {
    visible: root.showHourlyHistory && root.hourlyHistory.length > 0
    width: parent.width
    height: Style.space(88)
    hours: root.hourlyHistory
    maxMm: root.rain ? root.rain.maxHourMm : 0
    barColor: root.foreground
    hoverColor: root.accent
    labelColor: Qt.darker(root.foreground, 1.6)
    fontFamily: Style.font.family
    labelSize: Style.font.caption
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

      // One day's cell: the row of readings, and — when opened — the summary
      // beneath it, under one click target the size of both. An Item rather
      // than a Column holds them, so the MouseArea can fill the cell without
      // taking part in a Row's or Column's layout: an anchored child of a
      // positioning item is laid out by position as well, which is what put
      // every forecast label on top of the next.
      delegate: Item {
        id: dayCell
        width: parent.width
        height: content.implicitHeight

        readonly property bool expanded: root.expandedDay === index

        Column {
          id: content
          width: parent.width
          spacing: 0

          Row {
            id: dayRow
            width: parent.width
            height: Style.space(22)
            spacing: Style.space(6)
            opacity: modelData.isToday ? 1 : (dayCell.expanded ? 1 : 0.75)

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
              text: (dayCell.expanded ? "▾ " : "▸ ")
                + (modelData.description ? modelData.description : Weather.describeCode(modelData.weatherCode))
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

          Text {
            textFormat: Text.PlainText
            visible: dayCell.expanded
            width: parent.width
            text: root.daySummary(modelData)
            color: root.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            opacity: 0.65
            elide: Text.ElideRight
            topPadding: Style.space(2)
            bottomPadding: Style.space(2)
          }

          // The Bureau's paragraph for this day, where it has one. It is longer
          // than the Open-Meteo description the row is built from, so it wraps
          // rather than elides — the cell was opened for exactly this, and a
          // sentence cut in the middle says less than no sentence. It covers
          // fewer days than the row list, so a day past its last simply has no
          // line here.
          Text {
            textFormat: Text.PlainText
            visible: dayCell.expanded && text !== ""
            width: parent.width
            wrapMode: Text.WordWrap
            text: root.bomTextFor(modelData)
            color: root.foreground
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            opacity: 0.55
            topPadding: Style.space(2)
          }
        }

        MouseArea {
          anchors.fill: parent
          cursorShape: Qt.PointingHandCursor
          onClicked: root.expandedDay = dayCell.expanded ? -1 : index
        }
      }
    }
  }
}

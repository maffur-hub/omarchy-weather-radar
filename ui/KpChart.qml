import QtQuick

// Kp as a bar per 3-hour block, observed history running into NOAA's forecast.
// Two reference lines sit behind the bars: the G1 storm threshold, and the Kp
// this location needs before there is anything to go outside for.
Item {
  id: root

  // [{ t: Date, kp: Number, kind: "observed" | "estimated" | "predicted" }]
  property var rows: []
  property real maxKp: 9

  // Kp at which the aurora reaches the viewer, or <= 0 to omit that line.
  property real visibleAtKp: 0
  property bool showStormLine: true

  property color barColor: "#cacccc"
  property color forecastColor: "#707880"
  property color gridColor: "#707880"
  property color labelColor: "#707880"
  property string fontFamily: "monospace"
  property real labelSize: 10
  property string timePattern: "HH:mm"

  readonly property real labelStrip: labelSize * 1.6
  readonly property real plotHeight: Math.max(1, height - labelStrip)
  readonly property real slot: rows.length > 0 ? width / rows.length : 0

  function yFor(kp) { return plotHeight * (1 - Math.min(kp, maxKp) / maxKp) }

  // Index of the first forecast bar, so "now" can be marked between the two.
  readonly property int firstForecast: {
    for (var i = 0; i < rows.length; i++)
      if (rows[i].kind === "predicted") return i
    return -1
  }

  // A day tick wherever the local date rolls over.
  function isDayStart(i) {
    if (i === 0 || !rows[i] || !rows[i - 1]) return false
    return rows[i].t.getDate() !== rows[i - 1].t.getDate()
  }

  Item {
    width: parent.width
    height: root.plotHeight

    // Storm threshold.
    Rectangle {
      visible: root.showStormLine
      width: parent.width
      height: 1
      y: root.yFor(5)
      color: root.gridColor
      opacity: 0.55
    }
    Text {
      textFormat: Text.PlainText
      visible: root.showStormLine
      anchors.right: parent.right
      y: root.yFor(5) - height - 1
      text: "G1"
      color: root.labelColor
      font.family: root.fontFamily
      font.pixelSize: root.labelSize
      opacity: 0.8
    }

    // Where this location starts seeing something.
    Rectangle {
      visible: root.visibleAtKp > 0 && root.visibleAtKp <= root.maxKp
      width: parent.width
      height: 1
      y: root.yFor(root.visibleAtKp)
      color: root.barColor
      opacity: 0.45
    }
    Text {
      textFormat: Text.PlainText
      visible: root.visibleAtKp > 0 && root.visibleAtKp <= root.maxKp
      anchors.left: parent.left
      y: root.yFor(root.visibleAtKp) - height - 1
      text: "visible here"
      color: root.barColor
      font.family: root.fontFamily
      font.pixelSize: root.labelSize
      opacity: 0.7
    }

    Repeater {
      model: root.rows
      delegate: Item {
        readonly property bool forecast: modelData.kind === "predicted"
        x: index * root.slot
        width: root.slot
        height: parent.height

        Rectangle {
          anchors.bottom: parent.bottom
          x: Math.max(1, root.slot * 0.12)
          width: Math.max(1, root.slot - 2 * Math.max(1, root.slot * 0.12))
          height: Math.max(1, root.plotHeight - root.yFor(modelData.kp))
          radius: 1
          // Forecast bars are hollow: the shape is a prediction, not a reading.
          color: parent.forecast ? "transparent" : root.barColor
          border.color: parent.forecast ? root.forecastColor : "transparent"
          border.width: parent.forecast ? 1 : 0
          opacity: parent.forecast ? 0.9 : (modelData.kp >= 5 ? 1 : 0.75)
        }
      }
    }

    // The seam between observed and forecast.
    Rectangle {
      visible: root.firstForecast > 0
      x: root.firstForecast * root.slot
      width: 1
      height: parent.height
      color: root.gridColor
      opacity: 0.7
    }
  }

  // Day labels along the bottom.
  Repeater {
    model: root.rows
    delegate: Text {
      visible: root.isDayStart(index)
      x: index * root.slot + 2
      y: root.plotHeight + 2
      text: Qt.formatDateTime(modelData.t, "ddd")
      color: root.labelColor
      font.family: root.fontFamily
      font.pixelSize: root.labelSize
    }
  }

  Text {
    textFormat: Text.PlainText
    visible: root.firstForecast > 0
    x: Math.min(root.width - width, root.firstForecast * root.slot + 2)
    y: root.plotHeight + 2
    text: "now"
    color: root.labelColor
    font.family: root.fontFamily
    font.pixelSize: root.labelSize
    opacity: 0.8
  }
}

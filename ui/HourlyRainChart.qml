import QtQuick

// Hourly rainfall for one calendar day: one bar per hour, 12am on the left,
// ending with the hour under way. The daily chart above answers "which day was
// wet"; this answers "when did it fall", so the bars are packed tighter and
// only the six-hour marks and the current hour are labelled — a label under
// all twenty-four would run together.
//
// A dropped reading draws no bar. The provider returning nothing is not the
// same as it returning zero, and only one of the two is a measurement. An hour
// still to come is a third thing again: flagged `future` by the service, it
// draws no bar and says nothing on hover, because the model's figure for it is
// a forecast rather than a reading.
//
// Hovering names the hour under the pointer and its figure, and marks that bar
// in the accent: the amount is the reason to look at one hour, and twenty-four
// of them would not fit as printed labels.
Item {
  id: root

  // [{ hour, mm, isMidnight, future }], oldest first
  property var hours: []
  property real maxMm: 0

  property color barColor: "#cacccc"
  property color hoverColor: "#7aa2f7"
  property color labelColor: "#707880"
  property string fontFamily: "monospace"
  property real labelSize: 10

  // The bar under the pointer, or -1 when the pointer is away. One MouseArea
  // owns the whole strip rather than one per bar, so the gap between two
  // delegates still names the bar beside it.
  property int hoverIndex: -1

  readonly property real topStrip: labelSize * 1.8
  readonly property real labelStrip: labelSize * 1.6
  readonly property real plotHeight: Math.max(1, height - topStrip - labelStrip)
  readonly property real slot: hours.length > 0 ? width / hours.length : 0

  // Scaled by the wettest hour, floored at a couple of pixels so a dry hour
  // reads as a baseline tick rather than an absence — and the scale itself
  // guarded, so a day of dry weather lays out like any other.
  function heightFor(mm) {
    if (!(maxMm > 0) || !(mm > 0)) return 2
    return Math.max(2, plotHeight * Math.min(mm, maxMm) / maxMm)
  }

  // The six-hour marks, plus the current hour — the newest one that is not
  // still to come, which is the one being looked for. An hour yet to fall
  // carries no reading, so it is named by neither rule.
  readonly property int newestHourIndex: {
    for (var i = root.hours.length - 1; i >= 0; i--) {
      if (!root.hours[i] || root.hours[i].future !== true) return i
    }
    return -1
  }

  function showLabel(index, hour) {
    var entry = root.hours[index]
    if (entry && entry.future === true) return false
    if (index === root.newestHourIndex) return true
    var n = Number(hour)
    return isFinite(n) && n % 6 === 0
  }

  function hasHover() {
    return root.hoverIndex >= 0 && root.hoverIndex < root.hours.length
  }

  function indexAt(x) {
    if (root.hours.length <= 0) return -1
    var i = Math.floor(x / root.slot)
    if (i < 0) return 0
    if (i >= root.hours.length) return root.hours.length - 1
    return i
  }

  // The figure for the bar under the pointer: one decimal, a trace as "0", an
  // explicit absence where the provider dropped the reading, and nothing at all
  // for an hour that has not happened yet.
  function hoverText() {
    if (!root.hasHover()) return ""
    var entry = root.hours[root.hoverIndex]
    if (entry.future === true) return ""
    if (entry.mm === null || entry.mm === undefined)
      return entry.hour + ":00 · no reading"
    return entry.hour + ":00 · " + (entry.mm < 0.05 ? "0" : entry.mm.toFixed(1)) + " mm"
  }

  Rectangle {
    width: parent.width
    height: 1
    y: root.topStrip + root.plotHeight
    color: root.labelColor
    opacity: 0.35
  }

  Repeater {
    model: root.hours

    delegate: Item {
      id: cell
      readonly property real barHeight: root.heightFor(modelData.mm)
      readonly property bool missing: modelData.mm === null || modelData.mm === undefined
      readonly property bool future: modelData.future === true
      readonly property bool hovered: root.hoverIndex === index
      readonly property bool dimmed: root.hoverIndex >= 0 && !hovered
      x: index * root.slot
      width: root.slot
      height: root.height

      Rectangle {
        visible: !cell.missing && !cell.future
        anchors.horizontalCenter: parent.horizontalCenter
        y: root.topStrip + root.plotHeight - cell.barHeight
        width: Math.max(1, root.slot - 2)
        height: cell.barHeight
        radius: 1
        color: cell.hovered ? root.hoverColor : root.barColor
        opacity: cell.hovered ? 1.0 : (cell.dimmed ? 0.45 : 0.85)
      }

      Text {
        textFormat: Text.PlainText
        visible: root.showLabel(index, modelData.hour)
        width: parent.width
        horizontalAlignment: Text.AlignHCenter
        y: root.topStrip + root.plotHeight + 2
        // Hour zero is falsy, so the obvious `modelData.hour ? ...` would leave
        // midnight — the left edge of the day — unlabelled.
        text: modelData.hour === 0 ? "0" : (modelData.hour ? "" + modelData.hour : "")
        color: cell.hovered ? root.hoverColor : root.labelColor
        font.family: root.fontFamily
        font.pixelSize: root.labelSize
        opacity: 0.8
      }
    }
  }

  // The figure for the hour under the pointer, held above the bars so it never
  // covers the one it describes, and clamped to the strip at either end. An
  // hour still to come has nothing to say, so the strip stays empty over it.
  Text {
    textFormat: Text.PlainText
    visible: root.hasHover() && root.hoverText() !== ""
    width: root.labelSize * 12
    horizontalAlignment: Text.AlignHCenter
    x: Math.max(0, Math.min(root.width - width,
        root.hoverIndex * root.slot + root.slot / 2 - width / 2))
    y: 0
    text: root.hoverText()
    color: root.hoverColor
    font.family: root.fontFamily
    font.pixelSize: root.labelSize
    font.bold: true
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.NoButton
    onPositionChanged: root.hoverIndex = root.indexAt(mouseX)
    onEntered: root.hoverIndex = root.indexAt(mouseX)
    onExited: root.hoverIndex = -1
  }
}

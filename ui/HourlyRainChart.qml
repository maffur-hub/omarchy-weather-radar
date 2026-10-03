import QtQuick

// Hourly rainfall for the last completed day: one bar per hour, oldest on the
// left, ending with the hour just ended. The daily chart above answers "which
// day was wet"; this answers "when did it fall", so the bars are packed tighter
// and only the six-hour marks and the newest hour are labelled — a label under
// all twenty-four would run together.
//
// A dropped reading draws no bar. The provider returning nothing is not the
// same as it returning zero, and only one of the two is a measurement.
//
// Hovering names the hour under the pointer and its figure, and marks that bar
// in the accent: the amount is the reason to look at one hour, and twenty-four
// of them would not fit as printed labels.
Item {
  id: root

  // [{ hour, mm, isMidnight }], oldest first
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

  // The six-hour marks, plus the newest hour, which is the one being looked for.
  function showLabel(index, hour) {
    if (index === root.hours.length - 1) return true
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

  // The figure for the bar under the pointer: one decimal, a trace as "0", and
  // an explicit absence where the provider dropped the reading.
  function hoverText() {
    if (!root.hasHover()) return ""
    var entry = root.hours[root.hoverIndex]
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
      readonly property bool hovered: root.hoverIndex === index
      readonly property bool dimmed: root.hoverIndex >= 0 && !hovered
      x: index * root.slot
      width: root.slot
      height: root.height

      Rectangle {
        visible: !cell.missing
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
        text: modelData.hour ? "" + modelData.hour : ""
        color: cell.hovered ? root.hoverColor : root.labelColor
        font.family: root.fontFamily
        font.pixelSize: root.labelSize
        opacity: 0.8
      }
    }
  }

  // The figure for the hour under the pointer, held above the bars so it never
  // covers the one it describes, and clamped to the strip at either end.
  Text {
    textFormat: Text.PlainText
    visible: root.hasHover()
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

import QtQuick

// Daily rainfall as one bar per day — the last seven days, ending today —
// scaled to the wettest of them. The amount sits above each bar and the day
// below it, so both strips are reserved out of the height the parent gives.
//
// A dry day still draws its bar. The record has to show that nothing fell
// rather than skip the column and leave its label floating over an empty
// space, and 0 mm against a wet week would otherwise divide by nothing.
Item {
  id: root

  // [{ label, mm, isToday }]
  property var days: []
  property real maxMm: 0

  property color barColor: "#cacccc"
  property color todayColor: barColor
  property color labelColor: "#707880"
  property string fontFamily: "monospace"
  property real labelSize: 10

  readonly property real topStrip: labelSize * 1.6
  readonly property real labelStrip: labelSize * 1.6
  readonly property real plotHeight: Math.max(1, height - topStrip - labelStrip)
  readonly property real slot: days.length > 0 ? width / days.length : 0

  // Scaled by the wettest day, floored at a couple of pixels so a dry day
  // reads as a baseline tick rather than as an absence — and the scale itself
  // guarded, so a week of dry weather lays out like any other.
  function heightFor(mm) {
    if (!(maxMm > 0) || !(mm > 0)) return 2
    return Math.max(2, plotHeight * Math.min(mm, maxMm) / maxMm)
  }

  // Below half a tenth there is nothing to show: one decimal would print
  // "0.0" for a trace and "0.1" for a trace and a half the same.
  function amountFor(mm) { return mm < 0.05 ? "0" : mm.toFixed(1) }

  Repeater {
    model: root.days

    delegate: Item {
      readonly property real barHeight: root.heightFor(modelData.mm)
      x: index * root.slot
      width: root.slot
      height: root.height

      Text {
        textFormat: Text.PlainText
        anchors.horizontalCenter: parent.horizontalCenter
        y: root.topStrip - height - 2
        text: root.amountFor(modelData.mm)
        color: root.labelColor
        font.family: root.fontFamily
        font.pixelSize: root.labelSize
        opacity: 0.9
      }

      Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter
        y: root.topStrip + root.plotHeight - parent.barHeight
        width: Math.max(2, root.slot - 2 * Math.max(1, root.slot * 0.18))
        height: parent.barHeight
        radius: 1
        color: modelData.isToday ? root.todayColor : root.barColor
        opacity: 0.85
      }

      Text {
        textFormat: Text.PlainText
        anchors.horizontalCenter: parent.horizontalCenter
        y: root.topStrip + root.plotHeight + 2
        text: modelData.label
        color: root.labelColor
        font.family: root.fontFamily
        font.pixelSize: root.labelSize
        opacity: 0.8
      }
    }
  }
}

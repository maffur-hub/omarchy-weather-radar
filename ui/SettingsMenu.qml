import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../lib/Alerts.js" as Alerts
import "../lib/RadarModel.js" as RadarModel
import "../lib/Settings.js" as Settings

// The widget's settings, opened by right-clicking the bar icon.
//
// Everything the widget stores lives here: the two bar labels, the storm alert
// controls, and the radar palette and zoom. Each control writes straight back
// to this widget's inline shell.json entry through the same `updateEntryInline`
// call the panel uses, so the menu and the panel cannot disagree about a
// setting, and a change survives a shell restart.
//
// It is a popup rather than a tab in the panel on purpose: the panel is where
// the weather is read, and this is where the widget is tuned. The last row is
// the way across when looking is the point.
PopupCard {
  id: root

  property var hostWidget: null
  property var settings: ({})

  readonly property string widgetId: "eduardodallecort.weather-radar"
  readonly property color foreground: root.bar ? root.bar.foreground : Color.foreground
  readonly property color accent: Color.accent
  readonly property color background: root.bar ? root.bar.background : Color.background

  // Every reading goes through Settings.js, the same module the service and the
  // panel read through, so all three agree about what is configured.
  readonly property bool showTemperature: Settings.showTemperature(settings)
  readonly property bool showLabel: Settings.showLabel(settings)
  readonly property bool alertsEnabled: Settings.alertsEnabled(settings)
  readonly property int alertRadiusKm: Settings.alertRadiusKm(settings)
  readonly property var radiusPresets: Settings.radiusPresets(alertRadiusKm)
  readonly property string alertThreshold: Settings.alertThreshold(settings)
  readonly property var thresholdOptions: Alerts.THRESHOLD_OPTIONS
  readonly property int colorSchemeId: Settings.colorSchemeId(settings)
  readonly property var colorSchemeOptions: RadarModel.COLOR_SCHEMES.map(function(scheme) { return scheme.name })
  readonly property int defaultZoom: Settings.defaultZoom(settings)
  readonly property bool smoothTiles: Settings.smoothTiles(settings)
  readonly property bool showSnow: Settings.showSnow(settings)

  // Write one field back to this widget's inline shell.json entry, preserving
  // every other field — the same approach the first-party panels use. The host
  // is updated first so the control redraws on the click itself, before the
  // shell.json write comes back through the bar.
  function persistSetting(key, value) {
    var entry = { id: root.widgetId }
    for (var existing in root.settings) if (existing !== "id") entry[existing] = root.settings[existing]
    entry[key] = value

    if (root.hostWidget && "settings" in root.hostWidget) root.hostWidget.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.widgetId, entry)
  }

  function openPanel() {
    root.open = false
    if (root.hostWidget && typeof root.hostWidget.open === "function")
      Qt.callLater(root.hostWidget.open)
  }

  contentWidth: root.fittedContentWidth(Style.space(320))
  contentHeight: root.fittedContentHeight(scroll.contentHeight)

  Flickable {
    id: scroll
    anchors.fill: parent
    contentWidth: width
    contentHeight: column.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    Column {
      id: column
      width: scroll.width
      spacing: Style.space(10)

      PanelSectionHeader {
        text: "IN THE BAR"
        foreground: root.foreground
        fontFamily: Style.font.family
      }

      Toggle {
        width: parent.width
        label: "Temperature"
        description: "Show the current temperature beside the icon."
        checked: root.showTemperature
        foreground: root.foreground
        accent: root.accent
        onClicked: root.persistSetting("showTemperature", !root.showTemperature)
      }

      Toggle {
        width: parent.width
        label: "Status text"
        description: "Print the storm outlook and its time beside the icon. Needs storm alerts on."
        checked: root.showLabel
        foreground: root.foreground
        accent: root.accent
        onClicked: root.persistSetting("showLabel", !root.showLabel)
      }

      PanelSeparator { foreground: root.foreground }

      PanelSectionHeader {
        text: "STORM ALERTS"
        foreground: root.foreground
        fontFamily: Style.font.family
      }

      Toggle {
        width: parent.width
        label: "Storm alerts"
        description: "Notify when rain or a storm is forecast to reach you."
        checked: root.alertsEnabled
        foreground: root.foreground
        accent: root.accent
        onClicked: root.persistSetting("alertsEnabled", !root.alertsEnabled)
      }

      ChoiceSection {
        visible: root.alertsEnabled
        width: parent.width
        bar: root.bar
        title: "ALERT RADIUS"
        caption: "How far out to watch, and so how far ahead."
        options: root.radiusPresets
        value: String(root.alertRadiusKm)
        onChosen: function(km) { root.persistSetting("alertRadiusKm", parseInt(km, 10)) }
      }

      ChoiceSection {
        visible: root.alertsEnabled
        width: parent.width
        bar: root.bar
        title: "ALERT THRESHOLD"
        caption: "The least rain worth interrupting you for."
        options: root.thresholdOptions
        value: root.alertThreshold
        onChosen: function(name) { root.persistSetting("alertMinIntensity", name) }
      }

      PanelSeparator { foreground: root.foreground }

      PanelSectionHeader {
        text: "RADAR"
        foreground: root.foreground
        fontFamily: Style.font.family
      }

      Toggle {
        width: parent.width
        label: "Smooth radar"
        description: "Blend the radar image instead of showing hard pixel edges."
        checked: root.smoothTiles
        foreground: root.foreground
        accent: root.accent
        onClicked: root.persistSetting("smoothTiles", !root.smoothTiles)
      }

      Toggle {
        width: parent.width
        label: "Distinguish snow"
        description: "Colour snow separately from rain."
        checked: root.showSnow
        foreground: root.foreground
        accent: root.accent
        onClicked: root.persistSetting("showSnow", !root.showSnow)
      }

      Dropdown {
        width: parent.width
        label: "Colour scheme"
        options: root.colorSchemeOptions
        value: RadarModel.colorSchemeName(root.colorSchemeId)
        onChanged: function(name) { root.persistSetting("colorScheme", name) }
      }

      PanelSectionHeader {
        text: "DEFAULT ZOOM  ·  " + root.defaultZoom
        foreground: root.foreground
        fontFamily: Style.font.family
      }

      PanelSlider {
        width: parent.width
        bar: root.bar
        minimum: RadarModel.MIN_RADAR_ZOOM
        maximum: RadarModel.MAX_MAP_ZOOM
        step: 1
        integer: true
        tickCount: RadarModel.MAX_MAP_ZOOM - RadarModel.MIN_RADAR_ZOOM + 1
        value: root.defaultZoom
        onReleased: function(value) { root.persistSetting("defaultZoom", Math.round(value)) }
      }

      PanelSeparator { foreground: root.foreground }

      Button {
        width: parent.width
        text: "Open weather panel"
        foreground: root.foreground
        background: root.background
        bordered: true
        onClicked: root.openPanel()
      }
    }
  }
}

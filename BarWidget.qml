import QtQuick
import qs.Commons
import "lib/Alerts.js" as Alerts
import "lib/Glyphs.js" as Glyphs
import "lib/Settings.js" as Settings
import "lib/Weather.js" as Weather
import qs.Ui
import "ui"

// Bar pill for the radar plugin.
//
// Structure follows the first-party pattern (see plugins/panels/weather):
// the widget owns the button and lazily loads the panel, forwarding the
// open/close contract the bar's popout coordinator expects. All state comes
// from the plugin's service, so two monitors show the same thing without
// either of them polling.
BarWidget {
  id: root
  moduleName: "eduardodallecort.weather-radar"

  readonly property var radar: bar && bar.shell ? bar.shell.serviceFor("eduardodallecort.weather-radar") : null

  // The current conditions when the service has a reading, and the radar glyph
  // until the first one lands or when there is no location. Drawn through
  // Weather.iconForCode so the bar and the panel cannot show different skies
  // for the same code.
  readonly property string icon: {
    if (radar && radar.weather && radar.weather.current)
      return Weather.iconForCode(radar.weather.current.weatherCode, radar.isNight === true)
    return Glyphs.RADAR
  }

  // The reading beside the icon, in whole degrees Celsius, or "" until one
  // lands. Absent rather than 0°, since a dropped temperature and a real zero
  // are different answers.
  readonly property string temperature: {
    if (!radar || !radar.weather || !radar.weather.current) return ""
    var value = Number(radar.weather.current.temperature)
    if (!isFinite(value)) return ""
    return Math.round(value) + "°"
  }

  readonly property bool showTemperature: Settings.showTemperature(settings)

  readonly property bool showLabel: Settings.showLabel(settings)
  readonly property string summary: radar ? radar.barSummary : ""
  readonly property int outlookLevel: radar ? radar.outlookLevel : 0

  // What the pill prints: the conditions glyph, then the temperature and the
  // alert outlook, each only when it is switched on and has something to say.
  // Built from parts so an absent reading cannot leave a stray gap behind.
  readonly property string label: {
    var parts = [root.icon]
    if (root.showTemperature && root.temperature !== "") parts.push(root.temperature)
    if (root.showLabel && root.summary !== "") parts.push(root.summary)
    return parts.join("  ")
  }

  readonly property bool hasLabelText: root.label !== root.icon

  // Measuring the string is what lets the slot fit it instead of the pill
  // spilling into the module beside it. The icon-only pill keeps the stock
  // status slot; a label asks for whatever the font actually needs.
  TextMetrics {
    id: labelMetrics
    font.family: button.fontFamily
    font.pixelSize: button.fontSize
    text: root.label
  }

  readonly property color defaultForeground: bar ? bar.foreground : Color.foreground

  // Tint the pill when weather is on the way, the same way the stock
  // indicators signal state: accent for something worth knowing, urgent for a
  // severe outlook. Anything below that stays the ordinary bar foreground so
  // the bar does not become a christmas tree.
  readonly property color iconColor: {
    if (!radar || !radar.alertsEnabled) return defaultForeground
    if (outlookLevel >= Alerts.SEVERE) return Color.urgent
    if (outlookLevel >= Alerts.HEAVY) return Color.accent
    return defaultForeground
  }

  // The shell injects `settings` into widgets but not into services, so the
  // widget forwards them. On a multi-monitor setup every bar instance writes
  // the same value, which is harmless — they all read the same shell.json
  // entry.
  function syncService() {
    if (root.radar && "settings" in root.radar) root.radar.settings = root.settings
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("radar" in target) target.radar = root.radar
  }

  function togglePanel() {
    settingsMenu.open = false
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  // Right-click opens the settings menu; opening it closes the panel the way
  // opening the panel would close it, so the two are never up together.
  function toggleMenu() {
    if (!settingsMenu.open && root.opened) root.close()
    settingsMenu.open = !settingsMenu.open
  }

  // Shape contract for shell.summon/hide/toggle routing: the bar identifies a
  // panel by the widget mounted in its slot, so open/close/opened have to live
  // on this root rather than on the nested panel.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: { injectPanel(); syncService() }
  onRadarChanged: { injectPanel(); syncService() }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  SettingsMenu {
    id: settingsMenu
    bar: root.bar
    anchorItem: button
    hostWidget: root
    settings: root.settings
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.label
    foreground: root.iconColor
    // Only the horizontal pill is widened for a label. A vertical bar reads
    // slotSize as its height, so a long label there would stretch the bar's
    // thickness rather than give the text room.
    slotSize: !root.vertical && root.hasLabelText
      ? Math.max(Style.bar.statusSlot, Math.ceil(labelMetrics.width) + Style.space(8))
      : Style.bar.statusSlot
    tooltipText: ""

    onPressed: function(b) {
      if (b === Qt.MiddleButton && root.radar) root.radar.checkNow()
      else if (b === Qt.RightButton) root.toggleMenu()
      else root.togglePanel()
    }
  }
}

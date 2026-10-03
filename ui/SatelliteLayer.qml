import QtQuick

// One layer of the satellite picture.
//
// The satellite overlay is either a single live geostationary full-disk layer
// or a stack of polar true-colour sensors. The polar composites have swaths
// they never saw, painted opaque black; `maskBlack` runs their tiles through
// the black-to-alpha shader in shaders/blackmask.frag.qsb, so the gaps in the
// layer above fall through to the sensor below, and only ground no sensor saw
// shows the base map. Geostationary PNGs already carry alpha and are drawn
// unmasked. The layers and their order live in lib/Overlay.js.
//
// Tiles are plain Images, as in TileLayer. The mask is the only thing this
// adds: a compositor without ShaderEffect support draws the layer unmasked.
Item {
  id: root

  // function(sensor, zoom, x, y) -> the tile's URL, "" or null. Same contract
  // as TileLayer.tileUrlFor, with the sensor this layer carries.
  property var satelliteTileUrlFor: null
  property string sensor: ""

  property real centerLatitude: 0
  property real centerLongitude: 0
  property int zoom: 7

  // Zoom the source actually has, so a layer that runs out of resolution
  // before the map does is upscaled rather than requested past its deepest
  // tile. Set from the layer's maxZoom in lib/Overlay.js.
  property int sourceZoom: zoom
  // Not `smooth`: Item already has a `smooth`, and declaring it again shadows
  // the base property instead of carrying the tile setting.
  property bool smoothTiles: true
  property var revision: 0

  // Only the polar composites need the black gaps turned transparent.
  property bool maskBlack: true

  // An item layer is not free, so only pay for the texture when there is a
  // mask to apply and tiles to mask.
  layer.enabled: root.maskBlack && satelliteTileUrlFor !== null
  layer.effect: ShaderEffect {
    fragmentShader: Qt.resolvedUrl("../shaders/blackmask.frag.qsb")
  }

  function tileUrlFor(z, x, y) {
    if (!root.satelliteTileUrlFor) return ""
    return root.satelliteTileUrlFor(root.sensor, z, x, y)
  }

  TileLayer {
    anchors.fill: parent
    centerLatitude: root.centerLatitude
    centerLongitude: root.centerLongitude
    zoom: root.zoom
    sourceZoom: root.sourceZoom
    tileUrlFor: root.tileUrlFor
    revision: root.revision
    smooth: root.smoothTiles
  }
}

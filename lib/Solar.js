// Where the Sun is, and therefore whether a place is in daylight.
//
// Two things need the same answer and they used to get it two different ways.
// The satellite overlay must choose a visible band by day and an infrared band
// by night, and the weather glyphs must draw a sun or a moon. Open-Meteo
// carries an `is_day` flag, but it belongs to the last forecast it fetched, so
// a stale reading leaves the bar showing a daytime sun well after dark. This
// computes the terminator from the clock instead, which is right whenever
// yesterday's forecast is still on screen.
//
// The accuracy is deliberately low — a tenth of a degree or so is far finer
// than the question being asked, and this stays a dozen lines rather than a
// table of orbital elements.

.pragma library

// Great-circle angle between two points, in degrees.
function angularDistanceDeg(lat1, lon1, lat2, lon2) {
  var rad = Math.PI / 180
  var dLat = (lat2 - lat1) * rad
  var dLon = (lon2 - lon1) * rad
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / rad
}

// The subsolar point, where the Sun is overhead, to about a tenth of a degree.
// Low-precision solar position: mean longitude and anomaly, the equation of the
// centre, the obliquity, then sidereal time to turn right ascension into
// longitude.
function subsolarPoint(dateMs) {
  var rad = Math.PI / 180
  var n = dateMs / 86400000 + 2440587.5 - 2451545.0
  var L = (280.460 + 0.9856474 * n) % 360
  var g = (357.528 + 0.9856003 * n) % 360
  var lambda = (L + 1.915 * Math.sin(g * rad) + 0.020 * Math.sin(2 * g * rad)) % 360
  var epsilon = 23.439 - 0.0000004 * n
  var declination = Math.asin(Math.sin(epsilon * rad) * Math.sin(lambda * rad)) / rad
  var rightAscension = Math.atan2(Math.cos(epsilon * rad) * Math.sin(lambda * rad), Math.cos(lambda * rad)) / rad
  var gmst = (18.697374558 + 24.06570982441908 * n) % 24
  var longitude = rightAscension - gmst * 15
  longitude = ((longitude + 180) % 360 + 360) % 360 - 180
  return { latitude: declination, longitude: longitude }
}

// Whether the Sun is above the horizon at a place: the point is within a
// quarter turn of the subsolar point.
function isDaytime(latitude, longitude, dateMs) {
  var sun = subsolarPoint(dateMs)
  return angularDistanceDeg(latitude, longitude, sun.latitude, sun.longitude) < 90
}

// The day/night answer to use for a reading: the clock at the configured
// location when there is one, and the reading's own flag when there is not.
// `isDay` is whatever Open-Meteo last said, which is all there is to go on
// without a place to compute from.
function nighttime(latitude, longitude, isDay, dateMs) {
  if (typeof latitude === "number" && isFinite(latitude)
      && typeof longitude === "number" && isFinite(longitude)) {
    return !isDaytime(latitude, longitude, dateMs)
  }
  return !(isDay === true)
}

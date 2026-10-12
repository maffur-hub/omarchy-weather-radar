import QtQuick
import Quickshell
import Quickshell.Io
import "lib/Glyphs.js" as Glyphs
import "lib/Alerts.js" as Alerts
import "lib/Basemap.js" as Basemap
import "lib/Bom.js" as Bom
import "lib/ImageCache.js" as ImageCache
import "lib/RadarModel.js" as RadarModel
import "lib/Settings.js" as Settings
import "lib/Solar.js" as Solar
import "lib/TileCache.js" as TileCache
import "lib/Weather.js" as Weather

// Headless singleton behind the radar plugin.
//
// A bar widget is instantiated once per monitor, so anything that polls has to
// live here instead: the shell mounts exactly one service per plugin, which
// keeps a two-monitor setup from doubling every request.
//
// Four responsibilities:
//
//   1. Own the RainViewer frame manifest, so that a two-monitor setup showing
//      the map on both shares one copy instead of fetching one each. It is 818
//      bytes, and is fetched only while the map is open. The property is
//      `radarManifest` rather than the obvious `manifest` because the shell
//      assigns the plugin's own manifest.json to any service exposing a
//      property by that name.
//
//   2. Keep the loop's radar tiles on disk, so that each is fetched once
//      rather than on every pass through the loop.
//
//   3. Decide whether to warn about approaching weather, and say so once.
//
//   4. Own the point forecast behind the Weather tab and the bar icon, and keep
//      the last good reading of it on disk. It is a fetch like the others, so
//      it is one request per machine rather than one per monitor; and a reading
//      held by a panel dies with that panel, while one held here is drawn again
//      when the shell restarts. The same tab draws BOM's severe-weather warning
//      and NSW/ACT district forecast beside it — a second provider and its own
//      fetch, but the same reasoning and the same cache.
//
// On (3), a note on why the alert reads a point forecast rather than the radar
// image it draws. Distance alone does not mean approaching — a cell 80 km east
// travelling east is not your problem — so a radar-echo alert would have to
// derive motion vectors across frames to avoid crying wolf. The question the
// user is actually asking is "will weather hit me, and how bad", and a point
// forecast answers exactly that, including the instability indices that
// separate ordinary rain from a severe storm. Radar remains the better picture;
// the forecast is the better trigger.
Item {
  id: root

  // Injected by the shell.
  property var shell: null
  property var settings: ({})

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  // Coercion lives in Settings.js, which the panel reads through as well.
  // Clamping the same value in two places is two chances to disagree about it,
  // and the pair that would disagree here decides what gets a notification.
  readonly property bool settingsReady: Settings.isReady(settings)
  readonly property bool alertsEnabled: Settings.alertsEnabled(settings)
  readonly property int alertRadiusKm: Settings.alertRadiusKm(settings)
  readonly property string alertThreshold: Settings.alertThreshold(settings)

  // The alert radius doubles as a lead time — the conversion assumes a storm
  // speed, and lives in Alerts.js with the bands it feeds. One setting
  // therefore controls both the ring drawn on the map and how far ahead the
  // forecast is inspected.
  readonly property int leadMinutes: Alerts.leadMinutesFor(alertRadiusKm)
  readonly property int forecastSlots: Alerts.forecastSlotsFor(leadMinutes)

  // ---------------------------------------------------------------------------
  // Location
  // ---------------------------------------------------------------------------

  // Shared with the stock weather widget, which owns the file. Watching it
  // means changing city through the Omarchy menu re-centres the radar live.
  //
  // Read whole, without a ceiling, which is the one place this plugin does
  // that. It is deliberate: this is Omarchy's own state file, read exactly as
  // Omarchy's own weather panel reads it, with the same FileView and the same
  // watch. Reading it through a bounded process instead would mean diverging
  // from the platform on the platform's own file, and losing live updates with
  // it — omarchy-weather-location writes the file and notifies nobody, so the
  // watch is the only mechanism there is. Every stream this plugin owns is
  // bounded; see test/streams.test.js for the inventory.
  //
  // The watch only reaches as far as the containing directory. On a machine
  // where no weather location was ever set, `~/.local/state/omarchy/settings/`
  // does not exist, so there is nothing to watch and the file appearing later
  // is invisible — hence reloadLocation() below and the retry beneath it.
  property var location: ({ name: "", latitude: null, longitude: null, valid: false })

  readonly property bool hasLocation: location && location.valid === true
  readonly property string locationName: location ? location.name : ""

  // "ready", "unresolved" or "unset" — see RadarModel.locationState. The middle
  // one is a name typed with no city picked behind it, which the shared file
  // stores happily and this plugin can do nothing with.
  readonly property string locationState: RadarModel.locationState(location)

  FileView {
    id: locationFile
    path: RadarModel.locationFilePath(Quickshell.env("HOME"))
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.location = RadarModel.parseLocationFile(text())
    onLoadFailed: root.location = RadarModel.parseLocationFile("")
  }

  // Re-read the file now rather than waiting to be told about it. Whoever
  // writes the location calls this immediately afterwards, which is the only
  // way the first one to exist is ever noticed.
  function reloadLocation() {
    locationFile.reload()
  }

  // Covers the one window the file watch cannot: before any location has ever
  // been stored the settings directory does not exist, so a file created in it
  // is invisible. Once the directory exists the watch works — clearing a
  // location only removes the file — so what is needed is a bridge across the
  // start of the very first session, not a permanent watchdog.
  //
  // It runs quickly at first and then slowly forever, rather than stopping.
  // Stopping would strand the machine it exists for: with no directory to
  // watch, a location chosen an hour later from the stock weather widget or a
  // terminal would never be seen, while that widget updated live. A read a
  // minute apart is a file stat, and the burst is never re-armed, because
  // being without a location is otherwise an ordinary long-lived state —
  // clearing it from the panel, or storing a typed name with no coordinates —
  // and re-entering it should not restart rapid polling.
  property int locationRetries: 0
  readonly property int locationRetryBurst: 24

  Timer {
    interval: root.locationRetries < root.locationRetryBurst ? 5000 : 60000
    repeat: true
    running: !root.hasLocation
    triggeredOnStart: true
    onTriggered: {
      if (root.locationRetries < root.locationRetryBurst) root.locationRetries++
      locationFile.reload()
    }
  }

  // Identity of the configured place, and the thing "changed" is measured
  // against.
  //
  // Two properties of the surroundings make the obvious tests wrong. Watching
  // `hasLocation` misses a move, because going from one valid city to another
  // never flips it. Watching the `location` object misfires, because
  // parseLocationFile returns a fresh object on every read and QML notifies on
  // assignment rather than on inequality, so re-reading an unchanged file looks
  // like relocating. Comparing the values is what makes "changed" mean changed.
  property string locationKey: ""

  onLocationChanged: {
    var key = hasLocation ? location.latitude + "," + location.longitude + "|" + locationName : ""
    if (key === locationKey) return

    // Learning where we are is not the same as moving, and only the latter
    // re-arms. Startup can complete a check before this handler runs — the
    // location arrives, a poll fires against it, and the handler then sees a
    // key it has never recorded — so treating an empty previous key as
    // relocation would announce the same weather twice.
    var moved = locationKey !== ""
    locationKey = key

    coverageChecked = false
    hasCoverage = true

    if (moved) {
      // Somewhere new has not been reported on yet. Without this the latch
      // carries across the move, and someone who changes city during weather
      // is told nothing because they were already told about somewhere else.
      notifiedLevel = 0
      storeLatch(0)
      discardReading()
      // The same is true of a forecast: it is a reading about a place and a
      // moment, and the previous city's would sit under the new city's name
      // until the new one's lands.
      discardWeather()
      discardBomObservation()
      discardBomDwo()
    } else {
      // Learning where we are is the other half of the stored latch, and it can
      // arrive after the file does.
      adoptLatch()
    }

    if (hasLocation && alertsEnabled) checkNow()

    // The weather reading follows the location whenever one arrives or moves,
    // so both the tab and the bar icon have a current one without waiting out
    // the half-hour cadence.
    if (hasLocation) Qt.callLater(refreshWeather)
    // The BOM warning and district forecast follow it for the same reason; they
    // are pinned to the ACT rather than geocoded, but without a location there
    // is still no reader to fetch them for.
    if (hasLocation) Qt.callLater(refreshBom)
    if (hasLocation) Qt.callLater(refreshBomObservation)
  }

  // ---------------------------------------------------------------------------
  // RainViewer frame manifest
  // ---------------------------------------------------------------------------

  property var radarManifest: null
  property int frameConsumers: 0
  property int frameFailures: 0

  readonly property var frames: radarManifest ? radarManifest.past : []
  readonly property string tileHost: radarManifest ? radarManifest.host : ""
  readonly property int latestFrameTime: {
    var frame = RadarModel.latestFrame(radarManifest)
    return frame ? frame.time : 0
  }

  // Whether the newest frame in hand is one RainViewer could still improve on.
  // Frames publish about every ten minutes, so one younger than that is the
  // newest that exists, and asking again would return the same bytes.
  //
  // A function rather than a property: the answer depends on the passing of
  // time, and a binding would only be recomputed when the manifest changed —
  // freezing it at "current" for exactly as long as it stayed out of date.
  //
  // A frame that reads as newer than now means the clock moved backwards, not
  // that RainViewer published into the future: an RTC kept in local time, or
  // NTP correcting a drift. Freshness cannot be judged against a clock that
  // just jumped, so the safe answer is to go and ask.
  function manifestIsCurrent() {
    if (!radarManifest) return false
    var age = Date.now() / 1000 - latestFrameTime
    return age >= 0 && age < RadarModel.FRAME_INTERVAL_SEC
  }

  // The map calls these while it is open. Refcounted rather than boolean so two
  // monitors showing the panel do not fight over whether fetching should stop.
  function acquireManifest() {
    frameConsumers++
    loadBasemap()
    refreshManifest()
    retryFailedTiles()
    scheduleManifestCheck()
    // The cache is emptied while the frame list is being asked for, rather
    // than after it answers.
    if (tileCacheState === "cold") clearTileCache()
    // The image cache is emptied the same way, so a file left by a session that
    // died mid-transfer is never taken on trust.
    if (imageCacheState === "cold") clearImageCache()
  }

  // `owner` names the map letting go, so that its tile requests go with it.
  function releaseManifest(owner) {
    frameConsumers = Math.max(0, frameConsumers - 1)
    if (owner !== undefined) delete tileWants[owner]
    // Nobody is looking, so nothing still queued is worth fetching. What is
    // already on disk stays for the next time the map opens.
    if (frameConsumers === 0) {
      tileWants = ({})
      imageWants = ({})
    }
    rebuildTileQueue()
    rebuildImageQueue()
    scheduleManifestCheck()
  }

  // While a map is open, the frame list is asked for again when the next frame
  // should have been published, and every minute after that until it is: see
  // RadarModel.nextManifestCheckMs. `nextManifestCheckAt` is when, or 0 when
  // no map is open.
  property real nextManifestCheckAt: 0

  // Whether a request for the frame list is in flight. The map waits for it
  // before asking for tiles, rather than fetching the tiles of a list that is
  // about to be replaced, whose oldest frames may no longer be served at all.
  readonly property bool manifestPending: manifestProc.running

  function scheduleManifestCheck() {
    if (frameConsumers === 0) {
      manifestCheckTimer.stop()
      nextManifestCheckAt = 0
      return
    }
    var now = Date.now()
    var delay = RadarModel.nextManifestCheckMs(latestFrameTime, now)
    // Not before refreshManifest would agree to ask. A timer that fires a
    // little early would otherwise be turned away by the minimum gap and put
    // the question off by a whole extra interval.
    if (radarManifest && lastManifestFetchMs > 0 && lastManifestFetchMs <= now) {
      delay = Math.max(delay, lastManifestFetchMs + minFetchGapMs - now + 250)
    }
    nextManifestCheckAt = now + delay
    manifestCheckTimer.interval = delay
    manifestCheckTimer.restart()
  }

  Timer {
    id: manifestCheckTimer
    repeat: false
    onTriggered: {
      root.refreshManifest()
      // A fetch that starts here schedules the next check when it answers;
      // one that did not start, because the list was already current or was
      // asked for moments ago, is scheduled from here.
      if (!manifestProc.running) root.scheduleManifestCheck()
    }
  }

  // Every request passes through here, so this is where "is it worth asking"
  // belongs, rather than at each call site. Three reasons not to: one is
  // already in flight, the frames in hand are already the newest published, or
  // the last attempt was too recent to have changed anything.
  readonly property int minFetchGapMs: 60000
  property real lastManifestFetchMs: 0

  function refreshManifest() {
    if (manifestProc.running) return
    if (manifestIsCurrent()) return

    var now = Date.now()
    // As above, in the other direction: a request stamped in the future is a
    // clock that moved, and left alone it would refuse every fetch until real
    // time caught up — hours, on a machine whose RTC was wrong.
    if (lastManifestFetchMs > now) lastManifestFetchMs = 0

    // The floor bounds what opening and closing the map repeatedly can cost,
    // so it guards frames already on screen and waits until there are some.
    // Someone watching an empty map who closes it and opens it again is asking
    // to retry, and a minute of silence is not an answer to that.
    if (radarManifest && lastManifestFetchMs > 0 && now - lastManifestFetchMs < minFetchGapMs) return

    lastManifestFetchMs = now
    manifestProc.answered = false
    manifestProc.command = RadarModel.manifestCommand()
    manifestBeats = 0
    manifestProc.running = true
  }

  Process {
    id: manifestProc

    // A process that cannot be started emits neither `started` nor `exited`,
    // and goes from running to not running in silence. `exited` fires before
    // `running` drops, so a drop with nothing recorded is a fork that never
    // happened — which has to be answered, or the map waits on a reply that
    // will never come.
    property bool answered: false

    onExited: function(exitCode) {
      answered = true
      root.applyManifestResponse(exitCode, manifestOut.text)
      root.scheduleManifestCheck()
    }
    onRunningChanged: {
      if (running || answered) return
      root.applyManifestResponse(-1, "")
      root.scheduleManifestCheck()
    }

    // The collector holds the output and decides nothing. `onStreamFinished`
    // fires before `onExited`, so deciding there is deciding before the exit
    // code exists — and a transfer cut short by the time or size ceiling would
    // be read as one that completed.
    stdout: StdioCollector { id: manifestOut; waitForEnd: true }
  }

  function applyManifestResponse(exitCode, text) {
    // Keep the previous manifest on any failure: stale frames still render,
    // and the next tick retries. Blanking the map on one failed request would
    // be a worse outcome than showing data a few minutes old.
    if (exitCode !== 0) {
      frameFailures++
      return
    }
    var parsed = RadarModel.parseManifest(text)
    if (!parsed) {
      frameFailures++
      return
    }
    // A list that arrives after lists that did not is the network coming back.
    // Tiles that failed meanwhile are asked for again now, rather than each
    // waiting out a backoff that grew while nothing could have worked.
    var recovering = frameFailures > 0
    frameFailures = 0
    if (RadarModel.isNewerManifest(radarManifest, parsed)) {
      radarManifest = parsed
      evictStaleTiles()
    }
    if (recovering) {
      retryFailedTiles(true)
      rebuildTileQueue()
    }
  }

  // ---------------------------------------------------------------------------
  // Radar tiles
  // ---------------------------------------------------------------------------

  // The loop's tiles, kept on disk while their frame is in it. Why disk rather
  // than memory, and every name and command used here, are in
  // lib/TileCache.js.
  //
  // Owned here for the same reason as the manifest: two monitors showing the
  // map want the same files. Each panel says which tiles its view needs, in
  // the order it will need them; this fetches the ones not on disk yet and
  // answers where each one is.
  //
  // What is on disk is known only from this session's own fetches. The cache
  // is emptied the first time the map opens, so a file left behind by a
  // session that was killed mid-transfer, or by an older version of the
  // plugin, is never taken on trust.
  readonly property string tileCacheDir: TileCache.cacheDir(Quickshell.env("HOME"),
    Quickshell.env("XDG_CACHE_HOME"))

  // "cold" until the map first opens, "clearing" while the old cache is
  // removed, then "ready". "off" when there is nowhere safe to keep one, in
  // which case the panel loads each tile straight from the network.
  property string tileCacheState: tileCacheDir === "" ? "off" : "cold"

  // Bumped whenever a tile arrives, fails or leaves, so that bindings which
  // asked where a tile is ask again. The bookkeeping itself is plain objects,
  // which QML does not watch, so it costs nothing to update tile by tile.
  property int tileRevision: 0
  property var tilesOnDisk: ({})
  property int tilesOnDiskCount: 0
  property int maxTilesOnDisk: TileCache.MAX_TILES_ON_DISK
  property var unreadableCounts: ({})
  property var framesOnDisk: ({})
  property var tilesInFlight: ({})
  property var tileRetries: ({})
  property var tileQueue: []

  // What each open map wants, most urgent first, keyed by the map that asked.
  // Two monitors can each show the map, looking at different places, and the
  // queue takes a tile from each in turn so that neither waits on the other.
  property var tileWants: ({})
  property var wantedKeys: ({})
  property var framesToDelete: []

  // Set by a 429. RainViewer asking for less applies to every tile, not just
  // the one that drew it, so nothing is fetched until it passes.
  property real tilesPausedUntil: 0
  property int rateLimitStrikes: 0

  // Where a tile is, for an Image to load. A file URL once it is on disk; ""
  // for one that failed and is waiting out its retry, which is not worth
  // holding the loop for; null for one still coming. The map's layers count
  // null as outstanding, which is what holds a crossfade until the frame it
  // fades to has arrived.
  function tileSource(key) {
    var unused = tileRevision
    return TileCache.tileSourceFor("file://" + tileCacheDir + "/" + key, tilesOnDisk[key] === true,
      tileRetries[key] || null, tilesPausedUntil, Date.now())
  }

  // What the map says about a tile it wants: see TileCache.radarNotice.
  function tileState(key) {
    var unused = tileRevision
    return TileCache.tileState(tilesOnDisk[key] === true, tileRetries[key] || null,
      tilesPausedUntil, Date.now())
  }

  // The tiles one map needs, most urgent first. Replaces what that map asked
  // for before: a view that has moved on no longer needs the tiles of the one
  // it left.
  function wantTiles(owner, jobs) {
    tileWants[owner] = jobs || []
    rebuildTileQueue()
  }

  // A failed tile keeps its backoff when no map wants it for a while, so that
  // asking for it again, after a pan away and back, does not start it afresh.
  // The retry timer only looks at tiles some map wants, so a backoff kept
  // here never wakes it, and it goes when its frame leaves the loop.
  function rebuildTileQueue() {
    var lists = []
    for (var owner in tileWants) lists.push(tileWants[owner])
    var merged = TileCache.interleave(lists)
    var wanted = {}
    for (var i = 0; i < merged.length; i++) wanted[merged[i].key] = true
    wantedKeys = wanted

    var now = Date.now()
    var queue = []
    for (var j = 0; j < merged.length; j++) {
      var k = merged[j].key
      if (tilesOnDisk[k] || tilesInFlight[k]) continue
      if (TileCache.isWaiting(tileRetries[k], now)) continue
      queue.push(merged[j])
    }
    tileQueue = queue
    pumpTiles()
    scheduleTileWake()
  }

  // Opening the map is asking again, the same as it is for the manifest, so
  // tiles that failed are no longer made to wait out their backoff: whatever
  // stopped them, a dropped connection most likely, may be over. A 429 is the
  // exception. That was RainViewer asking for less, and reopening the panel
  // does not change their answer.
  //
  // The frame list answering after failures (`afterOutage`) is the network
  // coming back, which says nothing about a tile that arrived and could not
  // be read: that one keeps its count, and stays given up, until the map is
  // opened again.
  function retryFailedTiles(afterOutage) {
    var changed = false
    for (var key in tileRetries) {
      if (tileRetries[key].status === 429) continue
      if (afterOutage && tileRetries[key].unreadable === true) continue
      delete tileRetries[key]
      changed = true
    }
    if (!afterOutage) unreadableCounts = ({})
    if (changed) tileRevision++
  }

  function pumpTiles() {
    if (tileCacheState === "cold") {
      clearTileCache()
      return
    }
    if (tileCacheState !== "ready" || tileFetchProc.running || tileQueue.length === 0) return
    if (TileCache.isHeld(tilesPausedUntil, Date.now())) return

    var batch = tileQueue.slice(0, TileCache.BATCH_SIZE)
    tileQueue = tileQueue.slice(TileCache.BATCH_SIZE)
    var command = TileCache.fetchCommand(tileCacheDir, batch)
    if (command.length === 0) {
      // Nothing in it could be fetched. Its tiles are failures like any other,
      // rather than dropped from the queue with nothing to bring them back,
      // which would leave the map loading them for ever.
      applyTileReport(batch, "")
      return
    }
    for (var i = 0; i < batch.length; i++) tilesInFlight[batch[i].key] = true
    tileFetchProc.jobs = batch
    tileFetchProc.answered = false
    tileFetchProc.command = command
    batchBeats = 0
    tileFetchProc.running = true
  }

  Process {
    id: tileFetchProc

    // See manifestProc: a fork that never happened is answered too, or the
    // tiles it held stay in flight for the rest of the session.
    property bool answered: false
    property var jobs: []

    onExited: function(exitCode) {
      answered = true
      root.applyTileReport(jobs, tileReport.text)
    }
    onRunningChanged: if (!running && !answered) root.applyTileReport(jobs, "")

    // curl's report, one short line per tile, in a format and with paths this
    // plugin chose; nothing the server sends reaches it.
    stdout: StdioCollector { id: tileReport; waitForEnd: true }
  }

  function currentFrameTimes() {
    var current = {}
    for (var f = 0; f < frames.length; f++) current[frames[f].time] = true
    return current
  }

  function applyTileReport(jobs, text) {
    var result = TileCache.parseFetchReport(text, tileCacheDir, jobs)
    var current = currentFrameTimes()

    for (var i = 0; i < jobs.length; i++) delete tilesInFlight[jobs[i].key]

    // Nowhere to write, a full disk or a directory that cannot be made: the
    // cache is given up for the session, and the map loads tiles from the
    // network as it would with no cache at all, rather than failing for good.
    if (result.cannotWrite) {
      console.warn("weather-radar: cannot write the tile cache in " + tileCacheDir
        + "; loading tiles from the network for this session")
      tileCacheState = "off"
      tileQueue = []
      tileRevision++
      return
    }

    for (var a = 0; a < result.arrived.length; a++) {
      var key = result.arrived[a]
      var frame = TileCache.frameOfKey(key)
      // The frame left the loop while its tile was on the way.
      if (!current[frame]) {
        framesToDelete.push(frame)
        continue
      }
      if (!tilesOnDisk[key]) tilesOnDiskCount++
      tilesOnDisk[key] = true
      framesOnDisk[frame] = true
      delete tileRetries[key]
    }
    // Written but not a tile, a redirect's body: never offered, but its frame's
    // directory now holds a file, and is deleted with the frame.
    for (var w = 0; w < result.written.length; w++) {
      var writtenFrame = TileCache.frameOfKey(result.written[w])
      if (current[writtenFrame]) framesOnDisk[writtenFrame] = true
    }

    var now = Date.now()
    var limited = false
    // Nothing in the batch arrived: whatever failed may have failed for want
    // of a network rather than for anything about the tile itself.
    var outage = result.arrived.length === 0
    for (var b = 0; b < result.failed.length; b++) {
      var failed = result.failed[b]
      if (failed.status === 429) limited = true
      // A frame that left the loop is not coming back, and neither is the
      // need for its tiles.
      if (!current[TileCache.frameOfKey(failed.key)]) continue
      var attempts = (tileRetries[failed.key] ? tileRetries[failed.key].attempts : 0) + 1
      tileRetries[failed.key] = {
        at: now + TileCache.retryDelayMs(attempts, failed.status),
        attempts: attempts,
        status: failed.status,
        outage: outage
      }
    }
    // One line per batch, so that what RainViewer answered can be read back
    // from the journal: the status of each tile that failed, a few named.
    if (result.failed.length > 0) {
      var named = result.failed.slice(0, 4).map(function(f) { return f.status + " " + f.key })
      console.warn("weather-radar: " + result.failed.length + " of " + jobs.length
        + " tiles failed: " + named.join(", ") + (result.failed.length > 4 ? ", ..." : ""))
    }

    if (limited) {
      rateLimitStrikes++
      tilesPausedUntil = now + TileCache.retryDelayMs(rateLimitStrikes, 429)
    } else if (result.arrived.length > 0) {
      rateLimitStrikes = 0
    }

    // A tile arriving is the network working. Tiles that failed in a batch
    // where nothing answered at all are asked for again now, instead of each
    // waiting out its own delay: the network came back, and they would all
    // work. A tile that failed beside others that arrived keeps its delay, or
    // one that keeps timing out would be fetched again in every batch; so
    // does a tile that arrived and could not be read, whose record no batch
    // wrote.
    var revived = false
    if (result.arrived.length > 0) {
      for (var key2 in tileRetries) {
        var r = tileRetries[key2]
        if (r.status !== 0 || r.outage !== true) continue
        delete tileRetries[key2]
        revived = true
      }
    }

    tileRevision++
    if (tilesOnDiskCount > maxTilesOnDisk) {
      startTileCacheOver()
      return
    }
    runTileDeletes()
    if (revived) rebuildTileQueue()
    else pumpTiles()
    scheduleTileWake()
  }

  // Wakes when the next wanted tile's retry, or a rate limit, runs out, so a
  // five-second retry takes five seconds and not up to ten. The heartbeat
  // does the same every five seconds, in case this is ever missed.
  function scheduleTileWake() {
    var now = Date.now()
    var at = TileCache.nextWake(tileRetries, wantedKeys, tilesPausedUntil, now)
    if (at === 0 || frameConsumers === 0) {
      tileWakeTimer.stop()
      tileWakeAt = 0
      return
    }
    tileWakeTimer.interval = Math.max(50, at - now + 50)
    tileWakeTimer.restart()
    tileWakeAt = now + tileWakeTimer.interval
  }

  // When the service will next wake for a retry or a rate limit, or 0.
  property real tileWakeAt: 0

  Timer {
    id: tileWakeTimer
    repeat: false
    onTriggered: root.reviveDueTiles()
  }

  // Lifts a rate limit that has run out, and queues again the wanted tiles
  // whose retry is due.
  function reviveDueTiles() {
    if (tileCacheState !== "ready") return
    var now = Date.now()
    if (tilesPausedUntil > 0 && !TileCache.isHeld(tilesPausedUntil, now)) tilesPausedUntil = 0
    var due = false
    for (var key in tileRetries) {
      var retry = tileRetries[key]
      if (wantedKeys[key] && !retry.gaveUp && !TileCache.isHeld(retry.at, now)) { due = true; break }
    }
    if (!due && tilesPausedUntil === 0 && tileQueue.length > 0) {
      pumpTiles()
    } else if (due) {
      // A tile whose retry is due reads as outstanding again, and is queued.
      tileRevision++
      rebuildTileQueue()
    }
    scheduleTileWake()
  }

  // Past the ceiling on tiles, the cache is emptied and refilled with what the
  // maps on screen want, rather than growing for as long as someone explores.
  function startTileCacheOver() {
    tilesOnDisk = ({})
    framesOnDisk = ({})
    tilesOnDiskCount = 0
    tileRevision++
    tileCacheState = "cold"
    rebuildTileQueue()
  }

  // How long one batch may run, the clear of the cache, and a request for the
  // frame list, before they are stopped. curl's own limits end each of them
  // well before this, so reaching it means something is stuck that nothing
  // else would ever end. Measured in heartbeats since that process started
  // (each counter is reset where its process is started), rather than by the
  // clock, so that neither the clock moving nor a machine waking from sleep
  // can make a healthy process look hung, or a hung one look fresh.
  property int tileBatchTimeoutMs: 90000
  property int tileClearTimeoutMs: 30000
  property int manifestTimeoutMs: 30000
  property int imageBatchTimeoutMs: 90000
  property int imageClearTimeoutMs: 30000
  property int batchBeats: 0
  property int clearBeats: 0
  property int manifestBeats: 0
  property int imageBatchBeats: 0
  property int imageClearBeats: 0

  // The heartbeat of an open map, every five seconds. It is where everything
  // that could otherwise wait for ever is looked at again:
  //
  //  - a batch, a clear or a request for the frame list that has hung is
  //    stopped, and handled like any other failure when it ends;
  //  - a check of the frame list that is due is made, which covers a machine
  //    that slept through the timer meant to make it (Qt's timers do not count
  //    time spent suspended);
  //  - a rate limit that has run out is lifted, and failed tiles whose retry
  //    is due are queued again. The service also wakes for these at the
  //    moment they are due; this is the net under that.
  //  - the same for the overlay images, and their time-bucketed keys are
  //    pruned as their moment passes.
  Timer {
    id: tileHeartbeat
    interval: 5000
    repeat: true
    running: root.frameConsumers > 0
    onTriggered: {
      var beat = interval
      if (tileFetchProc.running) root.batchBeats++
      if (root.batchBeats * beat > root.tileBatchTimeoutMs) {
        console.warn("weather-radar: a tile batch ran for over " + Math.round(root.tileBatchTimeoutMs / 1000)
          + " s and was stopped")
        root.batchBeats = 0
        tileFetchProc.running = false
      }
      if (tileCleanProc.running) root.clearBeats++
      if (root.clearBeats * beat > root.tileClearTimeoutMs) {
        console.warn("weather-radar: clearing the tile cache hung and was stopped")
        root.clearBeats = 0
        tileCleanProc.running = false
      }
      if (imageFetchProc.running) root.imageBatchBeats++
      if (root.imageBatchBeats * beat > root.imageBatchTimeoutMs) {
        console.warn("weather-radar: an image batch ran for over " + Math.round(root.imageBatchTimeoutMs / 1000)
          + " s and was stopped")
        root.imageBatchBeats = 0
        imageFetchProc.running = false
      }
      if (imageCleanProc.running) root.imageClearBeats++
      if (root.imageClearBeats * beat > root.imageClearTimeoutMs) {
        console.warn("weather-radar: clearing the image cache hung and was stopped")
        root.imageClearBeats = 0
        imageCleanProc.running = false
      }
      if (manifestProc.running) root.manifestBeats++
      if (root.manifestBeats * beat > root.manifestTimeoutMs) {
        console.warn("weather-radar: a request for the frame list hung and was stopped")
        root.manifestBeats = 0
        manifestProc.running = false
      }

      var now = Date.now()
      if (root.nextManifestCheckAt > 0 && now >= root.nextManifestCheckAt + 1000 && !manifestProc.running) {
        root.refreshManifest()
        if (!manifestProc.running) root.scheduleManifestCheck()
      }
      root.reviveDueTiles()
      root.evictStaleImages()
      root.reviveDueImages()
    }
  }

  // Empties the cache. If a frame's directory is being deleted at that moment,
  // the clear waits for it to finish: handed a new command while running, the
  // process would report the old one's end as the clear's, and tiles fetched
  // in between would be deleted under the bookkeeping that says they are there.
  property bool clearPending: false

  function clearTileCache() {
    tileCacheState = "clearing"
    framesToDelete = []
    if (tileCleanProc.running) {
      clearPending = true
      return
    }
    tileCleanProc.command = TileCache.cleanCommand(tileCacheDir, null)
    clearBeats = 0
    tileCleanProc.running = true
  }

  // Frames that left the loop take their tiles with them: the files, the
  // failures waiting to be retried, and anything still queued for them.
  function evictStaleTiles() {
    var current = currentFrameTimes()
    for (var retry in tileRetries) {
      if (!current[TileCache.frameOfKey(retry)]) delete tileRetries[retry]
    }
    for (var unreadable in unreadableCounts) {
      if (!current[TileCache.frameOfKey(unreadable)]) delete unreadableCounts[unreadable]
    }
    tileQueue = tileQueue.filter(function(job) { return current[TileCache.frameOfKey(job.key)] === true })

    var stale = TileCache.staleFrames(framesOnDisk, frames)
    if (stale.length === 0) return
    var gone = {}
    for (var i = 0; i < stale.length; i++) {
      gone[stale[i]] = true
      delete framesOnDisk[stale[i]]
    }
    for (var key in tilesOnDisk) {
      if (!gone[TileCache.frameOfKey(key)]) continue
      delete tilesOnDisk[key]
      tilesOnDiskCount--
    }
    framesToDelete = framesToDelete.concat(stale)
    tileRevision++
    runTileDeletes()
  }

  // A file the map could not load, although this session wrote it: the cache
  // was deleted under it, or what arrived is not a readable image. Either way
  // it is not on disk any more as far as the map is concerned. How many times
  // a tile has come back unreadable is kept across its arrivals, so each
  // refetch waits longer, and after a few it is left alone until the map is
  // opened again: see TileCache.unreadableRetry.
  function tileUnreadable(source) {
    var prefix = "file://" + tileCacheDir + "/"
    var text = String(source || "")
    if (tileCacheDir === "" || text.indexOf(prefix) !== 0) return
    var key = text.slice(prefix.length)
    if (!TileCache.isTileKey(key) || !tilesOnDisk[key]) return
    delete tilesOnDisk[key]
    tilesOnDiskCount--
    var count = (unreadableCounts[key] || 0) + 1
    unreadableCounts[key] = count
    tileRetries[key] = TileCache.unreadableRetry(count, Date.now())
    tileRevision++
  }

  // A frame whose tiles a batch is still writing waits for that batch, which
  // runs this again when it ends. Deleting the directory under curl can land
  // between its making the directory and opening the file, and curl reports
  // that as a write it could not make, which gives the whole cache up.
  function runTileDeletes() {
    if (tileCleanProc.running || framesToDelete.length === 0) return
    var writing = {}
    for (var key in tilesInFlight) writing[TileCache.frameOfKey(key)] = true
    var now = framesToDelete.filter(function(frame) { return !writing[frame] })
    framesToDelete = framesToDelete.filter(function(frame) { return writing[frame] === true })
    if (now.length === 0) return
    var command = TileCache.cleanCommand(tileCacheDir, now)
    if (command.length === 0) return
    tileCleanProc.command = command
    clearBeats = 0
    tileCleanProc.running = true
  }

  Process {
    id: tileCleanProc

    // Nothing is read back. A delete that failed leaves files nobody points
    // at, and the next session's clear removes them.
    onRunningChanged: {
      if (running) return
      if (root.clearPending) {
        root.clearPending = false
        root.clearTileCache()
        return
      }
      if (root.tileCacheState === "clearing") {
        // Whatever was asked for while the cache was being emptied is queued
        // against what is on disk now, which is nothing.
        root.tileCacheState = "ready"
        root.rebuildTileQueue()
        return
      }
      root.runTileDeletes()
      root.pumpTiles()
    }
  }

  // ---------------------------------------------------------------------------
  // Overlay images
  // ---------------------------------------------------------------------------

  // The satellite, lightning and coverage rasters, kept on disk and fetched out
  // of process for the same reason the radar tiles are. Qt loading an https://
  // image in this process is the crash this whole pipeline exists to prevent —
  // see lib/ImageCache.js — so no remote URL ever reaches an Image.source or a
  // Canvas.loadImage: the layers ask by cache key and load a file:// path.
  //
  // Owned here rather than in a panel for the same reason as the tiles: two
  // monitors showing the map want the same files, and what is on disk is known
  // only from this session's own fetches. The cache is emptied the first time
  // the map opens, so a file left by a session that died mid-transfer is never
  // taken on trust.
  readonly property string imageCacheDir: ImageCache.cacheDir(Quickshell.env("HOME"),
    Quickshell.env("XDG_CACHE_HOME"))

  // "cold" until the map first opens, "clearing" while the old cache is
  // removed, then "ready". "off" when there is nowhere safe to keep one, in
  // which case no image is fetched and the overlays simply do not draw.
  property string imageCacheState: imageCacheDir === "" ? "off" : "cold"

  // Bumped whenever an image arrives, fails or leaves, so the layer bindings
  // that asked where an image is ask again.
  property int imageRevision: 0
  property var imagesOnDisk: ({})
  property int imagesOnDiskCount: 0
  property int maxImagesOnDisk: ImageCache.MAX_IMAGES_ON_DISK
  property var imagesInFlight: ({})
  property var imageRetries: ({})
  property var imageQueue: []

  // What the map on screen wants, keyed by cache key, and the same keys as a
  // set for the wake calculation. The callers are pull-based — a tile repoints
  // and asks for its key again — so a want is remembered here until it is on
  // disk, and pruned when its time bucket passes.
  property var imageWants: ({})
  property var wantedImageKeys: ({})
  property var imagesToDelete: []

  // Where an image is loaded from: its file once it is on disk, "" otherwise.
  // "" draws nothing and asks Qt for nothing, which is the only safe answer
  // while the fetch is still out of process.
  function imageSource(key) {
    var unused = imageRevision
    return ImageCache.imageSourceFor("file://" + imageCacheDir + "/" + key, imagesOnDisk[key] === true)
  }

  // Idempotent, because the panel calls this while a source binding evaluates,
  // which happens many times a second during a pan. Only a key not already
  // wanted, queued, in flight or on disk causes any work.
  function wantImage(key, url) {
    if (imageCacheState === "off") return
    if (!ImageCache.isImageKey(key) || !ImageCache.isImageUrl(url)) return
    if (imageWants[key] !== url) imageWants[key] = url
    if (imagesOnDisk[key] || imagesInFlight[key]) return
    if (TileCache.isWaiting(imageRetries[key], Date.now())) return
    for (var i = 0; i < imageQueue.length; i++) {
      if (imageQueue[i].key === key) return
    }
    rebuildImageQueue()
  }

  // The queue is rebuilt from the wants rather than appended to, so a key asked
  // for twice stays in one place and nothing already on disk is fetched again.
  function rebuildImageQueue() {
    var wanted = {}
    var queue = []
    var now = Date.now()
    for (var key in imageWants) {
      wanted[key] = true
      if (imagesOnDisk[key] || imagesInFlight[key]) continue
      if (TileCache.isWaiting(imageRetries[key], now)) continue
      queue.push({ key: key, url: imageWants[key] })
    }
    wantedImageKeys = wanted
    imageQueue = queue
    pumpImages()
    scheduleImageWake()
  }

  function pumpImages() {
    if (imageCacheState === "cold") {
      clearImageCache()
      return
    }
    // No map open means nobody is looking, so nothing is worth fetching.
    if (frameConsumers === 0) return
    if (imageCacheState !== "ready" || imageFetchProc.running || imageQueue.length === 0) return

    var batch = imageQueue.slice(0, ImageCache.BATCH_SIZE)
    imageQueue = imageQueue.slice(ImageCache.BATCH_SIZE)
    var command = ImageCache.fetchCommand(imageCacheDir, batch)
    if (command.length === 0) {
      // Nothing in it could be fetched. Its images are failures like any other,
      // rather than dropped from the queue with nothing to bring them back.
      applyImageReport(batch, "")
      return
    }
    for (var i = 0; i < batch.length; i++) imagesInFlight[batch[i].key] = true
    imageFetchProc.jobs = batch
    imageFetchProc.answered = false
    imageFetchProc.command = command
    imageBatchBeats = 0
    imageFetchProc.running = true
  }

  Process {
    id: imageFetchProc

    // See tileFetchProc: a fork that never happened is answered too, or the
    // images it held stay in flight for the rest of the session.
    property bool answered: false
    property var jobs: []

    onExited: function(exitCode) {
      answered = true
      root.applyImageReport(jobs, imageReport.text)
    }
    onRunningChanged: if (!running && !answered) root.applyImageReport(jobs, "")

    // curl's report, one short line per image, in a format and with paths this
    // plugin chose; nothing the server sends reaches it.
    stdout: StdioCollector { id: imageReport; waitForEnd: true }
  }

  function applyImageReport(jobs, text) {
    var result = ImageCache.parseFetchReport(text, imageCacheDir, jobs)

    for (var i = 0; i < jobs.length; i++) delete imagesInFlight[jobs[i].key]

    // Nowhere to write, a full disk or a directory that cannot be made: the
    // cache is given up for the session, and the overlays stop drawing rather
    // than loading a remote URL as a fallback. There is deliberately no remote
    // fallback; that is the crash.
    if (result.cannotWrite) {
      console.warn("weather-radar: cannot write the image cache in " + imageCacheDir
        + "; overlay images are off for this session")
      imageCacheState = "off"
      imageQueue = []
      imageRevision++
      return
    }

    for (var a = 0; a < result.arrived.length; a++) {
      var key = result.arrived[a]
      if (!imagesOnDisk[key]) imagesOnDiskCount++
      imagesOnDisk[key] = true
      delete imageRetries[key]
    }

    var now = Date.now()
    // Nothing in the batch arrived: whatever failed may have failed for want of
    // a network rather than for anything about the image itself.
    var outage = result.arrived.length === 0
    for (var b = 0; b < result.failed.length; b++) {
      var failed = result.failed[b]
      var attempts = (imageRetries[failed.key] ? imageRetries[failed.key].attempts : 0) + 1
      imageRetries[failed.key] = {
        at: now + TileCache.retryDelayMs(attempts, failed.status),
        attempts: attempts,
        status: failed.status,
        outage: outage
      }
    }
    if (result.failed.length > 0) {
      var named = result.failed.slice(0, 4).map(function(f) { return f.status + " " + f.key })
      console.warn("weather-radar: " + result.failed.length + " of " + jobs.length
        + " images failed: " + named.join(", ") + (result.failed.length > 4 ? ", ..." : ""))
    }

    // An image arriving is the network working. Images that failed in a batch
    // where nothing answered are asked for again now, rather than each waiting
    // out its own delay.
    var revived = false
    if (result.arrived.length > 0) {
      for (var key2 in imageRetries) {
        if (imageRetries[key2].status !== 0 || imageRetries[key2].outage !== true) continue
        delete imageRetries[key2]
        revived = true
      }
    }

    imageRevision++
    if (imagesOnDiskCount > maxImagesOnDisk) {
      startImageCacheOver()
      return
    }
    runImageDeletes()
    if (revived) rebuildImageQueue()
    else pumpImages()
    scheduleImageWake()
  }

  // Wakes when the next wanted image's retry runs out, so a five-second retry
  // takes five seconds and not up to the next heartbeat.
  function scheduleImageWake() {
    var now = Date.now()
    var at = ImageCache.nextImageWake(imageRetries, wantedImageKeys, now)
    if (at === 0 || frameConsumers === 0) {
      imageWakeTimer.stop()
      imageWakeAt = 0
      return
    }
    imageWakeTimer.interval = Math.max(50, at - now + 50)
    imageWakeTimer.restart()
    imageWakeAt = now + imageWakeTimer.interval
  }

  property real imageWakeAt: 0

  Timer {
    id: imageWakeTimer
    repeat: false
    onTriggered: root.reviveDueImages()
  }

  // Queues again the wanted images whose retry is due.
  function reviveDueImages() {
    if (imageCacheState !== "ready") return
    var now = Date.now()
    var due = false
    for (var key in imageRetries) {
      var retry = imageRetries[key]
      if (wantedImageKeys[key] && !retry.gaveUp && !TileCache.isHeld(retry.at, now)) { due = true; break }
    }
    if (due) {
      imageRevision++
      rebuildImageQueue()
    } else if (imageQueue.length > 0) {
      pumpImages()
    }
    scheduleImageWake()
  }

  // Past the ceiling on images, the cache is emptied and refilled with what the
  // map on screen wants, rather than growing for as long as someone explores.
  function startImageCacheOver() {
    imagesOnDisk = ({})
    imagesOnDiskCount = 0
    imageRevision++
    imageCacheState = "cold"
    rebuildImageQueue()
  }

  // Keys past their time bucket — the lightning archive window and the live
  // geostationary frames — are dropped from disk and from the wanted set, so a
  // long session does not keep asking for frames whose moment has passed. The
  // dated polar tiles and the coverage mask carry no bucket and are bounded by
  // the count cap instead.
  function evictStaleImages() {
    var now = Date.now()
    var changed = false
    for (var w in imageWants) {
      if (ImageCache.keyAgeMs(w, now) > ImageCache.IMAGE_MAX_AGE_MS) { delete imageWants[w]; changed = true }
    }
    for (var r in imageRetries) {
      if (ImageCache.keyAgeMs(r, now) > ImageCache.IMAGE_MAX_AGE_MS) { delete imageRetries[r]; changed = true }
    }
    var stale = ImageCache.staleKeys(imagesOnDisk, now)
    if (stale.length > 0) {
      for (var i = 0; i < stale.length; i++) {
        if (!imagesOnDisk[stale[i]]) continue
        delete imagesOnDisk[stale[i]]
        imagesOnDiskCount--
      }
      imagesToDelete = imagesToDelete.concat(stale)
      changed = true
    }
    if (!changed) return
    imageRevision++
    runImageDeletes()
    rebuildImageQueue()
  }

  // A key a batch is still writing waits for that batch, which runs this again
  // when it ends. Deleting a file under curl can land between the transfer
  // starting and the file being opened. `imagesInFlight` is keyed by exact key
  // here, not by frame as the tiles are.
  function runImageDeletes() {
    if (imageCleanProc.running || imagesToDelete.length === 0) return
    var now = imagesToDelete.filter(function(key) { return imagesInFlight[key] !== true })
    imagesToDelete = imagesToDelete.filter(function(key) { return imagesInFlight[key] === true })
    if (now.length === 0) return
    var command = ImageCache.cleanCommand(imageCacheDir, now)
    if (command.length === 0) return
    imageCleanProc.command = command
    imageClearBeats = 0
    imageCleanProc.running = true
  }

  Process {
    id: imageCleanProc

    // Nothing is read back. A delete that failed leaves files nobody points at,
    // and the next session's clear removes them.
    onRunningChanged: {
      if (running) return
      if (root.imageClearPending) {
        root.imageClearPending = false
        root.clearImageCache()
        return
      }
      if (root.imageCacheState === "clearing") {
        root.imageCacheState = "ready"
        root.rebuildImageQueue()
        return
      }
      root.runImageDeletes()
      root.pumpImages()
    }
  }

  // Empties the cache. If a file is being deleted at that moment, the clear
  // waits for it to finish, for the same reason the tile clear does.
  property bool imageClearPending: false

  function clearImageCache() {
    if (imageCacheState === "off") return
    imageCacheState = "clearing"
    imagesToDelete = []
    if (imageCleanProc.running) {
      imageClearPending = true
      return
    }
    imageCleanProc.command = ImageCache.cleanCommand(imageCacheDir, null)
    imageClearBeats = 0
    imageCleanProc.running = true
  }

  // ---------------------------------------------------------------------------
  // Basemap
  // ---------------------------------------------------------------------------

  // The ground the radar is drawn on, decoded once for the whole session.
  //
  // It lives here rather than in the panel for the same reason the frame
  // manifest does: a bar widget is built once per monitor, and two screens
  // showing the map would otherwise each hold their own ten megabytes of
  // coastline. It is read on first use rather than at startup, so a session
  // that never opens the map never pays for it.
  //
  // Data ships with the plugin instead of arriving as tiles. The world's
  // coastlines do not change, and a keyless tile endpoint is a policy rather
  // than a property — the one this plugin used began stamping "API KEY
  // REQUIRED" across every tile in August 2026, for every installation at
  // once, with nothing failing anywhere. Geometry in the repository cannot be
  // withdrawn, and works with no network at all.
  // Also read whole. It is this plugin's own file, inside its own directory:
  // anything able to replace it can replace Service.qml beside it, so a
  // ceiling here would guard nothing. Corruption is handled instead — the
  // decoder answers null on anything it cannot read, including a truncated
  // file.
  //
  // Decoding is spread over many short steps rather than done in one call,
  // because this is the thread that draws the bar, every panel and the lock
  // screen, and one call holds it for over half a second on a fast machine
  // and for seconds on a slow one. Each layer is published as it completes,
  // so the ground arrives in the order the file stores it — land first, then
  // what sits on land — over a second or so during which the radar is already
  // drawn over open sea. `basemap` holds the layers finished so far until the
  // last one lands, and is null again if the file turns out to be unreadable.
  property var basemap: null
  property bool basemapFailed: false
  property var basemapDecoder: null

  function loadBasemap() {
    if (basemap || basemapFile.path !== "") return
    basemapFile.path = Qt.resolvedUrl("data/basemap.bin").toString().replace("file://", "")
  }

  FileView {
    id: basemapFile
    path: ""
    onLoaded: {
      root.basemapDecoder = Basemap.beginDecode(basemapFile.data())
      if (root.basemapDecoder === null) root.basemapUnreadable("could not be decoded")
    }
    onLoadFailed: root.basemapUnreadable("could not be read")
  }

  function basemapUnreadable(why) {
    root.basemapDecoder = null
    root.basemap = null
    root.basemapFailed = true
    console.warn("weather-radar: data/basemap.bin " + why)
  }

  // One step per frame, for as long as there is a decoder. A QML Timer is
  // driven by the animation clock, not the event loop: an interval of zero
  // never fires at all, and one of a millisecond fires once per tick of that
  // clock, which is once per frame. So a step runs, the frame is drawn, and
  // input and the IPC the shell answers on this thread get their turn between
  // the two.
  Timer {
    id: basemapStepper
    interval: 1
    repeat: true
    running: root.basemapDecoder !== null
    onTriggered: {
      var decoder = root.basemapDecoder
      var layersBefore = decoder.order.length
      var finished = decoder.step(Basemap.DECODE_STEP_MS)

      if (finished) {
        if (decoder.result === null) {
          root.basemapUnreadable("could not be decoded")
          return
        }
        root.basemap = decoder.result
        root.basemapFailed = false
        root.basemapDecoder = null
      } else if (decoder.order.length !== layersBefore) {
        root.basemap = decoder.partial()
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Radar coverage
  // ---------------------------------------------------------------------------

  // Whether a ground radar reaches the configured location. Large parts of the
  // world have none, and an empty map there reads as a broken plugin unless it
  // says so. Resolved by the panel, which can decode images; the service just
  // remembers the answer.
  property bool coverageChecked: false
  property bool hasCoverage: true

  function reportCoverage(covered) {
    coverageChecked = true
    hasCoverage = covered === true
  }

  // ---------------------------------------------------------------------------
  // Forecast polling
  // ---------------------------------------------------------------------------

  property var forecast: null

  // When a check last produced an outlook, and when one last came back at all.
  // They are different questions: a request that fails, or answers with nothing
  // usable in it, still happened. Without the second, "has not run yet" and
  // "ran and could not tell you anything" look identical from outside — and the
  // failure backoff means the second can last an hour.
  property double lastCheckTime: 0
  property double lastAnswerTime: 0
  property bool checking: false
  property int consecutiveFailures: 0

  // Highest severity found inside the lead window: 0 clear, 1 light, 2
  // moderate, 3 heavy, 4 severe.
  property int outlookLevel: 0
  property int outlookLeadMinutes: 0

  // Wall-clock time the weather is expected, as "HH:MM". A relative figure
  // alone goes stale the moment it is written: a toast that says "in about 2h"
  // is wrong to anyone who reads it forty minutes later, or who walks back to
  // the machine and finds it waiting. The clock time stays true however long
  // the notification sits there.
  property string outlookAtClock: ""
  property real outlookPrecipitation: 0
  property real outlookCape: 0
  property real outlookGust: 0

  readonly property string outlookLabel: Alerts.levelName(outlookLevel)

  // Everything the last check said, dropped together.
  //
  // A reading is about a place and a moment, and `lastCheckTime` is what the
  // panel reads as "there is a reading". Clearing the outlook while leaving the
  // timestamp behind leaves fair weather asserted for a city that has never
  // been checked — which is the exact failure the wording elsewhere exists to
  // prevent, arrived at from the other direction.
  function discardReading() {
    outlookLevel = 0
    outlookLeadMinutes = 0
    outlookAtClock = ""
    outlookPrecipitation = 0
    outlookCape = 0
    outlookGust = 0
    lastCheckTime = 0
  }

  // Retried from the panel when it opens. See Alerts.shouldRetryForecast for
  // why only a failing check is retried.
  //
  // Seconds rather than the minute the manifest uses. The person this exists
  // for has just reconnected and reopened the panel, which is a thing that
  // happens well inside a minute — a floor long enough to catch them would
  // refuse the one retry that was actually asked for. Overlapping requests are
  // already impossible, so all this bounds is a burst from opening and closing
  // repeatedly, and only while checks are failing, which is usually while there
  // is no network for them to leave on.
  readonly property int minRetryGapMs: 10000

  function refreshIfStale() {
    if (!alertsEnabled || !hasLocation || checking) return
    if (!Alerts.shouldRetryForecast({
      now: Date.now(),
      lastAnswer: lastAnswerTime,
      lastReading: lastCheckTime,
      failing: consecutiveFailures > 0,
      floor: minRetryGapMs,
      cadence: RadarModel.FORECAST_INTERVAL_SEC * 1000
    })) return
    checkNow()
  }

  // What the request in flight was asked about: where, under what name, and
  // over how wide a window. A response is only an answer to the question that
  // was asked, and both halves of the question can move while curl is running.
  //
  // Nothing else closes that gap. checkNow() refuses to start a second request
  // while one is out, so the handlers that react to a change — onLocationChanged
  // and syncAlertConfig — call it and are turned away, and the change is left
  // with nothing running for it. Comparing here is what notices, and what asks
  // again.
  property string requestedFor: ""

  function forecastRequestKey(lat, lon) {
    return lat + "," + lon + "|" + locationName + "|" + forecastSlots
  }

  function checkNow() {
    if (!hasLocation || checking) return

    // Read the coordinates once and confirm they are numbers before building a
    // request out of them. `hasLocation` is derived from a property that other
    // code reassigns, and a plugin reload landing between the two has been seen
    // to reach this with nulls.
    //
    // parseFloat, not Number: an unset location carries null, Number(null) is
    // 0, and a request built from that would quietly report the weather at
    // 0°N 0°E — an alert naming no city, about an ocean. Failing loudly beats
    // answering confidently about the wrong hemisphere.
    var lat = parseFloat(location.latitude)
    var lon = parseFloat(location.longitude)
    if (!isFinite(lat) || !isFinite(lon)) return

    checking = true
    requestedFor = forecastRequestKey(lat, lon)

    // Five coordinates rather than one: the centre and four points 5 km out.
    // See RadarModel.samplePoints — the model grid is coarse enough that a
    // stored coordinate speaks for an arbitrary patch beside it rather than
    // for the town it names. They all travel in one request.
    var points = RadarModel.samplePoints(lat, lon)
    if (points.length === 0) {
      // Unreachable given the check above, but a guard that returns without
      // clearing `checking` would block every later check for the session.
      checking = false
      return
    }

    forecastProc.answered = false
    // One hour more than the window is wide. Each slot is judged against the
    // instability of the hour it falls in, and the slots start at the quarter
    // hour already under way — so a four-hour window ending at 16:00 begins at
    // 12:15 and touches five hours. Without the extra one the last slots have
    // no hour to be judged against and are never promoted.
    forecastProc.command = RadarModel.forecastCommand(
      points, forecastSlots, Math.max(2, Math.ceil(leadMinutes / 60)) + 1)
    forecastProc.running = true
  }

  Process {
    id: forecastProc

    // See manifestProc. `checking` is cleared only from here, so a fork that
    // never happened would leave it set and every later check would return at
    // the door — the alert silently stopping for the rest of the session.
    property bool answered: false

    // Set when this service stops the process itself. The exit code that
    // follows is a cancellation, and counting it would inflate the failure
    // backoff and tell the user the forecast cannot be reached because they
    // turned the alerts off.
    property bool cancelled: false

    onExited: function(exitCode) {
      answered = true
      if (cancelled) {
        cancelled = false
        root.checking = false
        return
      }
      root.applyForecastResponse(exitCode, forecastOut.text)
    }
    onRunningChanged: {
      if (running || answered) return
      if (cancelled) {
        cancelled = false
        root.checking = false
        return
      }
      root.applyForecastResponse(-1, "")
    }

    stdout: StdioCollector { id: forecastOut; waitForEnd: true }
  }

  function applyForecastResponse(exitCode, text) {
    checking = false
    lastAnswerTime = Date.now()

    // Answered a question nobody is asking any more. Applying it would report
    // one place's forecast under another place's name — the body ends with
    // whatever `locationName` holds now, not with the city the request went out
    // for — or would summarise the old window with the new one's slot count.
    // Neither the failure count nor the outlook learns anything from it; what
    // it earns is the request the change never got to make.
    var lat = parseFloat(location.latitude)
    var lon = parseFloat(location.longitude)
    if (requestedFor !== "" && (!isFinite(lat) || !isFinite(lon)
        || forecastRequestKey(lat, lon) !== requestedFor)) {
      requestedFor = ""
      checkNow()
      return
    }
    requestedFor = ""

    if (exitCode !== 0) {
      consecutiveFailures++
      return
    }

    var raw = String(text || "").trim()
    if (raw === "") {
      consecutiveFailures++
      return
    }

    var data
    try {
      data = JSON.parse(raw)
    } catch (e) {
      consecutiveFailures++
      return
    }

    consecutiveFailures = 0
    applyForecast(data)
  }

  function applyForecast(data) {
    var outlook = Alerts.summarizeForecast(data, forecastSlots)
    // Null means the response carried nothing usable. Keeping the previous
    // outlook is right; overwriting it with zeros would report fair weather on
    // the strength of a broken response.
    if (!outlook) return

    forecast = data
    outlookCape = outlook.cape
    outlookGust = outlook.gust
    outlookPrecipitation = outlook.precipitation
    outlookLeadMinutes = outlook.leadMinutes
    outlookAtClock = outlook.clock
    outlookLevel = outlook.level
    lastCheckTime = Date.now()

    evaluateAlert()
  }

  // ---------------------------------------------------------------------------
  // Weather tab
  // ---------------------------------------------------------------------------

  // The point forecast behind the Weather tab: one location asked of
  // Open-Meteo, parsed into everything ui/WeatherView.qml draws. It lives here
  // for the two reasons everything else in this file lives here — a bar widget
  // is built once per monitor, so a fetch in the panel is a fetch made twice —
  // and because a reading held by a panel dies with it, while this one is
  // still here when the panel is rebuilt, and is on disk when the shell
  // restarts.
  //
  // Fetching follows the configured location rather than any panel being open:
  // the bar icon draws the current conditions, so the reading has to be live on
  // an idle bar. It is one request per machine every half hour, shared by every
  // monitor, which is what makes the cadence affordable to run unattended.
  property var weather: null
  property bool weatherFailed: false
  property bool weatherChecking: false

  // Whether the configured place is past its terminator right now. Open-Meteo
  // carries an `is_day` flag, but it belongs to the last forecast fetched, so a
  // stale reading leaves a daytime sun up long after dark. Solar.nighttime
  // computes the answer from the clock at the coordinate instead, and falls
  // back to that flag only when there is no coordinate to compute from.
  property double clockNow: Date.now()
  readonly property bool isNight: {
    var lat = hasLocation ? parseFloat(location.latitude) : NaN
    var lon = hasLocation ? parseFloat(location.longitude) : NaN
    var isDay = weather && weather.current ? weather.current.isDay === true : true
    return Solar.nighttime(lat, lon, isDay, clockNow)
  }

  // Ticked once a minute so the bar flips its glyph at sunset rather than at
  // the next half-hourly fetch, and so a machine that wakes to a stale reading
  // still draws the right sky.
  Timer {
    interval: 60000
    repeat: true
    running: root.hasLocation
    onTriggered: root.clockNow = Date.now()
  }

  // When a response last came back at all, carrying anything usable or not —
  // the two are different questions, and without them apart "has not run yet"
  // and "ran and could not tell you anything" look identical from outside.
  // The cache stamps its record with the same figure, so a reading adopted
  // from disk still says when it was taken.
  property real weatherAnswerTime: 0

  // What the request in flight was asked about: where, under what name. See
  // applyWeatherResponse below for what it is compared against, and
  // `requestedFor` in the forecast section above for why nothing else closes
  // that gap — a response is only an answer to the question that was asked.
  property string weatherRequestedFor: ""

  // Identity of the configured place — the same string latchPlaceKey is built
  // from, for the same reason: a name or a coordinate moving makes a reading
  // a reading about somewhere else.
  function weatherKey() {
    return hasLocation ? location.latitude + "," + location.longitude + "|" + locationName : ""
  }

  // Everything the last reading said, dropped together. See discardReading:
  // keeping any one of it would leave a forecast of one city on screen under
  // the name of another.
  //
  // `weatherRequestedFor` is deliberately not among them. It is not a reading,
  // it is what the request already in flight was asked about — and
  // applyWeatherResponse needs it to recognise that response as an answer
  // about somewhere else. Clearing it here would open the exact hole the
  // stale-question guard exists to close: a city changed while curl is out
  // would let the previous city's answer through, drawn under the new city's
  // name and written to the cache under its key. The next refresh overwrites
  // it anyway.
  function discardWeather() {
    weather = null
    weatherFailed = false
    weatherAnswerTime = 0
  }

  // Asked when the tab is opened, when the location moves under it, and by
  // the cadence timer while at least one panel shows it.
  function refreshWeather() {
    if (!hasLocation || weatherChecking) return

    // Read the coordinates once and confirm they are numbers before building a
    // request out of them, for the reason checkNow gives: parseFloat, not
    // Number, because an unset location carries null, Number(null) is 0, and a
    // request built from that would quietly report the weather at 0°N 0°E.
    var lat = parseFloat(location.latitude)
    var lon = parseFloat(location.longitude)
    if (!isFinite(lat) || !isFinite(lon)) return

    weatherChecking = true
    weatherRequestedFor = weatherKey()

    var command = Weather.weatherCommand(lat, lon)
    // Unreachable given the check above — weatherUrl answers "" only for a
    // coordinate that would not parse — but a guard that returned without
    // clearing `weatherChecking` would block every later fetch for the
    // session.
    if (command.length === 0) {
      weatherChecking = false
      return
    }

    weatherProc.answered = false
    weatherProc.command = command
    weatherProc.running = true

    // The panel opens the Weather tab by asking for a fresh point reading, and
    // the same tab draws the BOM warning and district forecast. Asking for them
    // here keeps that behaviour internal to the service instead of adding a
    // second panel API, and refreshBom refuses to overlap a cycle already out.
    Qt.callLater(refreshBom)
    Qt.callLater(refreshBomObservation)
  }

  Process {
    id: weatherProc

    // See manifestProc. `weatherChecking` is cleared only from here, so a fork
    // that never happened would leave it set and every later fetch would
    // return at the door — the tab silently showing nothing for the rest of
    // the session.
    property bool answered: false

    onExited: function(exitCode) {
      answered = true
      root.applyWeatherResponse(exitCode, weatherOut.text)
    }
    onRunningChanged: if (!running && !answered) root.applyWeatherResponse(-1, "")

    // The collector holds the output and decides nothing: `onStreamFinished`
    // runs before the exit code exists, so a transfer cut short by the time or
    // size ceiling would be read as one that completed.
    stdout: StdioCollector { id: weatherOut; waitForEnd: true }
  }

  function applyWeatherResponse(exitCode, text) {
    // Cleared first and unconditionally: whichever way this ends, the request
    // it belongs to is over. See applyForecastResponse for why it is not
    // cleared behind a guard on the exit code.
    weatherChecking = false
    weatherAnswerTime = Date.now()

    // Answered a question nobody is asking any more. Applying it would put one
    // place's weather on screen under another place's name, because the body
    // describes the coordinates the request went out for and not wherever
    // `location` points now. What the change earns instead is the request it
    // never got to make: refreshWeather() refuses to overlap, so it was turned
    // away at the door while this one was out.
    if (weatherRequestedFor !== "" && weatherRequestedFor !== weatherKey()) {
      weatherRequestedFor = ""
      refreshWeather()
      return
    }
    weatherRequestedFor = ""

    var parsed = exitCode === 0 ? Weather.parseWeather(text) : null
    // A failure keeps whatever is already held: a reading a few hours old
    // still describes the place better than no reading at all, so the tab says
    // the fetch failed rather than emptying itself.
    if (!parsed) {
      weatherFailed = true
      return
    }
    weather = parsed
    weatherFailed = false
    storeWeatherCache(parsed)
  }

  Timer {
    id: weatherTimer
    // Open-Meteo rebuilds its model every few hours, so asking more often only
    // re-fetches the same forecast — and half an hour is short enough that the
    // tab and the bar icon are rarely more than one model run behind. It runs
    // from the location alone: the icon needs a reading with no panel open, and
    // a location the machine does not have is no request to make.
    interval: Weather.WEATHER_REFRESH_MS
    repeat: true
    running: root.hasLocation
    triggeredOnStart: true
    onTriggered: root.refreshWeather()
  }

  // The last good reading, on disk, so that a shell restart draws the tab at
  // once instead of its own "Loading forecast…" while the first request goes
  // out — and so that a reading exists at all when the network does not.
  //
  // It is this plugin's own record, in this plugin's own state directory,
  // written by storeWeatherCache below, and read without a byte ceiling like
  // the alert latch beside it: see test/streams.test.js for why that is
  // bounded by construction rather than by a limit here.
  readonly property string weatherCachePath: Weather.weatherCachePath(Quickshell.env("HOME"))

  // Whether a failed write has already been said. Not "has been saved" — a
  // successful save clears it, so that the next run of failures speaks once
  // more rather than never.
  property bool weatherCacheWarned: false

  FileView {
    id: weatherCacheFile
    path: root.weatherCachePath
    atomicWrites: true
    printErrors: false
    onLoaded: root.receiveWeatherCache(text())
    onLoadFailed: root.receiveWeatherCache("")
    onSaved: root.weatherCacheWarned = false
    onSaveFailed: {
      // Said once per run of failures rather than once per write: the cache
      // is rewritten every half hour, and a full disk would otherwise print
      // the same line all afternoon. The cost of silence is only that a
      // restart starts from nothing.
      if (!root.weatherCacheWarned) {
        console.warn("weather-radar: cannot write " + root.weatherCachePath
          + "; the last forecast is not kept across a shell restart")
      }
      root.weatherCacheWarned = true
    }
  }

  // A record written here, for the place configured now, under this schema
  // version, and nothing else. Hand-edited, truncated by a crash, left behind
  // by another version of the plugin, or carrying a schema number this build
  // does not know — each reads as no cache at all, which is the state a fresh
  // shell starts in anyway, rather than as data to draw. A reading already in
  // hand wins over the one on disk: the cache is where a session begins, and
  // overwriting a live answer with an older file would be going backwards.
  function receiveWeatherCache(text) {
    var record = null
    try {
      record = JSON.parse(String(text || ""))
    } catch (e) {
      record = null
    }

    if (record && typeof record === "object"
        && (record.schema === 1 || record.schema === 2 || record.schema === 3 || record.schema === 4)
        && record.key === weatherKey()
        && record.data && typeof record.data === "object") {
      if (root.weather === null) root.weather = record.data
      root.weatherAnswerTime = Number(record.at) || root.weatherAnswerTime
      // Schemas 2, 3 and 4 carry the BOM reading alongside the point forecast,
      // and a live answer still wins over disk: each is restored only when
      // nothing has arrived for it yet. Schema 3 added the observed rainfall
      // and schema 4 the daily observations it is corrected with.
      if ((record.schema === 2 || record.schema === 3 || record.schema === 4)
          && record.bom && typeof record.bom === "object") {
        if (root.bomWarnings === null) root.bomWarnings = record.bom.warnings || null
        if (root.bomForecast === null) root.bomForecast = record.bom.forecast || null
        if ((record.schema === 3 || record.schema === 4) && root.bomObservation === null)
          root.bomObservation = record.bom.observation || null
        if (record.schema === 4 && root.bomDwo === null)
          root.bomDwo = record.bom.dwo || null
      }
    }

    // The cache is where a session begins, and the live fetch that follows
    // replaces it as soon as it lands; without this a restarted shell would
    // wait out the whole cadence before asking for anything newer.
    Qt.callLater(refreshWeather)
  }

  // Written only on a good answer, so the file is always the last thing that
  // was actually drawn rather than the last thing attempted. The schema number
  // is what lets a later shape refuse this record instead of drawing it. Schema
  // 2 carries the BOM warning and district forecast beside the point forecast,
  // schema 3 adds the Bureau's observed rainfall, and schema 4 the daily
  // observations that correct it, so the tab's whole reading survives a restart
  // in one record.
  function storeWeatherCache(parsed) {
    if (weatherCachePath === "") return
    weatherCacheFile.setText(JSON.stringify({
      schema: 4,
      key: weatherKey(),
      at: Date.now(),
      data: parsed,
      bom: { warnings: root.bomWarnings, forecast: root.bomForecast, observation: root.bomObservation, dwo: root.bomDwo }
    }) + "\n")
  }

  // ---------------------------------------------------------------------------
  // BOM warnings and district forecast
  // ---------------------------------------------------------------------------

  // The second provider beside Open-Meteo: the Bureau's severe-weather warning
  // product and its NSW/ACT district forecast, drawn by the same Weather tab.
  // They live here for the same reasons the point forecast does — one fetch per
  // machine rather than one per monitor, and a reading that outlives a panel —
  // and they travel in that tab's cache. The products are pinned to the ACT
  // rather than geocoded, so no coordinate is asked of them.
  property var bomWarnings: null      // { issuedAt, phase, expiry, warnings: [...] }
  property var bomForecast: null      // { issuedAt, days: [...], synoptic, uv }
  property bool bomChecking: false
  property bool bomFailed: false
  property real bomAnswerTime: 0

  // Which of the two commands is in flight: "warning" then "forecast".
  property string bomStage: ""
  // How many of this cycle's two stages have failed. Only both failing is a
  // failed cycle; one dropped product keeps the other on screen.
  property int bomFailures: 0

  // The warnings that actually concern the reader: those naming a district this
  // location sits in or beside. The product may carry hazards for the rest of
  // the state, and those are not this plugin's to draw.
  readonly property var activeWarnings: {
    if (!bomWarnings || !bomWarnings.warnings) return []
    return bomWarnings.warnings.filter(function(warning) {
      return Bom.warningConcernsHome(warning)
    })
  }

  // Both products, one after the other, through a single process. A shell with
  // no panel open would otherwise have two requests in flight at once for one
  // tab; `bomStage` names which command is out.
  function refreshBom() {
    if (!hasLocation || bomChecking) return
    bomChecking = true
    bomFailures = 0
    bomStage = "warning"
    bomProc.answered = false
    bomProc.command = Bom.warningCommand()
    bomProc.running = true
  }

  Process {
    id: bomProc

    // See manifestProc. `bomChecking` gates every fetch, so a fork that never
    // happened has to be answered here or the warnings never refresh again.
    property bool answered: false

    onExited: function(exitCode) {
      answered = true
      root.applyBomResponse(exitCode, bomOut.text)
    }
    onRunningChanged: if (!running && !answered) root.applyBomResponse(-1, "")

    // The collector holds the output and decides nothing: `onStreamFinished`
    // fires before the exit code exists, so a transfer cut short by a ceiling
    // would read as one that completed.
    stdout: StdioCollector { id: bomOut; waitForEnd: true }
  }

  function applyBomResponse(exitCode, text) {
    // The matching parser for whichever command was out. A null parse or a
    // non-zero exit keeps the previous value, exactly as the point forecast
    // does: one bad product must not blank a warning that is still current.
    var parsed = exitCode === 0
      ? (bomStage === "warning" ? Bom.parseWarnings(text) : Bom.parseForecast(text))
      : null

    if (bomStage === "warning") {
      if (parsed) bomWarnings = parsed
      else bomFailures++
      // The warning has been answered either way; run the forecast stage next.
      // Scheduled rather than started here because `exited` fires before
      // `running` drops, so a start written into this handler would be
      // overwritten by the drop that follows it, and the running-changed guard
      // would then read the drop as a failed forecast fork. `answered` is armed
      // so that guard stays quiet until startBomForecast re-arms the process.
      bomProc.answered = true
      bomStage = "forecast"
      Qt.callLater(root.startBomForecast)
      return
    }

    if (parsed) bomForecast = parsed
    else bomFailures++

    // Both stages are done. The cycle failed only when neither answered, and the
    // answer time is stamped now that there is a complete reading to time.
    bomFailed = bomFailures >= 2
    bomChecking = false
    bomAnswerTime = Date.now()

    // The BOM products arrive separately from the point forecast, so the cache
    // is rewritten here as well. Guarded on a reading already held: a BOM
    // answer with no weather yet must not write `data: null` over the cache.
    if (root.weather !== null) storeWeatherCache(root.weather)
  }

  function startBomForecast() {
    bomProc.answered = false
    bomProc.command = Bom.forecastCommand()
    bomProc.running = true
  }

  Timer {
    id: bomTimer
    // Warnings are reissued as storms move and are worth asking after more
    // often than a forecast changes; the interval lives in Bom.js beside the
    // products it re-asks for. refreshBom fetches both stages each cycle, so
    // the district forecast rides along with the faster warning cadence.
    interval: Bom.WARNING_REFRESH_MS
    repeat: true
    running: root.hasLocation
    triggeredOnStart: true
    onTriggered: root.refreshBom()
  }

  // ---------------------------------------------------------------------------
  // BOM observations
  // ---------------------------------------------------------------------------

  // The Bureau's observed rainfall for this location, beside the modelled
  // record Open-Meteo gives. The model can print 0.0mm through a shower the
  // gauges and radar saw, so the tab carries what the nearest station measured
  // since 9am as its own reading rather than folding it into a forecast it does
  // not describe. One fetch per machine, like everything else here.
  property var bomObservation: null
  property bool bomObsChecking: false
  property bool bomObsFailed: false
  property real bomObsAnswerTime: 0

  // Asked on the warning cadence and whenever the location moves. A location
  // the Bureau cannot answer for — anywhere outside Australia — clears the
  // reading rather than keeping another place's gauge on screen, and asks for
  // nothing.
  function refreshBomObservation() {
    if (!hasLocation || bomObsChecking) return

    var lat = parseFloat(location.latitude)
    var lon = parseFloat(location.longitude)
    if (!isFinite(lat) || !isFinite(lon)) return

    var command = Bom.observationCommand(lat, lon)
    if (command.length === 0) {
      discardBomObservation()
      return
    }

    bomObsChecking = true
    bomObsProc.answered = false
    bomObsProc.command = command
    bomObsProc.running = true
  }

  function discardBomObservation() {
    bomObservation = null
    bomObsFailed = false
    bomObsAnswerTime = 0
  }

  Process {
    id: bomObsProc

    // See manifestProc. `bomObsChecking` gates every fetch, so a fork that
    // never happened has to be answered here or the reading never refreshes.
    property bool answered: false

    onExited: function(exitCode) {
      answered = true
      root.applyBomObservationResponse(exitCode, bomObsOut.text)
    }
    onRunningChanged: if (!running && !answered) root.applyBomObservationResponse(-1, "")

    // The collector holds the output and decides nothing: `onStreamFinished`
    // runs before the exit code exists, so a transfer cut short by a ceiling
    // would read as one that completed.
    stdout: StdioCollector { id: bomObsOut; waitForEnd: true }
  }

  function applyBomObservationResponse(exitCode, text) {
    // Cleared first and unconditionally: whichever way this ends, the request
    // it belongs to is over.
    bomObsChecking = false
    bomObsAnswerTime = Date.now()

    var parsed = exitCode === 0 ? Bom.parseObservations(text) : null
    // A failure keeps whatever is already held, exactly as the point forecast
    // does: a reading a few minutes old still describes the place.
    if (!parsed) {
      bomObsFailed = true
      return
    }
    bomObservation = parsed
    bomObsFailed = false

    // The daily history follows the observation: it is only worth asking for
    // the station the DWO product covers, and only once a day.
    if (bomObservation && bomObservation.station
        && bomObservation.station.bomId === Bom.DWO_STATION_BOM_ID) {
      if (bomDwo === null || bomDwoFetchedDate !== todayDateKey) Qt.callLater(refreshBomDwo)
    } else {
      discardBomDwo()
    }

    // The observation arrives separately from the point forecast, so the cache
    // is rewritten too. Guarded on a reading already held so an observation
    // with no weather yet cannot write `data: null` over the cache.
    if (root.weather !== null) storeWeatherCache(root.weather)
  }

  Timer {
    id: bomObsTimer
    interval: Bom.OBSERVATION_REFRESH_MS
    repeat: true
    running: root.hasLocation
    triggeredOnStart: true
    onTriggered: root.refreshBomObservation()
  }

  // ---------------------------------------------------------------------------
  // BOM daily observations
  // ---------------------------------------------------------------------------

  // The Bureau's observed daily rainfall for this location, when the nearest
  // station is the one the ACT DWO product draws from. It corrects the rain
  // the Open-Meteo model reports for each of the last seven days.
  property var bomDwo: null
  property bool bomDwoChecking: false
  property bool bomDwoFailed: false
  property real bomDwoAnswerTime: 0
  property string bomDwoFetchedDate: ""

  // The local calendar day, so "has the DWO been asked for today" is measured
  // in the reader's own zone rather than in UTC. `getMonth()` is 0-based, so
  // both the `+ 1` and the padding matter.
  readonly property string todayDateKey: {
    var d = new Date(root.clockNow)
    return d.getFullYear() + "-" + (d.getMonth() < 9 ? "0" : "") + (d.getMonth() + 1)
      + "-" + (d.getDate() < 10 ? "0" : "") + d.getDate()
  }

  function refreshBomDwo() {
    if (bomDwoChecking) return
    // Only the station the DWO product is drawn from has a daily history here;
    // anywhere else keeps the modelled record rather than another city's gauge.
    if (!bomObservation || !bomObservation.station
        || bomObservation.station.bomId !== Bom.DWO_STATION_BOM_ID) {
      discardBomDwo()
      return
    }

    var now = new Date(root.clockNow)
    var command = Bom.dwoCommand(now.getFullYear(), now.getMonth() + 1)
    if (command.length === 0) return

    bomDwoChecking = true
    bomDwoProc.answered = false
    bomDwoProc.command = command
    bomDwoProc.running = true
  }

  function discardBomDwo() {
    bomDwo = null
    bomDwoFailed = false
    bomDwoAnswerTime = 0
    bomDwoFetchedDate = ""
  }

  Process {
    id: bomDwoProc
    property bool answered: false
    onExited: function(exitCode) {
      answered = true
      root.applyBomDwoResponse(exitCode, bomDwoOut.text)
    }
    onRunningChanged: if (!running && !answered) root.applyBomDwoResponse(-1, "")
    stdout: StdioCollector { id: bomDwoOut; waitForEnd: true }
  }

  function applyBomDwoResponse(exitCode, text) {
    bomDwoChecking = false
    bomDwoAnswerTime = Date.now()
    var parsed = exitCode === 0 ? Bom.parseDwo(text) : null
    if (!parsed) { bomDwoFailed = true; return }
    bomDwo = parsed
    bomDwoFailed = false
    // The Bureau publishes DWO once a day, so the fetch is dated rather than
    // timed: a parse that succeeded is not re-asked until the day turns.
    bomDwoFetchedDate = todayDateKey
    if (root.weather !== null) storeWeatherCache(root.weather)
  }

  // Open-Meteo's rain, corrected by BOM's observed days and the live gauge
  // reading. Null when there is no observation to correct with, so the tab
  // falls back to the modelled record untouched.
  readonly property var observedRain: {
    if (!weather || !weather.rain) return null
    var days = {}
    if (bomDwo && bomDwo.days) {
      for (var i = 0; i < bomDwo.days.length; i++) {
        var day = bomDwo.days[i]
        if (day && day.date) days[day.date] = day.mm
      }
    }
    var today = (bomObservation && typeof bomObservation.rainSince9am === "number"
      && isFinite(bomObservation.rainSince9am)) ? bomObservation.rainSince9am : null
    var any = today !== null
    for (var key in days) { if (Object.prototype.hasOwnProperty.call(days, key)) { any = true; break } }
    if (!any) return null
    return Weather.mergeObservedRain(weather.rain, { days: days, today: today })
  }

  // ---------------------------------------------------------------------------
  // Alerting
  // ---------------------------------------------------------------------------

  // The level the user was last told about. Held until conditions clear so a
  // storm that lingers for three hours does not notify eighteen times, while a
  // situation that worsens still escalates.
  property int notifiedLevel: 0

  // ...and held across the rebuilds that would otherwise empty it. See
  // Alerts.latchRecord for why the file exists and what it is allowed to say;
  // this half is only the plumbing.
  //
  // Keyed off a binding rather than off `locationKey`: that one is written by
  // the location change handler, which can run before the `hasLocation` binding
  // it consults has been re-evaluated, leaving it empty for the life of a
  // session. A binding is always current by the time a forecast lands.
  readonly property string latchPlaceKey: hasLocation
    ? location.latitude + "," + location.longitude + "|" + locationName
    : ""
  property bool latchLoaded: false
  property var storedLatch: null
  property bool latchEvaluatePending: false

  // A machine can have nowhere to keep it (no home), or refuse to (a state
  // directory that is read-only, a full disk). Neither stops an alert: the
  // latch is held in memory, and the only cost is that a reload of the
  // service could announce a storm again. A write that fails is said once.
  readonly property string latchPath: Alerts.latchFilePath(Quickshell.env("HOME"))
  property bool latchWriteFailed: false

  FileView {
    id: latchFile
    path: root.latchPath
    atomicWrites: true
    printErrors: false
    onLoaded: root.receiveLatch(text())
    onLoadFailed: root.receiveLatch("")
    onSaved: root.latchWriteFailed = false
    onSaveFailed: {
      if (!root.latchWriteFailed) {
        console.warn("weather-radar: cannot write " + root.latchPath
          + "; storm alerts still work, but a reload of the plugin may repeat one")
      }
      root.latchWriteFailed = true
    }
  }

  // A FileView with no path neither loads nor fails, and deciding an alert
  // waits for the latch to be read, so with no file it is read as empty now.
  Component.onCompleted: if (latchPath === "") receiveLatch("")

  function receiveLatch(text) {
    var record = null
    try {
      record = JSON.parse(String(text || ""))
    } catch (e) {
      record = null
    }
    storedLatch = record && typeof record === "object" ? record : null
    latchLoaded = true
    adoptLatch()

    // A check can finish before the file does. Holding the verdict rather than
    // dropping it means the first reading of a session is still acted on, once
    // the service knows what it has already said.
    if (latchEvaluatePending) {
      latchEvaluatePending = false
      evaluateAlert()
    }
  }

  // Take up the stored latch once both halves are known. This file and the
  // location file load independently and either can win, so adoption is
  // attempted from both sides rather than assuming an order. Adoption only ever
  // raises the latch, so worsening weather still escalates.
  function adoptLatch() {
    if (!latchLoaded) return
    var level = Alerts.adoptedLevel(storedLatch, latchPlaceKey, Date.now(), Alerts.LATCH_MAX_AGE_MS)
    if (level > notifiedLevel) notifiedLevel = level
  }

  function storeLatch(level) {
    storedLatch = Alerts.latchRecord(level, latchPlaceKey, Date.now())
    if (latchPath !== "") latchFile.setText(JSON.stringify(storedLatch || { level: 0 }) + "\n")
  }

  function evaluateAlert() {
    // Deciding before the stored latch has been read is deciding without
    // knowing what has already been said, which is how the same storm gets
    // announced twice.
    if (!latchLoaded) {
      latchEvaluatePending = true
      return
    }

    // Every in-memory reset that was not a deliberate clear — a rebuild, most
    // of all — is undone here, before the decision that reads it.
    adoptLatch()

    var decision = Alerts.decideNotification(outlookLevel, notifiedLevel, alertThreshold, alertsEnabled)
    // Written only when it moved. A latch that rewrites its own file every ten
    // minutes for an unchanged value is disk traffic standing in for a fact
    // that did not change.
    if (decision.notifiedLevel !== notifiedLevel) storeLatch(decision.notifiedLevel)
    notifiedLevel = decision.notifiedLevel
    if (decision.notify) notify()
  }

  function notify() {
    var text = Alerts.notificationText({
      level: outlookLevel,
      leadMinutes: outlookLeadMinutes,
      clock: outlookAtClock,
      precipitation: outlookPrecipitation,
      cape: outlookCape,
      gust: outlookGust
    }, locationName)

    // Deliberately no click action. A click on a toast means "I have seen
    // this, go away" to almost everyone, and taking that gesture to open a
    // window instead answers a question the reader did not ask: they have been
    // told it is going to rain, which is the whole point of telling them.
    notifyProc.command = [
      "omarchy-notification-send",
      "--app-name", "Weather Radar",
      // The same glyph the bar widget wears, so the toast is recognisably from
      // this plugin before a word of it is read.
      "-g", Glyphs.RADAR,
      "-u", text.urgency,
      text.headline,
      text.description
    ]
    notifyProc.running = true
  }

  Process {
    id: notifyProc
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  // RainViewer publishes a frame every ten minutes and the forecast model
  // updates no faster, so this is both the floor and the natural cadence.
  // Backing off on repeated failure keeps a network outage from turning into a
  // tight retry loop inside a process that lives all day.
  readonly property int baseIntervalMs: RadarModel.FRAME_INTERVAL_SEC * 1000
  readonly property int backoffMultiplier: Math.min(6, Math.pow(2, Math.min(consecutiveFailures, 3)))

  // The alert check's cadence. The map's frame list is not asked for here: it
  // has its own schedule, timed from the newest frame (scheduleManifestCheck).
  //
  // The backoff belongs to the alert check alone, because only the forecast can
  // raise it, and it stands down while the map is open, where the alert's line
  // is on screen and someone is looking at it. With nobody watching, an hour
  // between attempts is the right courtesy to a service having a bad day.
  Timer {
    id: pollTimer
    readonly property bool alerting: root.alertsEnabled && root.hasLocation
    readonly property bool watched: root.frameConsumers > 0
    interval: root.baseIntervalMs * (alerting && !watched ? root.backoffMultiplier : 1)
    repeat: true
    running: alerting
    triggeredOnStart: true
    onTriggered: root.checkNow()
  }

  // Changing the threshold or the radius is as deliberate as flipping the
  // toggle, and deserves the same answer: re-arm and report the current state
  // rather than leaving the user to wonder for up to ten minutes.
  //
  // The two need different work. A new threshold only changes the question,
  // and the reading in hand still answers it, so it is re-evaluated in place.
  // A new radius moves the lead window, which means the held reading is about
  // the wrong horizon and has to be fetched again.
  //
  // Both are ignored the first time they settle, because settings arrive after
  // the service is constructed: their initial jump from defaults to stored
  // values is startup, not a decision.
  property string appliedThreshold: ""
  property int appliedRadius: 0

  onAlertThresholdChanged: applyAlertConfig()
  onAlertRadiusKmChanged: applyAlertConfig()
  onSettingsReadyChanged: applyAlertConfig()

  // Coalesced to the end of the turn. Bindings re-evaluate one at a time, so a
  // single settings arrival moves the radius and the threshold in separate
  // steps; comparing at each step would record the first as the baseline and
  // read the second as a decision nobody made. Qt.callLater collapses repeated
  // calls into one, so the comparison sees a settled state.
  function applyAlertConfig() {
    Qt.callLater(syncAlertConfig)
  }

  function syncAlertConfig() {
    if (!settingsReady) return

    var first = appliedThreshold === ""
    var thresholdMoved = !first && appliedThreshold !== alertThreshold
    var radiusMoved = !first && appliedRadius !== alertRadiusKm

    appliedThreshold = alertThreshold
    appliedRadius = alertRadiusKm

    if (first || (!thresholdMoved && !radiusMoved)) return

    notifiedLevel = 0
    storeLatch(0)
    if (radiusMoved) {
      if (hasLocation && alertsEnabled) checkNow()
    } else {
      evaluateAlert()
    }
  }

  // Turning alerts off must actually stop the work, not merely hide it.
  onAlertsEnabledChanged: {
    if (!alertsEnabled) {
      notifiedLevel = 0
      storeLatch(0)
      discardReading()
      // Stopping the process produces an exit code, and it is not an outage.
      if (forecastProc.running) forecastProc.cancelled = true
      forecastProc.running = false
      checking = false
    } else if (hasLocation) {
      checkNow()
    }
  }

  // ---------------------------------------------------------------------------
  // Summary for the bar
  // ---------------------------------------------------------------------------

  readonly property string barSummary: {
    if (!hasLocation) return ""
    if (!alertsEnabled) return ""
    // No reading at all while checks are failing is not fair weather. "clear"
    // there would be the plugin's own silence dressed up as an answer.
    if (lastCheckTime <= 0) return consecutiveFailures > 0 ? "unavailable" : ""
    if (outlookLevel === 0) return "clear"
    // Clock rather than countdown: the label only refreshes when a check runs,
    // so a relative figure would be up to ten minutes out of date on screen,
    // while a time stays correct between checks.
    var when = outlookAtClock !== "" ? outlookAtClock
      : (outlookLeadMinutes <= 0 ? "now" : Alerts.humanizeMinutes(outlookLeadMinutes))
    return outlookLabel.toLowerCase() + " " + when
  }
}

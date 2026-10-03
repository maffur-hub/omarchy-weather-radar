// Live lightning strikes, one JSON line per stroke.
//
// The feed is LightningMaps' own WebSocket topic at wss://live2.lightningmaps.org.
// It is undocumented community data drawn from the Blitzortung detection
// network: no availability guarantee, no schema, and it may change or vanish
// without notice. That is why the map falls back to the archive tiles whenever
// this process cannot run.
//
// One connection is made, to a host fixed here rather than read from anything
// the server sends, and the subscription is bounded to a box around the
// configured location. The process is long-lived: it reconnects with
// exponential backoff, and the QML side kills it when the layer is no longer
// needed.
//
// Node's built-in global WebSocket is used so there is no npm dependency and
// nothing to install. That global exists from Node 22; on an older Node this
// file throws on `new WebSocket` and the parent process sees it exit, which is
// exactly the "no stream" state the fallback handles.
//
// One strike per line, never a whole message: SplitParser on the QML side
// hands the parent a bounded line at a time, and lib/Strikes.js caps what is
// retained, so a burst of strokes cannot arrive as one unbounded read.

// A closed stdout — the parent stopping the reader before SIGTERM lands — must
// not become an unhandled write error and an ugly stack trace; there is no
// reader left, so exiting is the whole of the recovery.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); });

const a = process.argv.slice(2).map(Number);
const WORLD = [85, 180, -85, -180];
const p = (a.length === 4 && a.every(Number.isFinite)) ? a : WORLD;
const sub = { v:24,i:{},s:false,x:0,w:0,tx:0,tw:1,a:4,z:8,b:true,h:"",l:1,t:1,from_lightningmaps_org:true,p, r:"A" };
let ws, backoff=1000, stopped=false, first=true;
const seen = new Set();
const emit=o=>process.stdout.write(JSON.stringify(o)+"\n");
function connect(){ if(stopped)return;
  ws=new WebSocket("wss://live2.lightningmaps.org/");
  ws.onopen=()=>{ backoff=1000; ws.send(JSON.stringify(sub)); };
  ws.onmessage=e=>{ let m; try{m=JSON.parse(e.data)}catch{return}
    // The hello carries `time`/`cid`; a strike batch carries `strokes`. Only
    // those mean the subscription was accepted. A `{"message":"bye!"}` first
    // must not be read as ready, or the panel would drop the archive fallback
    // for a stream that is not there.
    if(first && (m.time !== undefined || m.cid !== undefined || m.strokes)){first=false; emit({ready:true, p});}
    if(m.time&&m.strokes) for(const s of m.strokes){ if(seen.has(s.id)) continue; seen.add(s.id); if(seen.size>20000) seen.clear(); emit({t:s.time,lat:s.lat,lon:s.lon,id:s.id}); } };
  ws.onerror=()=>{};
  ws.onclose=()=>{ if(!stopped) setTimeout(connect, backoff=Math.min(backoff*2,30000)); };
}
process.on("SIGTERM",()=>{stopped=true; try{ws&&ws.close()}catch{}; process.exit(0)});
process.on("SIGINT",()=>{stopped=true; try{ws&&ws.close()}catch{}; process.exit(0)});
connect();

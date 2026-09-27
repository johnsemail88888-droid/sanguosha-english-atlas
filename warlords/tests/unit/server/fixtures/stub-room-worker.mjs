// A stand-in for dist-headless/room-worker.mjs that follows the room worker contract
// (server/rooms.mjs) without the game: it opens a relay room as its host and counts every
// guest the relay announces as a connected human. The room name picks a behaviour:
//   (anything else)  normal: ready → status on each join / leave → idle / shutdown exits
//   'hang'           never gets ready (the server's ready timeout)
//   'crash'          throws while starting (an uncaught error in the worker)
//   'bail'           says closing{reason:'relay'} and exits(1) before it is ready
//   'crash-later'    gets ready, then throws 150 ms later
//   'stubborn'       gets ready but ignores {type:'shutdown'} (terminated after the grace)
import { parentPort, workerData } from 'node:worker_threads';

const { relayUrl, name, emptyLobbyMs, noHumansMs } = workerData;
const post = (m) => parentPort.postMessage(m);
const enc = new TextEncoder();

/** [flags u8][idLen u8][id][payload] — a reliable text frame to `to` ('*' = every guest) */
function frame(to, text) {
  const id = enc.encode(to);
  const body = enc.encode(text);
  const out = new Uint8Array(2 + id.length + body.length);
  out[0] = 0;
  out[1] = id.length;
  out.set(id, 2);
  out.set(body, 2 + id.length);
  return out;
}

if (name === 'crash') throw new Error('stub crash while starting');
if (name === 'bail') {
  post({ type: 'closing', reason: 'relay', detail: 'stub bails out' });
  process.exit(1);
}

let ws = null;
let humans = 0;
let everJoined = false;
let emptySince = Date.now();
let closing = false;

function status() {
  post({ type: 'status', phase: 'lobby', humans, bots: 0, players: humans });
}

function close(reason, detail) {
  if (closing) return;
  closing = true;
  try {
    ws?.send(frame('*', JSON.stringify({ t: 'leave' })));
  } catch {
    /* gone */
  }
  post({ type: 'closing', reason, ...(detail ? { detail } : {}) });
  try {
    ws?.close(1000, 'room closed');
  } catch {
    /* gone */
  }
  setTimeout(() => process.exit(0), 50);
}

parentPort.on('message', (m) => {
  if (m?.type === 'shutdown' && name !== 'stubborn') close('shutdown');
});

if (name !== 'hang') {
  ws = new WebSocket(relayUrl);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ op: 'create', v: 1 }));
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const msg = JSON.parse(ev.data);
    if (msg.op === 'created') {
      post({ type: 'ready', code: msg.code });
      post({ type: 'log', msg: `stub room ${msg.code} open` });
      status();
      if (name === 'crash-later') setTimeout(() => {
        throw new Error('stub crash in the match');
      }, 150);
    } else if (msg.op === 'peerJoin') {
      humans++;
      everJoined = true;
      status();
    } else if (msg.op === 'peerLeave') {
      humans = Math.max(0, humans - 1);
      if (humans === 0) emptySince = Date.now();
      status();
    }
  };
  ws.onclose = () => {
    if (!closing) close('relay', 'relay socket closed');
  };
  setInterval(() => {
    if (closing || humans > 0) return;
    const limit = everJoined ? noHumansMs : emptyLobbyMs;
    if (Date.now() - emptySince >= limit) close('idle');
  }, 50);
}

import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, SyncMode } from '@duet/ot';
import { Room, send, type Member } from './room';
import { memoryStore, postgresStore } from './store';

const PORT = Number(process.env.PORT ?? 4000);
const MODE: SyncMode = process.env.DUET_SYNC === 'naive' ? 'naive' : 'ot';
const MAX_PEERS = Number(process.env.DUET_MAX_PEERS ?? 4);
const HEARTBEAT_MS = Number(process.env.DUET_HEARTBEAT_MS ?? 30_000);
const MAX_ROOMS = Number(process.env.DUET_MAX_ROOMS ?? 1000);
const EMPTY_ROOM_TTL_MS = Number(process.env.DUET_EMPTY_ROOM_TTL_MS ?? 30 * 60_000);
const ROOM_ID = /^[\w-]{1,64}$/;
const USER_ID = /^[\w-]{8,64}$/;
const HOST_KEY = /^[\w-]{16,64}$/;

// Without DATABASE_URL nothing is saved and rooms live only in memory.
const store = process.env.DATABASE_URL ? await postgresStore(process.env.DATABASE_URL) : memoryStore;

/** Rooms in memory. A room is a promise while it loads from the database. */
const rooms = new Map<string, Promise<Room>>();
function getRoom(id: string) {
  let room = rooms.get(id);
  if (!room) {
    room = Room.open(id, MODE, MAX_PEERS, store);
    rooms.set(id, room);
    room.catch(() => rooms.delete(id));
  }
  return room;
}

// A room nobody has been in for EMPTY_ROOM_TTL_MS leaves memory. With a database it is still saved,
// and the next visitor reloads it; without one, it is gone.
setInterval(() => {
  const cutoff = Date.now() - EMPTY_ROOM_TTL_MS;
  for (const [id, pending] of rooms) {
    pending.then(room => { if (room.emptySince !== null && room.emptySince < cutoff) rooms.delete(id); }, () => {});
  }
}, Math.min(60_000, EMPTY_ROOM_TTL_MS));

const json = (res: import('node:http').ServerResponse, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://duet');
  // Liveness check for the host (Render pings this before routing traffic).
  if (url.pathname === '/health') return json(res, { ok: true, mode: MODE, rooms: rooms.size, saved: store !== memoryStore });

  // The rooms this browser has been in, newest first, for the front page. The front end is on another
  // host, so this one answer is readable cross-origin. The id is the browser's own random id.
  if (url.pathname === '/api/recent') {
    const user = url.searchParams.get('user') ?? '';
    if (!USER_ID.test(user)) return void res.writeHead(400).end();
    try {
      return json(res, await store.recent(user), { 'access-control-allow-origin': '*' });
    } catch {
      return void res.writeHead(503).end();
    }
  }

  // Everything typed in a saved room, for the replay page. Anyone with the room's link can already join it
  // and read the text, so the history is open to the same people. Cross-origin, like /api/recent.
  const replay = url.pathname.match(/^\/api\/rooms\/([\w-]{1,64})\/history$/);
  if (replay) {
    const cors = { 'access-control-allow-origin': '*' };
    try {
      const history = await store.history(replay[1]);
      return history ? json(res, history, cors) : void res.writeHead(404, cors).end();
    } catch {
      return void res.writeHead(503, cors).end();
    }
  }

  // Read-only room state, used by the e2e test to compare browser tabs with the server.
  const match = url.pathname.match(/^\/api\/rooms\/([\w-]{1,64})$/);
  const room = match && rooms.has(match[1]) ? await rooms.get(match[1]) : null;
  if (!room) return void res.writeHead(404).end();
  json(res, { revision: room.doc.revision, text: room.doc.text, peers: room.members.size });
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 1 << 20 });

// Heartbeat: ping every socket each interval. One that hasn't answered the previous ping is gone
// (laptop lid closed, network dropped without a FIN) and is terminated, which frees its room slot
// and removes its cursor. The pings also stop hosting proxies from closing idle connections.
const alive = new WeakSet<WebSocket>();
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) { ws.terminate(); continue; }
    alive.delete(ws);
    ws.ping();
  }
}, HEARTBEAT_MS);

wss.on('connection', ws => {
  let room: Room | undefined;
  let member: Member | null = null;
  let closed = false;
  // One message at a time per connection, so a join that waits on the database can't be overtaken.
  let queue: Promise<void> = Promise.resolve();
  alive.add(ws);
  ws.on('pong', () => alive.add(ws));

  const fail = (message: string) => {
    send(ws, { t: 'error', message });
    ws.close();
  };

  const onMessage = async (raw: string) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(raw); } catch { return fail('invalid JSON'); }

    if (!member) {
      if (msg.t !== 'join' || typeof msg.room !== 'string' || !ROOM_ID.test(msg.room)) return fail('join first');
      if (!rooms.has(msg.room) && rooms.size >= MAX_ROOMS) return fail('server is full, try again later');
      const r = room = await getRoom(msg.room);
      const user = typeof msg.user === 'string' && USER_ID.test(msg.user) ? msg.user : undefined;
      const key = typeof msg.key === 'string' && HOST_KEY.test(msg.key) ? msg.key : undefined;
      const client = typeof msg.client === 'string' && USER_ID.test(msg.client) ? msg.client : undefined;
      const since = msg.since && Number.isSafeInteger(msg.since.code) && Number.isSafeInteger(msg.since.problem) ? msg.since : undefined;
      member = await r.enqueue(() => r.join(ws, String(msg.name ?? ''), user, key, client, since));
      if (!member) return fail('room is full');
      if (closed) r.leave(member); // the socket closed while the room was loading
      return;
    }
    const m = member;
    await room!.enqueue(() => room!.handle(m, msg));
  };

  ws.on('message', raw => {
    queue = queue.then(() => onMessage(raw.toString())).catch(e => fail((e as Error).message));
  });
  ws.on('close', () => { closed = true; if (member) room!.leave(member); });
  ws.on('error', () => ws.close());
});

http.listen(PORT, () => console.log(
  `duet server on :${PORT} (sync mode: ${MODE}, max ${MAX_PEERS} per room, rooms ${store === memoryStore ? 'in memory only' : 'saved to Postgres'})`));

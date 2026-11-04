import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { ClientMsg, SyncMode } from '@duet/ot';
import { Room, send, type Member } from './room';

const PORT = Number(process.env.PORT ?? 4000);
const MODE: SyncMode = process.env.DUET_SYNC === 'naive' ? 'naive' : 'ot';
const MAX_PEERS = Number(process.env.DUET_MAX_PEERS ?? 4);
const ROOM_ID = /^[\w-]{1,64}$/;

const rooms = new Map<string, Room>();

const http = createServer((req, res) => {
  // Read-only room state, used by the e2e test to compare browser tabs with the server.
  const match = req.url?.match(/^\/api\/rooms\/([\w-]{1,64})$/);
  const room = match && rooms.get(match[1]);
  if (!room) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ revision: room.doc.revision, text: room.doc.text, peers: room.members.size }));
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 1 << 20 });

wss.on('connection', ws => {
  let room: Room | undefined;
  let member: Member | null = null;

  const fail = (message: string) => {
    send(ws, { t: 'error', message });
    ws.close();
  };

  ws.on('message', raw => {
    let msg: ClientMsg;
    try { msg = JSON.parse(raw.toString()); } catch { return fail('invalid JSON'); }

    if (!member) {
      if (msg.t !== 'join' || typeof msg.room !== 'string' || !ROOM_ID.test(msg.room)) return fail('join first');
      room = rooms.get(msg.room) ?? new Room(msg.room, MODE, MAX_PEERS);
      rooms.set(room.id, room);
      member = room.join(ws, String(msg.name ?? ''));
      if (!member) fail('room is full');
      return;
    }
    try { room!.handle(member, msg); } catch (e) { fail((e as Error).message); }
  });

  ws.on('close', () => { if (member) room!.leave(member); });
  ws.on('error', () => ws.close());
});

http.listen(PORT, () => console.log(`duet server on :${PORT} (sync mode: ${MODE}, max ${MAX_PEERS} per room)`));

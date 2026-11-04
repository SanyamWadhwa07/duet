import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { isOp, ServerDoc, targetLength, type ClientMsg, type Peer, type ServerMsg, type SyncMode } from '@duet/ot';

const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599'];
const MAX_DOC_CHARS = 200_000;

export type Member = Peer & { ws: WebSocket };

export function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** One shared document and the 2-4 people editing it. All state is in memory (Week 1). */
export class Room {
  readonly doc = new ServerDoc();
  readonly members = new Map<string, Member>();

  constructor(readonly id: string, readonly mode: SyncMode, readonly maxPeers: number) {}

  /** Adds a member and sends them the current document. Returns null if the room is full. */
  join(ws: WebSocket, name: string): Member | null {
    if (this.members.size >= this.maxPeers) return null;
    const used = new Set([...this.members.values()].map(m => m.color));
    const member: Member = {
      id: randomUUID().slice(0, 8),
      name: name.trim().slice(0, 32) || 'Guest',
      color: COLORS.find(c => !used.has(c)) ?? COLORS[0],
      ws,
    };
    send(ws, {
      t: 'init', mode: this.mode, rev: this.doc.revision, doc: this.doc.text,
      you: member.id, peers: [...this.members.values()].map(peerInfo),
    });
    this.broadcast(member, { t: 'join', peer: peerInfo(member) });
    this.members.set(member.id, member);
    return member;
  }

  leave(member: Member) {
    if (this.members.delete(member.id)) this.broadcast(member, { t: 'leave', id: member.id });
  }

  /** Handles one message from a member. Throws on a protocol violation; the caller disconnects them. */
  handle(member: Member, msg: ClientMsg) {
    switch (msg.t) {
      case 'op': {
        if (this.mode !== 'ot' || !isOp(msg.op)) throw new Error('bad op');
        if (targetLength(msg.op) > MAX_DOC_CHARS) throw new Error('document too large');
        const committed = this.doc.receive(msg.rev, msg.op);
        send(member.ws, { t: 'ack' });
        this.broadcast(member, { t: 'op', op: committed });
        return;
      }
      case 'file': {
        // Naive baseline (like Code-Sync's FILE_UPDATED): relay the whole file, no ordering or merging.
        if (this.mode !== 'naive' || typeof msg.doc !== 'string') throw new Error('bad file');
        if (msg.doc.length > MAX_DOC_CHARS) throw new Error('document too large');
        this.doc.text = msg.doc; // kept only so a late joiner gets the latest file
        this.broadcast(member, { t: 'file', doc: msg.doc });
        return;
      }
      case 'sel': {
        const sel = msg.sel;
        if (!Array.isArray(sel) || sel.length !== 2 || !sel.every(Number.isSafeInteger)) throw new Error('bad selection');
        this.broadcast(member, { t: 'sel', id: member.id, sel });
        return;
      }
      default:
        throw new Error('unknown message');
    }
  }

  /** Sends to everyone in the room except `from`. Serialises once for all receivers. */
  private broadcast(from: Member, msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (m !== from && m.ws.readyState === m.ws.OPEN) m.ws.send(data);
    }
  }
}

const peerInfo = ({ id, name, color }: Member): Peer => ({ id, name, color });

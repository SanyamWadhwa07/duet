import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  isOp, ServerDoc, targetLength,
  type ClientMsg, type DocId, type Language, type Peer, type RoomSettings, type RunReport, type ServerMsg, type SyncMode,
} from '@duet/ot';

const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599'];
const MAX_DOC_CHARS = 200_000;
const LANGUAGES: Language[] = ['javascript', 'python', 'cpp'];
const STATUSES = ['passed', 'failed', 'ran', 'error', 'timeout'];
const MAX_TESTS = 20, MAX_FIELD = 10_000, MAX_REPORT_BYTES = 100_000;
const isText = (x: unknown, max = MAX_FIELD): x is string => typeof x === 'string' && x.length <= max;

export type Member = Peer & { ws: WebSocket };

export function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** One room: the code, the problem statement, small shared settings, and the 2-4 people in it.
 *  All state is in memory until the Week 3 op log. */
export class Room {
  readonly docs: Record<DocId, ServerDoc> = { code: new ServerDoc(), problem: new ServerDoc() };
  readonly members = new Map<string, Member>();
  settings: RoomSettings = { language: 'python', tests: [], timerStartedAt: null };
  lastRun: RunReport | null = null;
  /** When the last member left (ms since epoch), or null while someone is in the room. */
  emptySince: number | null = Date.now();

  constructor(readonly id: string, readonly mode: SyncMode, readonly maxPeers: number) {}

  get doc() { return this.docs.code; }

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
      problem: { rev: this.docs.problem.revision, doc: this.docs.problem.text },
      settings: this.settings, lastRun: this.lastRun,
    });
    this.broadcast(member, { t: 'join', peer: peerInfo(member) });
    this.members.set(member.id, member);
    this.emptySince = null;
    return member;
  }

  leave(member: Member) {
    if (this.members.delete(member.id)) this.broadcast(member, { t: 'leave', id: member.id });
    if (this.members.size === 0) this.emptySince = Date.now();
  }

  /** Handles one message from a member. Throws on a protocol violation; the caller disconnects them. */
  handle(member: Member, msg: ClientMsg) {
    switch (msg.t) {
      case 'op': {
        const id = msg.doc ?? 'code';
        if (id !== 'code' && id !== 'problem') throw new Error('bad document');
        // The naive baseline only changes how the code syncs; the problem statement always uses OT.
        if ((id === 'code' && this.mode !== 'ot') || !isOp(msg.op)) throw new Error('bad op');
        if (targetLength(msg.op) > MAX_DOC_CHARS) throw new Error('document too large');
        const committed = this.docs[id].receive(msg.rev, msg.op);
        // Code messages carry no `doc` field, so they stay byte-for-byte what the benchmarks measured.
        send(member.ws, id === 'code' ? { t: 'ack' } : { t: 'ack', doc: id });
        this.broadcast(member, id === 'code' ? { t: 'op', op: committed } : { t: 'op', doc: id, op: committed });
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
      case 'settings': {
        this.settings = { ...this.settings, ...cleanSettings(msg.settings) };
        this.broadcast(null, { t: 'settings', settings: this.settings });
        return;
      }
      case 'run': {
        // Who ran it comes from the connection, not from the message.
        this.lastRun = { ...cleanReport(msg.report), by: member.name, at: Date.now() };
        this.broadcast(null, { t: 'run', report: this.lastRun });
        return;
      }
      default:
        throw new Error('unknown message');
    }
  }

  /** Sends to everyone in the room except `from` (null: everyone). Serialises once for all receivers. */
  private broadcast(from: Member | null, msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (m !== from && m.ws.readyState === m.ws.OPEN) m.ws.send(data);
    }
  }
}

const peerInfo = ({ id, name, color }: Member): Peer => ({ id, name, color });

function cleanSettings(s: Partial<RoomSettings>): Partial<RoomSettings> {
  if (!s || typeof s !== 'object') throw new Error('bad settings');
  const out: Partial<RoomSettings> = {};
  if ('language' in s) {
    if (!LANGUAGES.includes(s.language!)) throw new Error('bad language');
    out.language = s.language;
  }
  if ('tests' in s) {
    const tests = s.tests;
    if (!Array.isArray(tests) || tests.length > MAX_TESTS || !tests.every(c => c && isText(c.input) && isText(c.expected))) {
      throw new Error('bad tests');
    }
    out.tests = tests.map(({ input, expected }) => ({ input, expected }));
  }
  if ('timerStartedAt' in s) {
    if (s.timerStartedAt !== null && !Number.isSafeInteger(s.timerStartedAt)) throw new Error('bad timer');
    out.timerStartedAt = s.timerStartedAt;
  }
  return out;
}

function cleanReport(r: Pick<RunReport, 'language' | 'results'>): Pick<RunReport, 'language' | 'results'> {
  const ok = r && LANGUAGES.includes(r.language) && Array.isArray(r.results) && r.results.length <= MAX_TESTS
    && JSON.stringify(r).length <= MAX_REPORT_BYTES
    && r.results.every(x => x && isText(x.input) && (x.expected === null || isText(x.expected))
      && isText(x.output, MAX_REPORT_BYTES) && isText(x.error, MAX_REPORT_BYTES)
      && Number.isFinite(x.ms) && STATUSES.includes(x.status));
  if (!ok) throw new Error('bad run report');
  return {
    language: r.language,
    results: r.results.map(({ input, expected, output, error, ms, status }) => ({ input, expected, output, error, ms, status })),
  };
}

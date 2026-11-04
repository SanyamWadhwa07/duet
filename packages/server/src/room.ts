import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  isOp, ServerDoc, targetLength,
  type ClientMsg, type DocId, type Language, type Peer, type Role, type RoomSettings, type RunReport, type ServerMsg, type SyncMode,
} from '@duet/ot';
import { SNAPSHOT_EVERY, type Store } from './store';

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
 *  The live copy is in memory; every committed op is also saved to the store (Postgres, if configured). */
export class Room {
  readonly docs: Record<DocId, ServerDoc> = { code: new ServerDoc(), problem: new ServerDoc() };
  readonly members = new Map<string, Member>();
  settings: RoomSettings = { language: 'python', tests: [], timerStartedAt: null };
  lastRun: RunReport | null = null;
  /** When the last member left (ms since epoch), or null while someone is in the room. */
  emptySince: number | null = Date.now();
  private title = '';
  /** The interviewer key: a secret held by the browser that created the room (and any co-interviewer). */
  private hostKey: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private saves: Promise<unknown> = Promise.resolve();

  constructor(readonly id: string, readonly mode: SyncMode, readonly maxPeers: number, private store: Store) {}

  /** Loads a saved room (latest snapshot + the ops after it), or starts an empty one. */
  static async open(id: string, mode: SyncMode, maxPeers: number, store: Store): Promise<Room> {
    const room = new Room(id, mode, maxPeers, store);
    const saved = await store.load(id);
    if (saved) {
      for (const doc of ['code', 'problem'] as DocId[]) {
        const { base, text, ops } = saved.docs[doc];
        room.docs[doc] = new ServerDoc(text, base);
        room.docs[doc].replay(ops);
      }
      if (saved.settings) room.settings = saved.settings;
      room.lastRun = saved.lastRun ?? null;
      room.hostKey = saved.hostKey ?? null;
      room.title = titleOf(room.docs.problem.text);
    }
    return room;
  }

  get doc() { return this.docs.code; }

  /**
   * Runs `task` after every earlier task for this room. Ops are committed, saved and announced inside
   * one queue, so every client hears about them in the order they were committed and saved.
   */
  enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Adds a member and sends them the current document. Returns null if the room is full.
   * Whoever presents the room's interviewer key is an interviewer; everyone else is a candidate.
   * A room's first key becomes its interviewer key: the creator's browser makes one when it creates the room.
   */
  join(ws: WebSocket, name: string, user?: string, key?: string): Member | null {
    if (this.members.size >= this.maxPeers) return null;
    if (key && this.hostKey === null) {
      this.hostKey = key;
      this.saveRoom();
    }
    const role: Role = key && key === this.hostKey ? 'interviewer' : 'candidate';
    const used = new Set([...this.members.values()].map(m => m.color));
    const member: Member = {
      id: randomUUID().slice(0, 8),
      name: name.trim().slice(0, 32) || 'Guest',
      color: COLORS.find(c => !used.has(c)) ?? COLORS[0],
      role,
      ws,
    };
    send(ws, {
      t: 'init', mode: this.mode, rev: this.doc.revision, doc: this.doc.text,
      you: member.id, role, peers: [...this.members.values()].map(peerInfo),
      problem: { rev: this.docs.problem.revision, doc: this.docs.problem.text },
      settings: this.settings, lastRun: this.lastRun,
    });
    this.broadcast(member, { t: 'join', peer: peerInfo(member) });
    this.members.set(member.id, member);
    this.emptySince = null;
    if (user) this.save(this.store.visit(user, this.id));
    return member;
  }

  leave(member: Member) {
    if (this.members.delete(member.id)) this.broadcast(member, { t: 'leave', id: member.id });
    if (this.members.size === 0) this.emptySince = Date.now();
  }

  /** Handles one message from a member. Throws on a protocol violation; the caller disconnects them. */
  async handle(member: Member, msg: ClientMsg) {
    switch (msg.t) {
      case 'op': {
        const id = msg.doc ?? 'code';
        if (id !== 'code' && id !== 'problem') throw new Error('bad document');
        // The naive baseline only changes how the code syncs; the problem statement always uses OT.
        if ((id === 'code' && this.mode !== 'ot') || !isOp(msg.op)) throw new Error('bad op');
        if (id === 'problem' && member.role !== 'interviewer') throw new Error('only the interviewer can edit the problem');
        if (targetLength(msg.op) > MAX_DOC_CHARS) throw new Error('document too large');
        const doc = this.docs[id];
        const committed = doc.receive(msg.rev, msg.op);
        // Saved before the ack: an op the sender saw acknowledged survives a crash.
        await this.save(this.store.appendOp(this.id, id, doc.revision - 1, committed, member.name));
        if (doc.revision % SNAPSHOT_EVERY === 0) await this.save(this.store.snapshot(this.id, id, doc.revision, doc.text));
        if (id === 'problem' && titleOf(doc.text) !== this.title) {
          this.title = titleOf(doc.text);
          this.saveRoom();
        }
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
        const change = cleanSettings(msg.settings);
        // Anyone may pick the language; the tests and the timer belong to the interviewer.
        if (member.role !== 'interviewer' && ('tests' in change || 'timerStartedAt' in change)) {
          throw new Error('only the interviewer can change the tests or the timer');
        }
        this.settings = { ...this.settings, ...change };
        this.broadcast(null, { t: 'settings', settings: this.settings });
        this.saveRoom();
        return;
      }
      case 'run': {
        // Who ran it comes from the connection, not from the message.
        this.lastRun = { ...cleanReport(msg.report), by: member.name, at: Date.now() };
        this.broadcast(null, { t: 'run', report: this.lastRun });
        this.saveRoom();
        return;
      }
      default:
        throw new Error('unknown message');
    }
  }

  /**
   * Saves settings, last run and title. Saves run one after another and each writes the room's state at
   * the time it runs; two in flight at once could land out of order and an older one would win.
   */
  private saveRoom() {
    this.saves = this.saves.then(() => this.save(this.store.saveRoom(this.id, {
      settings: this.settings, lastRun: this.lastRun, title: this.title, hostKey: this.hostKey,
    })));
  }

  /** Saving is best effort: if the database is down the room keeps working from memory, and says so in the log. */
  private save(p: Promise<void>) {
    return p.catch(e => console.error(`room ${this.id}: save failed: ${(e as Error).message}`));
  }

  /** Sends to everyone in the room except `from` (null: everyone). Serialises once for all receivers. */
  private broadcast(from: Member | null, msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (m !== from && m.ws.readyState === m.ws.OPEN) m.ws.send(data);
    }
  }
}

const peerInfo = ({ id, name, color, role }: Member): Peer => ({ id, name, color, role });

/** The problem's first non-empty line, without Markdown heading marks: the room's name in "Your rooms". */
const titleOf = (problem: string) =>
  (problem.split('\n').find(line => line.trim()) ?? '').replace(/^#+/, '').trim().slice(0, 80);

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

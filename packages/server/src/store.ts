// Where rooms are saved. With DATABASE_URL set: an append-only op log per room and document, a full-text
// snapshot every SNAPSHOT_EVERY ops, and one row of settings per room, in Postgres. Without it nothing is
// saved and rooms live only in memory, as in Week 1.
import pg from 'pg';
import type { DocId, Op, RoomSettings, RunReport } from '@duet/ot';

export const SNAPSHOT_EVERY = 200;
const DOCS: DocId[] = ['code', 'problem'];

export type SavedDoc = { base: number; text: string; ops: Op[] };
export type SavedRoom = { settings: RoomSettings | null; lastRun: RunReport | null; docs: Record<DocId, SavedDoc> };
export type RecentRoom = { room: string; title: string; lastSeen: string };

export interface Store {
  /** The room's latest snapshot per document plus every op after it, or null for a new room. */
  load(room: string): Promise<SavedRoom | null>;
  /** Saves op number `rev` (it took the document from revision rev to rev + 1). */
  appendOp(room: string, doc: DocId, rev: number, op: Op, author: string): Promise<void>;
  snapshot(room: string, doc: DocId, rev: number, text: string): Promise<void>;
  saveRoom(room: string, settings: RoomSettings, lastRun: RunReport | null, title: string): Promise<void>;
  /** Remembers that this browser (or signed-in user) was in this room, for the "Your rooms" list. */
  visit(user: string, room: string): Promise<void>;
  recent(user: string): Promise<RecentRoom[]>;
}

export const memoryStore: Store = {
  load: async () => null,
  appendOp: async () => {},
  snapshot: async () => {},
  saveRoom: async () => {},
  visit: async () => {},
  recent: async () => [],
};

const SCHEMA = `
create table if not exists rooms (
  id text primary key,
  settings jsonb,
  last_run jsonb,
  title text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists ops (
  room_id text not null,
  doc text not null,
  rev integer not null,
  op jsonb not null,
  author text not null,
  created_at timestamptz not null default now(),
  primary key (room_id, doc, rev)
);
create table if not exists snapshots (
  room_id text not null,
  doc text not null,
  rev integer not null,
  text text not null,
  created_at timestamptz not null default now(),
  primary key (room_id, doc, rev)
);
create table if not exists visits (
  user_id text not null,
  room_id text not null,
  last_seen timestamptz not null default now(),
  primary key (user_id, room_id)
);`;

export async function postgresStore(url: string): Promise<Store> {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  await pool.query(SCHEMA);
  const ensureRoom = (room: string) => pool.query('insert into rooms (id) values ($1) on conflict do nothing', [room]);

  return {
    async load(room) {
      const r = await pool.query('select settings, last_run from rooms where id = $1', [room]);
      if (!r.rowCount) return null;
      const docs = {} as Record<DocId, SavedDoc>;
      for (const doc of DOCS) {
        const snap = await pool.query(
          'select rev, text from snapshots where room_id = $1 and doc = $2 order by rev desc limit 1', [room, doc]);
        const base: number = snap.rowCount ? snap.rows[0].rev : 0;
        const ops = await pool.query(
          'select op from ops where room_id = $1 and doc = $2 and rev >= $3 order by rev', [room, doc, base]);
        docs[doc] = { base, text: snap.rowCount ? snap.rows[0].text : '', ops: ops.rows.map(row => row.op) };
      }
      return { settings: r.rows[0].settings, lastRun: r.rows[0].last_run, docs };
    },
    async appendOp(room, doc, rev, op, author) {
      if (rev === 0) await ensureRoom(room);
      // jsonb wants a JSON string; a JS array would be sent as a Postgres array.
      await pool.query('insert into ops (room_id, doc, rev, op, author) values ($1, $2, $3, $4, $5)',
        [room, doc, rev, JSON.stringify(op), author]);
    },
    async snapshot(room, doc, rev, text) {
      await pool.query('insert into snapshots (room_id, doc, rev, text) values ($1, $2, $3, $4) on conflict do nothing',
        [room, doc, rev, text]);
    },
    async saveRoom(room, settings, lastRun, title) {
      await pool.query(
        `insert into rooms (id, settings, last_run, title, updated_at) values ($1, $2, $3, $4, now())
         on conflict (id) do update set settings = $2, last_run = $3, title = $4, updated_at = now()`,
        [room, JSON.stringify(settings), lastRun && JSON.stringify(lastRun), title]);
    },
    async visit(user, room) {
      await ensureRoom(room);
      await pool.query(
        `insert into visits (user_id, room_id) values ($1, $2)
         on conflict (user_id, room_id) do update set last_seen = now()`, [user, room]);
    },
    async recent(user) {
      const r = await pool.query(
        `select v.room_id, r.title, v.last_seen from visits v join rooms r on r.id = v.room_id
         where v.user_id = $1 order by v.last_seen desc limit 20`, [user]);
      return r.rows.map(row => ({ room: row.room_id, title: row.title, lastSeen: row.last_seen.toISOString() }));
    },
  };
}

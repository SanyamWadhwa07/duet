// Wire protocol between browser/bot clients and the server. Every message is one JSON object.
import type { Op } from './operation';

export type SyncMode = 'ot' | 'naive';
/** The interviewer writes the problem, tests and timer; the candidate solves. Both write code and run it. */
export type Role = 'interviewer' | 'candidate';
export type Peer = { id: string; name: string; color: string; role: Role };
/** A selection as [anchor, head] offsets into the document; equal values mean a plain cursor. */
export type Selection = [number, number];

/** A room holds two synced documents. Messages without `doc` refer to the code. */
export type DocId = 'code' | 'problem';
export type Language = 'javascript' | 'python' | 'cpp';
export type TestCase = { input: string; expected: string };
/** Small shared room state. Last writer wins: rarely edited by two people at once. */
export type RoomSettings = {
  /** The session's name, e.g. "Mock with Ravi: graphs". Empty until the interviewer names it. */
  name?: string;
  language: Language;
  tests: TestCase[];
  timerStartedAt: number | null;
};
export type RunStatus = 'passed' | 'failed' | 'ran' | 'error' | 'timeout';
export type TestResult = { input: string; expected: string | null; output: string; error: string; ms: number; status: RunStatus };
/** One press of Run, shown to everyone in the room. `by` and `at` are set by the server. */
export type RunReport = { by: string; at: number; language: Language; results: TestResult[] };
/** An op a reconnecting client missed. `mine` marks its own in-flight op whose ack was lost. */
export type CatchUp = { op: Op; mine: boolean };
/** One committed op for replay: who typed it (display name) and when (ms since the epoch). */
export type HistoryOp = { at: number; by: string; op: Op };
/** A saved room's history (GET /api/rooms/:id/history): both documents' ops from revision 0, in order. */
export type History = { name: string; title: string; language: Language; code: HistoryOp[]; problem: HistoryOp[] };

export type ClientMsg =
  // user: this browser's id, for "Your rooms". key: the room's interviewer key, if this browser holds it.
  // client: this page's id, stable across reconnects. since: on a reconnect, the revisions it has seen.
  | { t: 'join'; room: string; name: string; user?: string; key?: string; client?: string; since?: Record<DocId, number> }
  | { t: 'op'; doc?: DocId; rev: number; op: Op } // an op based on server revision `rev`
  | { t: 'file'; doc: string } // naive mode: the whole code file after a change
  | { t: 'sel'; sel: Selection } // presence in the code: ephemeral, not part of the document history
  | { t: 'settings'; settings: Partial<RoomSettings> }
  | { t: 'run'; report: Pick<RunReport, 'language' | 'results'> };

export type ServerMsg =
  | {
      t: 'init'; mode: SyncMode; rev: number; doc: string; you: string; role: Role; peers: Peer[];
      problem: { rev: number; doc: string }; settings: RoomSettings; lastRun: RunReport | null;
      /** On a reconnect the server can serve: what was missed since `since`, instead of a fresh copy. */
      catchUp?: Record<DocId, CatchUp[]>;
    }
  | { t: 'ack'; doc?: DocId }
  | { t: 'op'; doc?: DocId; op: Op }
  | { t: 'file'; doc: string }
  | { t: 'sel'; id: string; sel: Selection }
  | { t: 'join'; peer: Peer }
  | { t: 'leave'; id: string }
  | { t: 'settings'; settings: RoomSettings }
  | { t: 'run'; report: RunReport }
  | { t: 'error'; message: string };

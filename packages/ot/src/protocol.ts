// Wire protocol between browser/bot clients and the server. Every message is one JSON object.
import type { Op } from './operation';

export type SyncMode = 'ot' | 'naive';
export type Peer = { id: string; name: string; color: string };
/** A selection as [anchor, head] offsets into the document; equal values mean a plain cursor. */
export type Selection = [number, number];

/** A room holds two synced documents. Messages without `doc` refer to the code. */
export type DocId = 'code' | 'problem';
export type Language = 'javascript' | 'python' | 'cpp';
export type TestCase = { input: string; expected: string };
/** Small shared room state. Last writer wins: rarely edited by two people at once. */
export type RoomSettings = { language: Language; tests: TestCase[]; timerStartedAt: number | null };
export type RunStatus = 'passed' | 'failed' | 'ran' | 'error' | 'timeout';
export type TestResult = { input: string; expected: string | null; output: string; error: string; ms: number; status: RunStatus };
/** One press of Run, shown to everyone in the room. `by` and `at` are set by the server. */
export type RunReport = { by: string; at: number; language: Language; results: TestResult[] };

export type ClientMsg =
  | { t: 'join'; room: string; name: string; user?: string } // user: this browser's id, for "Your rooms"
  | { t: 'op'; doc?: DocId; rev: number; op: Op } // an op based on server revision `rev`
  | { t: 'file'; doc: string } // naive mode: the whole code file after a change
  | { t: 'sel'; sel: Selection } // presence in the code: ephemeral, not part of the document history
  | { t: 'settings'; settings: Partial<RoomSettings> }
  | { t: 'run'; report: Pick<RunReport, 'language' | 'results'> };

export type ServerMsg =
  | {
      t: 'init'; mode: SyncMode; rev: number; doc: string; you: string; peers: Peer[];
      problem: { rev: number; doc: string }; settings: RoomSettings; lastRun: RunReport | null;
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

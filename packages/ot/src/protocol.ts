// Wire protocol between browser/bot clients and the server. Every message is one JSON object.
import type { Op } from './operation';

export type SyncMode = 'ot' | 'naive';
export type Peer = { id: string; name: string; color: string };
/** A selection as [anchor, head] offsets into the document; equal values mean a plain cursor. */
export type Selection = [number, number];

export type ClientMsg =
  | { t: 'join'; room: string; name: string }
  | { t: 'op'; rev: number; op: Op } // ot mode: an op based on server revision `rev`
  | { t: 'file'; doc: string } // naive mode: the whole file after a change
  | { t: 'sel'; sel: Selection }; // presence: ephemeral, not part of the document history

export type ServerMsg =
  | { t: 'init'; mode: SyncMode; rev: number; doc: string; you: string; peers: Peer[] }
  | { t: 'ack' }
  | { t: 'op'; op: Op }
  | { t: 'file'; doc: string }
  | { t: 'sel'; id: string; sel: Selection }
  | { t: 'join'; peer: Peer }
  | { t: 'leave'; id: string }
  | { t: 'error'; message: string };

import { apply, transform, type Op } from './operation';

/** Who sent an op: the client's id for this page, and the op's sequence number from that client. */
export type Author = { client: string; seq: number };
export type Entry = { op: Op; author: Author | null };

/**
 * The server's copy of a document. It puts every op in one order (its revision number),
 * transforming ops that were based on an older revision past everything committed since.
 * A document reloaded from a snapshot starts at that snapshot's revision (`base`), not 0.
 */
export class ServerDoc {
  /** Ops committed after `base`: history[k] took the document from revision base+k to base+k+1. */
  readonly history: Op[] = [];
  private readonly authors: (Author | null)[] = [];
  private readonly lastSeq = new Map<string, number>();

  constructor(public text = '', readonly base = 0) {}

  get revision() { return this.base + this.history.length; }

  /** True if this client's op `seq` was already committed (a resend of something already applied). */
  isDuplicate(author: Author) {
    return (this.lastSeq.get(author.client) ?? -1) >= author.seq;
  }

  /** Commits an op the client based on `revision`. Returns the op as committed (to broadcast). */
  receive(revision: number, op: Op, author: Author | null = null): Op {
    if (!Number.isInteger(revision) || revision < this.base || revision > this.revision) {
      throw new Error(`bad revision ${revision} (server holds ${this.base}..${this.revision})`);
    }
    // Client op goes first, matching OTClient.remote, so both sides break ties the same way.
    for (const committed of this.history.slice(revision - this.base)) [op] = transform(op, committed);
    this.text = apply(this.text, op);
    this.record(op, author);
    return op;
  }

  /** Re-applies ops that were already committed (rebuilding from a snapshot plus the log after it). */
  replay(ops: Op[], authors: (Author | null)[] = []) {
    ops.forEach((op, k) => {
      this.text = apply(this.text, op);
      this.record(op, authors[k] ?? null);
    });
  }

  /**
   * Everything committed at or after `revision`, with who sent it: what a reconnecting client missed.
   * Null if this copy no longer goes back that far (it was reloaded from a later snapshot).
   */
  since(revision: number): Entry[] | null {
    if (!Number.isInteger(revision) || revision < this.base || revision > this.revision) return null;
    const from = revision - this.base;
    return this.history.slice(from).map((op, k) => ({ op, author: this.authors[from + k] }));
  }

  private record(op: Op, author: Author | null) {
    this.history.push(op);
    this.authors.push(author);
    if (author) this.lastSeq.set(author.client, Math.max(author.seq, this.lastSeq.get(author.client) ?? -1));
  }
}

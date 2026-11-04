import { apply, transform, type Op } from './operation';

/**
 * The server's copy of a document. It puts every op in one order (its revision number),
 * transforming ops that were based on an older revision past everything committed since.
 * A document reloaded from a snapshot starts at that snapshot's revision (`base`), not 0.
 */
export class ServerDoc {
  /** Ops committed after `base`: history[k] took the document from revision base+k to base+k+1. */
  readonly history: Op[] = [];

  constructor(public text = '', readonly base = 0) {}

  get revision() { return this.base + this.history.length; }

  /** Commits an op the client based on `revision`. Returns the op as committed (to broadcast). */
  receive(revision: number, op: Op): Op {
    if (!Number.isInteger(revision) || revision < this.base || revision > this.revision) {
      throw new Error(`bad revision ${revision} (server holds ${this.base}..${this.revision})`);
    }
    // Client op goes first, matching OTClient.remote, so both sides break ties the same way.
    for (const committed of this.history.slice(revision - this.base)) [op] = transform(op, committed);
    this.text = apply(this.text, op);
    this.history.push(op);
    return op;
  }

  /** Re-applies ops that were already committed (rebuilding from a snapshot plus the log after it). */
  replay(ops: Op[]) {
    for (const op of ops) {
      this.text = apply(this.text, op);
      this.history.push(op);
    }
  }
}

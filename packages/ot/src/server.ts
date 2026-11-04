import { apply, transform, type Op } from './operation';

/**
 * The server's copy of a document. It puts every op in one order (its revision number),
 * transforming ops that were based on an older revision past everything committed since.
 */
export class ServerDoc {
  readonly history: Op[] = [];

  constructor(public text = '') {}

  get revision() { return this.history.length; }

  /** Commits an op the client based on `revision`. Returns the op as committed (to broadcast). */
  receive(revision: number, op: Op): Op {
    if (!Number.isInteger(revision) || revision < 0 || revision > this.revision) {
      throw new Error(`bad revision ${revision} (server is at ${this.revision})`);
    }
    // Client op goes first, matching OTClient.remote, so both sides break ties the same way.
    for (const committed of this.history.slice(revision)) [op] = transform(op, committed);
    this.text = apply(this.text, op);
    this.history.push(op);
    return op;
  }
}

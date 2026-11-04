import { compose, transform, type Op } from './operation';

/**
 * Client side of the protocol. At most one op is in flight (`outstanding`); local edits made
 * while waiting for its ack are composed into `buffer` and sent when the ack arrives.
 * The same class drives the browser editor and the load-test bots.
 */
export class OTClient {
  outstanding: Op | null = null;
  buffer: Op | null = null;

  constructor(
    public revision: number,
    private send: (revision: number, op: Op) => void,
    private applyRemote: (op: Op) => void,
  ) {}

  get synced() { return this.outstanding === null; }

  /** The local user changed the document (the change is already applied locally). */
  local(op: Op) {
    if (!this.outstanding) {
      this.outstanding = op;
      this.send(this.revision, op);
    } else {
      this.buffer = this.buffer ? compose(this.buffer, op) : op;
    }
  }

  /** The server committed our outstanding op. */
  ack() {
    this.committed();
    if (this.outstanding) this.send(this.revision, this.outstanding);
  }

  /** Another client's op, as committed by the server. Transform it past our pending edits, then apply. */
  remote(op: Op) {
    this.revision++;
    if (this.outstanding) [this.outstanding, op] = transform(this.outstanding, op);
    if (this.buffer) [this.buffer, op] = transform(this.buffer, op);
    this.applyRemote(op);
  }

  /**
   * After a reconnect: the ops the server committed since our `revision`, in order. One marked `mine`
   * is our outstanding op whose ack was lost, so it counts as committed, not applied a second time.
   * Sends nothing; the caller then calls `resend()`. (Whatever was in flight on the old connection is
   * ignored by the server, so the outstanding op is either in `entries` or was never committed.)
   */
  catchUp(entries: { op: Op; mine: boolean }[]) {
    for (const entry of entries) {
      if (entry.mine && this.outstanding) this.committed();
      else this.remote(entry.op);
    }
  }

  /** Sends the op in flight, if any, based on the current revision: on a new connection after `catchUp`. */
  resend() {
    if (this.outstanding) this.send(this.revision, this.outstanding);
  }

  /** Our outstanding op is committed; the buffered edits, if any, become the next op in flight. */
  private committed() {
    if (!this.outstanding) throw new Error('ack with no outstanding op');
    this.revision++;
    this.outstanding = this.buffer;
    this.buffer = null;
  }
}

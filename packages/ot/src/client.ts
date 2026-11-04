import { compose, transform, type Op } from './operation';

/**
 * Client side of the protocol. At most one op is in flight (`outstanding`); local edits made
 * while waiting for its ack are composed into `buffer` and sent when the ack arrives.
 * Every op sent gets the next sequence number, so after a reconnect the server and client can tell
 * whether the op in flight was committed (its ack was lost) or never arrived.
 * The same class drives the browser editor and the load-test bots.
 */
export class OTClient {
  outstanding: Op | null = null;
  buffer: Op | null = null;
  /** Sequence number of `outstanding`. */
  outstandingSeq = -1;
  private seq = 0;

  constructor(
    public revision: number,
    private send: (revision: number, op: Op, seq: number) => void,
    private applyRemote: (op: Op) => void,
  ) {}

  get synced() { return this.outstanding === null; }

  /** The local user changed the document (the change is already applied locally). */
  local(op: Op) {
    if (!this.outstanding) {
      this.outstanding = op;
      this.outstandingSeq = ++this.seq;
      this.send(this.revision, op, this.outstandingSeq);
    } else {
      this.buffer = this.buffer ? compose(this.buffer, op) : op;
    }
  }

  /** The server committed our outstanding op. */
  ack() {
    if (!this.outstanding) throw new Error('ack with no outstanding op');
    this.revision++;
    this.outstanding = this.buffer;
    this.buffer = null;
    if (this.outstanding) {
      this.outstandingSeq = ++this.seq;
      this.send(this.revision, this.outstanding, this.outstandingSeq);
    }
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
   * is our outstanding op whose ack was lost, so it counts as acked, not applied a second time.
   * If the outstanding op is not among them it never reached the server, so it is sent again.
   */
  catchUp(entries: { op: Op; mine: boolean }[]) {
    let resend = this.outstanding !== null;
    for (const entry of entries) {
      if (entry.mine && this.outstanding) {
        this.ack();
        resend = false; // ack() already sent the buffer, if any, as the new outstanding op
      } else {
        this.remote(entry.op);
      }
    }
    if (resend && this.outstanding) this.send(this.revision, this.outstanding, this.outstandingSeq);
  }
}

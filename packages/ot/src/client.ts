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
    if (!this.outstanding) throw new Error('ack with no outstanding op');
    this.revision++;
    this.outstanding = this.buffer;
    this.buffer = null;
    if (this.outstanding) this.send(this.revision, this.outstanding);
  }

  /** Another client's op, as committed by the server. Transform it past our pending edits, then apply. */
  remote(op: Op) {
    this.revision++;
    if (this.outstanding) [this.outstanding, op] = transform(this.outstanding, op);
    if (this.buffer) [this.buffer, op] = transform(this.buffer, op);
    this.applyRemote(op);
  }
}

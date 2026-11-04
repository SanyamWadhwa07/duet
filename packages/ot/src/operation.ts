// A text operation walks the whole document left to right as a list of components:
//   positive integer n  -> retain (skip) n characters
//   string s            -> insert s at this point
//   negative integer -n -> delete the next n characters
// Lengths are UTF-16 code units, the same unit as JS string indexes and Monaco offsets.
export type Component = number | string;
export type Op = Component[];

const isInsert = (c: Component | undefined): c is string => typeof c === 'string';
const isRetain = (c: Component | undefined): c is number => typeof c === 'number' && c > 0;
const isDelete = (c: Component | undefined): c is number => typeof c === 'number' && c < 0;
const size = (c: Component) => (typeof c === 'string' ? c.length : Math.abs(c));

// Appends a component in canonical form: neighbours of the same kind are merged,
// and an insert always sits before a delete at the same position.
function push(op: Op, c: Component): void {
  if (c === 0 || c === '') return;
  const last = op[op.length - 1];
  if (isInsert(c)) {
    if (isInsert(last)) op[op.length - 1] = last + c;
    else if (isDelete(last)) {
      const prev = op[op.length - 2];
      if (isInsert(prev)) op[op.length - 2] = prev + c;
      else op.splice(op.length - 1, 0, c);
    } else op.push(c);
  } else if (typeof last === 'number' && Math.sign(last) === Math.sign(c)) {
    op[op.length - 1] = last + c;
  } else op.push(c);
}

export class OpBuilder {
  readonly op: Op = [];
  retain(n: number) { push(this.op, n); return this; }
  insert(s: string) { push(this.op, s); return this; }
  delete(n: number) { push(this.op, -n); return this; }
}

/** Length of the document this op applies to. */
export function baseLength(op: Op): number {
  let n = 0;
  for (const c of op) if (!isInsert(c)) n += Math.abs(c);
  return n;
}

/** Length of the document after applying this op. */
export function targetLength(op: Op): number {
  let n = 0;
  for (const c of op) if (!isDelete(c)) n += size(c);
  return n;
}

/** True if `x` is a well-formed op (used to validate what arrives off the wire). */
export function isOp(x: unknown): x is Op {
  return Array.isArray(x) && x.every(c =>
    (typeof c === 'string' && c.length > 0) || (Number.isSafeInteger(c) && c !== 0));
}

export function apply(doc: string, op: Op): string {
  if (baseLength(op) !== doc.length) {
    throw new Error(`op base length ${baseLength(op)} != document length ${doc.length}`);
  }
  let out = '';
  let i = 0;
  for (const c of op) {
    if (isInsert(c)) out += c;
    else if (c > 0) { out += doc.slice(i, i + c); i += c; }
    else i -= c;
  }
  return out;
}

// Reads an op one component at a time, allowing the caller to take part of a component.
class Reader {
  private i = 0;
  private head: Component | undefined;
  constructor(private op: Op) { this.head = op[0]; }
  peek() { return this.head; }
  take(n = Infinity): Component {
    const c = this.head!;
    if (n >= size(c)) { this.head = this.op[++this.i]; return c; }
    if (isInsert(c)) { this.head = c.slice(n); return c.slice(0, n); }
    const sign = Math.sign(c);
    this.head = c - sign * n;
    return sign * n;
  }
}

/** One op with the same effect as applying `a` then `b`. */
export function compose(a: Op, b: Op): Op {
  if (targetLength(a) !== baseLength(b)) throw new Error('compose: length mismatch');
  const out: Op = [];
  const ra = new Reader(a), rb = new Reader(b);
  while (ra.peek() !== undefined || rb.peek() !== undefined) {
    if (isDelete(ra.peek())) { push(out, ra.take()); continue; } // b never saw these chars
    if (isInsert(rb.peek())) { push(out, rb.take()); continue; } // b's insert consumes nothing of a
    const n = Math.min(size(ra.peek()!), size(rb.peek()!));
    const ca = ra.take(n), cb = rb.take(n);
    if (isRetain(cb)) push(out, ca);        // b keeps what a left: a's retain or insert survives
    else if (isRetain(ca)) push(out, cb);   // b deletes an original char
    // else a inserted text that b deleted: they cancel out
  }
  return out;
}

/**
 * Given concurrent ops a and b on the same document, returns [a', b'] such that
 * apply(apply(d, a), b') === apply(apply(d, b), a').
 * Tie-break: when both insert at the same position, a's insert goes first.
 */
export function transform(a: Op, b: Op): [Op, Op] {
  if (baseLength(a) !== baseLength(b)) throw new Error('transform: base length mismatch');
  const a1: Op = [], b1: Op = [];
  const ra = new Reader(a), rb = new Reader(b);
  while (ra.peek() !== undefined || rb.peek() !== undefined) {
    if (isInsert(ra.peek())) { const s = ra.take() as string; push(a1, s); push(b1, s.length); continue; }
    if (isInsert(rb.peek())) { const s = rb.take() as string; push(a1, s.length); push(b1, s); continue; }
    const ca = ra.peek()!, cb = rb.peek()!;
    const n = Math.min(size(ca), size(cb));
    ra.take(n); rb.take(n);
    if (isRetain(ca) && isRetain(cb)) { push(a1, n); push(b1, n); }
    else if (isDelete(ca) && isRetain(cb)) push(a1, -n); // only a deletes these chars
    else if (isRetain(ca) && isDelete(cb)) push(b1, -n); // only b deletes these chars
    // both deleted the same chars: neither transformed op needs to touch them
  }
  return [a1, b1];
}

/** Where a position in the old document ends up after `op`. Inserts at the position push it right. */
export function transformIndex(index: number, op: Op): number {
  let oldPos = 0;
  let result = index;
  for (const c of op) {
    if (oldPos > index) break;
    if (isInsert(c)) result += c.length;
    else if (c > 0) oldPos += c;
    else { result -= Math.min(-c, index - oldPos); oldPos -= c; }
  }
  return result;
}

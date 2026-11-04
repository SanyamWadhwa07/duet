// Reconnect property test. Clients type unique characters while their connections drop at random,
// losing whatever was in flight in both directions (ops on their way up, acks and ops on their way down).
// A dropped client reconnects by asking for everything committed since its revision (catch-up).
// At the end every character typed must be in the document exactly once: nothing lost, nothing doubled.
import { describe, expect, it } from 'vitest';
import { apply, OpBuilder, OTClient, ServerDoc, type Op } from '../src';
import { int, rng } from './random';

const SCALE = Number(process.env.OT_SCALE ?? 1);
const RUNS = 3_000 * SCALE;

type Up = { revision: number; op: Op };
type Down = { ack: true } | { op: Op };
type Sim = { id: string; ot: OTClient; doc: string; online: boolean; up: Up[]; down: Down[] };

function run(seed: number) {
  const rand = rng(seed);
  const server = new ServerDoc();
  let next = 0x4e00; // each keystroke types a character no one else has typed
  const typed: string[] = [];

  const clients: Sim[] = [];
  const count = 2 + int(rand, 3);
  for (let k = 0; k < count; k++) {
    const sim = { id: `c${k}`, doc: '', online: true, up: [], down: [] } as unknown as Sim;
    sim.ot = new OTClient(0,
      (revision, op) => { if (sim.online) sim.up.push({ revision, op }); }, // a send on a dead socket is lost
      op => { sim.doc = apply(sim.doc, op); });
    clients.push(sim);
  }

  const type = (c: Sim) => {
    const ch = String.fromCodePoint(next++);
    typed.push(ch);
    const at = int(rand, c.doc.length + 1);
    const op = new OpBuilder().retain(at).insert(ch).retain(c.doc.length - at).op;
    c.doc = apply(c.doc, op);
    c.ot.local(op);
  };
  const serverReceive = (c: Sim) => {
    const { revision, op } = c.up.shift()!;
    const committed = server.receive(revision, op, c.id);
    for (const other of clients) if (other.online) other.down.push(other === c ? { ack: true } : { op: committed });
  };
  const clientReceive = (c: Sim) => {
    const msg = c.down.shift()!;
    if ('ack' in msg) c.ot.ack(); else c.ot.remote(msg.op);
  };
  // Clearing `up` is the server ignoring whatever still arrives on a connection the page has replaced.
  const drop = (c: Sim) => { c.online = false; c.up = []; c.down = []; };
  const reconnect = (c: Sim) => {
    c.online = true;
    const missed = server.since(c.ot.revision)!;
    c.ot.catchUp(missed.map(e => ({ op: e.op, mine: e.author === c.id })));
    c.ot.resend();
  };
  const pick = (ok: (c: Sim) => boolean) => {
    const ready = clients.filter(ok);
    return ready.length ? ready[int(rand, ready.length)] : null;
  };

  const steps = 40 + int(rand, 160);
  for (let s = 0; s < steps; s++) {
    const r = rand();
    if (r < 0.35) type(clients[int(rand, clients.length)]); // offline clients keep typing into their buffer
    else if (r < 0.6) { const c = pick(c => c.up.length > 0); if (c) serverReceive(c); }
    else if (r < 0.85) { const c = pick(c => c.down.length > 0); if (c) clientReceive(c); }
    else if (r < 0.93) { const c = pick(c => c.online); if (c) drop(c); }
    else { const c = pick(c => !c.online); if (c) reconnect(c); }
  }

  for (const c of clients) if (!c.online) reconnect(c);
  for (;;) {
    const up = pick(c => c.up.length > 0), down = pick(c => c.down.length > 0);
    if (!up && !down) break;
    if (up && (!down || rand() < 0.5)) serverReceive(up); else clientReceive(down!);
  }

  for (const c of clients) {
    expect(c.ot.synced).toBe(true);
    expect(c.doc).toBe(server.text);
  }
  expect([...server.text].sort()).toEqual([...typed].sort()); // every keystroke exactly once
}

describe('reconnect', { timeout: 60_000 * SCALE }, () => {
  it(`dropped connections lose nothing and double nothing (${RUNS} runs)`, () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      try { run(seed); } catch (e) { throw new Error(`seed ${seed}: ${(e as Error).message}`); }
    }
  });

  it('since() lists what a client missed, with who sent it, and refuses revisions it no longer holds', () => {
    const doc = new ServerDoc('ab', 5);
    doc.receive(5, [1, 'x', 1], 'c1');
    doc.receive(6, [3, 'y'], 'c2');
    expect(doc.since(6)).toEqual([{ op: [3, 'y'], author: 'c2' }]);
    expect(doc.since(7)).toEqual([]);
    expect(doc.since(4)).toBeNull(); // before the snapshot: the client must start over
    expect(doc.since(8)).toBeNull(); // ahead of the server: not a revision this copy has seen
  });
});

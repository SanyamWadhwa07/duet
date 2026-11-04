// Randomized property tests. Each case is seeded; a failure reports the seed so it can be replayed.
// Counts are reported in docs/METRICS.md. OT_SCALE=10 runs ten times as many cases (a soak run).
import { describe, expect, it } from 'vitest';
import { apply, compose, OTClient, ServerDoc, transform, type Op } from '../src';
import { int, randomOp, randomText, rng } from './random';

const SCALE = Number(process.env.OT_SCALE ?? 1);
const TP1_CASES = 10_000 * SCALE;
const COMPOSE_CASES = 10_000 * SCALE;
const SIMULATIONS = 10_000 * SCALE;

function forEachSeed(cases: number, check: (seed: number) => void) {
  for (let seed = 1; seed <= cases; seed++) {
    try { check(seed); } catch (e) { throw new Error(`seed ${seed}: ${(e as Error).message}`); }
  }
}

describe('convergence properties', () => {
  it(`TP1: transformed concurrent ops reach the same text (${TP1_CASES} cases)`, () => {
    forEachSeed(TP1_CASES, seed => {
      const rand = rng(seed);
      const doc = randomText(rand, 40);
      const a = randomOp(doc, rand), b = randomOp(doc, rand);
      const [a1, b1] = transform(a, b);
      expect(apply(apply(doc, a), b1)).toBe(apply(apply(doc, b), a1));
    });
  });

  it(`compose: apply(compose(a, b)) equals applying a then b (${COMPOSE_CASES} cases)`, () => {
    forEachSeed(COMPOSE_CASES, seed => {
      const rand = rng(seed);
      const doc = randomText(rand, 40);
      const a = randomOp(doc, rand);
      const b = randomOp(apply(doc, a), rand);
      expect(apply(doc, compose(a, b))).toBe(apply(apply(doc, a), b));
    });
  });

  it(`simulation: 2-4 clients, random edits and message timing, all converge (${SIMULATIONS} runs)`, () => {
    forEachSeed(SIMULATIONS, seed => simulate(seed));
  });
});

type ToClient = { ack: true } | { op: Op };

/**
 * One server and 2-4 clients joined by FIFO queues (like TCP/WebSocket: in order, but delayed).
 * Each step does one random thing: a client edits, the server receives a client's next message,
 * or a client receives its next message from the server. Clients may also join mid-session.
 * At the end every queue is drained and every client must hold exactly the server's text.
 */
function simulate(seed: number) {
  const rand = rng(seed);
  const server = new ServerDoc(randomText(rand, 20));
  const docs: string[] = [];
  const clients: OTClient[] = [];
  const toServer: { revision: number; op: Op }[][] = [];
  const toClient: ToClient[][] = [];

  const join = () => {
    const k = clients.length;
    docs.push(server.text);
    toServer.push([]);
    toClient.push([]);
    clients.push(new OTClient(
      server.revision,
      (revision, op) => toServer[k].push({ revision, op }),
      op => { docs[k] = apply(docs[k], op); },
    ));
  };
  const serverReceive = (k: number) => {
    const { revision, op } = toServer[k].shift()!;
    const committed = server.receive(revision, op);
    toClient.forEach((q, j) => q.push(j === k ? { ack: true } : { op: committed }));
  };
  const clientReceive = (k: number) => {
    const msg = toClient[k].shift()!;
    if ('ack' in msg) clients[k].ack();
    else clients[k].remote(msg.op);
  };
  const pick = (queues: unknown[][]) => {
    const ready = queues.flatMap((q, k) => (q.length ? [k] : []));
    return ready.length ? ready[int(rand, ready.length)] : -1;
  };

  const initial = 2 + int(rand, 2);
  for (let i = 0; i < initial; i++) join();

  const steps = 20 + int(rand, 120);
  for (let s = 0; s < steps; s++) {
    const r = rand();
    if (r < 0.03 && clients.length < 4) join();
    else if (r < 0.45) {
      const k = int(rand, clients.length);
      const op = randomOp(docs[k], rand);
      docs[k] = apply(docs[k], op);
      clients[k].local(op);
    } else if (r < 0.7) {
      const k = pick(toServer);
      if (k >= 0) serverReceive(k);
    } else {
      const k = pick(toClient);
      if (k >= 0) clientReceive(k);
    }
  }

  // Drain in random order until nothing is in flight.
  for (;;) {
    const k = pick(toServer), j = pick(toClient);
    if (k < 0 && j < 0) break;
    if (j < 0 || (k >= 0 && rand() < 0.5)) serverReceive(k);
    else clientReceive(j);
  }

  for (let k = 0; k < clients.length; k++) {
    expect(clients[k].synced).toBe(true);
    expect(docs[k]).toBe(server.text);
  }
}

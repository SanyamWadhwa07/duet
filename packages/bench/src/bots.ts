// Bot load test. Runs BOTS_PER_ROOM x ROOMS bot editors against a Duet server. Each bot is the real
// @duet/ot client (OT mode) or a whole-file client (naive mode); the server decides which.
//
// Every bot types one letter of its own (A, B, C, D) at a random position every ~RATE_MS while all the
// others do the same. That lets us count, at the end, how many of each bot's keystrokes survived.
// Reports: op round-trip (send -> ack, OT only), wire bytes per keystroke, lost keystrokes, divergence.
//   WS_URL=ws://localhost:4000/ws BOTS_PER_ROOM=2 ROOMS=1 SECONDS=30 npm run bench
import { cpus, totalmem } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { apply, OpBuilder, OTClient, type ServerMsg, type SyncMode } from '@duet/ot';

const WS_URL = process.env.WS_URL ?? 'ws://localhost:4000/ws';
const HTTP_URL = WS_URL.replace(/^ws/, 'http').replace(/\/ws$/, '');
const BOTS_PER_ROOM = Number(process.env.BOTS_PER_ROOM ?? 2);
const ROOMS = Number(process.env.ROOMS ?? 1);
const SECONDS = Number(process.env.SECONDS ?? 30);
const RATE_MS = Number(process.env.RATE_MS ?? 150); // ~6.7 keys/s per bot, a fast typist
// Simulated one-way network delay, added by the bot to every message it sends and receives.
// 0 = raw localhost. Timers with equal delays fire in order, so messages stay in order.
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const later = (fn: () => void) => (LATENCY_MS > 0 ? void setTimeout(fn, LATENCY_MS) : fn());

// A ~2 KB starter file, all lowercase so it never contains a bot's letter.
const STARTER = Array.from({ length: 60 }, (_, i) => `    let value${i} = compute(input, ${i}); // step ${i}\n`)
  .join('').slice(0, 2000).toLowerCase();

class Bot {
  doc = '';
  mode: SyncMode = 'ot';
  client: OTClient | null = null;
  typed = 0;
  measuring = false;
  bytesOut = 0;
  bytesIn = 0;
  rtts: number[] = [];
  private sentAt = 0;
  private ws!: WebSocket;

  constructor(readonly letter: string) {}

  connect(room: string) {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.on('open', () => this.send({ t: 'join', room, name: `bot-${this.letter}` }));
      this.ws.on('error', reject);
      this.ws.on('message', data => later(() => {
        const raw = data.toString();
        if (this.measuring) this.bytesIn += Buffer.byteLength(raw);
        const msg: ServerMsg = JSON.parse(raw);
        if (msg.t === 'init') {
          this.mode = msg.mode;
          this.doc = msg.doc;
          this.client = new OTClient(msg.rev, (rev, op) => {
            this.sentAt = performance.now();
            this.send({ t: 'op', rev, op });
          }, op => { this.doc = apply(this.doc, op); });
          resolve();
        } else if (msg.t === 'ack') {
          if (this.measuring) this.rtts.push(performance.now() - this.sentAt);
          this.client!.ack(); // may send the buffered op straight away
        } else if (msg.t === 'op') this.client!.remote(msg.op);
        else if (msg.t === 'file') this.doc = msg.doc;
        else if (msg.t === 'error') reject(new Error(msg.message));
      }));
    });
  }

  /** Inserts text at a random position, the way the editor would report one keystroke. */
  type(text: string, at = Math.floor(Math.random() * (this.doc.length + 1))) {
    if (this.mode === 'naive') {
      this.doc = this.doc.slice(0, at) + text + this.doc.slice(at);
      this.send({ t: 'file', doc: this.doc });
      return;
    }
    const op = new OpBuilder().retain(at).insert(text).retain(this.doc.length - at).op;
    this.doc = apply(this.doc, op);
    this.client!.local(op);
  }

  get synced() { return this.mode === 'naive' || this.client!.synced; }
  close() { this.ws.close(); }

  /** Round trip of a WebSocket ping frame: the network alone, with no Duet code in the path. */
  ping() {
    return new Promise<number>(resolve => {
      const start = performance.now();
      this.ws.once('pong', () => resolve(performance.now() - start));
      this.ws.ping();
    });
  }

  private send(msg: object) {
    const raw = JSON.stringify(msg);
    if (this.measuring) this.bytesOut += Buffer.byteLength(raw);
    later(() => this.ws.send(raw));
  }
}

const runId = Date.now().toString(36);
const rooms = Array.from({ length: ROOMS }, (_, r) => ({
  id: `bench-${runId}-${r}`,
  bots: Array.from({ length: BOTS_PER_ROOM }, (_, k) => new Bot('ABCD'[k])),
}));

// Join, then have the first bot in each room load the starter file and wait until everyone has it.
for (const room of rooms) for (const bot of room.bots) await bot.connect(room.id);
for (const room of rooms) room.bots[0].type(STARTER, 0);
while (!rooms.every(r => r.bots.every(b => b.synced && b.doc.length === STARTER.length))) await sleep(50);
const mode = rooms[0].bots[0].mode;
const target = /localhost|127\.0\.0\.1/.test(WS_URL) ? 'local' : new URL(HTTP_URL).hostname.split('.')[0];

// Network baseline: 20 ping frames from one bot, so op round-trips can be compared with the bare network.
const pings: number[] = [];
for (let i = 0; i < 20; i++) { pings.push(await rooms[0].bots[0].ping()); await sleep(50); }
console.log(`${mode} mode: ${ROOMS} room(s) x ${BOTS_PER_ROOM} bots, typing for ${SECONDS}s every ~${RATE_MS}ms, +${LATENCY_MS}ms each way`);

// Typing phase: every bot types its letter at a jittered interval, all at once.
const lag = monitorEventLoopDelay();
lag.enable();
const all = rooms.flatMap(r => r.bots);
all.forEach(b => { b.measuring = true; });
const end = Date.now() + SECONDS * 1000;
await Promise.all(all.map(async bot => {
  await sleep(Math.random() * RATE_MS);
  while (Date.now() < end) {
    bot.type(bot.letter);
    bot.typed++;
    await sleep(RATE_MS * (0.5 + Math.random()));
  }
}));
lag.disable();

// Let in-flight messages land, then compare each room's final text with what was typed.
const settleBy = Date.now() + 10_000;
while (Date.now() < settleBy && !all.every(b => b.synced)) await sleep(50);
await sleep(1000 + 2 * LATENCY_MS);
all.forEach(b => { b.measuring = false; });

let typed = 0, lost = 0, divergedRooms = 0, finalLength = 0;
for (const room of rooms) {
  const server: { text: string } = await (await fetch(`${HTTP_URL}/api/rooms/${room.id}`)).json();
  finalLength += server.text.length;
  if (room.bots.some(b => b.doc !== server.text)) divergedRooms++;
  for (const bot of room.bots) {
    const survived = server.text.split(bot.letter).length - 1;
    typed += bot.typed;
    lost += Math.max(0, bot.typed - survived);
  }
}
all.forEach(b => b.close());

const rtts = all.flatMap(b => b.rtts).sort((a, b) => a - b);
pings.sort((a, b) => a - b);
const pct = (xs: number[], p: number) => xs.length ? +xs[Math.min(xs.length - 1, Math.floor(p / 100 * xs.length))].toFixed(2) : null;
const bytes = all.reduce((s, b) => s + b.bytesOut + b.bytesIn, 0);
const result = {
  mode, target, rooms: ROOMS, botsPerRoom: BOTS_PER_ROOM, bots: all.length, seconds: SECONDS, rateMs: RATE_MS, latencyMs: LATENCY_MS,
  starterChars: STARTER.length, avgFinalChars: Math.round(finalLength / ROOMS),
  keystrokes: typed,
  roundTripMs: mode === 'ot' ? { samples: rtts.length, p50: pct(rtts, 50), p95: pct(rtts, 95), p99: pct(rtts, 99), max: pct(rtts, 100) } : null,
  networkPingMs: { samples: pings.length, p50: pct(pings, 50), p95: pct(pings, 95) },
  wireBytes: bytes, bytesPerKeystroke: +(bytes / typed).toFixed(1),
  lostKeystrokes: lost, lostPercent: +(100 * lost / typed).toFixed(2), divergedRooms,
  botEventLoopLagP99Ms: +(lag.percentile(99) / 1e6).toFixed(2),
  machine: { cpu: cpus()[0].model, cores: cpus().length, memGB: Math.round(totalmem() / 2 ** 30), node: process.version, os: process.platform },
  date: new Date().toISOString(),
};
console.log(JSON.stringify(result, null, 2));
mkdirSync('../../bench/results', { recursive: true });
writeFileSync(`../../bench/results/${result.date.slice(0, 10)}-${target}-${mode}-${ROOMS}x${BOTS_PER_ROOM}-lat${LATENCY_MS}-${runId}.json`, JSON.stringify(result, null, 2) + '\n');
process.exit(0);

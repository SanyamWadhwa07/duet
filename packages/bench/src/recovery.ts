// Crash-recovery test. Starts the real server against Postgres, has two clients make OPS edits at once
// until every edit is acknowledged, kills the server process outright (like a crash), starts it again,
// and checks that the room comes back with the same text and revision. Also times the reload.
//   DATABASE_URL=postgres://... OPS=450 npm run recovery
import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { apply, OpBuilder, OTClient, type ServerMsg } from '@duet/ot';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('set DATABASE_URL');
const OPS = Number(process.env.OPS ?? 450);
const PORT = Number(process.env.PORT ?? 4300);
const URL_WS = `ws://localhost:${PORT}/ws`;
const room = `recovery-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function startServer(): Promise<{ proc: ChildProcess; ms: number }> {
  const start = performance.now();
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: '../server', env: { ...process.env, PORT: String(PORT), DATABASE_URL }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    proc.stdout!.on('data', d => { if (String(d).includes('duet server on')) resolve({ proc, ms: performance.now() - start }); });
    proc.on('exit', code => reject(new Error(`server exited (${code})`)));
  });
}

/** A minimal client: joins, keeps a local copy in sync with OTClient, can type one letter. */
function client(name: string) {
  return new Promise<{ ws: WebSocket; text: () => string; type: (c: string) => void; synced: () => boolean; initMs: number; rev: number }>(resolve => {
    const ws = new WebSocket(URL_WS);
    let doc = '';
    let ot: OTClient;
    const start = performance.now();
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room, name })));
    ws.on('message', data => {
      const msg: ServerMsg = JSON.parse(String(data));
      if (msg.t === 'init') {
        doc = msg.doc;
        ot = new OTClient(msg.rev, (rev, op) => ws.send(JSON.stringify({ t: 'op', rev, op })), op => { doc = apply(doc, op); });
        resolve({
          ws, initMs: performance.now() - start, rev: msg.rev,
          text: () => doc,
          synced: () => ot.synced,
          type: c => {
            const at = Math.floor(Math.random() * (doc.length + 1));
            const op = new OpBuilder().retain(at).insert(c).retain(doc.length - at).op;
            doc = apply(doc, op);
            ot.local(op);
          },
        });
      } else if (msg.t === 'ack') ot.ack();
      else if (msg.t === 'op' && !msg.doc) ot.remote(msg.op);
    });
  });
}

let server = await startServer();
const [a, b] = [await client('A'), await client('B')];
// EXACT=1 waits for each ack, so every keystroke is its own op and the revision equals OPS (to land
// on either side of the snapshot interval). Otherwise both type at once and keystrokes may be composed.
const EXACT = process.env.EXACT === '1';
for (let i = 0; i < OPS; i++) {
  const c = i % 2 ? b : a;
  c.type(i % 2 ? 'b' : 'a');
  if (EXACT) while (!c.synced()) await sleep(0);
  else if (i % 10 === 9) await sleep(5);
}
while (!(a.synced() && b.synced() && a.text() === b.text() && a.text().length === OPS)) await sleep(20);
const before = a.text();
const revBefore: number = (await (await fetch(`http://localhost:${PORT}/api/rooms/${room}`)).json()).revision;
console.log(`${OPS} edits acknowledged (revision ${revBefore}); killing the server`);

server.proc.kill('SIGKILL');
await new Promise(r => server.proc.once('exit', r));
a.ws.terminate();
b.ws.terminate();

server = await startServer();
const back = await client('C');
const recovered = back.text() === before && back.rev === revBefore;
console.log(`server restarted in ${server.ms.toFixed(0)} ms; room reloaded and joined in ${back.initMs.toFixed(1)} ms`
  + ` (snapshot at revision ${Math.floor(revBefore / 200) * 200}, ${revBefore % 200} ops replayed)`);
console.log(`revision ${back.rev}, ${back.text().length} chars: ${recovered ? 'PASS, identical to before the crash' : 'FAIL, room differs'}`);
back.ws.close();
server.proc.kill();
process.exit(recovered ? 0 : 1);

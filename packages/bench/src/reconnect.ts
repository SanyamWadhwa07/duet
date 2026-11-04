// Reconnect test in real browsers (headless Edge). Two tabs share a room. Tab B's WebSocket runs through a
// proxy that can lose messages in either direction and cut the connection, in three cases:
//   1. lost ack: B's edit reached the server and was committed, but the ack never came back;
//   2. lost op: B's edit never reached the server;
//   3. outage: no connection for a few seconds while both keep typing.
// After each, both tabs and the server must hold the same text, with every typed marker exactly once
// and nothing else: no edit lost, none applied twice.
//   WEB_URL=http://localhost:5173 npm run reconnect
import { chromium, type Page, type WebSocketRoute } from 'playwright-core';

const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const room = `reconnect-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const net = { dropUp: false, dropDown: false, down: false, connects: 0 };
let live: { page: WebSocketRoute; server: WebSocketRoute } | null = null;
const cut = () => { live?.page.close(); live?.server.close(); };

const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true });
const join = async (name: string, proxied: boolean) => {
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript({ content: 'window.__name = f => f' }); // tsx wraps functions sent to the page in __name()
  if (proxied) {
    await page.routeWebSocket(url => url.pathname === '/ws', ws => {
      if (net.down) return void ws.close(); // no network: the connection fails at once
      net.connects++;
      const server = ws.connectToServer();
      ws.onMessage(m => { if (!net.dropUp) server.send(m); });
      server.onMessage(m => { if (!net.dropDown) ws.send(m); });
      live = { page: ws, server };
    });
  }
  await page.goto(`${WEB}/r/${room}`);
  await page.fill('input', name);
  await page.press('input', 'Enter');
  await page.waitForFunction(() => (window as any).duet?.session?.code?.client, null, { timeout: 30_000 });
  return page;
};
const a = await join('A', false);
const b = await join('B', true);

/** Types at the end of the code, through Monaco's own typing command (as a keystroke would). */
const type = (page: Page, text: string) => page.evaluate(t => {
  const { editor } = (window as any).duet;
  editor.setPosition(editor.getModel().getPositionAt(editor.getModel().getValueLength()));
  editor.trigger('keyboard', 'type', { text: t });
}, text);
const textOf = (page: Page) => page.evaluate(() => (window as any).duet.editor.getValue() as string);
const serverText = async () => (await (await fetch(`${WEB}/api/rooms/${room}`)).json()).text as string;

/** Waits until both tabs and the server agree and B has nothing unacknowledged. */
async function settle(label: string) {
  for (let i = 0; i < 150; i++) {
    const [ta, tb, ts, synced] = await Promise.all([textOf(a), textOf(b), serverText(), b.evaluate(() => (window as any).duet.session.synced)]);
    if (ta === tb && tb === ts && synced) return ts;
    await sleep(100);
  }
  throw new Error(`${label}: tabs did not converge: A=${JSON.stringify(await textOf(a))} B=${JSON.stringify(await textOf(b))}`);
}

const typed: string[] = [];
let failures = 0;
function check(label: string, text: string, markers: string[]) {
  typed.push(...markers);
  const counts = typed.map(m => text.split(m).length - 1);
  const stray = typed.reduce((t, m) => t.replace(m, ''), text);
  const ok = counts.every(n => n === 1) && stray === '';
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${typed.map((m, i) => `${m} x${counts[i]}`).join(', ')}${stray ? `, stray ${JSON.stringify(stray)}` : ''}`);
}

console.log(`room ${room}`);

// 1. Lost ack.
net.dropDown = true;
await type(b, '<ackLost>');
await sleep(500); // the server commits it meanwhile
await type(a, '<fromA1>');
await sleep(300);
cut();
net.dropDown = false;
check('lost ack', await settle('lost ack'), ['<ackLost>', '<fromA1>']);

// 2. Lost op.
net.dropUp = true;
await type(b, '<opLost>');
await sleep(300);
cut();
net.dropUp = false;
check('lost op', await settle('lost op'), ['<opLost>']);

// 3. Outage: B can't connect for 2.5 s and keeps typing; A types too.
net.down = true;
cut();
await sleep(300);
const editableOffline = await b.evaluate(() => !(window as any).duet.editor.getRawOptions().readOnly);
await type(b, '<offline1>');
await type(a, '<fromA2>');
await type(b, '<offline2>');
await sleep(2500);
net.down = false;
check('outage', await settle('outage'), ['<offline1>', '<offline2>', '<fromA2>']);

const notices = await b.locator('.notice').count();
console.log(`B could type while offline: ${editableOffline}; connections B opened: ${net.connects}; lost-edits notices: ${notices}`);
await browser.close();
process.exit(failures === 0 && editableOffline && notices === 0 ? 0 : 1);

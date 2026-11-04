// Week-1 exit test. Opens TABS real browser tabs (headless Edge) in one room. Every tab types and deletes
// at random positions at the same time, through Monaco's own typing commands (so auto-closing brackets,
// auto-indent and multi-cursor edits all go through the real binding). When typing stops, every tab
// must hold exactly the server's text.
//   WEB_URL=http://localhost:5173 TABS=2 SECONDS=10 npm run e2e
import { chromium, type Page } from 'playwright-core';

const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const TABS = Number(process.env.TABS ?? 2);
const SECONDS = Number(process.env.SECONDS ?? 10);
const room = `e2e-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true });
const errors: string[] = [];
const pages: Page[] = [];
for (let i = 0; i < TABS; i++) {
  const page = await (await browser.newContext()).newPage(); // own context = own user
  // tsx (esbuild keepNames) wraps functions in __name(); functions sent to the page need it defined.
  await page.addInitScript({ content: 'window.__name = f => f' });
  page.on('pageerror', e => errors.push(`tab ${i}: ${e.message}`));
  await page.goto(`${WEB}/r/${room}`);
  await page.fill('input', `tab${i}`);
  await page.press('input', 'Enter');
  await page.waitForFunction(() => (window as any).duet?.session?.code?.client, null, { timeout: 30_000 });
  pages.push(page);
}
console.log(`room ${room}: ${TABS} tabs joined, typing for ${SECONDS}s`);

const edits = await Promise.all(pages.map(page => page.evaluate(seconds => new Promise<number>(resolve => {
  const { editor } = (window as any).duet;
  const model = editor.getModel();
  const at = (offset: number) => model.getPositionAt(offset);
  const randomOffset = () => Math.floor(Math.random() * (model.getValueLength() + 1));
  let count = 0;
  const end = Date.now() + seconds * 1000;
  const tick = () => {
    if (Date.now() > end) return resolve(count);
    const r = Math.random();
    if (r < 0.1) {
      // two cursors at once: one change event with two edits
      const [a, b] = [at(randomOffset()), at(randomOffset())];
      editor.setSelections([
        { selectionStartLineNumber: a.lineNumber, selectionStartColumn: a.column, positionLineNumber: a.lineNumber, positionColumn: a.column },
        { selectionStartLineNumber: b.lineNumber, selectionStartColumn: b.column, positionLineNumber: b.lineNumber, positionColumn: b.column },
      ]);
    } else editor.setPosition(at(randomOffset()));
    if (r > 0.75) editor.trigger('e2e', 'deleteLeft', null);
    else editor.trigger('e2e', 'type', { text: 'abcdefgh {(\n'[Math.floor(Math.random() * 12)] });
    count++;
    setTimeout(tick, 10 + Math.random() * 30);
  };
  tick();
}), SECONDS)));

// Wait until every tab has no unacked edits and holds the server's text.
let result = 'FAIL';
let server = { revision: 0, text: '' };
let texts: string[] = [];
for (const deadline = Date.now() + 20_000; Date.now() < deadline; await sleep(250)) {
  const states = await Promise.all(pages.map(p => p.evaluate(() => {
    const { editor, session } = (window as any).duet;
    return { synced: session.synced as boolean, text: editor.getValue() as string };
  })));
  server = await (await fetch(`${WEB}/api/rooms/${room}`)).json();
  texts = states.map(s => s.text);
  if (states.every(s => s.synced) && texts.every(t => t === server.text)) { result = 'PASS'; break; }
}
await browser.close();

console.log(`edits per tab: ${edits.join(', ')} (total ${edits.reduce((a, b) => a + b, 0)})`);
console.log(`server revision ${server.revision}, final length ${server.text.length}`);
console.log(`tab lengths: ${texts.map(t => t.length).join(', ')}`);
if (errors.length) { console.log('page errors:', errors); result = 'FAIL'; }
console.log(result === 'PASS' ? 'PASS: all tabs identical to the server' : 'FAIL: tabs diverged');
process.exit(result === 'PASS' ? 0 : 1);

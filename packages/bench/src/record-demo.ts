// Records the README demo: a mock interview on the live site, in two real browser windows side by side.
// Asha (the interviewer) starts a named session; Ravi joins from the plain link as the candidate. Asha
// loads a problem, Ravi writes the solution while Asha adds a note at the top of the same file, and Ravi
// runs the tests, which both of them see pass. Writes docs/demo.gif and checks that both editors and the
// server end with the same text.
//   WEB_URL=https://duet-six-rose.vercel.app SERVER_URL=https://duet-server.onrender.com npm run demo
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const WEB = process.env.WEB_URL ?? 'https://duet-six-rose.vercel.app';
const SERVER = process.env.SERVER_URL ?? 'https://duet-server.onrender.com';
const OUT = process.env.OUT ?? '../../docs/demo.gif';
const size = { width: 960, height: 600 }; // wide enough for the room's two-column layout

await fetch(`${SERVER}/health`); // wake a sleeping free instance before recording
const frameDir = mkdtempSync(join(tmpdir(), 'duet-demo-'));
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', headless: true });
const open = async () => {
  const context = await browser.newContext({ viewport: size });
  return { context, page: await context.newPage() };
};
const asha = await open();
const ravi = await open();

// Asha creates the room (and becomes its interviewer); Ravi opens the plain link (a candidate).
await asha.page.goto(WEB);
await asha.page.fill('#name', 'Asha');
await asha.page.fill('#session', 'Mock interview: Ravi');
await asha.page.press('#name', 'Enter');
await asha.page.waitForSelector('text=Connected', { timeout: 90_000 });
const roomUrl = asha.page.url();
await ravi.page.goto(roomUrl);
await ravi.page.fill('#name', 'Ravi');
await ravi.page.press('#name', 'Enter');
await ravi.page.waitForSelector('text=Connected');
console.log(`room ${roomUrl}`);

// Screenshot both windows together, as fast as they come (about 10 per second), until stopped.
let recording = true;
let frames = 0;
const recordStart = Date.now();
const recorder = (async () => {
  while (recording) {
    const [fa, fr] = await Promise.all([asha.page.screenshot(), ravi.page.screenshot()]);
    const n = String(frames++).padStart(4, '0');
    writeFileSync(join(frameDir, `a${n}.png`), fa);
    writeFileSync(join(frameDir, `r${n}.png`), fr);
  }
})();
const pause = (ms: number) => asha.page.waitForTimeout(ms);
const type = async (page: Page, lines: string[]) => {
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(line, { delay: 55 });
  }
};

await pause(1200);
// Asha picks the language and a problem: the statement, its tests and the starter code reach both windows.
await asha.page.selectOption('select[aria-label="Language"]', 'javascript');
await asha.page.waitForFunction(() => document.querySelector('.code-pane .view-lines')?.textContent?.includes('readline'));
await pause(600);
await asha.page.selectOption('select[aria-label="Load an example problem"]', 'pair-sum');
await ravi.page.waitForSelector('.markdown h1');
await pause(2000);

// Ravi writes the solution under the starter; once he's started, Asha adds a note at the top.
await ravi.page.click('.code-pane .view-lines');
await ravi.page.keyboard.press('Control+End');
await Promise.all([
  type(ravi.page, [
    'const seen = new Map();',
    'nums.forEach((x, i) => {',
    'const j = seen.get(target - x);',
    'if (j !== undefined) console.log(j, i);',
    'seen.set(x, i);',
  ]),
  (async () => {
    await asha.page.waitForFunction(() => document.querySelector('.code-pane .view-lines')?.textContent?.includes('forEach'));
    await asha.page.click('.code-pane .view-lines');
    await asha.page.keyboard.press('Control+Home');
    await asha.page.keyboard.press('Enter'); // a fresh first line for the note
    await asha.page.keyboard.press('ArrowUp');
    await asha.page.keyboard.type('// Asha: walk me through the time complexity.', { delay: 55 });
  })(),
]);
await pause(800);

// Ravi runs the tests (Ctrl+Enter); the result reaches both windows.
await ravi.page.keyboard.press('Control+Enter');
await Promise.all([asha, ravi].map(w => w.page.waitForSelector('text=4 of 4 tests passed', { timeout: 30_000 })));
await pause(3000); // hold the final frame
recording = false;
await recorder;
const fps = (frames / ((Date.now() - recordStart) / 1000)).toFixed(2); // play back at real speed

// Visible text of an editor, line by line (Monaco positions its line elements absolutely).
const text = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.code-pane .view-lines .view-line'))
  .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
  .map(l => l.innerText.replace(/ /g, ' ').trimEnd()).join('\n'));
const [a, r] = [await text(asha.page), await text(ravi.page)];
const server: { text: string; revision: number } =
  await (await fetch(`${SERVER}/api/rooms/${roomUrl.split('/r/')[1]}`)).json();
const serverText = server.text.split('\n').map(l => l.trimEnd()).join('\n');
console.log(`server revision ${server.revision}, ${server.text.length} chars`);
console.log(a === r && a === serverText ? 'PASS: both editors and the server hold the same text' : 'FAIL: texts differ');

await asha.context.close();
await ravi.context.close();
await browser.close();

// Put the two windows side by side and make a palette-optimised GIF.
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-framerate', fps, '-i', join(frameDir, 'a%04d.png'),
  '-framerate', fps, '-i', join(frameDir, 'r%04d.png'),
  '-filter_complex',
  '[0:v][1:v]hstack=inputs=2,scale=1440:-1:flags=lanczos,fps=10,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer',
  OUT,
]);
console.log(`wrote ${OUT} (${frames} frames at ${fps} fps)`);

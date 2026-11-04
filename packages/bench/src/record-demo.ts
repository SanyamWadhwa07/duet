// Records the README demo: two real browser windows ("Asha" and "Ravi") in one room on the live site,
// typing at the same time with real keystrokes. Writes the side-by-side video as docs/demo.gif and
// checks that both editors and the server end with the same text.
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

const enterRoom = async (page: Page, name: string, url: string) => {
  await page.goto(url);
  await page.fill('input', name);
  await page.press('input', 'Enter');
  await page.waitForSelector('text=connected');
  await page.click('.code-pane .view-lines');
};
await enterRoom(asha.page, 'Asha', WEB);
const roomUrl = asha.page.url();
await enterRoom(ravi.page, 'Ravi', roomUrl);
// The demo code is JavaScript: switch the room's language, then clear the starter comment it inserts.
await asha.page.selectOption('select[aria-label="Language"]', 'javascript');
await asha.page.click('.code-pane .view-lines');
await asha.page.keyboard.press('Control+A');
await asha.page.keyboard.press('Delete');
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

const type = async (page: Page, lines: string[]) => {
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(line, { delay: 55 });
  }
};
// Visible text of an editor, line by line (Monaco positions its line elements absolutely).
const text = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.code-pane .view-lines .view-line'))
  .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
  .map(l => l.innerText.replace(/ /g, ' ').trimEnd()).join('\n'));

// Asha writes the function. Once her braces exist, Ravi adds a test call below them, while she keeps typing.
await Promise.all([
  type(asha.page, [
    '// Two Sum: indices of two numbers that add up to target',
    'function twoSum(nums, target) {',
    'const seen = new Map();',
    'for (let i = 0; i < nums.length; i++) {',
    'const j = seen.get(target - nums[i]);',
    'if (j !== undefined) return [j, i];',
    'seen.set(nums[i], i);',
  ]),
  (async () => {
    await ravi.page.waitForFunction(() => document.querySelector('.code-pane .view-lines')?.textContent?.includes('Map()'));
    await ravi.page.keyboard.press('Control+End');
    await ravi.page.keyboard.press('Enter');
    await type(ravi.page, ['', 'console.log(twoSum([2, 7, 11, 15], 9)); // [0, 1]']);
  })(),
]);
await asha.page.waitForTimeout(2500); // let the last ops land, and hold the final frame
recording = false;
await recorder;
const fps = (frames / ((Date.now() - recordStart) / 1000)).toFixed(2); // play back at real speed

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

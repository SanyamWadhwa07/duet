// Every example's expected outputs are checked against a reference solution, so no example ships with
// a wrong answer. Each reference reads the test input exactly as the browser runner would give it.
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../src/example';

const lines = (input: string) => input.split('\n');
const nums = (line: string) => line.trim().split(/\s+/).map(Number);

const REFERENCE: Record<string, (input: string) => string> = {
  'pair-sum': input => {
    const [, a, t] = lines(input);
    const xs = nums(a), target = Number(t), seen = new Map<number, number>();
    for (let i = 0; i < xs.length; i++) {
      if (seen.has(target - xs[i])) return `${seen.get(target - xs[i])} ${i}`;
      seen.set(xs[i], i);
    }
    return 'none';
  },
  brackets: input => {
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    const stack: string[] = [];
    for (const ch of input.trim()) {
      if ('([{'.includes(ch)) stack.push(ch);
      else if (stack.pop() !== pairs[ch]) return 'NO';
    }
    return stack.length ? 'NO' : 'YES';
  },
  'binary-search': input => {
    const [, a, t] = lines(input);
    const xs = nums(a), target = Number(t);
    let lo = 0, hi = xs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] === target) return String(mid);
      if (xs[mid] < target) lo = mid + 1; else hi = mid - 1;
    }
    return '-1';
  },
  'longest-unique': input => {
    const s = input.trim(), last = new Map<string, number>();
    let best = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      if ((last.get(s[i]) ?? -1) >= start) start = last.get(s[i])! + 1;
      last.set(s[i], i);
      best = Math.max(best, i - start + 1);
    }
    return String(best);
  },
  'merge-intervals': input => {
    const [n, ...rest] = lines(input);
    const xs = rest.slice(0, Number(n)).map(nums).sort((a, b) => a[0] - b[0]);
    const out: number[][] = [];
    for (const [s, e] of xs) {
      const top = out[out.length - 1];
      if (top && s <= top[1]) top[1] = Math.max(top[1], e); else out.push([s, e]);
    }
    return out.map(x => x.join(' ')).join('\n');
  },
  islands: input => {
    const [head, ...rows] = lines(input);
    const [r, c] = nums(head);
    const grid = rows.slice(0, r).map(row => [...row.trim()]);
    let count = 0;
    const sink = (i: number, j: number): void => {
      if (i < 0 || j < 0 || i >= r || j >= c || grid[i][j] !== '1') return;
      grid[i][j] = '0';
      sink(i + 1, j); sink(i - 1, j); sink(i, j + 1); sink(i, j - 1);
    };
    for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) if (grid[i][j] === '1') { count++; sink(i, j); }
    return String(count);
  },
  dijkstra: input => {
    const ls = lines(input);
    const [n, m] = nums(ls[0]);
    const adj: [number, number][][] = Array.from({ length: n + 1 }, () => []);
    for (let k = 1; k <= m; k++) {
      const [u, v, w] = nums(ls[k]);
      adj[u].push([v, w]);
      adj[v].push([u, w]);
    }
    const s = Number(ls[m + 1]);
    const dist = Array(n + 1).fill(Infinity);
    const done = Array(n + 1).fill(false);
    dist[s] = 0;
    for (let round = 0; round < n; round++) { // O(n^2) is plenty for a reference
      let u = -1;
      for (let v = 1; v <= n; v++) if (!done[v] && (u === -1 || dist[v] < dist[u])) u = v;
      if (u === -1 || dist[u] === Infinity) break;
      done[u] = true;
      for (const [v, w] of adj[u]) dist[v] = Math.min(dist[v], dist[u] + w);
    }
    return dist.slice(1).map(d => (d === Infinity ? -1 : d)).join(' ');
  },
  'strong-password': input => {
    const p = input.trim();
    const missing = [/[a-z]/, /[A-Z]/, /[0-9]/, /[!@#$%^&*]/].filter(re => !re.test(p)).length;
    return String(Math.max(8 - p.length, missing));
  },
};

describe('example problems', () => {
  it('every example has a reference solution', () => {
    expect(EXAMPLES.map(e => e.id).sort()).toEqual(Object.keys(REFERENCE).sort());
  });
  for (const example of EXAMPLES) {
    it(`${example.title}: expected outputs match the reference (${example.tests.length} tests)`, () => {
      for (const t of example.tests) expect(REFERENCE[example.id](t.input), t.input).toBe(t.expected);
    });
  }
});

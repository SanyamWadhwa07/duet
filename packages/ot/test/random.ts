import { OpBuilder, type Op } from '../src';

/** Seeded PRNG (mulberry32), so every failing case can be replayed from its seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = () => number;
export const int = (rand: Rand, max: number) => Math.floor(rand() * max); // 0..max-1

const ALPHABET = 'abcxyz {}();\n';

export function randomText(rand: Rand, maxLen: number): string {
  let s = '';
  const n = int(rand, maxLen + 1);
  for (let i = 0; i < n; i++) s += ALPHABET[int(rand, ALPHABET.length)];
  return s;
}

/** A random op on `doc`: half the time a single keystroke-sized edit, otherwise many edits at once. */
export function randomOp(doc: string, rand: Rand): Op {
  const b = new OpBuilder();
  if (rand() < 0.5) {
    const at = int(rand, doc.length + 1);
    b.retain(at);
    const del = rand() < 0.3 ? Math.min(1 + int(rand, 3), doc.length - at) : 0;
    if (del === 0 || rand() < 0.3) b.insert(randomText(rand, 4) || 'k');
    b.delete(del);
    b.retain(doc.length - at - del);
    return b.op;
  }
  let i = 0;
  while (i < doc.length) {
    const n = 1 + int(rand, Math.min(6, doc.length - i));
    const r = rand();
    if (r < 0.2) b.insert(randomText(rand, 5));
    else if (r < 0.4) { b.delete(n); i += n; }
    else { b.retain(n); i += n; }
  }
  if (rand() < 0.3) b.insert(randomText(rand, 5));
  return b.op;
}

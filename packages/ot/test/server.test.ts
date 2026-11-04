import { describe, expect, it } from 'vitest';
import { apply, ServerDoc, type Op } from '../src';
import { randomOp, randomText, rng } from './random';

describe('ServerDoc rebuilt from a snapshot', () => {
  it('snapshot + replayed log gives the same text and revision as the original (500 cases)', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rand = rng(seed);
      const initial = randomText(rand, 20);
      const original = new ServerDoc(initial);
      const log: Op[] = [];
      for (let i = 0; i < 30; i++) log.push(original.receive(original.revision, randomOp(original.text, rand)));

      // Snapshot at revision 17, then replay the rest of the log, as the server does on reload.
      const snapshot = log.slice(0, 17).reduce((text, op) => apply(text, op), initial);
      const rebuilt = new ServerDoc(snapshot, 17);
      rebuilt.replay(log.slice(17));
      expect(rebuilt.text, `seed ${seed}`).toBe(original.text);
      expect(rebuilt.revision).toBe(original.revision);
    }
  });

  it('accepts ops based on any revision it still holds, and rejects older ones', () => {
    const doc = new ServerDoc('hello', 10);
    doc.receive(10, [5, '!']); // now at revision 11
    doc.receive(10, ['>', 5]); // concurrent with the op above, so it is transformed past it
    expect(doc.text).toBe('>hello!');
    expect(doc.revision).toBe(12);
    expect(() => doc.receive(9, [7])).toThrow(/bad revision/); // older than the snapshot: the client must rejoin
  });
});

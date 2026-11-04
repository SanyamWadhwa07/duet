import { describe, expect, it } from 'vitest';
import { apply, compose, isOp, OpBuilder, transform, transformIndex } from '../src';

describe('operation basics', () => {
  it('applies retain, insert and delete', () => {
    expect(apply('hello world', [6, -5, 'there'])).toBe('hello there');
    expect(apply('', ['abc'])).toBe('abc');
    expect(() => apply('abc', [2, 'x'])).toThrow(/base length/);
  });

  it('builds canonical ops: merges neighbours, puts inserts before deletes', () => {
    expect(new OpBuilder().retain(2).retain(3).insert('a').insert('b').op).toEqual([5, 'ab']);
    expect(new OpBuilder().retain(1).delete(2).insert('x').retain(1).op).toEqual([1, 'x', -2, 1]);
    expect(new OpBuilder().retain(0).insert('').delete(0).op).toEqual([]);
  });

  it('composes two ops into one', () => {
    const a = [3, 'X', 2]; // abcde -> abcXde
    const b = [1, -3, 'Y', 2]; // abcXde -> aYde
    expect(apply('abcde', compose(a, b))).toBe('aYde');
    expect(compose(['abc'], [1, -1, 1])).toEqual(['ac']); // inserted then deleted: cancels
  });

  it('transforms concurrent inserts at the same position: first argument goes first', () => {
    const [a1, b1] = transform([1, 'A', 2], [1, 'B', 2]);
    expect(apply(apply('xyz', [1, 'A', 2]), b1)).toBe('xAByz');
    expect(apply(apply('xyz', [1, 'B', 2]), a1)).toBe('xAByz');
  });

  it('transforms overlapping deletes without deleting twice', () => {
    const a = [1, -3, 1]; // abcde -> ae
    const b = [2, -3]; // abcde -> ab
    const [a1, b1] = transform(a, b);
    expect(apply(apply('abcde', a), b1)).toBe('a');
    expect(apply(apply('abcde', b), a1)).toBe('a');
  });

  it('moves a cursor index through an op', () => {
    expect(transformIndex(3, [1, 'XX', 4])).toBe(5); // insert before: shifts right
    expect(transformIndex(3, [3, 'XX', 2])).toBe(5); // insert at: pushed right
    expect(transformIndex(3, [4, 'XX', 1])).toBe(3); // insert after: unchanged
    expect(transformIndex(3, [1, -3, 1])).toBe(1); // cursor inside a deleted range: collapses to its start
  });

  it('validates ops from the wire', () => {
    expect(isOp([3, 'a', -1])).toBe(true);
    expect(isOp([0])).toBe(false);
    expect(isOp([''])).toBe(false);
    expect(isOp([1.5])).toBe(false);
    expect(isOp('abc')).toBe(false);
  });
});

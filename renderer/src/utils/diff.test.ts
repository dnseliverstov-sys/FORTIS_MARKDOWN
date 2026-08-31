import {describe, expect, it} from 'vitest';
import {diffCount, diffLines} from './diff';

describe('line diff', () => {
  it('reports additions and removals deterministically', () => {
    expect(diffCount('a\nb', 'a\nc')).toEqual({added: 1, removed: 1});
    expect(diffLines('a\nb', 'a\nc').map((line) => line.kind)).toEqual(['same', 'added', 'removed']);
  });
});

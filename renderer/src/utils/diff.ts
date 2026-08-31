export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({length: rows}, () => new Uint32Array(columns));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      matrix[i][j] = left[i] === right[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      result.push({kind: 'same', text: left[i]}); i++; j++;
    } else if (j < right.length && (i >= left.length || matrix[i][j + 1] >= matrix[i + 1][j])) {
      result.push({kind: 'added', text: right[j++]});
    } else {
      result.push({kind: 'removed', text: left[i++]});
    }
  }
  return result;
}

export function diffCount(before: string, after: string): {added: number; removed: number} {
  return diffLines(before, after).reduce((count, line) => {
    if (line.kind === 'added') count.added++;
    if (line.kind === 'removed') count.removed++;
    return count;
  }, {added: 0, removed: 0});
}

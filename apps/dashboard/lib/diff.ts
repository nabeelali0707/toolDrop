// A line diff for comparing two versions' recipes: the longest common
// subsequence of lines, then what each side has that the other does not.
// Recipes are a few hundred lines at most, so the quadratic table is fine.

export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const width = b.length + 1;
  // common[i * width + j]: the longest common subsequence of a[i..] and b[j..].
  const common = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number) => common[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] ?? '' });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && at(i + 1, j) >= at(i, j + 1))) {
      lines.push({ kind: 'removed', text: a[i] ?? '' });
      i++;
    } else {
      lines.push({ kind: 'added', text: b[j] ?? '' });
      j++;
    }
  }
  return lines;
}

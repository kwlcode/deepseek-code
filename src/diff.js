/**
 * Dependency-free unified diff (Myers-style LCS) used to preview the Write and
 * Edit tools before anything touches disk, and to render what changed after.
 *
 * The line diff is computed with a classic LCS table after trimming the common
 * prefix/suffix, which keeps the table small for the edits an agent normally
 * makes. Oversized inputs fall back to a "whole region replaced" hunk instead
 * of allocating a huge matrix.
 */

const MAX_MATRIX = 4_000_000; // cells; 4M * 4 bytes = 16MB upper bound

function splitLines(text) {
  return String(text ?? '').split('\n');
}

/** LCS walk over two line arrays, returned as eq/del/ins operations. */
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', line: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'ins', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', line: a[i++] });
  while (j < m) ops.push({ type: 'ins', line: b[j++] });
  return ops;
}

/** Full operation list for turning `oldText` into `newText`. */
export function diffOps(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const ops = [];
  for (let k = 0; k < start; k++) ops.push({ type: 'eq', line: a[k] });

  if (midA.length * midB.length > MAX_MATRIX) {
    for (const line of midA) ops.push({ type: 'del', line });
    for (const line of midB) ops.push({ type: 'ins', line });
  } else {
    ops.push(...lcsOps(midA, midB));
  }

  for (let k = endA; k < a.length; k++) ops.push({ type: 'eq', line: a[k] });
  return ops;
}

/** Counts for a human summary line ("+3 -1"). */
export function diffStats(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'ins') added++;
    else if (op.type === 'del') removed++;
  }
  return { added, removed };
}

/**
 * Render a unified diff with @@ hunk headers.
 * @returns {{text: string, added: number, removed: number, hunks: number}}
 */
export function unifiedDiff(oldText, newText, options = {}) {
  const { context = 3, oldLabel = 'a', newLabel = 'b' } = options;
  const ops = diffOps(oldText, newText);
  const { added, removed } = diffStats(ops);

  const annotated = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    annotated.push({ ...op, oldNo, newNo });
    if (op.type === 'eq') {
      oldNo++;
      newNo++;
    } else if (op.type === 'del') {
      oldNo++;
    } else {
      newNo++;
    }
  }

  const changed = [];
  annotated.forEach((entry, index) => {
    if (entry.type !== 'eq') changed.push(index);
  });

  if (changed.length === 0) return { text: '', added, removed, hunks: 0 };

  // Group nearby changes into hunks (two changes are joined when the untouched
  // gap between them is no wider than the context on both sides).
  const groups = [];
  let last = null;
  for (const index of changed) {
    if (last !== null && index - last <= context * 2) {
      groups[groups.length - 1].end = index;
    } else {
      groups.push({ start: index, end: index });
    }
    last = index;
  }

  const out = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const group of groups) {
    const from = Math.max(0, group.start - context);
    const to = Math.min(annotated.length - 1, group.end + context);

    let oldCount = 0;
    let newCount = 0;
    const body = [];
    for (let i = from; i <= to; i++) {
      const entry = annotated[i];
      if (entry.type === 'eq') {
        oldCount++;
        newCount++;
        body.push(` ${entry.line}`);
      } else if (entry.type === 'del') {
        oldCount++;
        body.push(`-${entry.line}`);
      } else {
        newCount++;
        body.push(`+${entry.line}`);
      }
    }

    const oldStart = annotated[from].oldNo;
    const newStart = annotated[from].newNo;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    out.push(...body);
  }

  return { text: out.join('\n'), added, removed, hunks: groups.length };
}

/** Short "+N -M" label used next to a file name. */
export function diffSummary(added, removed) {
  const parts = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`-${removed}`);
  return parts.length ? parts.join(' ') : 'no changes';
}

const MAX_LINES = 2000;

export interface MergeResult {
  text: string;
  threeWay: boolean;
}

/**
 * Build an editable buffer. With a baseline this is a line-level three-way
 * merge; otherwise changed regions are marked as a two-way conflict.
 */
export function mergeTexts(local: string, remote: string, base?: string | null): MergeResult {
  const localLines = splitLines(local);
  const remoteLines = splitLines(remote);
  if (localLines.length > MAX_LINES || remoteLines.length > MAX_LINES) {
    return { text: joinLines(markPair(localLines, remoteLines, null)), threeWay: false };
  }
  if (base != null) {
    const baseLines = splitLines(base);
    if (baseLines.length > MAX_LINES) {
      return { text: joinLines(markPair(localLines, remoteLines, null)), threeWay: false };
    }
    return { text: joinLines(diff3(baseLines, localLines, remoteLines)), threeWay: true };
  }
  return { text: joinLines(twoWay(localLines, remoteLines)), threeWay: false };
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split("\n");
}

function joinLines(lines: string[]): string {
  return lines.join("\n");
}

function twoWay(local: string[], remote: string[]): string[] {
  return hunksToLines(diffLines(local, remote));
}

function hunksToLines(edits: Edit[]): string[] {
  const out: string[] = [];
  let localHunk: string[] = [];
  let remoteHunk: string[] = [];
  const flush = () => {
    if (localHunk.length === 0 && remoteHunk.length === 0) return;
    if (same(localHunk, remoteHunk)) out.push(...remoteHunk);
    else out.push(...markPair(localHunk, remoteHunk, null));
    localHunk = [];
    remoteHunk = [];
  };
  for (const edit of edits) {
    if (edit.op === "eq") {
      flush();
      out.push(edit.text);
    } else if (edit.op === "del") localHunk.push(edit.text);
    else remoteHunk.push(edit.text);
  }
  flush();
  return out;
}

interface Region {
  baseLo: number;
  baseHi: number;
  lines: string[];
}

function diff3(base: string[], local: string[], remote: string[]): string[] {
  const left = changeRegions(base, local);
  const right = changeRegions(base, remote);
  const out: string[] = [];
  let cursor = 0;
  let i = 0;
  let j = 0;
  const end = base.length;
  let guard = 0;
  const limit = base.length + local.length + remote.length + left.length + right.length + 4;
  while ((cursor < end || i < left.length || j < right.length) && guard++ < limit) {
    const a = left[i];
    const b = right[j];
    const aLo = a ? a.baseLo : Number.POSITIVE_INFINITY;
    const bLo = b ? b.baseLo : Number.POSITIVE_INFINITY;
    if (cursor < aLo && cursor < bLo) {
      const stop = Math.min(aLo, bLo, end);
      if (stop <= cursor) break;
      out.push(...base.slice(cursor, stop));
      cursor = stop;
      continue;
    }
    if (a && b && overlaps(a, b)) {
      let hi = Math.max(a.baseHi, b.baseHi);
      const aLines: string[] = [];
      const bLines: string[] = [];
      let aBaseLo = a.baseLo;
      let bBaseLo = b.baseLo;
      while (i < left.length && left[i].baseLo <= hi) {
        aLines.push(...left[i].lines);
        aBaseLo = Math.min(aBaseLo, left[i].baseLo);
        hi = Math.max(hi, left[i].baseHi);
        i++;
      }
      while (j < right.length && right[j].baseLo <= hi) {
        bLines.push(...right[j].lines);
        bBaseLo = Math.min(bBaseLo, right[j].baseLo);
        hi = Math.max(hi, right[j].baseHi);
        j++;
      }
      const baseLines = base.slice(Math.min(aBaseLo, bBaseLo), hi);
      if (same(aLines, bLines)) out.push(...aLines);
      else out.push(...markPair(aLines, bLines, baseLines));
      cursor = hi;
      continue;
    }
    if (a && aLo <= bLo) {
      out.push(...a.lines);
      cursor = a.baseHi;
      i++;
      continue;
    }
    if (b) {
      out.push(...b.lines);
      cursor = b.baseHi;
      j++;
      continue;
    }
    break;
  }
  if (cursor < end) out.push(...base.slice(cursor));
  return out;
}

function overlaps(a: Region, b: Region): boolean {
  const aEmpty = a.baseLo === a.baseHi;
  const bEmpty = b.baseLo === b.baseHi;
  if (aEmpty && bEmpty) return a.baseLo === b.baseLo;
  if (aEmpty) return a.baseLo >= b.baseLo && a.baseLo <= b.baseHi;
  if (bEmpty) return b.baseLo >= a.baseLo && b.baseLo <= a.baseHi;
  return a.baseLo < b.baseHi && b.baseLo < a.baseHi;
}

function changeRegions(base: string[], edited: string[]): Region[] {
  const regions: Region[] = [];
  let baseIndex = 0;
  let lo = 0;
  let lines: string[] | null = null;
  const flush = (hi: number) => {
    if (!lines) return;
    regions.push({ baseLo: lo, baseHi: hi, lines });
    lines = null;
  };
  for (const edit of diffLines(base, edited)) {
    if (edit.op === "eq") {
      flush(baseIndex);
      baseIndex++;
      continue;
    }
    if (!lines) {
      lo = baseIndex;
      lines = [];
    }
    if (edit.op === "del") baseIndex++;
    else lines.push(edit.text);
  }
  flush(baseIndex);
  return regions;
}

function markPair(local: string[], remote: string[], base: string[] | null): string[] {
  // Obsidian Markdown: a lone "=======" is a setext H1 underline (blows up the
  // previous line), and lines starting with ">" become purple blockquotes.
  // Keep markers obvious but MD-inert.
  const lines = ["<<<< LOCAL", ...local];
  if (base && base.length > 0) lines.push("|||| BASE", ...base);
  lines.push("==== REMOTE", ...remote, "<<<< END");
  return lines;
}

function same(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

interface Edit {
  op: "eq" | "del" | "ins";
  text: string;
}

function diffLines(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const trace: Array<Record<number, number>> = [];
  const v: Record<number, number> = { 1: 0 };
  for (let d = 0; d <= max; d++) {
    trace.push({ ...v });
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[k - 1] < v[k + 1]);
      let x = down ? v[k + 1] : v[k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  const deleted: Edit[] = a.map((text) => ({ op: "del", text }));
  const inserted: Edit[] = b.map((text) => ({ op: "ins", text }));
  return deleted.concat(inserted);
}

function backtrack(trace: Array<Record<number, number>>, a: string[], b: string[]): Edit[] {
  const edits: Edit[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] ?? {};
    const k = x - y;
    const prevK = k === -d || (k !== d && v[k - 1] < v[k + 1]) ? k + 1 : k - 1;
    const prevX = v[prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push({ op: "eq", text: a[x - 1] ?? "" });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) {
      edits.push({ op: "ins", text: b[y - 1] ?? "" });
      y--;
    } else {
      edits.push({ op: "del", text: a[x - 1] ?? "" });
      x--;
    }
  }
  edits.reverse();
  return edits;
}

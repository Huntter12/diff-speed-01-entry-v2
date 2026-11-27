// diff-speed iter2: a faster drop-in for makefun-diff 1.0.0 (make.fun's own reference program).
//
// The rule, exactly as the house baseline's vendor/makefun-diff/index.js states it:
// lines are cut after every "\n" (a "\r" is part of its line; a last line with no
// "\n" is a line too); two lines are equal only when they are the same code units,
// newline or its absence included. The edit script keeps the common prefix, then the
// common suffix of what is left; between them Myers's greedy search from the first
// lines, keeping on each diagonal the path reaching furthest into the old text and,
// when a deletion and an insertion reach the same point, the deletion's, never moving
// past either text's end, pruning no edge diagonal, and following every run of equal
// lines as far as it goes; the first path to reach both ends is the script. The patch
// is "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I", then per hunk
// "@ os ol ns nl" and one line per line it covers ("=" kept, "-" deleted, "+" inserted);
// each change run lists its deletions before its insertions, shows up to 3 kept lines
// before and after it, and two runs at most 6 kept lines apart share a hunk. A line
// that ends its text with no newline is written with one and followed by a line "%".
// Identical texts are the first line alone.
//
// This module reproduces that rule bit for bit, faster, in two ways over the v1 entry
// (hashed-line Myers with V snapshots):
//
// 1. ANCHOR RUNS. After hashing lines to integers, a line that occurs exactly once
//    in each text is a unique match. A maximal run of at least two consecutive unique
//    matches on one diagonal (consecutive lines in both texts, in order) is a
//    candidate anchor — but only when it is uncontested and certified. A run is
//    contested when any other run crosses it (earlier in one text, later in the
//    other): no alignment can match both, and choosing by run weight alone is
//    wrong, because the gap matches on either side can outweigh a small weight
//    difference (a block of lines moved past another block). Contested runs are
//    dropped and their region is decided by the exact gap search. A surviving
//    run is certified by a crossing count: with chain neighbours ending at
//    (px, py) and starting at (nx, ny), any path that skips the run can gain
//    matches only inside the two crossing rectangles [x+R..nx] x [py..y] and
//    [px..x] x [y+R..ny]; if C is the sum over line values of the smaller of
//    the two sides' counts there, such a path gains at most C matches while
//    losing the run's R, so R > C puts the run on every shortest path, hence
//    on the greedy path. (A surviving run's crossing rectangles hold no run
//    lines at all — any run crossing it would make it contested — so the
//    count is over repeated lines and isolated unique matches, the two ways
//    a short run can be outvoted.) Runs failing the check are dropped, the
//    check repeats until a pass drops nothing, and the gap search decides
//    their regions. Single unique matches (runs of length 1) are NOT anchors:
//    two equally short scripts can disagree about them, and the greedy
//    tie-break decides.
// 2. The exact greedy Myers from v1 (Int32Array diagonals, V snapshots + backtrack
//    with the reference's exact tie-break) runs only on the gaps between
//    anchor runs, never on the whole text, so the D^2 diagonal walk collapses to a
//    sum over gaps (a contested region costs about its own D^2/2). If no anchor
//    run exists the whole middle is one gap and the module behaves like v1.
//
// Nothing is cached from one case to the next: every run() call builds its own
// line table from its own input.

/** The patch's first word. */
export const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
export const CONTEXT = 3;

/** The shortest run of consecutive unique matches that counts as an anchor. */
export const RUN_MIN = 2;

const KEEP = '=';
const DELETE = '-';
const INSERT = '+';

/** A text's lines, each with its "\n" (the last one without, when the text does not end in one). */
function tokenize(text) {
  const parts = text.split('\n');
  const lines = [];
  const last = parts.length - 1;
  for (let i = 0; i < last; i++) lines.push(parts[i] + '\n');
  if (parts[last] !== '') lines.push(parts[last]);
  return lines;
}

/**
 * The runs of the edit script of A[x0 .. x0+N) into B[y0 .. y0+M): [[kind, count], ...]
 * in order, kinds '=' kept, '-' deleted, '+' inserted. The forward search is the
 * header's greedy search (furthest point per diagonal, deletion on ties, no move
 * past either end, no edge pruning, full snakes); the snapshots it keeps let the
 * backtrack below recover the first path to reach both ends, with the same choices.
 * (Unchanged from the v1 entry: it is the exact greedy search, run here only on gaps.)
 */
function myers(A, B, x0, y0, N, M) {
  if (N === 0 && M === 0) return [];
  const Vs = [];
  // Depth 0: the snake from the first lines along diagonal 0.
  let x = 0;
  let y = 0;
  while (x < N && y < M && A[x0 + x] === B[y0 + y]) { x++; y++; }
  const v0 = new Int32Array(1);
  v0[0] = x;
  Vs.push(v0);
  if (x >= N && y >= M) return [[KEEP, N]];
  let D = -1;
  for (let d = 1; ; d++) {
    const Vd = new Int32Array(2 * d + 1);
    let done = false;
    const prev = Vs[d - 1];
    let idx = 0;
    let downIdx = -2;
    let upIdx = 0;
    for (let k = -d; k <= d; k += 2, idx += 2, downIdx += 2, upIdx += 2) {
      // Furthest x on diagonals k-1 and k+1 at depth d-1 (-1: no path there).
      const vDown = k === -d ? -1 : prev[downIdx];
      const vUp = k === d ? -1 : prev[upIdx];
      // A move past the end of either text is no candidate.
      const canRemove = vDown >= 0 && vDown < N;
      const canAdd = vUp >= 0 && vUp - (k + 1) < M;
      if (!canRemove && !canAdd) { Vd[idx] = -1; continue; }
      // Further into the old text wins; the deletion when both reach one point.
      let nx = (canRemove && (!canAdd || vDown + 1 >= vUp)) ? vDown + 1 : vUp;
      let ny = nx - k;
      while (nx < N && ny < M && A[x0 + nx] === B[y0 + ny]) { nx++; ny++; }
      Vd[idx] = nx;
      if (nx >= N && ny >= M) { D = d; done = true; break; }
    }
    Vs.push(Vd);
    if (done) break;
  }
  // Backtrack the first path to reach both ends, re-applying the same choices.
  const ops = [];
  x = N;
  y = M;
  for (let d = D; d >= 1; d--) {
    const k = x - y;
    const prev = Vs[d - 1];
    const vDown = k === -d ? -1 : prev[k + d - 2];
    const vUp = k === d ? -1 : prev[k + d];
    const canRemove = vDown >= 0 && vDown < N;
    const canAdd = vUp >= 0 && vUp - (k + 1) < M;
    let prevX;
    let prevY;
    let isDel;
    if (canRemove && (!canAdd || vDown + 1 >= vUp)) {
      isDel = true;
      prevX = vDown;
      prevY = vDown - (k - 1);
    } else {
      isDel = false;
      prevX = vUp;
      prevY = vUp - (k + 1);
    }
    const ex = isDel ? prevX + 1 : prevX;
    const keep = x - ex;
    if (keep > 0) ops.push([KEEP, keep]);
    ops.push([isDel ? DELETE : INSERT, 1]);
    x = prevX;
    y = prevY;
  }
  if (x > 0) ops.push([KEEP, x]);
  // Reverse the backtracked segments, merging neighbours of one kind into runs.
  const runs = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === op[0]) last[1] += op[1];
    else runs.push([op[0], op[1]]);
  }
  return runs;
}

/**
 * The anchor runs of the middle A[x0 .. x0+N) into B[y0 .. y0+M): maximal runs of
 * at least RUN_MIN consecutive unique matches (a line id occurring exactly once in
 * each text), each [x, y, len] in middle coordinates. Between them lie the gaps.
 */
function anchorRuns(A, B, x0, y0, N, M, counts) {
  const { countA, countB, posB } = counts;
  const runs = [];
  let rx = -1; // start x of the open run, -1 when none
  let ry = -1; // start y of the open run
  let rlen = 0;
  let px = -1; // previous unique match's x
  let py = -1; // previous unique match's y
  for (let x = 0; x < N; x++) {
    const id = A[x0 + x];
    let y = -1;
    if (countA[id] === 1 && countB[id] === 1) {
      // posB holds absolute B positions; the run works in middle coordinates.
      // A unique line whose only B occurrence lies in the trimmed prefix or
      // suffix is left to the gap search (it cannot anchor the middle).
      const yy = posB[id] - y0;
      if (yy >= 0 && yy < M) y = yy;
    }
    if (y >= 0 && rx >= 0 && x === px + 1 && y === py + 1) {
      // Continues the open run.
      rlen++;
    } else {
      if (rlen >= RUN_MIN) runs.push([rx, ry, rlen]);
      if (y >= 0) { rx = x; ry = y; rlen = 1; }
      else { rx = -1; ry = -1; rlen = 0; }
    }
    px = x; py = y;
  }
  if (rlen >= RUN_MIN) runs.push([rx, ry, rlen]);
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** make.fun's own patch of input.old into input.new (the header). */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const a = tokenize(input.old);
  const b = tokenize(input.new);
  const n = a.length;
  const m = b.length;
  // Lines hashed to integers: exact code-unit equality, compared as ints below.
  const ids = new Map();
  const A = new Int32Array(n);
  const B = new Int32Array(m);
  let nextId = 0;
  for (let i = 0; i < n; i++) {
    const s = a[i];
    let id = ids.get(s);
    if (id === undefined) { id = nextId++; ids.set(s, id); }
    A[i] = id;
  }
  for (let j = 0; j < m; j++) {
    const s = b[j];
    let id = ids.get(s);
    if (id === undefined) { id = nextId++; ids.set(s, id); }
    B[j] = id;
  }
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && A[prefix] === B[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && A[n - 1 - suffix] === B[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push([KEEP, prefix]);
  const mx0 = prefix;
  const my0 = prefix;
  const mN = n - prefix - suffix;
  const mM = m - prefix - suffix;
  if (mN > 0 || mM > 0) {
    // Occurrence counts and the B position of every unique-both line id.
    const countA = new Int32Array(nextId);
    const countB = new Int32Array(nextId);
    const posB = new Int32Array(nextId);
    for (let i = 0; i < n; i++) countA[A[i]]++;
    for (let j = 0; j < m; j++) countB[B[j]]++;
    for (let j = 0; j < m; j++) {
      const id = B[j];
      if (countA[id] === 1 && countB[id] === 1) posB[id] = j;
    }
    const anchors = anchorRuns(A, B, mx0, my0, mN, mM, { countA, countB, posB });
    // CONTESTED RUNS. Two runs cross when one is earlier in the old text
    // but later in the new text (or the reverse): no alignment can match
    // both, so choosing between them by run weight alone is wrong — the
    // gap matches on either side can outweigh a small weight difference
    // (a block of lines moved past another block). Every run crossed by
    // any other run is therefore dropped, and its region is decided by
    // the exact gap search instead. A moved block's own run crosses the
    // runs in its span, so those runs are dropped too; the gap search
    // re-derives them at a cost of about D^2/2 diagonal visits for the
    // region, which is small next to the whole text's D^2. The survivors
    // cross nothing, so they already form a chain in old-text order and
    // no longest-subsequence step is needed. A run is contested exactly
    // when some later run starts lower in the new text, or some earlier
    // run starts higher: runs are in old-text order and their new-text
    // ranges are disjoint, so a suffix minimum and a prefix maximum of
    // the new-text starts decide it in linear time.
    let chain = [];
    {
      const R = anchors.length;
      const sufMin = new Int32Array(R + 1);
      sufMin[R] = 1 << 30;
      for (let i = R - 1; i >= 0; i--) sufMin[i] = anchors[i][1] < sufMin[i + 1] ? anchors[i][1] : sufMin[i + 1];
      let preMax = -1;
      for (let i = 0; i < R; i++) {
        const r = anchors[i];
        // Contested: crossed by a later run starting lower in the new
        // text, or by an earlier run starting higher.
        if (sufMin[i + 1] >= r[1] && preMax <= r[1]) chain.push(r);
        if (r[1] > preMax) preMax = r[1];
      }
    }
    // The crossing count C of a chain run against its chain neighbours.
    // Scratch arrays for zone counting without per-rectangle allocation:
    // stamp arrays version the counts, so a zone's counts need no clearing.
    const stampA = new Int32Array(nextId);
    const cntA = new Int32Array(nextId);
    const stampB = new Int32Array(nextId);
    const cntB = new Int32Array(nextId);
    const seenBuf = new Int32Array(nextId);
    let curMark = 0;
    // Count, per line id, the smaller side's occurrences in one rectangle:
    // an upper bound on how many lines any alignment can match there.
    // Scratch arrays version the counts, so a zone's counts need no clearing.
    const rectCount = (ax0, ax1, by0, by1, cap) => {
      if (ax0 >= ax1 || by0 >= by1) return 0;
      curMark++;
      let seenLen = 0;
      for (let i = ax0; i < ax1; i++) {
        const id = A[mx0 + i];
        if (stampA[id] !== curMark) { stampA[id] = curMark; cntA[id] = 0; seenBuf[seenLen++] = id; }
        cntA[id]++;
      }
      for (let j = by0; j < by1; j++) {
        const id = B[my0 + j];
        if (stampB[id] !== curMark) { stampB[id] = curMark; cntB[id] = 0; }
        cntB[id]++;
      }
      let total = 0;
      for (let k = 0; k < seenLen; k++) {
        const id = seenBuf[k];
        if (stampB[id] === curMark) {
          const na = cntA[id], nb = cntB[id];
          total += na < nb ? na : nb;
          if (total >= cap) return total;
        }
      }
      return total;
    };
    const crossingOf = (ch, t) => {
      const r = ch[t];
      const x = r[0], y = r[1], len = r[2];
      const px = t > 0 ? ch[t - 1][0] + ch[t - 1][2] : 0;
      const py = t > 0 ? ch[t - 1][1] + ch[t - 1][2] : 0;
      const nx = t + 1 < ch.length ? ch[t + 1][0] : mN;
      const ny = t + 1 < ch.length ? ch[t + 1][1] : mM;
      let c = rectCount(x + len, nx, py, y, len);
      if (c < len) c += rectCount(px, x, y + len, ny, len - c);
      return c;
    };
    // Certification of the survivors: a run is kept only while no
    // alternative can outvote it (see the crossing count above). Dropping
    // a survivor only widens its neighbours' zones, so the check is
    // repeated until a pass drops nothing; no re-chaining is needed.
    // A pair of adjacent runs is certified the same way, as one unit:
    // each run alone can pass while the pair is jointly outvoted — an
    // alternative that skips both runs at once gains the matches in the
    // pair's outer crossing zones (bounded by the pair's outer neighbours)
    // plus the inter-run gap, and the individual checks never see that
    // region because each run's zones are bounded by the other run. A
    // pair whose combined length does not exceed that count is dropped
    // as a whole, and its region is decided by the gap search. The pair
    // pass runs exactly once, from a single chain snapshot: dropping a
    // pair widens its neighbours' zones, so re-running it would cascade
    // and eat the chain. After the pair pass the individual check runs
    // again to convergence.
    const certifySingles = () => {
      for (let pass = 0; pass < 6; pass++) {
        const keep = [];
        let dropped = 0;
        for (let t = 0; t < chain.length; t++) {
          if (chain[t][2] > crossingOf(chain, t)) keep.push(chain[t]);
          else dropped++;
        }
        if (dropped === 0) break;
        chain = keep;
      }
    };
    certifySingles();
    if (chain.length >= 2) {
      const dropPair = new Set();
      for (let t = 0; t + 1 < chain.length; t++) {
        const r0 = chain[t], r1 = chain[t + 1];
        const px = t > 0 ? chain[t - 1][0] + chain[t - 1][2] : 0;
        const py = t > 0 ? chain[t - 1][1] + chain[t - 1][2] : 0;
        const nx = t + 2 < chain.length ? chain[t + 2][0] : mN;
        const ny = t + 2 < chain.length ? chain[t + 2][1] : mM;
        const rPair = r0[2] + r1[2];
        let c = rectCount(r1[0] + r1[2], nx, py, r0[1], rPair);
        if (c < rPair) c += rectCount(px, r0[0], r1[1] + r1[2], ny, rPair - c);
        if (c < rPair) c += rectCount(r0[0] + r0[2], r1[0], r0[1] + r0[2], r1[1], rPair - c);
        if (c >= rPair) { dropPair.add(t); dropPair.add(t + 1); }
      }
      if (dropPair.size > 0) {
        chain = chain.filter((_, i) => !dropPair.has(i));
        certifySingles();
      }
    }
    const anchorsKept = chain;
    // Walk the middle: anchor runs are kept, gaps get the exact greedy Myers.
    let cx = 0;
    let cy = 0;
    for (let t = 0; t < anchorsKept.length; t++) {
      const [ax, ay, alen] = anchorsKept[t];
      if (ax > cx || ay > cy) {
        const gap = myers(A, B, mx0 + cx, my0 + cy, ax - cx, ay - cy);
        for (let i = 0; i < gap.length; i++) runs.push(gap[i]);
      }
      runs.push([KEEP, alen]);
      cx = ax + alen;
      cy = ay + alen;
    }
    if (cx < mN || cy < mM) {
      const gap = myers(A, B, mx0 + cx, my0 + cy, mN - cx, mM - cy);
      for (let i = 0; i < gap.length; i++) runs.push(gap[i]);
    }
  }
  if (suffix > 0) runs.push([KEEP, suffix]);

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < runs.length; i++) {
    const kind = runs[i][0];
    const count = runs[i][1];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DELETE) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written(KEEP, a[at]));
      for (let i = 0; i < c.dels; i++) out.push(written(DELETE, a[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written(INSERT, b[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written(KEEP, a[at]));
  }
  return out.join('');
}

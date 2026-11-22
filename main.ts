// Sokoban solver: push-optimal, room by room.
//
// The generator's levels are a one-wide hallway with rooms off it, each room
// holding 3 or 4 boxes and as many goals, joined to the hallway through a
// single door; a box pushed out of its room can never come back, so a level's
// push-optimal count is the sum of its rooms' optima. This solver finds the
// rooms (articulation points of the floor graph), solves each room on its own
// with a push-based A* (minimum-cost box-to-goal matching heuristic, dead
// squares, player-position canonicalisation), and stitches the rooms together
// with hallway walks. Moves are what the checker replays; only the push count
// is scored, so the solver optimises pushes, not steps.
//
// Deterministic: expansion caps, never the clock; fixed direction order and
// insertion-order tie-breaking in every heap and BFS.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Per-room expansion cap; the whole set is 5 levels, each a few rooms. */
const ROOM_EXPANSIONS = 150_000;
/** Whole-level fallback cap. */
const LEVEL_EXPANSIONS = 300_000;

const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
};

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

/** The four neighbours of cell i that are not walls, in fixed order. */
function neighbours(lv: Level, i: number): number[] {
  const { w, h, wall } = lv;
  const x = i % w;
  const y = (i / w) | 0;
  const out: number[] = [];
  if (y > 0 && !wall[i - w]) out.push(i - w);
  if (y < h - 1 && !wall[i + w]) out.push(i + w);
  if (x > 0 && !wall[i - 1]) out.push(i - 1);
  if (x < w - 1 && !wall[i + 1]) out.push(i + 1);
  return out;
}

/** Connected components of the floor with cell `cut` removed. */
function componentsWithout(lv: Level, cut: number): number[][] {
  const { w, h, wall } = lv;
  const seen = new Uint8Array(w * h);
  if (cut >= 0) seen[cut] = 1;
  const comps: number[][] = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] || seen[s]) continue;
    const comp: number[] = [];
    const q = [s];
    seen[s] = 1;
    while (q.length > 0) {
      const c = q.pop()!;
      comp.push(c);
      for (const nb of neighbours(lv, c)) {
        if (!seen[nb]) {
          seen[nb] = 1;
          q.push(nb);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

type Room = { cells: number[]; boxes: number[]; goals: number[]; entries: number[] };

/** Find the rooms by the hallway row: the player starts in the hallway, a
 * one-wide row across the board; removing that row splits the floor into the
 * rooms above and below it. Each room holds as many boxes as goals. */
function findRoomsRow(lv: Level): Room[] {
  const hy = (lv.player / lv.w) | 0;
  const boxSet = new Set(lv.boxes);
  const hallway = new Set<number>();
  for (let x = 0; x < lv.w; x++) {
    const i = hy * lv.w + x;
    if (!lv.wall[i]) hallway.add(i);
  }
  const seen = new Uint8Array(lv.w * lv.h);
  hallway.forEach((i) => {
    seen[i] = 1;
  });
  const rooms: Room[] = [];
  for (let s = 0; s < lv.w * lv.h; s++) {
    if (lv.wall[s] || seen[s]) continue;
    const comp: number[] = [];
    const q = [s];
    seen[s] = 1;
    while (q.length > 0) {
      const c = q.pop()!;
      comp.push(c);
      for (const nb of neighbours(lv, c)) {
        if (!seen[nb]) {
          seen[nb] = 1;
          q.push(nb);
        }
      }
    }
    const boxes = comp.filter((c) => boxSet.has(c));
    const goals = comp.filter((c) => lv.goal[c] === 1);
    if (boxes.length === 0 || boxes.length !== goals.length) continue;
    const compSet = new Set(comp);
    // The hallway cells the room opens onto: its doors.
    const entries = [...hallway]
      .filter((h) => neighbours(lv, h).some((nb) => compSet.has(nb)))
      .sort((a, b) => a - b);
    if (entries.length === 0) continue;
    rooms.push({ cells: comp, boxes, goals, entries });
  }
  rooms.sort((a, b) => a.entries[0]! - b.entries[0]!);
  return rooms;
}

/** Fallback room finder: maximal floor components cut off by one door cell,
 * holding as many boxes as goals and not holding the player start, and never
 * reaching into the hallway row (that marks a component that is the whole
 * level minus the player, not a room). */
function findRoomsArticulation(lv: Level): Room[] {
  const hy = (lv.player / lv.w) | 0;
  const boxSet = new Set(lv.boxes);
  const cands: Room[] = [];
  for (let v = 0; v < lv.w * lv.h; v++) {
    if (lv.wall[v]) continue;
    const comps = componentsWithout(lv, v);
    if (comps.length < 2) continue;
    for (const comp of comps) {
      if (comp.includes(lv.player)) continue;
      if (comp.some((c) => (c / lv.w) | 0 === hy)) continue;
      const boxes = comp.filter((c) => boxSet.has(c));
      const goals = comp.filter((c) => lv.goal[c] === 1);
      if (boxes.length > 0 && boxes.length === goals.length) {
        cands.push({ cells: comp, boxes, goals, entries: [v] });
      }
    }
  }
  // Keep only maximal candidates: a room found through its door contains any
  // nook found through an articulation inside it.
  cands.sort((a, b) => b.cells.length - a.cells.length);
  const kept: Room[] = [];
  for (const c of cands) {
    const set = new Set(c.cells);
    const covered = kept.some((k) => c.cells.every((cell) => k.cells.includes(cell)));
    const overlap = kept.some((k) => k.cells.some((cell) => set.has(cell)));
    if (!covered && !overlap) kept.push(c);
  }
  kept.sort((a, b) => a.entries[0]! - b.entries[0]!);
  return kept;
}

/** The rooms of a level, by the hallway row first, articulation second. */
function findRooms(lv: Level): Room[] {
  const byRow = findRoomsRow(lv);
  const covered = new Set<number>();
  for (const r of byRow) for (const b of r.boxes) covered.add(b);
  if (byRow.length > 0 && lv.boxes.every((b) => covered.has(b))) return byRow;
  const byArt = findRoomsArticulation(lv);
  const covered2 = new Set<number>();
  for (const r of byArt) for (const b of r.boxes) covered2.add(b);
  if (byArt.length > 0 && lv.boxes.every((b) => covered2.has(b))) return byArt;
  return byRow.length >= byArt.length ? byRow : byArt;
}

/** BFS distances from `from` over `cells` (a Set of floor cells), ignoring boxes. */
function bfsDist(lv: Level, from: number, cells: Set<number>): Map<number, number> {
  const dist = new Map<number, number>([[from, 0]]);
  const q = [from];
  for (let h = 0; h < q.length; h++) {
    const c = q[h]!;
    for (const nb of neighbours(lv, c)) {
      if (!cells.has(nb) || dist.has(nb)) continue;
      dist.set(nb, dist.get(c)! + 1);
      q.push(nb);
    }
  }
  return dist;
}

/** Shortest walk from `from` to `to` over floor cells not in `blocked`, as a
 * move string, or null. Deterministic direction order. */
function walkPath(lv: Level, from: number, to: number, blocked: Set<number>): string | null {
  if (from === to) return '';
  const prev = new Map<number, number>();
  const prevMove = new Map<number, string>();
  const q = [from];
  prev.set(from, -1);
  for (let h = 0; h < q.length; h++) {
    const c = q[h]!;
    const x = c % lv.w;
    const y = (c / lv.w) | 0;
    for (const [dx, dy, letter] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) continue;
      const nb = ny * lv.w + nx;
      if (lv.wall[nb] || blocked.has(nb) || prev.has(nb)) continue;
      prev.set(nb, c);
      prevMove.set(nb, letter);
      if (nb === to) {
        let moves = '';
        for (let t = nb; t !== from; t = prev.get(t)!) moves = prevMove.get(t)! + moves;
        return moves;
      }
      q.push(nb);
    }
  }
  return null;
}

/** The reachable region of the player from `from`, over `cells` minus `boxes`. */
function reachable(lv: Level, from: number, cells: Set<number>, boxes: Set<number>): Set<number> {
  const seen = new Set<number>([from]);
  const q = [from];
  for (let h = 0; h < q.length; h++) {
    const c = q[h]!;
    for (const nb of neighbours(lv, c)) {
      if (!cells.has(nb) || boxes.has(nb) || seen.has(nb)) continue;
      seen.add(nb);
      q.push(nb);
    }
  }
  return seen;
}

/** Dead squares: floor cells (not goals) from which a box can never reach a
 * goal, by reverse-push reachability ignoring other boxes. A state holding a
 * box on one is pruned. */
function deadSquares(lv: Level, cells: Set<number>, goals: number[]): Set<number> {
  // Reverse graph: a box on b can be pushed to b+d when b-d is floor (the
  // player stands there). Live cells are the ones goals reach in reverse.
  const live = new Set<number>(goals);
  const q = [...goals];
  for (let h = 0; h < q.length; h++) {
    const b = q[h]!;
    const x = b % lv.w;
    const y = (b / lv.w) | 0;
    for (const [dx, dy] of DIRS) {
      const prev = b - (dy * lv.w + dx); // the box stood here before the push
      const px = prev % lv.w;
      const py = (prev / lv.w) | 0;
      if (px < 0 || px >= lv.w || py < 0 || py >= lv.h) continue;
      if (!cells.has(prev) || live.has(prev)) continue;
      // The push needs the player behind the box: prev-d must be floor.
      const behind = prev - (dy * lv.w + dx);
      const bx = behind % lv.w;
      const by = (behind / lv.w) | 0;
      if (bx < 0 || bx >= lv.w || by < 0 || by >= lv.h) continue;
      if (!cells.has(behind)) continue;
      // And the box's destination b must be floor (it is: b is live).
      live.add(prev);
      q.push(prev);
    }
  }
  const dead = new Set<number>();
  for (const c of cells) {
    if (!live.has(c) && lv.goal[c] !== 1) dead.add(c);
  }
  return dead;
}

/** Minimum-cost assignment of boxes to goals by the distance matrix, exact
 * DP over subsets (rooms hold at most 4 boxes). Infinity when no assignment
 * reaches every goal. */
function matchingCost(boxes: number[], goals: number[], dist: Map<number, Map<number, number>>): number {
  const k = boxes.length;
  const INF = 1e9;
  const cost: number[][] = boxes.map((b) => goals.map((g) => dist.get(b)?.get(g) ?? INF));
  const dp = new Array(1 << k).fill(INF);
  dp[0] = 0;
  for (let mask = 0; mask < 1 << k; mask++) {
    const i = popcount(mask); // boxes[0..i) assigned
    if (i >= k) continue;
    for (let j = 0; j < k; j++) {
      if (mask & (1 << j)) continue;
      const c = cost[i]![j]!;
      if (c < INF) dp[mask | (1 << j)] = Math.min(dp[mask | (1 << j)]!, dp[mask]! + c);
    }
  }
  return dp[(1 << k) - 1]!;
}

function popcount(x: number): number {
  let n = 0;
  while (x > 0) {
    n += x & 1;
    x >>= 1;
  }
  return n;
}

/** Admissible push heuristic: exact minimum-cost assignment for small
 * counts, else the sum of each box's nearest-goal distance. */
function heuristicCost(boxes: number[], goals: number[], dist: Map<number, Map<number, number>>): number {
  if (boxes.length <= 6) return matchingCost(boxes, goals, dist);
  let s = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (const g of goals) m = Math.min(m, dist.get(b)?.get(g) ?? Infinity);
    if (m === Infinity) return Infinity;
    s += m;
  }
  return s;
}

type Push = { box: number; dx: number; dy: number; letter: string };

/** Push-optimal solve of one room (or, as a fallback, of a whole level).
 * `cells` is the floor the player and boxes may use; `entry` is where the
 * player starts; boxes stay inside `cells`. Returns the move string from the
 * entry, or null when the cap is hit or the room is unsolvable. */
function solveRoom(
  lv: Level,
  cells: number[],
  entry: number,
  boxes0: number[],
  goals0: number[],
  cap: number,
): { moves: string; endPlayer: number; endBoxes: number[] } | null {
  const cellSet = new Set(cells);
  const goalSet = new Set(goals0);
  const dead = deadSquares(lv, cellSet, goals0);
  for (const b of boxes0) if (dead.has(b)) return null;

  // All-pairs floor distances inside the room, for the matching heuristic.
  const dist = new Map<number, Map<number, number>>();
  for (const c of cellSet) dist.set(c, bfsDist(lv, c, cellSet));

  const keyOf = (boxes: number[], player: number): string => boxes.join(',') + '|' + player;

  // A* over pushes. States hold the canonical player (the smallest cell of
  // the player's reachable region), so equivalent positions collapse. The
  // start state keeps the entry itself: the returned moves start there.
  type State = { boxes: number[]; player: number; parent: number; push: Push | null; g: number };
  const states: State[] = [];
  const startPlayer = entry;
  states.push({ boxes: [...boxes0].sort((a, b) => a - b), player: startPlayer, parent: -1, push: null, g: 0 });

  const heap: [number, number, number][] = []; // [f, g, state]
  let seq = 0;
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const hpush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const hpop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const startH = heuristicCost(states[0]!.boxes, goals0, dist);
  if (startH >= 1e9) return null;
  const best = new Map<string, number>([[keyOf(states[0]!.boxes, startPlayer), 0]]);
  hpush([startH, 0, 0]);

  let expanded = 0;
  let goalState = -1;
  while (heap.length > 0) {
    const [f, g, s] = hpop();
    const st = states[s]!;
    if (best.get(keyOf(st.boxes, st.player)) !== g) continue;
    if (st.boxes.every((b) => goalSet.has(b))) {
      goalState = s;
      break;
    }
    if (++expanded > cap) return null;
    const boxSet = new Set(st.boxes);
    const region = reachable(lv, st.player, cellSet, boxSet);
    for (const b of st.boxes) {
      const x = b % lv.w;
      const y = (b / lv.w) | 0;
      for (const [dx, dy, letter] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) continue;
        const target = ny * lv.w + nx;
        if (!cellSet.has(target) || boxSet.has(target)) continue;
        const pusher = b - (dy * lv.w + dx);
        if (!region.has(pusher)) continue;
        const nb = [...st.boxes];
        nb[nb.indexOf(b)] = target;
        nb.sort((a, b2) => a - b2);
        if (nb.some((cell) => dead.has(cell))) continue;
        const h = heuristicCost(nb, goals0, dist);
        if (h >= 1e9) continue;
        // After the push the player stands where the box stood; canonicalise.
        const region2 = reachable(lv, b, cellSet, new Set(nb));
        const nplayer = Math.min(...region2);
        const k = keyOf(nb, nplayer);
        const seen = best.get(k);
        if (seen !== undefined && seen <= g + 1) continue;
        best.set(k, g + 1);
        const t = states.length;
        states.push({ boxes: nb, player: nplayer, parent: s, push: { box: b, dx, dy, letter }, g: g + 1 });
        hpush([g + 1 + h, g + 1, t]);
      }
    }
  }
  if (goalState < 0) return null;

  // Reconstruct: for each push, walk the player to the pushing square, then push.
  const pushes: Push[] = [];
  for (let t = goalState; t > 0; t = states[t]!.parent) {
    pushes.push(states[t]!.push!);
  }
  pushes.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = [...states[0]!.boxes];
  for (let i = 0; i < pushes.length; i++) {
    const p = pushes[i]!;
    const pusher = p.box - (p.dy * lv.w + p.dx);
    const walk = walkPath(lv, player, pusher, new Set(boxes));
    if (walk === null) return null;
    moves += walk;
    moves += p.letter;
    boxes[boxes.indexOf(p.box)] = p.box + (p.dy * lv.w + p.dx);
    boxes.sort((a, b) => a - b);
    player = p.box;
  }
  return { moves, endPlayer: player, endBoxes: boxes };
}

/** Replay a move string on the level; returns the end state, or null on an
 * illegal step. */
function applyMoves(lv: Level, moves: string): { player: number; boxes: number[] } | null {
  const boxSet = new Set(lv.boxes);
  let player = lv.player;
  for (const ch of moves) {
    const d = DIRS.find(([, , letter]) => letter === ch.toLowerCase());
    if (!d) return null;
    const [dx, dy] = d;
    const next = player + (dy * lv.w + dx);
    if (lv.wall[next]) return null;
    if (boxSet.has(next)) {
      const beyond = next + (dy * lv.w + dx);
      if (lv.wall[beyond] || boxSet.has(beyond)) return null;
      boxSet.delete(next);
      boxSet.add(beyond);
    }
    player = next;
  }
  return { player, boxes: [...boxSet].sort((a, b) => a - b) };
}

/** Solve one level, returning the move string ('' when unsolved). */
function solve(text: string): string {
  const lv = parseLevel(text);
  if (lv.boxes.length === 0) return '';
  if (lv.boxes.every((b) => lv.goal[b] === 1)) return '';

  const rooms = findRooms(lv);
  const covered = new Set<number>();
  for (const r of rooms) for (const b of r.boxes) covered.add(b);
  const allCovered = lv.boxes.every((b) => covered.has(b));

  if (rooms.length > 0 && allCovered) {
    // Room by room, in door order.
    let moves = '';
    let player = lv.player;
    const currentBoxes = new Set(lv.boxes);
    for (const room of rooms) {
      const entry = room.entries[0]!;
      const walk = walkPath(lv, player, entry, currentBoxes);
      if (walk === null) return '';
      moves += walk;
      player = entry;
      const solved = solveRoom(lv, [...room.cells, ...room.entries], entry, room.boxes, room.goals, ROOM_EXPANSIONS);
      if (solved === null) return '';
      moves += solved.moves;
      for (const b of room.boxes) currentBoxes.delete(b);
      for (const b of solved.endBoxes) currentBoxes.add(b);
      player = solved.endPlayer;
    }
    // Defensive replay: only a solved level scores.
    const end = applyMoves(lv, moves);
    if (end === null || !end.boxes.every((b) => lv.goal[b] === 1)) return '';
    return moves;
  }

  // Fallback: one push-A* over the whole level.
  const floor: number[] = [];
  for (let i = 0; i < lv.w * lv.h; i++) if (!lv.wall[i]) floor.push(i);
  const goals = floor.filter((c) => lv.goal[c] === 1);
  const solved = solveRoom(lv, floor, lv.player, lv.boxes, goals, LEVEL_EXPANSIONS);
  if (solved === null) return '';
  const end = applyMoves(lv, solved.moves);
  if (end === null || !end.boxes.every((b) => lv.goal[b] === 1)) return '';
  return solved.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}

// Fog of war for the bridge: the cells the player has seen on screen, a copy of the world that
// holds only them, and the frontier to walk to when the goal is not among them yet.
import type { LogicApi, World } from "../load-logic.ts"
import { angleDiff, passable, type Cell } from "./route.ts"

// Sample spacing along a ray, in FP units: a quarter cell, so no cell a ray crosses is skipped.
const RAY_STEP = 256
const SIDES: Cell[] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
// Keep walking to the frontier picked before while it costs at most this many steps more.
const KEEP_TARGET = 2
// A boss that is nowhere in sight may be in a known cell nobody has looked at for this long.
export const STALE_MS = 10000

export interface KnownMapJson {
    key: string
    w: number
    h: number
    // One char per cell, row after row: 1 seen, 0 not.
    seen: string
    boss: Cell | null
}

// Cells on screen right now: a ray per screen column, as the renderer casts them, marking every
// cell the ray crosses up to the wall, door or exit it stops at (the game caps a ray at 48 cells).
export function visibleCells(api: LogicApi, world: World): Cell[] {
    const out = new Map<number, Cell>()
    const add = (cx: number, cy: number) => {
        if (cx >= 0 && cy >= 0 && cx < world.w && cy < world.h) out.set(cy * world.w + cx, [cx, cy])
    }
    const hit = new api.Hit()
    for (let col = 0; col < api.VIEW_W; col++) {
        api.castColumn(world, col, hit)
        const ex = world.x + ((hit.dist * hit.rdx) >> 10)
        const ey = world.y + ((hit.dist * hit.rdy) >> 10)
        const len = Math.hypot(ex - world.x, ey - world.y)
        const n = Math.ceil(len / RAY_STEP)
        for (let i = 0; i <= n; i++) {
            const t = n === 0 ? 0 : i / n
            add(Math.floor((world.x + (ex - world.x) * t) / api.FP), Math.floor((world.y + (ey - world.y) * t) / api.FP))
        }
        add(hit.cellX, hit.cellY)
    }
    return [...out.values()]
}

// What the player knows of one level. Kept across attempts unless the bridge runs without map
// memory; `toJSON` is the shape a level-memory file can store.
export class KnownMap {
    key = ""
    w = 0
    h = 0
    seen = new Uint8Array(0)
    // When each cell was last on screen, in the bridge clock (an earlier attempt's time stays).
    seenAt = new Float64Array(0)
    private clock = 0
    // Where the boss was last seen, in this attempt or an earlier one.
    boss: Cell | null = null
    // Frontier (or stale) cell being walked to, so the pick does not flip between two equal ones.
    target: Cell | null = null

    reset(key: string, w: number, h: number): void {
        this.key = key
        this.w = w
        this.h = h
        this.seen = new Uint8Array(w * h)
        this.seenAt = new Float64Array(w * h)
        this.clock = 0
        this.boss = null
        this.target = null
    }

    // How long ago the cell was on screen; Infinity if never.
    ageMs(cx: number, cy: number, now: number): number {
        return this.knows(cx, cy) ? now - this.seenAt[cy * this.w + cx] : Infinity
    }

    knows(cx: number, cy: number): boolean {
        return cx >= 0 && cy >= 0 && cx < this.w && cy < this.h && this.seen[cy * this.w + cx] === 1
    }

    mark(cx: number, cy: number): boolean {
        if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h || this.seen[cy * this.w + cx]) return false
        this.seen[cy * this.w + cx] = 1
        return true
    }

    // The current view plus the cell the player stands on and the four it touches, seen at `now`.
    // Returns how many cells were new.
    see(api: LogicApi, world: World, now = 0): number {
        if (world.w !== this.w || world.h !== this.h) this.reset(this.key, world.w, world.h)
        // The clock went back (a console reboot): what was seen before is just long ago.
        if (now < this.clock) this.seenAt.fill(now - 1e9)
        this.clock = now
        let added = 0
        const cx = world.x >> 10
        const cy = world.y >> 10
        for (const [x, y] of [[cx, cy], ...SIDES.map(([dx, dy]) => [cx + dx, cy + dy]), ...visibleCells(api, world)]) {
            if (this.mark(x, y)) added++
            if (this.knows(x, y)) this.seenAt[y * this.w + x] = now
        }
        return added
    }

    count(): number {
        let n = 0
        for (const v of this.seen) n += v
        return n
    }

    // Same chars as the live map (# wall, . floor, ~ lava, E exit, D door), `?` for unseen.
    rows(api: LogicApi, world: World): string[] {
        const rows: string[] = []
        for (let cy = 0; cy < this.h; cy++) {
            let row = ""
            for (let cx = 0; cx < this.w; cx++) {
                const tile = api.tileAt(world, cx, cy)
                if (!this.knows(cx, cy)) row += "?"
                else if (api.isDoor(tile)) row += "D"
                else if (tile === api.TILE_EXIT) row += "E"
                else if (tile === api.TILE_FLOOR) row += api.lavaAt(world, cx, cy) ? "~" : "."
                else row += "#"
            }
            rows.push(row)
        }
        return rows
    }

    toJSON(): KnownMapJson {
        return { key: this.key, w: this.w, h: this.h, seen: Array.from(this.seen).join(""), boss: this.boss }
    }

    static fromJSON(j: KnownMapJson): KnownMap {
        const m = new KnownMap()
        m.reset(j.key, j.w, j.h)
        for (let i = 0; i < m.seen.length; i++) m.seen[i] = j.seen[i] === "1" ? 1 : 0
        m.boss = j.boss
        return m
    }
}

// The world as the player knows it: unseen cells are stone, unseen lava is floor, unseen items
// are not there. Everything else (position, doors, enemies, keys held) is the live world. The
// cell the player stands in counts as seen: a predicted position may be one step into the unknown.
export function knownWorld(api: LogicApi, world: World, known: KnownMap): World {
    const view: World = Object.create(world)
    const own = (world.y >> 10) * world.w + (world.x >> 10)
    const seen = (i: number) => i === own || (known.w === world.w && known.seen[i] === 1)
    view.grid = world.grid.map((t: number, i: number) => (seen(i) ? t : api.TILE_STONE))
    view.lava = (world.lava as number[]).map((v, i) => (seen(i) ? v : 0))
    view.items = world.items.filter((it) => seen((it.y >> 10) * world.w + (it.x >> 10)))
    return view
}

const knowsIn = (map: World, known: KnownMap, x: number, y: number) => known.knows(x, y) || (x === map.x >> 10 && y === map.y >> 10)

// Walkable known cell with an unseen side.
export function isFrontier(api: LogicApi, map: World, known: KnownMap, c: Cell): boolean {
    if (!knowsIn(map, known, c[0], c[1]) || !passable(api, map, c[0], c[1], map.keys)) return false
    return SIDES.some(([dx, dy]) => {
        const x = c[0] + dx
        const y = c[1] + dy
        return x >= 0 && y >= 0 && x < known.w && y < known.h && !knowsIn(map, known, x, y)
    })
}

export interface Frontier {
    cell: Cell
    // Known cells from the player to the frontier cell.
    path: Cell[]
    // Up to BEYOND unseen cells past the frontier, the way a player walks into the
    // dark: the console stops at the first one that turns out to be a wall, so there is no halt
    // at every frontier waiting for the next decision.
    beyond: Cell[]
}

export const BEYOND = 1

// Unseen cells past the frontier: the side that keeps the walking direction if it is unseen,
// else the unseen side closest to it, then straight on while the cells stay unseen.
function beyondOf(api: LogicApi, map: World, known: KnownMap, path: Cell[]): Cell[] {
    const f = path[path.length - 1]
    const prev = path.length > 1 ? path[path.length - 2] : null
    const a = (map.ang * 2 * Math.PI) / api.ANGLES
    const facing: Cell = Math.abs(Math.cos(a)) >= Math.abs(Math.sin(a)) ? [Math.sign(Math.cos(a)), 0] : [0, Math.sign(Math.sin(a))]
    const dir: Cell = prev ? [f[0] - prev[0], f[1] - prev[1]] : facing
    const unseen = (x: number, y: number) => x >= 0 && y >= 0 && x < known.w && y < known.h && !knowsIn(map, known, x, y)
    const order = [...SIDES].sort((a, b) => (b[0] * dir[0] + b[1] * dir[1]) - (a[0] * dir[0] + a[1] * dir[1]))
    const side = order.find(([dx, dy]) => unseen(f[0] + dx, f[1] + dy))
    if (!side) return []
    const out: Cell[] = []
    for (let s = 1; s <= BEYOND && unseen(f[0] + side[0] * s, f[1] + side[1] * s); s++) out.push([f[0] + side[0] * s, f[1] + side[1] * s])
    return out
}

const turnCost = (api: LogicApi, ang: number, from: Cell, to: Cell) => {
    const heading = Math.round((Math.atan2(to[1] - from[1], to[0] - from[0]) * api.ANGLES) / (2 * Math.PI))
    return Math.abs(angleDiff(api, ang, heading)) / (api.ANGLES / 4)
}

// The cheapest walk over known walkable cells (`map` is a knownWorld) to a cell that passes
// `test`. Cost is steps plus up to 2 for turning around; ties go to the higher `rank`. The target
// picked earlier stays while it still passes and costs at most KEEP_TARGET steps more. Only a
// `commit` call (the observed world, not a prediction) moves that target.
function nearestWhere(api: LogicApi, map: World, known: KnownMap, from: Cell, commit: boolean, test: (c: Cell) => boolean, rank: (c: Cell) => number): Cell[] | null {
    const key = (c: Cell) => c[1] * map.w + c[0]
    const prev = new Map<number, number>([[key(from), -1]])
    const dist = new Map<number, number>([[key(from), 0]])
    const queue: Cell[] = [from]
    const found: Array<{ cell: Cell; cost: number; open: number }> = []
    while (queue.length > 0) {
        const cur = queue.shift() as Cell
        const d = dist.get(key(cur)) as number
        if (test(cur)) {
            let k = key(cur)
            while (d > 0 && prev.get(k) !== key(from)) k = prev.get(k) as number
            const first: Cell = [k % map.w, Math.floor(k / map.w)]
            found.push({ cell: cur, cost: d + turnCost(api, map.ang, from, first), open: rank(cur) })
        }
        for (const [dx, dy] of SIDES) {
            const next: Cell = [cur[0] + dx, cur[1] + dy]
            if (prev.has(key(next)) || !passable(api, map, next[0], next[1], map.keys)) continue
            prev.set(key(next), key(cur))
            dist.set(key(next), d + 1)
            queue.push(next)
        }
    }
    if (found.length === 0) {
        if (commit) known.target = null
        return null
    }
    found.sort((a, b) => a.cost - b.cost || b.open - a.open || a.cell[1] - b.cell[1] || a.cell[0] - b.cell[0])
    let pick = found[0]
    const kept = known.target && found.find((f) => f.cell[0] === known.target![0] && f.cell[1] === known.target![1])
    if (kept && kept.cost <= pick.cost + KEEP_TARGET) pick = kept
    if (commit) known.target = pick.cell
    const path: Cell[] = []
    for (let k: number = key(pick.cell); k !== -1; k = prev.get(k) as number) path.unshift([k % map.w, Math.floor(k / map.w)])
    return path
}

// The frontier to explore next; ties go to the cell with more unseen sides.
export function nearestFrontier(api: LogicApi, map: World, known: KnownMap, from: Cell, commit = true): Frontier | null {
    const unseenSides = (c: Cell) => SIDES.filter(([dx, dy]) => !knowsIn(map, known, c[0] + dx, c[1] + dy)).length
    const path = nearestWhere(api, map, known, from, commit, (c) => isFrontier(api, map, known, c), unseenSides)
    return path ? { cell: path[path.length - 1], path, beyond: beyondOf(api, map, known, path) } : null
}

// Nothing left unexplored but the boss is not in sight: the nearest known cell not on screen for
// STALE_MS, the one seen longest ago on a tie. The walk there looks the area over again.
export function nearestStale(api: LogicApi, map: World, known: KnownMap, from: Cell, now: number, commit = true): Frontier | null {
    const age = (c: Cell) => known.ageMs(c[0], c[1], now)
    const stale = (c: Cell) => known.knows(c[0], c[1]) && age(c) >= STALE_MS && passable(api, map, c[0], c[1], map.keys)
    const path = nearestWhere(api, map, known, from, commit, stale, age)
    return path ? { cell: path[path.length - 1], path, beyond: [] } : null
}

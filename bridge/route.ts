// Grid routing shared by the AI bridge and the scripted demo pilot: BFS over walkable cells,
// keys the route needs, and the floor cell in front of the exit.
import type { LogicApi, World } from "../load-logic.ts"

export type Cell = [number, number]

export function angleTo(api: LogicApi, world: World, x: number, y: number): number {
    const a = Math.atan2(y - world.y, x - world.x)
    return ((Math.round((a * api.ANGLES) / (2 * Math.PI)) % api.ANGLES) + api.ANGLES) % api.ANGLES
}

export function angleDiff(api: LogicApi, from: number, to: number): number {
    const half = api.ANGLES / 2
    return ((((to - from) % api.ANGLES) + api.ANGLES + half) % api.ANGLES) - half
}

export function centre(api: LogicApi, c: number): number {
    return c * api.FP + api.FP / 2
}

// Walkable for planning: floor without lava, plain doors and keyed doors whose key is in `keys`.
export function passable(api: LogicApi, world: World, cx: number, cy: number, keys: number, avoidLava = true): boolean {
    const tile = api.tileAt(world, cx, cy)
    if (tile === api.TILE_FLOOR) return !avoidLava || !api.lavaAt(world, cx, cy)
    if (!api.isDoor(tile)) return false
    const door = api.doorAt(world, cx, cy)
    return door.key === 0 || (keys & door.key) !== 0
}

export function findPath(api: LogicApi, world: World, from: Cell, to: Cell, keys: number = world.keys, avoidLava = true): Cell[] {
    const key = (c: Cell) => c[1] * world.w + c[0]
    const prev = new Map<number, number>()
    const queue: Cell[] = [from]
    prev.set(key(from), -1)
    while (queue.length > 0) {
        const cur = queue.shift() as Cell
        if (cur[0] === to[0] && cur[1] === to[1]) break
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const next: Cell = [cur[0] + dx, cur[1] + dy]
            if (!passable(api, world, next[0], next[1], keys, avoidLava) || prev.has(key(next))) continue
            prev.set(key(next), key(cur))
            queue.push(next)
        }
    }
    if (!prev.has(key(to))) return []
    const path: Cell[] = []
    for (let k = key(to); k !== -1; k = prev.get(k) as number) {
        path.unshift([k % world.w, Math.floor(k / world.w)])
    }
    return path
}

// Keeps only the corners of a grid path so the pilot walks straight runs without wobbling.
export function corners(path: Cell[]): Cell[] {
    if (path.length <= 2) return path.slice(1)
    const out: Cell[] = []
    for (let i = 1; i < path.length - 1; i++) {
        const a = path[i - 1]
        const b = path[i]
        const c = path[i + 1]
        if (b[0] - a[0] !== c[0] - b[0] || b[1] - a[1] !== c[1] - b[1]) out.push(b)
    }
    out.push(path[path.length - 1])
    return out
}

export interface ExitSpot {
    cell: Cell
    ang: number
}

// Floor cell next to the exit tile and the heading that walks into it.
export function exitSpot(api: LogicApi, world: World): ExitSpot {
    for (let cy = 0; cy < world.h; cy++) {
        for (let cx = 0; cx < world.w; cx++) {
            if (api.tileAt(world, cx, cy) !== api.TILE_EXIT) continue
            const sides: Array<[number, number, number]> = [[-1, 0, 0], [1, 0, 512], [0, -1, 256], [0, 1, 768]]
            for (const [dx, dy, ang] of sides) {
                if (api.tileAt(world, cx + dx, cy + dy) === api.TILE_FLOOR) return { cell: [cx + dx, cy + dy], ang }
            }
        }
    }
    throw new Error("no exit")
}

export const KEY_ITEMS: Record<number, number> = { 2: 1, 3: 2 }

// Waypoints that solve the level: fetch each key the route needs, then the exit. Null if stuck.
export function planRoute(api: LogicApi, world: World, from: Cell, exit: Cell): Cell[] | null {
    const out: Cell[] = []
    let keys = world.keys
    let at = from
    const taken = new Set<number>()
    for (let guard = 0; guard < 8; guard++) {
        if (findPath(api, world, at, exit, keys).length > 0 || (at[0] === exit[0] && at[1] === exit[1])) {
            out.push(exit)
            return out
        }
        let best: Cell | null = null
        let bestLen = Infinity
        let bestKey = 0
        let bestIdx = -1
        world.items.forEach((item, i) => {
            const bit = KEY_ITEMS[item.kind]
            if (!bit || item.taken || taken.has(i) || (keys & bit) !== 0) return
            const cell: Cell = [item.x >> 10, item.y >> 10]
            const len = findPath(api, world, at, cell, keys).length
            if (len > 0 && len < bestLen) {
                best = cell
                bestLen = len
                bestKey = bit
                bestIdx = i
            }
        })
        if (!best) return null
        taken.add(bestIdx)
        out.push(best)
        keys |= bestKey
        at = best
    }
    return null
}

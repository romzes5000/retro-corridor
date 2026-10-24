// Scripted "player": turns game state into pad presses. Shared by feature tests and demo GIFs,
// so both drive the game through the same Input the console reads from buttons.
import type { Input, LogicApi, World } from "../load-logic.ts"

export type Cell = [number, number]

export type Task =
    | { kind: "goto"; cell: Cell }
    | { kind: "face"; ang: number }
    | { kind: "faceCell"; cell: Cell }
    | { kind: "wait"; ms: number }
    | { kind: "push"; ms: number }
    | { kind: "fire"; enemy: number; ms: number }
    | { kind: "strafe"; dir: number; ms: number }
    | { kind: "turn"; dir: number; ms: number }
    | { kind: "map"; open: boolean }

const ARRIVE = 110
const AIM = 10
const STEER = 70

export function angleTo(api: LogicApi, world: World, x: number, y: number): number {
    const a = Math.atan2(y - world.y, x - world.x)
    return ((Math.round((a * api.ANGLES) / (2 * Math.PI)) % api.ANGLES) + api.ANGLES) % api.ANGLES
}

export function angleDiff(api: LogicApi, from: number, to: number): number {
    const half = api.ANGLES / 2
    return ((((to - from) % api.ANGLES) + api.ANGLES + half) % api.ANGLES) - half
}

function centre(api: LogicApi, c: number): number {
    return c * api.FP + api.FP / 2
}

// Walkable for planning: floor, plain doors and keyed doors whose key is in `keys`.
export function passable(api: LogicApi, world: World, cx: number, cy: number, keys: number): boolean {
    const tile = api.tileAt(world, cx, cy)
    if (tile === api.TILE_FLOOR) return true
    if (!api.isDoor(tile)) return false
    const door = api.doorAt(world, cx, cy)
    return door.key === 0 || (keys & door.key) !== 0
}

export function findPath(api: LogicApi, world: World, from: Cell, to: Cell, keys: number = world.keys): Cell[] {
    const key = (c: Cell) => c[1] * world.w + c[0]
    const prev = new Map<number, number>()
    const queue: Cell[] = [from]
    prev.set(key(from), -1)
    while (queue.length > 0) {
        const cur = queue.shift() as Cell
        if (cur[0] === to[0] && cur[1] === to[1]) break
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const next: Cell = [cur[0] + dx, cur[1] + dy]
            if (!passable(api, world, next[0], next[1], keys) || prev.has(key(next))) continue
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

const KEY_ITEMS: Record<number, number> = { 2: 1, 3: 2 }

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

export class Pilot {
    readonly api: LogicApi
    readonly tasks: Task[] = []
    mapOpen = false
    private elapsed = 0

    constructor(api: LogicApi, tasks: Task[] = []) {
        this.api = api
        this.tasks.push(...tasks)
    }

    get done(): boolean {
        return this.tasks.length === 0
    }

    route(world: World, to: Cell, from: Cell = [world.x >> 10, world.y >> 10], keys: number = world.keys): void {
        for (const cell of corners(findPath(this.api, world, from, to, keys))) this.tasks.push({ kind: "goto", cell })
    }

    // Press A on a closed door straight ahead; while it slides open just wait instead of shooting.
    private doorAhead(world: World, input: Input): void {
        const api = this.api
        const ax = world.x + ((api.cos(world.ang) * api.USE_REACH) >> 10)
        const ay = world.y + ((api.sin(world.ang) * api.USE_REACH) >> 10)
        const door = api.doorAt(world, ax >> 10, ay >> 10)
        if (door && (door.state === api.DOOR_CLOSED || door.state === api.DOOR_CLOSING)) input.fire = true
    }

    // Side step (+1 right, -1 left, 0 none) that takes the player off the line of an incoming fireball.
    dodge(world: World): number {
        const api = this.api
        const lane = api.PLAYER_RADIUS + api.SHOT_RADIUS + 200
        for (const shot of world.shots) {
            const rx = world.x - shot.x
            const ry = world.y - shot.y
            const along = rx * shot.vx + ry * shot.vy
            if (along <= 0 || Math.hypot(rx, ry) > 2.5 * api.FP) continue
            const v2 = shot.vx * shot.vx + shot.vy * shot.vy
            const px = rx - (along / v2) * shot.vx
            const py = ry - (along / v2) * shot.vy
            if (Math.hypot(px, py) > lane) continue
            const rightX = -api.sin(world.ang)
            const rightY = api.cos(world.ang)
            let dir = px * rightX + py * rightY >= 0 ? 1 : -1
            const probe = (d: number) => api.fits(world, world.x + rightX * d * 0.6, world.y + rightY * d * 0.6, api.PLAYER_RADIUS)
            if (!probe(dir)) dir = -dir
            return probe(dir) ? dir : 0
        }
        return 0
    }

    private aim(world: World, input: Input, ang: number, tolerance: number): boolean {
        const diff = angleDiff(this.api, world.ang, ang)
        if (Math.abs(diff) > tolerance) input.turn = diff > 0 ? 1 : -1
        return Math.abs(diff) <= tolerance
    }

    private finish(): void {
        this.tasks.shift()
        this.elapsed = 0
    }

    next(world: World, dt: number): Input {
        const api = this.api
        const input = new api.Input()
        const task = this.tasks[0]
        if (!task) return input
        this.elapsed += dt
        switch (task.kind) {
            case "goto": {
                const side = this.dodge(world)
                if (side !== 0) {
                    input.strafe = side
                    return input
                }
                const tx = centre(api, task.cell[0])
                const ty = centre(api, task.cell[1])
                if (api.distance(world.x, world.y, tx, ty) < ARRIVE) {
                    this.finish()
                    return this.next(world, 0)
                }
                const ang = angleTo(api, world, tx, ty)
                this.aim(world, input, ang, AIM)
                if (Math.abs(angleDiff(api, world.ang, ang)) < STEER) input.fwd = 1
                this.doorAhead(world, input)
                return input
            }
            case "face":
                if (this.aim(world, input, task.ang, AIM)) this.finish()
                return input
            case "faceCell":
                if (this.aim(world, input, angleTo(api, world, centre(api, task.cell[0]), centre(api, task.cell[1])), AIM)) {
                    this.finish()
                }
                return input
            case "wait":
                if (this.elapsed >= task.ms) this.finish()
                return input
            case "push":
                input.fwd = 1
                if (this.elapsed >= task.ms || world.won) this.finish()
                return input
            case "strafe":
                input.strafe = task.dir
                if (this.elapsed >= task.ms) this.finish()
                return input
            case "turn":
                input.turn = task.dir
                if (this.elapsed >= task.ms) this.finish()
                return input
            case "fire": {
                const enemy = world.enemies[task.enemy]
                if (!enemy || enemy.dead || this.elapsed >= task.ms) {
                    this.finish()
                    return input
                }
                const side = this.dodge(world)
                if (side !== 0) {
                    input.strafe = side
                    input.fire = api.target(world) === task.enemy
                    return input
                }
                const onTarget = this.aim(world, input, angleTo(api, world, enemy.x, enemy.y), AIM)
                input.fire = onTarget && api.target(world) === task.enemy
                if (onTarget && !input.fire) input.fwd = 1
                return input
            }
            case "map":
                this.mapOpen = task.open
                this.finish()
                return this.next(world, 0)
            default: {
                const never: never = task
                return never
            }
        }
    }
}

function itemCell(item: { x: number; y: number }): Cell {
    return [item.x >> 10, item.y >> 10]
}

// Side trips a player would make first: pick up the shotgun, grab a medkit when hurt or ammo when
// low, and hunt
// the boss while it keeps the exit locked.
function detours(api: LogicApi, world: World, at: Cell): Cell[] {
    const out: Cell[] = []
    const reachable = (c: Cell) => findPath(api, world, at, c).length > 0
    const gun = world.items.find((it) => !it.taken && it.kind === api.ITEM_SHOTGUN)
    if (gun && reachable(itemCell(gun))) out.push(itemCell(gun))
    if (world.health < 60) {
        const kits = world.items.filter((it) => !it.taken && it.kind === api.ITEM_HEALTH)
            .map(itemCell).filter(reachable)
            .sort((a, b) => findPath(api, world, at, a).length - findPath(api, world, at, b).length)
        if (kits.length > 0) out.push(kits[0])
    }
    if (world.ammo < 30) {
        const boxes = world.items.filter((it) => !it.taken && it.kind === api.ITEM_AMMO)
            .map(itemCell).filter(reachable)
            .sort((a, b) => findPath(api, world, at, a).length - findPath(api, world, at, b).length)
        if (boxes.length > 0) out.push(boxes[0])
    }
    const boss = world.enemies.find((e) => !e.dead && e.kind === api.ENEMY_BOSS)
    if (boss && world.exitLocked && reachable(itemCell(boss))) out.push(itemCell(boss))
    return out
}

// Level-solving strategy for feature tests and demos: fetch the keys the route needs, walk to the
// exit, and stop to shoot any enemy that has spotted the player and is close enough to matter.
export function fightingPilot(api: LogicApi, world: World, exit?: Cell, exitAng?: number): (dt: number) => Input {
    const spot = exit ? { cell: exit, ang: exitAng ?? 0 } : exitSpot(api, world)
    const walker = new Pilot(api)
    const plan = () => {
        walker.tasks.length = 0
        let at: Cell = [world.x >> 10, world.y >> 10]
        let keys = world.keys
        const points = [...detours(api, world, at), ...(planRoute(api, world, at, spot.cell) ?? [spot.cell])]
        for (const p of points) {
            walker.route(world, p, at, keys)
            const item = world.items.find((it) => !it.taken && it.x >> 10 === p[0] && it.y >> 10 === p[1])
            if (item && KEY_ITEMS[item.kind]) keys |= KEY_ITEMS[item.kind]
            at = p
        }
        walker.tasks.push({ kind: "face", ang: spot.ang }, { kind: "push", ms: 3000 })
    }
    plan()
    let fighter: Pilot | null = null
    return (dt: number) => {
        const armed = world.ammo >= (world.weapon === api.WEAPON_SHOTGUN ? api.SHOTGUN_AMMO : 1)
        if (fighter && (fighter.done || !armed)) {
            fighter = null
            plan()
        }
        if (!fighter && armed) {
            const threat = world.enemies.findIndex((enemy) => !enemy.dead && enemy.sees
                && api.distance(enemy.x, enemy.y, world.x, world.y) < 6 * api.FP)
            if (threat >= 0) fighter = new Pilot(api, [{ kind: "fire", enemy: threat, ms: 4000 }])
        }
        if (fighter) return fighter.next(world, dt)
        if (walker.done) plan()
        return walker.next(world, dt)
    }
}

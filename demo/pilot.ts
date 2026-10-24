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
    | { kind: "fire"; imp: number; ms: number }
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

export function findPath(api: LogicApi, world: World, from: Cell, to: Cell): Cell[] {
    const key = (c: Cell) => c[1] * world.w + c[0]
    const prev = new Map<number, number>()
    const queue: Cell[] = [from]
    prev.set(key(from), -1)
    while (queue.length > 0) {
        const cur = queue.shift() as Cell
        if (cur[0] === to[0] && cur[1] === to[1]) break
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const next: Cell = [cur[0] + dx, cur[1] + dy]
            if (api.tileAt(world, next[0], next[1]) !== api.TILE_FLOOR || prev.has(key(next))) continue
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

    route(world: World, to: Cell): void {
        const from: Cell = [world.x >> 10, world.y >> 10]
        for (const cell of corners(findPath(this.api, world, from, to))) this.tasks.push({ kind: "goto", cell })
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
                const tx = centre(api, task.cell[0])
                const ty = centre(api, task.cell[1])
                if (api.distance(world.x, world.y, tx, ty) < ARRIVE) {
                    this.finish()
                    return this.next(world, 0)
                }
                const ang = angleTo(api, world, tx, ty)
                this.aim(world, input, ang, AIM)
                if (Math.abs(angleDiff(api, world.ang, ang)) < STEER) input.fwd = 1
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
                const imp = world.imps[task.imp]
                if (!imp || imp.dead || this.elapsed >= task.ms) {
                    this.finish()
                    return input
                }
                const onTarget = this.aim(world, input, angleTo(api, world, imp.x, imp.y), AIM)
                input.fire = onTarget && api.target(world) === task.imp
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

// Campaign-solving strategy for feature tests: walk to the exit, stop to shoot any imp that has
// spotted the player and is close enough to matter.
export function fightingPilot(api: LogicApi, world: World, exit: Cell, exitAng: number): (dt: number) => Input {
    const walker = new Pilot(api)
    const plan = () => {
        walker.route(world, exit)
        walker.tasks.push({ kind: "face", ang: exitAng }, { kind: "push", ms: 3000 })
    }
    plan()
    let fighter: Pilot | null = null
    return (dt: number) => {
        if (fighter && fighter.done) {
            fighter = null
            walker.tasks.length = 0
        }
        if (!fighter) {
            const threat = world.imps.findIndex((imp) => !imp.dead && imp.sees
                && api.distance(imp.x, imp.y, world.x, world.y) < 6 * api.FP)
            if (threat >= 0) fighter = new Pilot(api, [{ kind: "fire", imp: threat, ms: 4000 }])
        }
        if (fighter) return fighter.next(world, dt)
        if (walker.done) plan()
        return walker.next(world, dt)
    }
}

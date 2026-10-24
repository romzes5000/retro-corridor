// In-process stand-in for the console: runs the real game logic frame by frame the way main.ts
// does in AI mode, prints the same AI lines and reads commands from a byte-array mailbox.
import { loadGame, type Game, type LogicApi, type World } from "../load-logic.ts"
import { damageSource } from "./damage.ts"
import type { Transport } from "./loop.ts"
import { BOX_SIZE, encodeBox, type BoxWrite } from "./mailbox.ts"

export const SIM_DT = 20

export type SimResult = "won" | "dead" | null

// Per-frame input as [fwd, strafe, turn, fire, swap], enough to replay the run bit for bit.
export type Frame = [number, number, number, number, number]

export function levelIndex(api: LogicApi, name: string): number {
    if (/^\d+$/.test(name)) return Number(name)
    const i = (api.LEVELS as Array<{ name: string }>).findIndex((l) => l.name.toUpperCase() === name.toUpperCase())
    if (i < 0) throw new Error(`no level ${name}; levels: ${api.LEVELS.map((l: { name: string }) => l.name).join(", ")}`)
    return i
}

export interface SimLevel {
    // Campaign index, or endless depth minus one.
    index: number
    endless: boolean
    name: string
}

// "ALL", a campaign level name or index, or endless depths "D3" / "D1-D5".
export function simLevels(api: LogicApi, spec: string): SimLevel[] {
    const campaign = (i: number): SimLevel => ({ index: i, endless: false, name: api.LEVELS[i].name })
    if (spec.toUpperCase() === "ALL") return api.LEVELS.map((_: unknown, i: number) => campaign(i))
    const depth = spec.toUpperCase().match(/^D(\d+)(?:-D?(\d+))?$/)
    if (!depth) return [campaign(levelIndex(api, spec))]
    const from = Number(depth[1])
    const to = Number(depth[2] ?? depth[1])
    if (from < 1 || to < from) throw new Error(`no depths ${spec}; use D1 or D1-D5`)
    return Array.from({ length: to - from + 1 }, (_, k) => ({ index: from + k - 1, endless: true, name: `D${from + k}` }))
}

export class SimConsole implements Transport {
    readonly game: Game
    readonly api: LogicApi
    readonly box = encodeBox({ seq: 0, obs: 0, cmd: 0, a: 0, b: 0, conf: 0, latency: 0, label: "" })
    readonly frames: Frame[] = []
    // On-screen AI status line as [first frame, text] each time it changes.
    readonly statuses: Array<[number, string]> = []
    readonly level: number
    readonly difficulty: number
    // Like the console: retry after a death, go on after a win, until the campaign is over.
    // Otherwise the sim stops at the end of the first level and `frames` replays it.
    readonly continuous: boolean
    world: World
    link: any
    session: any
    result: SimResult = null
    clock = 0
    writes = 0
    deaths = 0
    cleared = 0
    // Time the player stood still with no enemy in sight, and the longest such stretch.
    idleMs = 0
    longestIdleMs = 0
    playMs = 0
    // Health lost by source.
    damage = { bite: 0, shot: 0, lava: 0 }
    // Played every frame while the player holds the controls (takeOver() to handBack()).
    humanInput: any = null
    private idleRun = 0
    private listeners: Array<(line: string) => void> = []

    // `endless`: `level` is the endless depth minus one (procgen level D<level+1>).
    constructor(level: number, difficulty: number, run = 1 + Math.floor(Math.random() * 30000), continuous = false, endless = false) {
        this.game = loadGame()
        this.api = this.game.corridor
        this.level = level
        this.difficulty = difficulty
        this.continuous = continuous
        if (endless) {
            this.session = this.api.startSession(this.api.RUN_ENDLESS, difficulty)
            this.session.level = level
        } else {
            this.session = this.api.startAtLevel(difficulty, level)
        }
        this.session.ai = true
        this.link = new this.api.AiLink(run)
        this.enter()
    }

    // Console reflexes (fire at the crosshair, sidestep a ball about to land), on by default.
    get reflexes(): boolean {
        return this.link.reflexes
    }

    set reflexes(on: boolean) {
        this.link.reflexes = on
    }

    private enter(): void {
        this.world = this.api.enterLevel(this.session)
        this.api.aiEnterLevel(this.link, this.session, this.world)
    }

    onLine(listener: (line: string) => void): void {
        this.listeners.push(listener)
    }

    async writeBox(writes: BoxWrite[]): Promise<void> {
        for (const w of writes) {
            if (w.offset + w.data.length > BOX_SIZE) throw new Error("write past the box")
            this.box.set(w.data, w.offset)
        }
        this.writes++
    }

    reset(): void {}

    private emit(line: string): void {
        for (const l of this.listeners) l(line)
    }

    // TAKE OVER in the pause menu: from now on the level plays `input` (default: stand still).
    takeOver(input: any = new this.api.Input()): void {
        this.humanInput = input
        this.emit(this.api.AI_HUMAN)
    }

    // GIVE TO AI in the pause menu.
    handBack(): void {
        this.humanInput = null
        this.api.aiHandBack(this.link, this.session)
    }

    step(dt = SIM_DT): void {
        if (this.result) return
        this.clock += dt
        const api = this.api
        const world = this.world
        if (world.won || world.lost) {
            const end = this.humanInput ? api.AI_STAY : api.aiEndStep(this.link, world, dt, (line: string) => this.emit(line))
            if (!this.continuous) {
                this.result = world.won ? "won" : "dead"
            } else if (end === api.AI_REPLAY) {
                this.deaths++
                this.enter()
            } else if (end === api.AI_ADVANCE) {
                this.cleared++
                if (api.completeLevel(this.session, world)) this.enter()
                else this.result = "won"
            }
            return
        }
        const ai = !this.humanInput
        const input = ai ? api.aiFrame(this.link, this.world, dt, (i: number) => this.box[i]) : this.humanInput
        const status = ai ? (api.aiStatus(this.link) as string) : ""
        if (this.statuses.at(-1)?.[1] !== status) this.statuses.push([this.frames.length, status])
        const snapshot = ai && api.aiSnapshotDue(this.link) ? (api.aiSnapshot(this.link, this.world, this.difficulty) as string[]) : []
        this.frames.push([input.fwd, input.strafe, input.turn, input.fire ? 1 : 0, input.swap ? 1 : 0])
        const before = { x: world.x, y: world.y, hp: world.health, shots: world.shots.length }
        api.update(this.world, input, dt)
        this.measure(before, dt)
        for (const line of snapshot) this.emit(line)
    }

    private measure(before: { x: number; y: number; hp: number; shots: number }, dt: number): void {
        const api = this.api
        const world = this.world
        this.playMs += dt
        const fighting = world.enemies.some((e: { dead: boolean; x: number; y: number }) => !e.dead && api.canSee(world, world.x, world.y, e.x, e.y))
        if (world.x === before.x && world.y === before.y && !fighting && !world.won) {
            this.idleRun += dt
            this.idleMs += dt
            this.longestIdleMs = Math.max(this.longestIdleMs, this.idleRun)
        } else {
            this.idleRun = 0
        }
        const lost = before.hp - world.health
        if (lost <= 0) return
        this.damage[damageSource(api, world, world.x, world.y, world.shots.length < before.shots && world.events.includes("hurt"))] += lost
    }
}

export interface SimRecording {
    level: number
    difficulty: number
    dt: number
    frames: Frame[]
    statuses: Array<[number, string]>
}

export function recording(sim: SimConsole): SimRecording {
    return { level: sim.level, difficulty: sim.difficulty, dt: SIM_DT, frames: sim.frames, statuses: sim.statuses }
}

// Plays a recorded run back: same level, same difficulty, same inputs, same outcome.
export class Replayer {
    readonly api: LogicApi
    readonly world: World
    private readonly rec: SimRecording
    private at = 0

    constructor(api: LogicApi, rec: SimRecording) {
        if (rec.dt !== SIM_DT) throw new Error(`recording step ${rec.dt} ms, replay needs ${SIM_DT}`)
        this.api = api
        this.rec = rec
        this.world = api.enterLevel(api.startAtLevel(rec.difficulty, rec.level))
    }

    get done(): boolean {
        return this.at >= this.rec.frames.length || this.world.won || this.world.lost
    }

    // Plays up to `count` frames; returns every game event they produced.
    advance(count: number): string[] {
        const events: string[] = []
        for (let k = 0; k < count && !this.done; k++) {
            const [fwd, strafe, turn, fire, swap] = this.rec.frames[this.at++]
            const input = new this.api.Input()
            input.fwd = fwd
            input.strafe = strafe
            input.turn = turn
            input.fire = fire === 1
            input.swap = swap === 1
            this.api.update(this.world, input, SIM_DT)
            events.push(...this.world.events)
        }
        return events
    }

    status(): string {
        let text = ""
        for (const [from, s] of this.rec.statuses) {
            if (from > this.at) break
            text = s
        }
        return text
    }
}

export function replay(rec: SimRecording): World {
    const player = new Replayer(loadGame().corridor, rec)
    while (!player.done) player.advance(1)
    return player.world
}

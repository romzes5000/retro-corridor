// The bridge loop: console snapshot -> shadow world -> facts -> Jev -> one command in the mailbox.
// One Jev request in flight; whatever snapshot is newest when it returns gets the next request.
import type { LogicApi, World } from "../load-logic.ts"
import { applyLesson, decide, lessonLabel, mustHeal, type Decision } from "./decide.ts"
import type { Action, JevAnswer, JevFn } from "./jev.ts"
import { activeLesson, learn, lessonText, postMortem, Trace, type ActiveLesson, type Learned, type LessonStore, type ReflectFn } from "./lessons.ts"
import { boxWrites, encodeBox, nextSeq, type BoxWrite } from "./mailbox.ts"
import { Memory } from "./memory.ts"
import { facts, progressText, situate, type Situation } from "./observe.ts"
import { Parser, type Snapshot } from "./protocol.ts"
import type { Cell } from "./route.ts"
import { Shadow } from "./shadow.ts"

export interface Transport {
    onLine(listener: (line: string) => void): void
    writeBox(writes: BoxWrite[]): Promise<void>
    // The console restarted (new run id): drop any cached mailbox address.
    reset(): void
}

export interface LogRecord {
    kind: "decision" | "won" | "dead" | "skip" | "watchdog" | "lesson"
    at: number
    n?: number
    lvl?: string
    state?: Record<string, unknown>
    answer?: JevAnswer
    decision?: Decision
    seq?: number
    reason?: string
    // Decision: id of the lesson in force and whether it replaced Jev's pick.
    lesson?: string
    override?: boolean
    // Lesson record: what the death taught.
    learned?: Learned
}

export interface Stats {
    decisions: number
    errors: number
    latencies: number[]
    cost: number
    won: number
    dead: number
    stale: number
    skipped: number
    // Times the watchdog replaced Jev's pick to get a stalled player moving.
    watchdog: number
    // Times a calm pick at low health was replaced by heal.
    forcedHeal: number
    // Facts described the predicted moment rather than the snapshot.
    predicted: number
    // Decisions with a death lesson in force, and the ones where it replaced Jev's pick.
    lessonActive: number
    lessonOverride: number
    // Lessons learned from deaths, by who wrote them.
    lessonsLlm: number
    lessonsRule: number
    // Jev picks by action, and items the player picked up by kind (seen in the shadow world).
    picks: Record<string, number>
    pickups: Record<string, number>
}

export function emptyStats(): Stats {
    return {
        decisions: 0, errors: 0, latencies: [], cost: 0, won: 0, dead: 0, stale: 0, skipped: 0, watchdog: 0, forcedHeal: 0, predicted: 0,
        lessonActive: 0, lessonOverride: 0, lessonsLlm: 0, lessonsRule: 0, picks: {}, pickups: {},
    }
}

const COUNTERS = ["decisions", "errors", "cost", "won", "dead", "stale", "skipped", "watchdog", "forcedHeal", "predicted", "lessonActive", "lessonOverride", "lessonsLlm", "lessonsRule"] as const

export function addStats(total: Stats, s: Stats): void {
    for (const k of COUNTERS) total[k] += s[k]
    total.latencies.push(...s.latencies)
    for (const [k, v] of Object.entries(s.picks)) total.picks[k] = (total.picks[k] ?? 0) + v
    for (const [k, v] of Object.entries(s.pickups)) total.pickups[k] = (total.pickups[k] ?? 0) + v
}

export const ITEM_NAMES = ["medkit", "ammo", "red key", "blue key", "shotgun"]

const RECENT = 3
// Out of combat and not moving for this long: Jev's pick is replaced by advance, once per stall.
export const WATCHDOG_MS = 6000
const STILL_EPS = 32
const PREDICT_LATENCIES = 10
const PREDICT_DT = 20

export interface BridgeOptions {
    // Describe the world as it will be when Jev's answer lands (default on).
    predict?: boolean
    // Death lessons: where they live and who writes them (null reflect: the rule only).
    lessons?: { store: LessonStore; reflect: ReflectFn | null } | null
}

interface Sent {
    cmd: number
    a: number
    b: number
    route: Cell[]
    from: Cell
}

export class Bridge {
    readonly stats: Stats = emptyStats()
    onEnd: (kind: "won" | "dead") => void = () => {}
    private readonly parser = new Parser()
    private readonly shadow: Shadow
    private readonly ahead: Shadow
    private readonly memory = new Memory()
    private latest: Snapshot | null = null
    private decided = ""
    private inFlight: Promise<void> | null = null
    private seq: number
    private run = -1
    // Bumped on every win or death so a retried level starts with a clean memory.
    private attempt = 0
    // Last few commands with what the console reported back for each.
    private history: Array<{ seq: number; action: string; result: string }> = []
    private staleSeen = -1
    private steps: number | null = null
    private goal = ""
    private takenKey = ""
    private taken: boolean[] = []
    private still: { key: string; x: number; y: number; since: number; fired: boolean } | null = null
    private sent: Sent | null = null
    private readonly trace = new Trace()
    // `lvl:hash` of the latest snapshot, the key of zone lessons.
    private mapKey = ""
    // Lessons in force at least once in this attempt, credited on a win.
    private activeIds = new Set<string>()
    private learning: Promise<void> = Promise.resolve()
    private readonly lessons: BridgeOptions["lessons"]
    private readonly predict: boolean
    private readonly api: LogicApi
    private readonly transport: Transport
    private readonly jev: JevFn
    private readonly log: (rec: LogRecord) => void
    private readonly now: () => number

    // seq starts at a random point so a restarted bridge never repeats the seq already in the box.
    constructor(
        api: LogicApi,
        transport: Transport,
        jev: JevFn,
        log: (rec: LogRecord) => void = () => {},
        now: () => number = Date.now,
        seq: number = 1 + Math.floor(Math.random() * 60000),
        opts: BridgeOptions = {},
    ) {
        this.api = api
        this.transport = transport
        this.jev = jev
        this.log = log
        this.now = now
        this.shadow = new Shadow(api)
        this.ahead = new Shadow(api)
        this.seq = seq
        this.predict = opts.predict ?? true
        this.lessons = opts.lessons ?? null
        transport.onLine((line) => this.line(line))
    }

    // Resolves once the request in flight (if any) has written its command.
    idle(): Promise<void> {
        return this.inFlight ?? Promise.resolve()
    }

    // Resolves once every death so far has been turned into a lesson (or not).
    lessonsIdle(): Promise<void> {
        return this.learning
    }

    line(raw: string): void {
        const msg = this.parser.line(raw)
        if (!msg) return
        if (msg.kind === "won" || msg.kind === "dead") {
            if (msg.kind === "won") this.stats.won++
            else this.stats.dead++
            this.endAttempt(msg.kind)
            this.attempt++
            this.history = []
            this.latest = null
            this.steps = null
            this.still = null
            this.sent = null
            this.log({ kind: msg.kind, at: this.now() })
            this.onEnd(msg.kind)
            return
        }
        const snap = msg.snap
        if (snap.run !== this.run) {
            if (this.run !== -1) this.transport.reset()
            this.run = snap.run
        }
        if (snap.ack.stale && snap.ack.seq !== this.staleSeen) {
            this.staleSeen = snap.ack.seq
            this.stats.stale++
        }
        const sent = this.history.find((h) => h.seq === snap.ack.seq)
        if (sent) sent.result = snap.ack.stale ? "dropped" : snap.ack.result === "run" ? "in progress" : snap.ack.result
        if (this.lessons) this.trace.snap(this.api, this.shadow.sync(snap), snap)
        this.mapKey = `${snap.lvl}:${snap.hash}`
        this.latest = snap
        this.kick()
    }

    // A win credits the lessons used on the way; a death becomes a lesson in the background, so the
    // retry starts at once and picks the lesson up when it is ready.
    private endAttempt(kind: "won" | "dead"): void {
        const lessons = this.lessons
        const used = [...this.activeIds]
        this.activeIds.clear()
        if (!lessons) return
        if (kind === "won") {
            if (used.length > 0) {
                lessons.store.win(used)
                lessons.store.save()
            }
            this.trace.reset()
            return
        }
        const world = this.shadow.world
        this.trace.dead(this.api, world, this.latest)
        const death = world ? postMortem(this.trace, this.mapKey, this.latest?.lvl ?? this.mapKey.split(":")[0]) : null
        this.trace.reset()
        if (!world || !death) return
        this.learning = this.learning.then(async () => {
            const learned = await learn(this.api, world, lessons.store, death, lessons.reflect)
            if (learned.source === "llm") this.stats.lessonsLlm++
            else if (learned.source === "rule") this.stats.lessonsRule++
            this.log({ kind: "lesson", at: this.now(), lvl: death.lvl, learned, reason: learned.note })
        })
    }

    private kick(): void {
        const snap = this.latest
        if (this.inFlight || !snap || `${snap.run}:${snap.n}` === this.decided) return
        this.decided = `${snap.run}:${snap.n}`
        const world = this.shadow.sync(snap)
        if (!world) {
            this.stats.skipped++
            this.log({ kind: "skip", at: this.now(), n: snap.n, lvl: snap.lvl, reason: this.shadow.problem })
            return
        }
        const level = `${snap.run}:${snap.lvl}:${this.attempt}`
        this.countPickups(`${snap.run}:${snap.lvl}`, world)
        this.memory.observe(level, this.api, world, snap.t, this.shadow.spawns)
        const sit = situate(this.api, world, this.memory)
        const stalledMs = this.stalled(level, snap, sit)
        const view = this.predicted(snap) ?? { world, sit }
        const recent = this.history.map((h) => `${h.action} ${h.result}`)
        const goal = `${snap.lvl}:${view.sit.goal}:${view.sit.goalCell}`
        const lesson = this.activeLesson(world, sit)
        const state = facts(this.api, view.world, view.sit, recent, progressText(goal === this.goal ? this.steps : null, view.sit.steps), {
            stalledMs,
            lesson: lesson ? lessonText(lesson) : undefined,
        })
        this.goal = goal
        this.steps = view.sit.steps
        const watchdog = this.watchdog(snap, stalledMs)
        this.inFlight = this.ask(snap, state, (answer) => {
            let pick: Action = watchdog ? "advance" : answer.action
            if (mustHeal(world, sit, pick)) {
                pick = "heal"
                this.stats.forcedHeal++
            }
            const taught = applyLesson(lesson?.action ?? null, pick, watchdog)
            const override = taught !== pick
            if (override) this.stats.lessonOverride++
            const decision = decide(this.api, world, sit, taught, answer.danger)
            if (override) decision.label = lessonLabel(decision.label)
            if (this.lessons) this.tracePick(snap, sit, answer.action, decision.action, lesson)
            return { decision, note: lesson ? { lesson: lesson.lesson.id, override } : {} }
        }, sit.at, lesson?.action ?? null)
            .finally(() => {
                this.inFlight = null
                this.kick()
            })
    }

    private activeLesson(world: World, sit: Situation): ActiveLesson | null {
        if (!this.lessons) return null
        const a = activeLesson(this.api, world, sit, this.lessons.store.forKey(this.mapKey), this.mapKey)
        if (a) {
            this.stats.lessonActive++
            this.activeIds.add(a.lesson.id)
        }
        return a
    }

    private tracePick(snap: Snapshot, sit: Situation, pick: Action, sent: Action, lesson: ActiveLesson | null): void {
        this.trace.pick({
            k: "pick",
            t: snap.t,
            hp: snap.hp,
            cell: sit.at,
            pick,
            sent,
            enemies: sit.enemies.map((e) => `${e.kind} ${e.cells} cells${e.inBiteRange ? " biting" : ""}`),
            fireballs: sit.fireballs.length,
            medkit: sit.medkit?.steps ?? null,
            shotgun: sit.shotgun?.steps ?? null,
            lesson: lesson?.lesson.id ?? "",
        })
    }

    // Time out of combat without moving, from the console clock.
    private stalled(level: string, snap: Snapshot, sit: Situation): number {
        const s = this.still
        const moved = !s || s.key !== level || Math.abs(snap.x - s.x) > STILL_EPS || Math.abs(snap.y - s.y) > STILL_EPS
        if (moved || sit.enemies.length > 0) {
            this.still = { key: level, x: snap.x, y: snap.y, since: snap.t, fired: false }
            return 0
        }
        return snap.t - s.since
    }

    private watchdog(snap: Snapshot, stalledMs: number): boolean {
        const s = this.still
        if (!s || s.fired || stalledMs < WATCHDOG_MS) return false
        s.fired = true
        this.stats.watchdog++
        this.log({ kind: "watchdog", at: this.now(), n: snap.n, lvl: snap.lvl, reason: `still for ${stalledMs} ms` })
        return true
    }

    // The shadow world run forward by the usual Jev latency under the command already in the box,
    // so the facts describe the moment the answer lands. Null when there is nothing to predict, or
    // the prediction walks into a wall or takes damage: then the snapshot itself is safer.
    private predicted(snap: Snapshot): { world: World; sit: Situation } | null {
        const lead = percentile(this.stats.latencies.slice(-PREDICT_LATENCIES), 0.5)
        if (!this.predict || !this.sent || lead <= 0) return null
        const world = this.ahead.sync(snap)
        if (!world) return null
        const api = this.api
        const exec = new api.AiExec()
        const s = this.sent
        api.aiStart(exec, world, s.cmd, s.a, s.b, s.route.flat(), s.from[0], s.from[1])
        if (exec.result === api.AI_BLOCKED) return null
        for (let t = 0; t < lead; t += PREDICT_DT) {
            api.update(world, api.aiStep(exec, world, PREDICT_DT), PREDICT_DT)
            if (world.health < snap.hp || world.won || world.lost || exec.result === api.AI_BLOCKED) return null
        }
        this.stats.predicted++
        return { world, sit: situate(api, world, this.memory) }
    }

    private countPickups(key: string, world: World): void {
        const now = world.items.map((it) => it.taken)
        if (key === this.takenKey) {
            now.forEach((t, i) => {
                if (!t || this.taken[i]) return
                const name = ITEM_NAMES[world.items[i].kind] ?? "item"
                this.stats.pickups[name] = (this.stats.pickups[name] ?? 0) + 1
            })
        }
        this.takenKey = key
        this.taken = now
    }

    private async ask(
        snap: Snapshot,
        state: Record<string, unknown>,
        choose: (a: JevAnswer) => { decision: Decision; note: Partial<LogRecord> },
        from: Cell,
        lesson: Action | null,
    ): Promise<void> {
        const answer = await this.jev(state, lesson ? { lesson } : undefined)
        if (answer.error) this.stats.errors++
        else this.stats.picks[answer.action] = (this.stats.picks[answer.action] ?? 0) + 1
        this.stats.latencies.push(answer.latencyMs)
        this.stats.cost += answer.cost
        if (!this.latest || this.latest.run !== snap.run || this.latest.lvl !== snap.lvl) return
        const { decision, note } = choose(answer)
        this.seq = nextSeq(this.seq)
        const box = encodeBox({
            seq: this.seq,
            obs: snap.n,
            cmd: decision.cmd,
            a: decision.a,
            b: decision.b,
            conf: answer.confidence * 100,
            latency: answer.latencyMs,
            label: decision.label,
            route: decision.route,
            danger: answer.danger,
        })
        await this.transport.writeBox(boxWrites(box))
        this.sent = { cmd: decision.cmd, a: decision.a, b: decision.b, route: decision.route, from }
        this.stats.decisions++
        this.history = [...this.history, { seq: this.seq, action: decision.action, result: "sent" }].slice(-RECENT)
        this.log({ kind: "decision", at: this.now(), n: snap.n, lvl: snap.lvl, state, answer, decision, seq: this.seq, ...note })
    }
}

export function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

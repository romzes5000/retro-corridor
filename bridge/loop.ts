// The bridge loop: console snapshot -> shadow world -> facts -> Jev -> one command in the mailbox.
// One Jev request in flight; whatever snapshot is newest when it returns gets the next request.
import type { LogicApi } from "../load-logic.ts"
import { decide, type Decision } from "./decide.ts"
import type { JevAnswer, JevFn } from "./jev.ts"
import { boxWrites, encodeBox, nextSeq, type BoxWrite } from "./mailbox.ts"
import { facts, progressText, situate } from "./observe.ts"
import { Parser, type Snapshot } from "./protocol.ts"
import { Shadow } from "./shadow.ts"

export interface Transport {
    onLine(listener: (line: string) => void): void
    writeBox(writes: BoxWrite[]): Promise<void>
    // The console restarted (new run id): drop any cached mailbox address.
    reset(): void
}

export interface LogRecord {
    kind: "decision" | "won" | "dead" | "skip"
    at: number
    n?: number
    lvl?: string
    state?: Record<string, unknown>
    answer?: JevAnswer
    decision?: Decision
    seq?: number
    reason?: string
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
}

const RECENT = 3

export class Bridge {
    readonly stats: Stats = { decisions: 0, errors: 0, latencies: [], cost: 0, won: 0, dead: 0, stale: 0, skipped: 0 }
    onEnd: (kind: "won" | "dead") => void = () => {}
    private readonly parser = new Parser()
    private readonly shadow: Shadow
    private latest: Snapshot | null = null
    private decided = ""
    private inFlight: Promise<void> | null = null
    private seq: number
    private run = -1
    // Last few commands with what the console reported back for each.
    private history: Array<{ seq: number; action: string; result: string }> = []
    private staleSeen = -1
    private steps: number | null = null
    private goal = ""
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
    ) {
        this.api = api
        this.transport = transport
        this.jev = jev
        this.log = log
        this.now = now
        this.shadow = new Shadow(api)
        this.seq = seq
        transport.onLine((line) => this.line(line))
    }

    // Resolves once the request in flight (if any) has written its command.
    idle(): Promise<void> {
        return this.inFlight ?? Promise.resolve()
    }

    line(raw: string): void {
        const msg = this.parser.line(raw)
        if (!msg) return
        if (msg.kind === "won" || msg.kind === "dead") {
            if (msg.kind === "won") this.stats.won++
            else this.stats.dead++
            this.history = []
            this.latest = null
            this.steps = null
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
        this.latest = snap
        this.kick()
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
        const recent = this.history.map((h) => `${h.action} ${h.result}`)
        const sit = situate(this.api, world)
        const goal = `${snap.lvl}:${sit.goal}:${sit.goalCell}`
        const state = facts(this.api, world, sit, recent, progressText(goal === this.goal ? this.steps : null, sit.steps))
        this.goal = goal
        this.steps = sit.steps
        this.inFlight = this.ask(snap, state, (answer) => decide(this.api, world, sit, answer.action))
            .finally(() => {
                this.inFlight = null
                this.kick()
            })
    }

    private async ask(snap: Snapshot, state: Record<string, unknown>, choose: (a: JevAnswer) => Decision): Promise<void> {
        const answer = await this.jev(state)
        if (answer.error) this.stats.errors++
        this.stats.latencies.push(answer.latencyMs)
        this.stats.cost += answer.cost
        if (!this.latest || this.latest.run !== snap.run || this.latest.lvl !== snap.lvl) return
        const decision = choose(answer)
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
        })
        await this.transport.writeBox(boxWrites(box))
        this.stats.decisions++
        this.history = [...this.history, { seq: this.seq, action: decision.action, result: "sent" }].slice(-RECENT)
        this.log({ kind: "decision", at: this.now(), n: snap.n, lvl: snap.lvl, state, answer, decision, seq: this.seq })
    }
}

export function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

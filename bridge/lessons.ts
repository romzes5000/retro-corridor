// Death lessons. After a death the bridge looks at the last seconds (what hit the player, from
// where, what Jev picked), asks an LLM for one lesson "under these conditions do this" and keeps
// it: per level and map for a place ("ambush behind this door"), or for every level for a tactic
// ("boss in sight at low health"). A lesson in force is shown to Jev and backed by a bridge rule.
import fs from "node:fs"
import path from "node:path"
import type { LogicApi, World } from "../load-logic.ts"
import { biter, damageSource, type DamageSource } from "./damage.ts"
import type { Action } from "./jev.ts"
import { ENEMY_NAMES, type Situation } from "./observe.ts"
import type { Snapshot } from "./protocol.ts"
import { passable, type Cell } from "./route.ts"

export const CONDITIONS = ["biter_near", "shooter_visible", "fireball_near", "boss_visible", "health_below_60", "health_below_40"] as const
export type Condition = (typeof CONDITIONS)[number]
// No advance, open or wait: a lesson that only says "stand here" or "walk on" would stall the player.
export const LESSON_ACTIONS = ["attack", "retreat", "dodge", "heal", "weapon", "ammo"] as const
export type LessonAction = (typeof LESSON_ACTIONS)[number]

export const ZONE_LIMIT = 3
export const GLOBAL_LIMIT = 3
export const MAX_FAILS = 2
export const TRACE_MS = 15000
// A pause in the damage this long, or a heal, ends one damage streak and starts the next.
export const SAFE_MS = 3000
export const WHY_MAX = 60
export const ZONE_R_MAX = 4
const BITER_CELLS = 3
const ITEM_NEAR = 10
const PICKS_BEFORE_MS = 2000
const ALL_KEYS = 0xff

export interface Zone {
    x: number
    y: number
    r: number
}

export interface Draft {
    scope: "zone" | "global"
    zone: Zone | null
    when: Condition[]
    do: LessonAction
    why: string
}

export interface Lesson extends Draft {
    id: string
    // `lvl:hash` for a zone lesson, "global" otherwise.
    key: string
    deaths: number
    wins: number
    failed: number
    at: number
    source: "llm" | "rule"
}

export type TraceEntry =
    | { k: "hit"; t: number; hp: number; cell: Cell; amount: number; source: DamageSource; by: string }
    | { k: "heal"; t: number; hp: number; cell: Cell }
    | { k: "pick"; t: number; hp: number; cell: Cell; pick: string; sent: string; enemies: string[]; fireballs: number; medkit: number | null; shotgun: number | null; lesson: string }

const cellOf = (x: number, y: number): Cell => [x >> 10, y >> 10]

// The last TRACE_MS of one level attempt.
export class Trace {
    entries: TraceEntry[] = []
    private prev: Snapshot | null = null

    reset(): void {
        this.entries = []
        this.prev = null
    }

    // Every console snapshot: a health drop becomes a hit with its likely source, a rise a heal.
    snap(api: LogicApi, world: World | null, snap: Snapshot): void {
        const p = this.prev
        this.prev = snap
        if (!p || !world || p.run !== snap.run || p.lvl !== snap.lvl || p.hash !== snap.hash) return
        const cell = cellOf(snap.x, snap.y)
        if (snap.hp < p.hp) {
            const source = damageSource(api, world, snap.x, snap.y, snap.shots.length < p.shots.length)
            const b = source === "bite" ? biter(api, snap.x, snap.y, snap.enemies) : null
            const by = source === "shot" ? "fireball" : source === "lava" ? "lava" : b ? ENEMY_NAMES[b.kind] ?? "enemy" : "enemy"
            this.push({ k: "hit", t: snap.t, hp: snap.hp, cell, amount: p.hp - snap.hp, source, by })
        } else if (snap.hp > p.hp) {
            this.push({ k: "heal", t: snap.t, hp: snap.hp, cell })
        }
    }

    // The killing blow lands between snapshots: the console reports the death, not a snapshot at
    // 0 HP. Without it a one-hit death from low health would leave nothing to learn from.
    dead(api: LogicApi, world: World | null, last: Snapshot | null): void {
        if (!world || !last || last.hp <= 0) return
        const b = biter(api, last.x, last.y, last.enemies)
        const source = api.lavaAt(world, last.x >> 10, last.y >> 10) ? "lava" : b ? "bite" : last.shots.length > 0 ? "shot" : "bite"
        const by = source === "bite" ? (b ? ENEMY_NAMES[b.kind] ?? "enemy" : "enemy") : source === "shot" ? "fireball" : "lava"
        this.push({ k: "hit", t: last.t + 1, hp: 0, cell: cellOf(last.x, last.y), amount: last.hp, source, by })
    }

    pick(entry: Extract<TraceEntry, { k: "pick" }>): void {
        this.push(entry)
    }

    private push(e: TraceEntry): void {
        this.entries.push(e)
        const from = e.t - TRACE_MS
        while (this.entries.length > 0 && this.entries[0].t < from) this.entries.shift()
    }
}

export interface Death {
    key: string
    lvl: string
    // Where the fatal damage streak began, and the health then.
    start: Cell
    startHp: number
    end: Cell
    cause: DamageSource
    by: string
    hits: Array<{ t: number; source: DamageSource; by: string; amount: number; cell: Cell }>
    picks: Array<{ t: number; hp: number; pick: string; sent: string; enemies: string[]; fireballs: number }>
    medkitNear: boolean
    shotgunNear: boolean
    // Lessons that were in force during the streak.
    active: string[]
}

// The fatal streak: hits back from the last one until a heal or a SAFE_MS pause. Null without hits.
export function postMortem(trace: Trace, key: string, lvl: string): Death | null {
    const e = trace.entries
    let last = -1
    for (let i = e.length - 1; i >= 0; i--) if (e[i].k === "hit") {
        last = i
        break
    }
    if (last < 0) return null
    let start = last
    let nextT = e[last].t
    for (let i = last - 1; i >= 0; i--) {
        const x = e[i]
        if (x.k === "heal") break
        if (x.k !== "hit") continue
        if (nextT - x.t >= SAFE_MS) break
        start = i
        nextT = x.t
    }
    const first = e[start] as Extract<TraceEntry, { k: "hit" }>
    const hits = e.slice(start).filter((x): x is Extract<TraceEntry, { k: "hit" }> => x.k === "hit")
    const picks = e.filter((x): x is Extract<TraceEntry, { k: "pick" }> => x.k === "pick" && x.t >= first.t - PICKS_BEFORE_MS)
    const total = new Map<string, number>()
    for (const h of hits) total.set(`${h.source}:${h.by}`, (total.get(`${h.source}:${h.by}`) ?? 0) + h.amount)
    const [top] = [...total.entries()].sort((a, b) => b[1] - a[1])[0]
    const [cause, by] = top.split(":") as [DamageSource, string]
    const end = e[e.length - 1].cell
    return {
        key,
        lvl,
        start: first.cell,
        startHp: first.hp + first.amount,
        end,
        cause,
        by,
        hits: hits.map((h) => ({ t: h.t, source: h.source, by: h.by, amount: h.amount, cell: h.cell })),
        picks: picks.map((p) => ({ t: p.t, hp: p.hp, pick: p.pick, sent: p.sent, enemies: p.enemies, fireballs: p.fireballs })),
        medkitNear: picks.some((p) => p.medkit !== null && p.medkit <= ITEM_NEAR),
        shotgunNear: picks.some((p) => p.shotgun !== null && p.shotgun <= ITEM_NEAR),
        active: [...new Set(picks.filter((p) => p.t >= first.t && p.lesson !== "").map((p) => p.lesson))],
    }
}

// The lesson without an LLM, for the three common deaths. Null for lava: the bridge already
// refuses to step into it, a lesson would add nothing.
export function classify(death: Death): Draft | null {
    const zone = { x: death.start[0], y: death.start[1], r: 2 }
    if (death.cause === "lava") return null
    if (death.cause === "shot") return { scope: "zone", zone, when: ["fireball_near"], do: "dodge", why: `fireball hits from ${death.startHp} HP` }
    if (death.by === "boss") return { scope: "global", zone: null, when: ["boss_visible", "health_below_60"], do: "retreat", why: "boss bites up close" }
    if (death.medkitNear) return { scope: "global", zone: null, when: ["health_below_60"], do: "heal", why: "died with a medkit nearby" }
    return { scope: "zone", zone, when: ["biter_near", "health_below_60"], do: "retreat", why: `${death.by} bit to death from ${death.startHp} HP` }
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v)

// Strict check of a lesson from outside (LLM or file). Returns the reason on refusal.
export function validateDraft(api: LogicApi, world: World, raw: unknown): Draft | string {
    const r = raw as Record<string, unknown>
    if (!r || typeof r !== "object") return "not an object"
    if (r.scope !== "zone" && r.scope !== "global") return `bad scope ${String(r.scope)}`
    if (!Array.isArray(r.when) || r.when.length === 0) return "when is empty"
    if (!r.when.every((c) => (CONDITIONS as readonly unknown[]).includes(c))) return `unknown condition in ${JSON.stringify(r.when)}`
    if (!(LESSON_ACTIONS as readonly unknown[]).includes(r.do)) return `action ${String(r.do)} is not allowed`
    if (typeof r.why !== "string" || r.why.trim() === "" || r.why.length > WHY_MAX) return `why must be 1-${WHY_MAX} characters`
    let zone: Zone | null = null
    if (r.scope === "zone") {
        const z = r.zone as Record<string, unknown> | null
        if (!z || !isInt(z.x) || !isInt(z.y) || !isInt(z.r)) return "zone needs integer x, y, r"
        if (z.r < 1 || z.r > ZONE_R_MAX) return `zone radius must be 1-${ZONE_R_MAX}`
        if (z.x < 0 || z.y < 0 || z.x >= world.w || z.y >= world.h) return "zone is off the map"
        if (!passable(api, world, z.x, z.y, ALL_KEYS, false)) return "zone centre is in a wall"
        zone = { x: z.x, y: z.y, r: z.r }
    }
    return { scope: r.scope, zone, when: [...new Set(r.when as Condition[])], do: r.do as LessonAction, why: r.why.trim() }
}

export type Verdict = { kind: "new"; draft: Draft } | { kind: "edit"; id: string; draft: Draft } | { kind: "none" }

export function parseVerdict(api: LogicApi, world: World, raw: unknown, existing: Lesson[]): Verdict | string {
    const r = raw as Record<string, unknown>
    if (!r || typeof r !== "object") return "not an object"
    if (r.verdict === "none") return { kind: "none" }
    if (r.verdict !== "new" && r.verdict !== "edit") return `bad verdict ${String(r.verdict)}`
    const draft = validateDraft(api, world, r.lesson)
    if (typeof draft === "string") return draft
    if (r.verdict === "new") return { kind: "new", draft }
    const id = r.edit_id
    if (typeof id !== "string" || !existing.some((l) => l.id === id)) return `no lesson ${String(id)} to edit`
    return { kind: "edit", id, draft }
}

const score = (l: Lesson) => l.wins - l.deaths - 2 * l.failed
const sameWhen = (a: Condition[], b: Condition[]) => a.length === b.length && a.every((c) => b.includes(c))
const overlap = (a: Zone | null, b: Zone | null) => !!a && !!b && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= a.r + b.r

// One file per bridge mode, so the console and a sim bench running at once never overwrite each other.
export function lessonsFile(dir: string, mode: "console" | "sim"): string {
    return path.join(dir, `lessons-${mode}.json`)
}

export interface LessonFlags {
    on: boolean
    file?: string
    reset: boolean
}

// Off by default: on ARENA, 10 runs each, lessons gave 30 deaths before the win against 34
// without, within run-to-run noise. Naming a file or a reset turns them on too.
export function lessonsOn(flags: LessonFlags): boolean {
    return flags.on || flags.file !== undefined || flags.reset
}

export class LessonStore {
    lessons: Lesson[] = []
    private readonly file: string | null
    private readonly now: () => number
    private next = 1

    constructor(file: string | null, now: () => number = Date.now) {
        this.file = file
        this.now = now
        if (file && fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, "utf8")) as { lessons?: Lesson[] }
            this.lessons = (data.lessons ?? []).filter((l) => typeof l.id === "string" && typeof l.key === "string")
            for (const l of this.lessons) this.next = Math.max(this.next, Number(l.id.replace(/\D/g, "")) + 1)
        }
    }

    get(id: string): Lesson | undefined {
        return this.lessons.find((l) => l.id === id)
    }

    // Zone lessons of this level and map, then every global one.
    forKey(key: string): Lesson[] {
        return this.lessons.filter((l) => l.key === key || l.scope === "global")
    }

    add(key: string, draft: Draft, source: Lesson["source"]): Lesson {
        const k = draft.scope === "global" ? "global" : key
        const same = this.lessons.find((l) => l.key === k && l.scope === draft.scope && sameWhen(l.when, draft.when) && (draft.scope === "global" || overlap(l.zone, draft.zone)))
        if (same) {
            same.deaths++
            Object.assign(same, { do: draft.do, why: draft.why, zone: draft.zone ?? same.zone, source, at: this.now() })
            return same
        }
        const lesson: Lesson = { ...draft, id: `L${this.next++}`, key: k, deaths: 1, wins: 0, failed: 0, at: this.now(), source }
        this.lessons.push(lesson)
        const group = this.lessons.filter((l) => l.key === k)
        if (group.length > (k === "global" ? GLOBAL_LIMIT : ZONE_LIMIT)) {
            const others = group.filter((l) => l !== lesson).sort((a, b) => score(a) - score(b) || a.at - b.at)
            this.remove(others[0].id)
        }
        return lesson
    }

    edit(id: string, draft: Draft, source: Lesson["source"]): Lesson | null {
        const l = this.get(id)
        if (!l) return null
        Object.assign(l, { scope: draft.scope, zone: draft.zone, when: draft.when, do: draft.do, why: draft.why, source, at: this.now() })
        return l
    }

    win(ids: Iterable<string>): void {
        for (const id of ids) {
            const l = this.get(id)
            if (l) l.wins++
        }
    }

    // A lesson in force when the same kind of death came again did not help; twice and it goes.
    fail(id: string): boolean {
        const l = this.get(id)
        if (!l) return false
        l.failed++
        if (l.failed >= MAX_FAILS) this.remove(id)
        return true
    }

    remove(id: string): void {
        this.lessons = this.lessons.filter((l) => l.id !== id)
    }

    clear(): void {
        this.lessons = []
    }

    save(): void {
        if (!this.file) return
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const tmp = `${this.file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, lessons: this.lessons }, null, 1) + "\n")
        fs.renameSync(tmp, this.file)
    }
}

export function holds(api: LogicApi, world: World, sit: Situation, c: Condition): boolean {
    switch (c) {
        case "biter_near":
            return sit.enemies.some((e) => api.ENEMY_BITE[world.enemies[e.i].kind] > 0 && e.cells <= BITER_CELLS)
        case "shooter_visible":
            return sit.enemies.some((e) => api.ENEMY_BITE[world.enemies[e.i].kind] === 0)
        case "fireball_near":
            return sit.fireballs.length > 0
        case "boss_visible":
            return sit.enemies.some((e) => e.kind === "boss")
        case "health_below_60":
            return world.health < 60
        case "health_below_40":
            return world.health < 40
        default: {
            const never: never = c
            return never
        }
    }
}

// The concrete action a lesson asks for right now; null when it makes no sense here (nothing to
// retreat from, no medkit left), so the lesson stays quiet instead of stalling the player.
export function lessonAction(world: World, sit: Situation, l: Lesson): Action | null {
    switch (l.do) {
        case "attack":
            return sit.enemies.length > 0 && world.ammo >= 1 ? "attack" : null
        case "retreat":
            return sit.enemies.length > 0 || sit.fireballs.length > 0 ? "retreat" : null
        case "dodge": {
            const f = sit.fireballs.find((b) => b.safeSide !== "none")
            return f ? (f.safeSide === "left" ? "dodge_left" : "dodge_right") : null
        }
        case "heal":
            return sit.medkit && sit.medkit.steps > 0 ? "heal" : null
        case "weapon":
            return sit.shotgun ? "weapon" : null
        case "ammo":
            return sit.ammo && sit.ammo.steps > 0 ? "ammo" : null
        default: {
            const never: never = l.do
            return never
        }
    }
}

const inZone = (z: Zone | null, at: Cell) => !!z && Math.max(Math.abs(at[0] - z.x), Math.abs(at[1] - z.y)) <= z.r

export interface ActiveLesson {
    lesson: Lesson
    action: Action
}

// The lesson in force: a zone lesson of this map with the player inside it first, then a global
// one; every condition must hold and the action must make sense here.
export function activeLesson(api: LogicApi, world: World, sit: Situation, lessons: Lesson[], key: string): ActiveLesson | null {
    const candidates = lessons
        .filter((l) => (l.scope === "global" || (l.key === key && inZone(l.zone, sit.at))) && l.when.every((c) => holds(api, world, sit, c)))
        .sort((a, b) => (a.scope === b.scope ? score(b) - score(a) : a.scope === "zone" ? -1 : 1))
    for (const lesson of candidates) {
        const action = lessonAction(world, sit, lesson)
        if (action) return { lesson, action }
    }
    return null
}

export function lessonText(a: ActiveLesson): string {
    const where = a.lesson.scope === "zone" ? "died here before" : "died like this before"
    return `${where}: ${a.lesson.when.join(" + ")}, ${a.action}`
}

// Which deaths a lesson is about: a fireball lesson does not fail on a bite.
function sameCause(l: Lesson, cause: DamageSource): boolean {
    const shot = l.when.some((c) => c === "fireball_near" || c === "shooter_visible")
    const bite = l.when.some((c) => c === "biter_near" || c === "boss_visible")
    if (shot && !bite) return cause === "shot"
    if (bite && !shot) return cause === "bite"
    return cause !== "lava"
}

export type ReflectFn = (death: Death, existing: Lesson[], failed: string[]) => Promise<unknown>

export interface Learned {
    lesson: Lesson | null
    verdict: Verdict["kind"]
    source: "llm" | "rule" | "none"
    failed: string[]
    // Why the LLM answer was not used, empty when it was.
    note: string
}

// Marks the lessons that failed, asks the LLM (or falls back to the rule) and saves the result.
export async function learn(api: LogicApi, world: World, store: LessonStore, death: Death, reflect: ReflectFn | null): Promise<Learned> {
    const failed: string[] = []
    for (const id of death.active) {
        const l = store.get(id)
        if (l && sameCause(l, death.cause)) {
            failed.push(id)
            store.fail(id)
        }
    }
    let verdict: Verdict | null = null
    let note = reflect ? "" : "no reflect"
    if (reflect) {
        try {
            const existing = store.forKey(death.key)
            const v = parseVerdict(api, world, await reflect(death, existing, failed), existing)
            if (typeof v === "string") note = v
            else verdict = v
        } catch (err) {
            note = err instanceof Error ? err.message : String(err)
        }
    }
    let source: Learned["source"] = "llm"
    if (!verdict) {
        const draft = classify(death)
        verdict = draft ? { kind: "new", draft } : { kind: "none" }
        source = "rule"
    }
    let lesson: Lesson | null = null
    if (verdict.kind === "new") lesson = store.add(death.key, verdict.draft, source === "llm" ? "llm" : "rule")
    else if (verdict.kind === "edit") lesson = store.edit(verdict.id, verdict.draft, "llm")
    if (!lesson) source = "none"
    store.save()
    return { lesson: lesson ? structuredClone(lesson) : null, verdict: verdict.kind, source, failed, note }
}

export const LESSON_URL = "https://openrouter.ai/api/v1/chat/completions"
export const DEFAULT_LESSON_MODEL = "openai/gpt-4.1-mini"
export const REFLECT_TIMEOUT_MS = 10000

const SYSTEM = [
    "You review a death in a first-person maze shooter played by an AI that picks one tactic every half second.",
    "Write at most one short lesson that would have avoided this death, or none if it was bad luck.",
    "A zone lesson is about a place on this map (cells x, y; radius r up to 4); a global lesson is a tactic for every level.",
    `The lesson fires when all conditions in "when" hold. Actions: attack, retreat (back away while shooting), dodge (sidestep a fireball), heal (walk to a medkit), weapon (walk to the shotgun), ammo.`,
    "If an existing lesson is close, edit it by id instead of adding a new one; lessons marked failed did not help, replace them.",
    `Keep "why" under ${WHY_MAX} characters.`,
].join(" ")

const LESSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "edit_id", "lesson"],
    properties: {
        verdict: { type: "string", enum: ["new", "edit", "none"] },
        edit_id: { type: "string" },
        lesson: {
            type: "object",
            additionalProperties: false,
            required: ["scope", "zone", "when", "do", "why"],
            properties: {
                scope: { type: "string", enum: ["zone", "global"] },
                zone: {
                    anyOf: [
                        { type: "null" },
                        { type: "object", additionalProperties: false, required: ["x", "y", "r"], properties: { x: { type: "integer" }, y: { type: "integer" }, r: { type: "integer" } } },
                    ],
                },
                when: { type: "array", items: { type: "string", enum: [...CONDITIONS] } },
                do: { type: "string", enum: [...LESSON_ACTIONS] },
                why: { type: "string" },
            },
        },
    },
} as const

// What the LLM reads: the streak, Jev's picks in it and the lessons it may edit.
export function deathPrompt(death: Death, existing: Lesson[], failed: string[]): string {
    return JSON.stringify({
        level: death.lvl,
        damage_streak: { started_at_cell: death.start, health_then: death.startHp, died_at_cell: death.end, main_cause: `${death.cause} by ${death.by}`, hits: death.hits.map((h) => `${h.by} -${h.amount} at ${h.cell.join(",")}`) },
        picks: death.picks.map((p) => `hp ${p.hp}: jev ${p.pick}, did ${p.sent}${p.enemies.length ? `, enemies ${p.enemies.join("; ")}` : ""}${p.fireballs ? `, ${p.fireballs} fireball(s)` : ""}`),
        medkit_was_near: death.medkitNear,
        shotgun_was_near: death.shotgunNear,
        existing_lessons: existing.map((l) => ({ id: l.id, scope: l.scope, zone: l.zone, when: l.when, do: l.do, why: l.why, failed: failed.includes(l.id) || l.failed > 0 })),
    })
}

export interface ReflectOptions {
    key: string
    model?: string
    timeoutMs?: number
    fetch?: typeof fetch
}

// One chat completion with a JSON schema. Throws on any failure; `learn` then uses the rule.
export function makeReflect(opts: ReflectOptions): ReflectFn {
    const doFetch = opts.fetch ?? fetch
    const model = opts.model ?? (process.env.LESSON_MODEL || DEFAULT_LESSON_MODEL)
    const timeoutMs = opts.timeoutMs ?? REFLECT_TIMEOUT_MS
    return async (death, existing, failed) => {
        if (!opts.key) throw new Error("no API key")
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), timeoutMs)
        try {
            const res = await doFetch(LESSON_URL, {
                method: "POST",
                headers: { Authorization: `Bearer ${opts.key}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model,
                    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: deathPrompt(death, existing, failed) }],
                    response_format: { type: "json_schema", json_schema: { name: "lesson", strict: true, schema: LESSON_SCHEMA } },
                }),
                signal: abort.signal,
            })
            if (!res.ok) throw new Error(`http ${res.status}`)
            const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
            const content = body.choices?.[0]?.message?.content
            if (typeof content !== "string") throw new Error("no content in answer")
            return JSON.parse(content)
        } catch (err) {
            if (abort.signal.aborted) throw new Error(`timeout ${timeoutMs} ms`)
            throw err
        } finally {
            clearTimeout(timer)
        }
    }
}

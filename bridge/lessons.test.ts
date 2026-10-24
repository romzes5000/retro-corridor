// Death lessons: damage sources, the fatal streak, the rule and the LLM check, the store on disk,
// which lesson is in force, how it reaches Jev, and the bridge learning from real deaths in the sim.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { loadLogic, type World } from "../load-logic.ts"
import { biter, damageSource } from "./damage.ts"
import { applyLesson, lessonLabel } from "./decide.ts"
import { ACTION_QUESTIONS, LESSON_CRITERION, makeJev, questionsFor, type Action, type JevFn, type JevHint } from "./jev.ts"
import {
    activeLesson, classify, GLOBAL_LIMIT, learn, LessonStore, lessonsFile, lessonsOn, lessonText, makeReflect, parseVerdict, postMortem,
    SAFE_MS, Trace, TRACE_MS, validateDraft, ZONE_LIMIT, type Death, type Draft, type Lesson, type ReflectFn, type TraceEntry,
} from "./lessons.ts"
import { Bridge, type LogRecord } from "./loop.ts"
import { facts, situate } from "./observe.ts"
import type { Snapshot } from "./protocol.ts"
import { levelIndex, SimConsole, simLevels } from "./sim.ts"

const api = loadLogic()
const FP = 1024
const centre = (c: number) => c * FP + FP / 2
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "rc-lessons-"))

function snap(over: Partial<Snapshot>): Snapshot {
    return {
        n: 0, t: 0, run: 1, lvl: "0", hash: 7, difficulty: 1, x: centre(1), y: centre(1), ang: 0, hp: 100, ammo: 10, weapon: 0, keys: 0,
        locked: false, enemies: [], shots: [], doors: [], taken: [], ack: { seq: 0, result: "", stale: false }, ...over,
    }
}

function death(over: Partial<Death> = {}): Death {
    return {
        key: "0:7", lvl: "0", start: [2, 1], startHp: 50, end: [3, 1], cause: "bite", by: "imp", hits: [], picks: [],
        medkitNear: false, shotgunNear: false, active: [], ...over,
    }
}

const lesson = (over: Partial<Lesson>): Lesson => ({
    id: "L1", key: "0:7", scope: "zone", zone: { x: 1, y: 1, r: 1 }, when: ["biter_near"], do: "retreat", why: "test",
    deaths: 1, wins: 0, failed: 0, at: 0, source: "rule", ...over,
})

const draft = (over: Partial<Draft> = {}): Draft => ({ scope: "zone", zone: { x: 2, y: 1, r: 2 }, when: ["biter_near"], do: "retreat", why: "imp bit", ...over })

const hit = (t: number, amount: number, by = "knight", cell: [number, number] = [4, 1], source: "bite" | "shot" | "lava" = "bite", hp = 50): TraceEntry =>
    ({ k: "hit", t, hp, cell, amount, source, by })
const pick = (t: number, over: Partial<Extract<TraceEntry, { k: "pick" }>> = {}): TraceEntry =>
    ({ k: "pick", t, hp: 50, cell: [4, 1], pick: "advance", sent: "advance", enemies: [], fireballs: 0, medkit: null, shotgun: null, lesson: "", ...over })

test("урон: снаряд, лава, укус; кусает ближайший враг в досягаемости", () => {
    const world = api.createWorld(["#######", "#S.L..#", "#######"], 0)
    assert.equal(damageSource(api, world, centre(1), centre(1), true), "shot")
    assert.equal(damageSource(api, world, centre(3), centre(1), false), "lava")
    assert.equal(damageSource(api, world, centre(1), centre(1), false), "bite")
    const far = { kind: api.ENEMY_IMP, x: centre(1) + 2000, y: centre(1) }
    const near = { kind: api.ENEMY_KNIGHT, x: centre(1) + 500, y: centre(1) }
    const nearer = { kind: api.ENEMY_IMP, x: centre(1) + 300, y: centre(1) }
    const shooter = { kind: api.ENEMY_SHOOTER, x: centre(1) + 100, y: centre(1) }
    assert.equal(biter(api, centre(1), centre(1), [far, near, nearer, shooter]), nearer)
    assert.equal(biter(api, centre(1), centre(1), [far, shooter]), null, "стрелок не кусает, дальний не достаёт")
})

test("трасса: удар с источником, лечение, другой уровень не сравнивается, хвост 15 с", () => {
    const world = api.createWorld(["#######", "#S.L..#", "#######"], 0)
    const trace = new Trace()
    const imp = { i: 0, kind: api.ENEMY_IMP, x: centre(1) + 300, y: centre(1), hp: 2, sees: true }
    trace.snap(api, world, snap({ t: 0 }))
    trace.snap(api, world, snap({ t: 250, hp: 90, enemies: [imp] }))
    trace.snap(api, world, snap({ t: 500, hp: 90, shots: [{ x: 0, y: 0, vx: 0, vy: 0 }] }))
    trace.snap(api, world, snap({ t: 750, hp: 80 }))
    trace.snap(api, world, snap({ t: 1000, hp: 70, x: centre(3) }))
    trace.snap(api, world, snap({ t: 1250, hp: 95 }))
    trace.snap(api, world, snap({ t: 1500, hp: 50, lvl: "1" }))
    assert.deepEqual(trace.entries.map((e) => (e.k === "hit" ? `${e.source}:${e.by}:${e.amount}` : e.k)), ["bite:imp:10", "shot:fireball:10", "lava:lava:10", "heal"])
    trace.pick(pick(1250 + TRACE_MS) as Extract<TraceEntry, { k: "pick" }>)
    assert.deepEqual(trace.entries.map((e) => e.k), ["heal", "pick"], "старше 15 с отброшено")
})

test("трасса: смертельный удар между снимками дописывается по сообщению о смерти", () => {
    const world = api.createWorld(["#######", "#S.L..#", "#######"], 0)
    const knight = { i: 0, kind: api.ENEMY_KNIGHT, x: centre(1) + 400, y: centre(1), hp: 6, sees: true }
    const cases: Array<[Partial<Snapshot>, string]> = [
        [{ enemies: [knight] }, "bite:knight"],
        [{ shots: [{ x: centre(2), y: centre(1), vx: -2000, vy: 0 }] }, "shot:fireball"],
        [{ x: centre(3) }, "lava:lava"],
    ]
    for (const [over, want] of cases) {
        const trace = new Trace()
        trace.dead(api, world, snap({ t: 900, hp: 5, ...over }))
        const e = trace.entries[0]
        assert.ok(e.k === "hit")
        assert.deepEqual([`${e.source}:${e.by}`, e.amount, e.hp, e.t], [want, 5, 0, 901])
        assert.equal(postMortem(trace, "0:7", "0")?.startHp, 5, "смерть с одного удара тоже разбирается")
    }
    const trace = new Trace()
    trace.dead(api, world, null)
    trace.dead(api, world, snap({ hp: 0 }))
    assert.equal(trace.entries.length, 0)
})

test("разбор смерти: серия от лечения или паузы 3 с, главная причина, уроки в силе, аптечка рядом", () => {
    const trace = new Trace()
    trace.entries = [
        hit(1000, 10, "imp", [1, 1]),
        { k: "heal", t: 2000, hp: 90, cell: [2, 1] },
        pick(4000, { medkit: 5 }),
        hit(5000, 30, "knight", [4, 1], "bite", 60),
        pick(5500, { lesson: "L1" }),
        hit(6000, 30, "knight", [5, 1], "bite", 30),
        hit(6500, 30, "fireball", [5, 1], "shot", 0),
    ]
    const d = postMortem(trace, "0:7", "0")
    assert.ok(d)
    assert.deepEqual([d.start, d.startHp, d.cause, d.by, d.end], [[4, 1], 90, "bite", "knight", [5, 1]])
    assert.equal(d.hits.length, 3, "удар до лечения — другая серия")
    assert.deepEqual(d.active, ["L1"])
    assert.equal(d.medkitNear, true)

    trace.entries = [hit(1000, 10, "imp", [1, 1]), hit(1000 + SAFE_MS, 40, "imp", [6, 1])]
    assert.deepEqual(postMortem(trace, "0:7", "0")?.start, [6, 1], "пауза 3 с обрывает серию")
    trace.entries = [pick(100)]
    assert.equal(postMortem(trace, "0:7", "0"), null, "без ударов разбирать нечего")
})

test("правило без LLM: шар, босс, аптечка рядом, укусы; лава без урока", () => {
    assert.deepEqual(classify(death({ cause: "shot", by: "fireball" })), { scope: "zone", zone: { x: 2, y: 1, r: 2 }, when: ["fireball_near"], do: "dodge", why: "fireball hits from 50 HP" })
    assert.deepEqual(classify(death({ by: "boss" }))?.when, ["boss_visible", "health_below_60"])
    assert.equal(classify(death({ by: "boss" }))?.scope, "global")
    assert.deepEqual(classify(death({ medkitNear: true })), { scope: "global", zone: null, when: ["health_below_60"], do: "heal", why: "died with a medkit nearby" })
    assert.deepEqual(classify(death()), { scope: "zone", zone: { x: 2, y: 1, r: 2 }, when: ["biter_near", "health_below_60"], do: "retreat", why: "imp bit to death from 50 HP" })
    assert.equal(classify(death({ cause: "lava", by: "lava" })), null)
})

test("проверка урока от LLM: тупиковые действия, словарь, зона, длина why; правка и пустой ответ", () => {
    const world = api.createWorld(["#####", "#S..#", "#####"], 0)
    assert.deepEqual(validateDraft(api, world, draft()), draft())
    for (const bad of ["advance", "wait", "open"]) assert.match(String(validateDraft(api, world, draft({ do: bad as Draft["do"] }))), /not allowed/, bad)
    assert.match(String(validateDraft(api, world, { ...draft(), when: ["in_zone"] })), /unknown condition/)
    assert.match(String(validateDraft(api, world, draft({ when: [] }))), /empty/)
    assert.match(String(validateDraft(api, world, draft({ zone: { x: 9, y: 1, r: 1 } }))), /off the map/)
    assert.match(String(validateDraft(api, world, draft({ zone: { x: 0, y: 1, r: 1 } }))), /wall/)
    assert.match(String(validateDraft(api, world, draft({ zone: { x: 2, y: 1, r: 5 } }))), /radius/)
    assert.match(String(validateDraft(api, world, draft({ zone: null }))), /integer/)
    assert.match(String(validateDraft(api, world, draft({ why: "x".repeat(61) }))), /characters/)
    assert.deepEqual(validateDraft(api, world, draft({ scope: "global", zone: { x: 9, y: 9, r: 9 } })), draft({ scope: "global", zone: null }), "у общего зона не нужна")

    const existing = [lesson({ id: "L3" })]
    assert.deepEqual(parseVerdict(api, world, { verdict: "none" }, existing), { kind: "none" })
    assert.deepEqual(parseVerdict(api, world, { verdict: "edit", edit_id: "L3", lesson: draft() }, existing), { kind: "edit", id: "L3", draft: draft() })
    assert.match(String(parseVerdict(api, world, { verdict: "edit", edit_id: "L9", lesson: draft() }, existing)), /no lesson L9/)
    assert.match(String(parseVerdict(api, world, { verdict: "maybe" }, existing)), /bad verdict/)
})

test("хранилище: слияние, лимиты 3 по уровню и 3 общих, вытеснение, провал, победы, файл", () => {
    const dir = tmpDir()
    const file = path.join(dir, "lessons.json")
    let t = 0
    const store = new LessonStore(file, () => ++t)
    const a = store.add("0:7", draft(), "llm")
    assert.equal(store.add("0:7", draft({ zone: { x: 3, y: 1, r: 1 }, do: "attack" }), "rule"), a, "та же зона и условие")
    assert.deepEqual([a.deaths, a.do, store.lessons.length], [2, "attack", 1])
    store.add("0:7", draft({ when: ["fireball_near"], do: "dodge" }), "rule")
    store.add("0:7", draft({ when: ["shooter_visible"], do: "attack" }), "rule")
    store.win([a.id])
    store.win([a.id])
    const fourth = store.add("0:7", draft({ when: ["health_below_40"], do: "heal" }), "rule")
    assert.equal(store.forKey("0:7").length, ZONE_LIMIT)
    assert.ok(store.get(a.id) && store.get(fourth.id), "вытеснен худший по wins - deaths, не урок с победой и не новый")
    assert.equal(store.lessons.some((l) => l.when[0] === "fireball_near"), false, "при равенстве уходит самый старый")
    for (const w of ["biter_near", "fireball_near", "shooter_visible", "boss_visible"] as const) store.add("5:1", draft({ scope: "global", zone: null, when: [w] }), "rule")
    assert.equal(store.lessons.filter((l) => l.scope === "global").length, GLOBAL_LIMIT)
    assert.equal(store.forKey("9:9").length, GLOBAL_LIMIT, "общие видны на любом уровне")
    assert.equal(store.forKey("0:7").length, ZONE_LIMIT + GLOBAL_LIMIT)

    assert.equal(store.fail(fourth.id), true)
    assert.equal(store.get(fourth.id)?.failed, 1)
    store.fail(fourth.id)
    assert.equal(store.get(fourth.id), undefined, "два провала — урок удалён")
    store.save()
    assert.deepEqual(fs.readdirSync(dir), ["lessons.json"], "временный файл переименован")
    const again = new LessonStore(file)
    assert.deepEqual(again.lessons, store.lessons)
    assert.equal(again.get(a.id)?.wins, 2)
    const next = again.add("1:2", draft(), "rule")
    assert.ok(!store.lessons.some((l) => l.id === next.id), "id не повторяются после перезагрузки")
    assert.notEqual(lessonsFile(dir, "console"), lessonsFile(dir, "sim"), "у приставки и эмулятора разные файлы")
})

// Corridor with a knight 1.5 cells ahead of the player, awake and looking.
function knightAhead(hp = 100): World {
    const world = api.createWorld(["############", "#S........X#", "############"], 0)
    world.health = hp
    world.enemies.push(new api.Enemy(api.ENEMY_KNIGHT, world.x + 1500, world.y))
    Object.assign(world.enemies[0], { awake: true, sees: true, hunting: true })
    return world
}

test("урок в силе: зона и условие; общий везде; зональный важнее; бессмысленное действие молчит", () => {
    const world = knightAhead()
    const sit = situate(api, world)
    const here = lesson({ zone: { x: sit.at[0], y: sit.at[1], r: 1 } })
    assert.deepEqual(activeLesson(api, world, sit, [here], "0:7"), { lesson: here, action: "retreat" })
    assert.equal(activeLesson(api, world, sit, [here], "3:3"), null, "чужая карта")
    assert.equal(activeLesson(api, world, sit, [lesson({ zone: { x: 9, y: 1, r: 1 } })], "0:7"), null, "вне зоны")
    assert.equal(activeLesson(api, world, sit, [lesson({ zone: here.zone, when: ["biter_near", "health_below_60"] })], "0:7"), null, "условие не выполнено")
    const global = lesson({ id: "G1", scope: "global", key: "global", zone: null, do: "attack" })
    assert.deepEqual(activeLesson(api, world, sit, [global], "3:3"), { lesson: global, action: "attack" })
    assert.equal(activeLesson(api, world, sit, [global, here], "0:7")?.lesson, here)
    const calm = api.createWorld(["############", "#S........X#", "############"], 0)
    calm.health = 30
    const calmSit = situate(api, calm)
    assert.equal(activeLesson(api, calm, calmSit, [lesson({ id: "G2", scope: "global", key: "global", zone: null, when: ["health_below_40"], do: "retreat" })], "0:7"), null, "отступать не от кого")
    assert.equal(activeLesson(api, calm, calmSit, [lesson({ id: "G3", scope: "global", key: "global", zone: null, when: ["health_below_40"], do: "dodge" })], "0:7"), null, "шара нет")
})

test("урок для Jev: поле lesson в конце, без урока поля нет; критерий только у действия урока", () => {
    const world = knightAhead(50)
    const sit = situate(api, world)
    const text = lessonText({ lesson: lesson({ when: ["biter_near", "health_below_60"] }), action: "retreat" })
    assert.equal(text, "died here before: biter_near + health_below_60, retreat")
    const keys = Object.keys(facts(api, world, sit, [], "new goal", { lesson: text }))
    assert.equal(keys.at(-1), "lesson")
    assert.equal(keys.at(-2), "weapon_state")
    assert.equal("lesson" in facts(api, world, sit, []), false)
    const before = Object.keys(facts(api, world, sit, [], "new goal", { lesson: text }, "before_weapon_state"))
    assert.deepEqual(before.slice(-2), ["lesson", "weapon_state"])
    assert.equal(lessonText({ lesson: lesson({ scope: "global", zone: null }), action: "attack" }), "died like this before: biter_near, attack")

    assert.equal(questionsFor(null), ACTION_QUESTIONS)
    const q = questionsFor("retreat").action.criteria as Record<string, string>
    const base = ACTION_QUESTIONS.action.criteria as Record<string, string>
    assert.equal(q.retreat, base.retreat + LESSON_CRITERION)
    assert.equal(q.attack, base.attack)
    assert.equal(base.retreat.includes(LESSON_CRITERION), false, "общие критерии не тронуты")
})

test("makeJev: с уроком критерий его действия уходит в запросе, без урока — обычный", async () => {
    const bodies: Array<Record<string, any>> = []
    const fakeFetch = (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ answers: { action: { choice: "retreat", confidence: 0.9 } } }), { status: 200 })
    }) as typeof fetch
    const jev = makeJev({ key: "k", model: "m", fetch: fakeFetch })
    await jev({ a: 1 }, { lesson: "heal" })
    await jev({ a: 1 })
    assert.ok(bodies[0].questions.action.criteria.heal.endsWith(LESSON_CRITERION))
    assert.equal(bodies[1].questions.action.criteria.heal.includes(LESSON_CRITERION), false)
})

test("подмена уроком: только мирный выбор, сторожевой таймер важнее; метка с !", () => {
    for (const p of ["advance", "wait", "open", "ammo", "weapon"] as Action[]) assert.equal(applyLesson("retreat", p, false), "retreat", p)
    for (const p of ["attack", "dodge_left", "dodge_right", "heal", "retreat"] as Action[]) assert.equal(applyLesson("retreat", p, false), p, p)
    assert.equal(applyLesson("retreat", "advance", true), "advance", "watchdog толкает advance, урок не мешает")
    assert.equal(applyLesson(null, "advance", false), "advance")
    assert.equal(lessonLabel("RETREAT"), "RETREAT!")
    assert.equal(lessonLabel("DODGE L"), "DODGE L!")
})

const verdictBody = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), { status: 200 })

test("reflect: JSON-схема в запросе, ключ только в заголовке; мусор, http-ошибка, таймаут и нет ключа — исключение", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const ok = (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return verdictBody({ verdict: "none", edit_id: "", lesson: draft() })
    }) as typeof fetch
    const raw = await makeReflect({ key: "secret-k", model: "x/y", fetch: ok })(death(), [lesson({})], ["L1"])
    assert.deepEqual(raw, { verdict: "none", edit_id: "", lesson: draft() })
    const body = JSON.parse(String(calls[0].init.body))
    assert.equal(body.model, "x/y")
    assert.equal(body.response_format.type, "json_schema")
    assert.equal(body.response_format.json_schema.strict, true)
    assert.deepEqual(body.response_format.json_schema.schema.properties.lesson.properties.do.enum, ["attack", "retreat", "dodge", "heal", "weapon", "ammo"])
    assert.match(body.messages[1].content, /"failed":true/)
    assert.ok(!String(calls[0].init.body).includes("secret-k"))
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer secret-k")

    await assert.rejects(makeReflect({ key: "k", fetch: (async () => verdictBody("not json")) as typeof fetch })(death(), [], []))
    await assert.rejects(makeReflect({ key: "k", fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch })(death(), [], []), /http 500/)
    const hang = ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch
    await assert.rejects(makeReflect({ key: "k", fetch: hang, timeoutMs: 20 })(death(), [], []), /timeout 20 ms/)
    await assert.rejects(makeReflect({ key: "", fetch: ok })(death(), [], []), /no API key/)
})

test("learn: LLM пишет урок, мусор — правило, none — без урока, провал отмечается, правка по id", async () => {
    const world = api.createWorld(["######", "#S...#", "######"], 0)
    const store = new LessonStore(null)
    const answer = (v: unknown): ReflectFn => async () => v
    const llm = await learn(api, world, store, death(), answer({ verdict: "new", edit_id: "", lesson: draft({ do: "attack" }) }))
    assert.deepEqual([llm.source, llm.lesson?.source, llm.lesson?.do, llm.note], ["llm", "llm", "attack", ""])
    const junk = await learn(api, world, store, death({ start: [4, 1] }), answer({ verdict: "new", lesson: draft({ do: "wait" as Draft["do"] }) }))
    assert.deepEqual([junk.source, junk.lesson?.do], ["rule", "retreat"])
    assert.match(junk.note, /not allowed/)
    const thrown = await learn(api, world, store, death({ cause: "shot", by: "fireball" }), async () => { throw new Error("http 502") })
    assert.deepEqual([thrown.source, thrown.lesson?.do, thrown.note], ["rule", "dodge", "http 502"])
    const none = await learn(api, world, store, death(), answer({ verdict: "none" }))
    assert.deepEqual([none.source, none.lesson, none.verdict], ["none", null, "none"])
    assert.equal((await learn(api, world, store, death({ cause: "lava", by: "lava" }), null)).source, "none")

    const id = llm.lesson?.id as string
    const again = await learn(api, world, store, death({ active: [id] }), answer({ verdict: "edit", edit_id: id, lesson: draft({ do: "heal", why: "heal first" }) }))
    assert.deepEqual(again.failed, [id])
    assert.deepEqual([store.get(id)?.failed, store.get(id)?.do, again.verdict], [1, "heal", "edit"])
    const fireball = await learn(api, world, store, death({ active: [thrown.lesson?.id as string] }), answer({ verdict: "none" }))
    assert.deepEqual(fireball.failed, [], "урок про шар не проваливается на укусе")
    await learn(api, world, store, death({ active: [id] }), answer({ verdict: "none" }))
    assert.equal(store.get(id), undefined, "второй провал удаляет урок")
})

// HANGAR as the console runs it, every enemy gone.
function hangar(run: number): { world: World; link: any } {
    const world = api.enterLevel(api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL))
    for (const e of world.enemies) e.dead = true
    const link = new api.AiLink(run)
    api.aiEnterLevel(link, api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL), world)
    return { world, link }
}

class FakeTransport {
    private listener: (line: string) => void = () => {}
    onLine(l: (line: string) => void): void {
        this.listener = l
    }
    async writeBox(): Promise<void> {}
    reset(): void {}
    send(lines: string[]): void {
        for (const l of lines) this.listener(l)
    }
}

test("мост: общий урок из файла срабатывает на другом уровне; без уроков поля и подмены нет", async () => {
    const file = path.join(tmpDir(), "lessons-sim.json")
    const first = new LessonStore(file)
    first.add("4:99", draft({ scope: "global", zone: null, when: ["health_below_60"], do: "heal", why: "died with a medkit nearby" }), "llm")
    first.save()
    const run = async (lessons: boolean) => {
        const { world, link } = hangar(21)
        world.health = 50
        world.x = 5 * api.FP + api.FP / 2
        const transport = new FakeTransport()
        const seen: Array<{ state: Record<string, unknown>; hint?: JevHint }> = []
        const jev: JevFn = async (state, hint) => {
            seen.push({ state, hint })
            return { action: "advance", confidence: 0.5, danger: null, cost: 0, latencyMs: 0, error: "" }
        }
        const log: LogRecord[] = []
        const bridge = new Bridge(api, transport, jev, (r) => log.push(r), () => link.clock, 1, { lessons: lessons ? { store: new LessonStore(file), reflect: null } : null })
        transport.send(api.aiSnapshot(link, world, api.DIFF_NORMAL) as string[])
        await bridge.idle()
        return { seen, bridge, rec: log.find((r) => r.kind === "decision") }
    }
    const on = await run(true)
    assert.equal(on.seen[0].state.lesson, "died like this before: health_below_60, heal")
    assert.deepEqual(on.seen[0].hint, { lesson: "heal" })
    assert.deepEqual([on.rec?.decision?.action, on.rec?.decision?.label, on.rec?.override, on.rec?.lesson], ["heal", "HEAL!", true, "L1"])
    assert.deepEqual([on.bridge.stats.lessonActive, on.bridge.stats.lessonOverride, on.bridge.stats.forcedHeal], [1, 1, 0])
    const off = await run(false)
    assert.equal("lesson" in off.seen[0].state, false)
    assert.equal(off.seen[0].hint, undefined)
    assert.deepEqual([off.rec?.decision?.label, off.bridge.stats.lessonOverride], ["ADVANCE", 0])
})

test("уроки по умолчанию выключены; --lessons, файл или сброс включают", () => {
    assert.equal(lessonsOn({ on: false, reset: false }), false)
    assert.equal(lessonsOn({ on: true, reset: false }), true)
    assert.equal(lessonsOn({ on: false, file: "x.json", reset: false }), true)
    assert.equal(lessonsOn({ on: false, reset: true }), true)
})

test("мост из командной строки: без флага уроков нет, с --lessons-file — файл и строка в выводе", () => {
    const main = fileURLToPath(new URL("./main.ts", import.meta.url))
    const file = path.join(tmpDir(), "lessons.json")
    const run = (...flags: string[]) => {
        const r = spawnSync(process.execPath, ["--experimental-strip-types", main, "--sim", "HANGAR", "--fake", "--fast", "--quiet", ...flags], { encoding: "utf8", env: { ...process.env, OPENROUTER_KEY: "" } })
        assert.equal(r.status, 0, r.stderr)
        return r.stdout
    }
    const off = run()
    assert.doesNotMatch(off, /^lessons/m)
    assert.match(off, /^HANGAR: won 1\/1/m)
    const on = run("--lessons-file", file, "--lessons-reset")
    assert.match(on, /^lessons .*lessons\.json: 0 kept, written by rule$/m)
    assert.match(on, /^lessons kept: 0$/m)
    assert.ok(fs.existsSync(file))
})

test("--sim D1-D5: глубины бесконечного режима, кампания и ошибки в записи", () => {
    const row = (spec: string) => simLevels(api, spec).map((l) => [l.name, l.index, l.endless])
    assert.deepEqual(row("D2-D4"), [["D2", 1, true], ["D3", 2, true], ["D4", 3, true]])
    assert.deepEqual(row("d5"), [["D5", 4, true]])
    assert.deepEqual(row("D1-5"), [["D1", 0, true], ["D2", 1, true], ["D3", 2, true], ["D4", 3, true], ["D5", 4, true]])
    assert.deepEqual(row("arena"), [["ARENA", levelIndex(api, "ARENA"), false]])
    assert.equal(simLevels(api, "ALL").length, api.LEVELS.length)
    assert.throws(() => simLevels(api, "D0"), /no depths/)
    assert.throws(() => simLevels(api, "D4-D2"), /no depths/)
    assert.throws(() => simLevels(api, "NOWHERE"), /no level/)
})

test("мост на глубине D2: общий урок с уровня кампании в силе и подменяет advance, как только аптечка на виду", async () => {
    const [d2] = simLevels(api, "D2")
    const sim = new SimConsole(d2.index, api.DIFF_EASY, 5, false, d2.endless)
    sim.world.health = 50
    const store = new LessonStore(null)
    store.add(`${levelIndex(api, "ARENA")}:99`, draft({ scope: "global", zone: null, when: ["health_below_60"], do: "heal", why: "died with a medkit nearby" }), "llm")
    const log: LogRecord[] = []
    const jev: JevFn = async () => ({ action: "advance", confidence: 0.5, danger: null, cost: 0, latencyMs: 0, error: "" })
    const bridge = new Bridge(sim.api, sim, jev, (r) => log.push(r), () => sim.clock, 100, { lessons: { store, reflect: null } })
    const medkitSeen = (r: LogRecord) => r.kind === "decision" && r.state?.medkit != null
    while (!log.some(medkitSeen) && sim.clock < 60000) {
        sim.world.health = 50
        sim.step()
        await new Promise((resolve) => setImmediate(resolve))
    }
    const at = log.findIndex(medkitSeen)
    assert.ok(at >= 0, "аптечка попалась на глаза за минуту")
    const rec = log[at]
    assert.deepEqual([sim.session.kind, sim.session.level], [api.RUN_ENDLESS, 1])
    assert.deepEqual([rec?.decision?.action, rec?.decision?.label, rec?.override, rec?.lesson], ["heal", "HEAL!", true, "L1"])
    assert.ok(bridge.stats.lessonActive >= 1)
    assert.ok(log.slice(0, at).every((r) => r.kind !== "decision" || r.decision?.action !== "heal"), "к невиданной аптечке урок не ведёт")
})

test("сценарий: смерть на ARENA даёт урок у начала серии, на следующих попытках он в силе и подменяет advance", async () => {
    const sim = new SimConsole(levelIndex(api, "ARENA"), api.DIFF_NORMAL, 5, true)
    sim.world.health = 5
    const deaths: Death[] = []
    const reflect: ReflectFn = async (d) => {
        deaths.push(d)
        const shot = d.cause === "shot"
        return { verdict: "new", edit_id: "", lesson: { scope: "zone", zone: { x: d.start[0], y: d.start[1], r: 4 }, when: [shot ? "fireball_near" : "biter_near"], do: shot ? "dodge" : "attack", why: "test" } }
    }
    const store = new LessonStore(null)
    const states: Array<Record<string, unknown>> = []
    const log: LogRecord[] = []
    const pending: Array<{ at: number; done: () => void }> = []
    const jev: JevFn = async (state) => {
        states.push(state)
        await new Promise<void>((done) => pending.push({ at: sim.clock + 500, done }))
        return { action: "advance", confidence: 0.5, danger: null, cost: 0, latencyMs: 500, error: "" }
    }
    const bridge = new Bridge(sim.api, sim, jev, (r) => log.push(r), () => sim.clock, 100, { lessons: { store, reflect } })
    while (sim.deaths < 3 && sim.cleared === 0 && !sim.result && sim.clock < 600000) {
        sim.step()
        for (const p of pending.filter((p) => p.at <= sim.clock)) {
            pending.splice(pending.indexOf(p), 1)
            p.done()
        }
        await new Promise((resolve) => setImmediate(resolve))
    }
    await bridge.lessonsIdle()
    assert.equal(deaths.length, 3, "каждая смерть разобрана")
    assert.equal(deaths[0].startHp, 5, "первая смерть — с одного удара при 5 HP")
    const lessons = log.filter((r) => r.kind === "lesson")
    const firstLesson = lessons[0].learned?.lesson
    assert.equal(lessons[0].learned?.source, "llm")
    assert.deepEqual([firstLesson?.zone?.x, firstLesson?.zone?.y], deaths[0].start, "зона в начале серии урона")
    assert.ok(states.some((s) => typeof s.lesson === "string"), "Jev видит урок")
    assert.ok(bridge.stats.lessonOverride > 0)
    assert.ok(log.some((r) => r.kind === "decision" && r.override && r.decision?.label.endsWith("!")))
    assert.ok(lessons.some((r) => (r.learned?.failed.length ?? 0) > 0), "смерть с тем же уроком в силе — провал")
    assert.equal(bridge.stats.lessonsLlm, deaths.length)
})

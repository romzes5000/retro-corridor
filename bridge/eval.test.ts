import assert from "node:assert/strict"
import test from "node:test"
import { loadLogic } from "../load-logic.ts"
import { evaluate, formatReport } from "./eval.ts"
import { fakeJev } from "./fake-jev.ts"
import type { JevFn } from "./jev.ts"
import { addStats, Bridge, emptyStats } from "./loop.ts"
import { judge, SCENARIOS, scenarioState, scenarioWorld, type Scenario } from "./scenarios.ts"
import { SimConsole } from "./sim.ts"

const api = loadLogic()

test("контрольные ситуации: разрешённые и запрещённые выборы", () => {
    const heal: Scenario = { name: "x", map: [], ang: 0, allowed: ["heal"] }
    assert.equal(judge(heal, "heal"), true)
    assert.equal(judge(heal, "advance"), false)
    const noWait: Scenario = { name: "y", map: [], ang: 0, forbidden: ["wait", "retreat"] }
    assert.equal(judge(noWait, "advance"), true)
    assert.equal(judge(noWait, "retreat"), false)
    const both: Scenario = { name: "z", map: [], ang: 0, allowed: ["open", "advance"], forbidden: ["advance"] }
    assert.equal(judge(both, "advance"), false)
})

test("контрольные ситуации: каждая собирается в мир и факты без русского текста", () => {
    for (const sc of SCENARIOS) {
        const world = scenarioWorld(api, sc)
        assert.ok(world.w > 0, sc.name)
        const state = scenarioState(api, sc)
        assert.equal(typeof state.goal, "string", sc.name)
        assert.doesNotMatch(JSON.stringify(state), /[а-яё]/i, sc.name)
    }
    const low = SCENARIOS.find((s) => /low hp, medkit/.test(s.name)) as Scenario
    assert.equal(scenarioWorld(api, low).health, 25)
})

test("eval: доля попаданий по ситуациям, ошибка Jev не засчитывается", async () => {
    const report = await evaluate(api, fakeJev, 2)
    assert.equal(report.scores.length, SCENARIOS.length)
    for (const s of report.scores) {
        assert.equal(s.runs, 2)
        assert.equal(Object.values(s.picks).reduce((a, b) => a + b, 0), 2)
    }
    const broken: JevFn = async () => ({ action: "wait", confidence: 0, danger: null, cost: 0.001, latencyMs: 1500, error: "timeout" })
    const bad = await evaluate(api, broken, 1, [{ name: "any", map: SCENARIOS[1].map, ang: 0 }])
    assert.deepEqual([bad.scores[0].hits, bad.errors, bad.latencies, bad.cost], [0, 1, [1500], 0.001])
    assert.match(formatReport(bad).at(-1) ?? "", /^total 0\/1, latency median 1500 ms/)
})

test("статистика моста: выборы по действиям и подобранные предметы по видам, сумма по прогонам", async () => {
    const sim = new SimConsole(0, api.DIFF_NORMAL)
    const bridge = new Bridge(sim.api, sim, fakeJev, () => {}, () => sim.clock, 7)
    while (!sim.result && sim.clock < 120000) {
        sim.step()
        await bridge.idle()
    }
    assert.equal(sim.result, "won")
    const picked = Object.values(bridge.stats.pickups).reduce((a, b) => a + b, 0)
    assert.equal(picked, sim.world.items.filter((it) => it.taken).length, JSON.stringify(bridge.stats.pickups))
    assert.ok((bridge.stats.picks.advance ?? 0) > 0)
    const total = emptyStats()
    addStats(total, bridge.stats)
    addStats(total, bridge.stats)
    assert.equal(total.decisions, 2 * bridge.stats.decisions)
    assert.equal(total.picks.advance, 2 * (bridge.stats.picks.advance ?? 0))
})

test("эмулятор: простой без врагов в поле зрения и урон по источникам", () => {
    const sim = new SimConsole(0, api.DIFF_NORMAL)
    sim.world = api.createWorld(["#######", "#S..L.#", "#######"], 0)
    sim.world.difficulty = api.DIFF_NORMAL
    for (let i = 0; i < 25; i++) sim.step()
    assert.equal(sim.idleMs, 500, "без команд игрок стоит — простой")
    assert.equal(sim.longestIdleMs, 500)

    sim.world.x = 4 * 1024 + 512
    for (let i = 0; i < 20; i++) sim.step()
    assert.ok(sim.damage.lava > 0, "стоит в лаве")
    assert.equal(sim.damage.shot + sim.damage.bite, 0)

    sim.world.x = 2 * 1024 + 512
    sim.world.shots.push(new api.Shot(sim.world.x + 300, sim.world.y, -2000, 0))
    sim.step()
    assert.ok(sim.damage.shot > 0, "попал шар")
})

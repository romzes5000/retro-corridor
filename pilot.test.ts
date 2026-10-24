import assert from "node:assert/strict"
import test from "node:test"
import { boxWrites, CMD, encodeBox, nextSeq, type BoxCommand } from "./bridge/mailbox.ts"
import { Parser } from "./bridge/protocol.ts"
import { loadLogic, type World } from "./load-logic.ts"

const c = loadLogic()
const DT = 20

class Box {
    mem = encodeBox({ seq: 0, obs: 0, cmd: 0, a: 0, b: 0, conf: 0, latency: 0, label: "" })
    seq = 0
    read = (i: number) => this.mem[i]
    send(cmd: Omit<BoxCommand, "seq">): number {
        this.seq = nextSeq(this.seq)
        const box = encodeBox({ ...cmd, seq: this.seq })
        for (const w of boxWrites(box)) this.mem.set(w.data, w.offset)
        return this.seq
    }
}

const cmd = (name: keyof typeof CMD, obs: number, a = 0, b = 0): Omit<BoxCommand, "seq"> =>
    ({ obs, cmd: CMD[name], a, b, conf: 84, latency: 230, label: name })

function aiLevel(): { session: any; world: World; link: any; box: Box } {
    const session = c.startAtLevel(c.DIFF_NORMAL, 0)
    session.ai = true
    const world = c.enterLevel(session)
    const link = new c.AiLink(7)
    c.aiEnterLevel(link, session, world)
    return { session, world, link, box: new Box() }
}

function walk(world: World, ms: number): void {
    const input = new c.Input()
    input.turn = 1
    input.fwd = 1
    for (let t = 0; t < ms; t += DT) c.update(world, input, DT)
}

test("пауза: A на пункте пилота отдаёт PACT_PILOT, кто бы ни играл; курсор идёт через пять пунктов", () => {
    for (const ai of [true, false]) {
        const pause = new c.Pause(true, c.DIFF_NORMAL, ai)
        const pad = new c.Pad()
        pad.tapDirs = c.DIR_UP
        c.pauseStep(pause, pad)
        pad.tapDirs = c.DIR_UP
        c.pauseStep(pause, pad)
        assert.equal(pause.index, c.PAUSE_PILOT, "вверх от RESUME: QUIT, затем пилот")
        pad.tapDirs = 0
        pad.tapA = true
        assert.equal(c.pauseStep(pause, pad), c.PACT_PILOT)
        assert.equal(pause.ai, ai, "пункт не переключается на месте: передачу делает main.ts")
    }
})

test("TAKE OVER: строка в консоль — AI HUMAN, мост читает её как перехват", () => {
    assert.equal(c.AI_HUMAN, "AI HUMAN")
    assert.deepEqual(new Parser().line(c.AI_HUMAN), { kind: "human" })
})

test("GIVE TO AI: команда, спланированная до перехвата, не исполняется; ИИ продолжает с места игрока, ответ на новый снимок исполняется", () => {
    const { session, world, link, box } = aiLevel()
    for (let t = 0; t < 400; t += DT) c.update(world, c.aiFrame(link, world, DT, box.read), DT)
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    const before = link.obs
    box.send(cmd("goto", before, 3, 1))
    c.aiFrame(link, world, DT, box.read)
    assert.equal(link.exec.cmd, c.AI_GOTO, "ИИ шёл по маршруту, когда игрок взял управление")
    const clock = link.clock
    walk(world, 1500)
    box.send(cmd("wait", before))

    c.aiHandBack(link, session)
    assert.equal(link.clock, clock, "часы связи стояли, пока играл человек")
    assert.equal(link.exec.cmd, c.AI_NONE, "маршрут ИИ до перехвата сброшен")
    assert.equal(c.aiStatus(link), "JEV", "старая метка Jev не висит")
    assert.equal(c.aiSnapshotDue(link), true, "свежий снимок уходит сразу, не через 250 мс")
    link.snapDue = link.clock
    c.aiFrame(link, world, DT, box.read)
    assert.equal(link.exec.cmd, c.AI_NONE, "ответ на снимок до перехвата, пришедший в ящик, не исполняется")
    assert.equal(link.stale, true)
    const lines: string[] = c.aiSnapshot(link, world, c.DIFF_NORMAL)
    assert.ok(link.obs > before + 1)
    assert.match(lines[1], new RegExp(`^AI P ${world.x} ${world.y} ${world.ang} ${world.health} ${world.ammo} `), "снимок с места, здоровья и патронов игрока")
    assert.match(lines.at(-2) ?? "", / stale$/, "мост видит, что старая команда отброшена")

    box.send(cmd("wait", link.obs))
    c.aiFrame(link, world, DT, box.read)
    assert.equal(link.exec.cmd, c.AI_WAIT, "ответ на снимок после передачи исполняется")
    assert.equal(link.stale, false)
})

test("рекорды: уровень, начатый человеком и отданный ИИ, рекорд не ставит; целиком свой — ставит", () => {
    const rec = new c.Records()
    const human = c.startSession(c.RUN_ENDLESS, c.DIFF_NORMAL)
    human.level = 4
    const link = new c.AiLink(7)
    c.aiEnterLevel(link, human, c.enterLevel(human))
    c.aiHandBack(link, human)
    assert.equal(human.ai, true)
    assert.equal(c.noteRun(rec, human), false)
    assert.equal(rec.depth, 0)

    const own = c.startSession(c.RUN_ENDLESS, c.DIFF_NORMAL)
    own.level = 4
    assert.equal(c.noteRun(rec, own), true)
    assert.equal(rec.depth, 4)
})

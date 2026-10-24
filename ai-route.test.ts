// Console side of the smoother AI: GOTO routes from the snapshot cell, early turns, backpedal
// with fire, the lava ban, reflexes and the red JEV line.
import assert from "node:assert/strict"
import test from "node:test"
import { boxWrites, CMD, encodeBox, nextSeq, type BoxCommand } from "./bridge/mailbox.ts"
import { FakeImage } from "./fake-image.ts"
import { loadGame, type World } from "./load-logic.ts"

const game = loadGame()
const c = game.corridor
const r = game.corridorRender
const DT = 20

class Box {
    mem = encodeBox({ seq: 0, obs: 0, cmd: 0, a: 0, b: 0, conf: 0, latency: 0, label: "" })
    seq = 0
    read = (i: number) => this.mem[i]
    send(cmd: Omit<BoxCommand, "seq">): void {
        this.seq = nextSeq(this.seq)
        for (const w of boxWrites(encodeBox({ ...cmd, seq: this.seq }))) this.mem.set(w.data, w.offset)
    }
}

function cmd(name: keyof typeof CMD, obs: number, a = 0, b = 0, route: Array<[number, number]> = []): Omit<BoxCommand, "seq"> {
    return { obs, cmd: CMD[name], a, b, conf: 80, latency: 500, label: name, route }
}

function linkFor(world: World): any {
    const link = new c.AiLink(7)
    c.aiEnterLevel(link, c.startSession(c.RUN_CAMPAIGN, c.DIFF_NORMAL), world)
    return link
}

interface Run {
    ms: number
    longestStill: number
    lava: boolean
    shots: number
}

// Plays frames until the command is over (or `ms` runs out) and reports how it went.
function play(link: any, world: World, box: Box, ms: number, keepGoing = false): Run {
    const run: Run = { ms: 0, longestStill: 0, lava: false, shots: 0 }
    let still = 0
    while (run.ms < ms) {
        const x = world.x
        const y = world.y
        c.update(world, c.aiFrame(link, world, DT, box.read), DT)
        run.ms += DT
        if (world.events.includes("shoot") || world.events.includes("blast")) run.shots++
        if (c.lavaAt(world, world.x >> 10, world.y >> 10)) run.lava = true
        still = world.x === x && world.y === y ? still + DT : 0
        if (link.exec.result === c.AI_RUNNING) run.longestStill = Math.max(run.longestStill, still)
        if (!keepGoing && link.exec.result !== c.AI_RUNNING) break
    }
    return run
}

const cell = (world: World) => [world.x >> 10, world.y >> 10]
const L_CORRIDOR = ["#######", "#S..###", "###.###", "###...#", "#######"]

test("ящик: точки маршрута в байтах 26-29 и danger в байте 30; пустые точки — нули", () => {
    const box = encodeBox({ seq: 3, obs: 1, cmd: CMD.goto, a: 3, b: 1, conf: 50, latency: 400, label: "advance", route: [[3, 3], [5, 3]], danger: 0.72 })
    assert.deepEqual([...box.slice(26, 31)], [4, 4, 6, 4, 72])
    const got = c.decodeAiBox((i: number) => box[i])
    assert.deepEqual([...got.route], [3, 3, 5, 3])
    assert.equal(got.danger, 72)
    const plain = encodeBox({ seq: 3, obs: 1, cmd: CMD.goto, a: 3, b: 1, conf: 50, latency: 400, label: "advance", route: [[0, 0]] })
    assert.deepEqual([...plain.slice(26, 31)], [1, 1, 0, 0, c.AI_NO_DANGER], "клетка 0,0 — не «нет точки», нет danger — 0xff")
    assert.deepEqual([...c.decodeAiBox((i: number) => plain[i]).route], [0, 0])
    const old = encodeBox({ seq: 3, obs: 1, cmd: CMD.goto, a: 3, b: 1, conf: 50, latency: 400, label: "advance" })
    old[30] = 0
    let sum = 0
    for (let i = 0; i < 31; i++) sum += old[i]
    old[31] = sum & 0xff
    const legacy = c.decodeAiBox((i: number) => old[i])
    assert.deepEqual([legacy.route.length, legacy.danger], [0, 0], "ящик старого моста: маршрута нет, danger 0")
})

test("GOTO по маршруту с двумя поворотами: одна команда, без остановок на углах", () => {
    const world = c.createWorld(L_CORRIDOR, 0)
    const link = linkFor(world)
    const box = new Box()
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    box.send(cmd("goto", link.obs, 3, 1, [[3, 3], [5, 3]]))
    const run = play(link, world, box, 6000)
    assert.equal(link.exec.result, c.AI_OK)
    assert.deepEqual(cell(world), [5, 3])
    assert.ok(run.longestStill <= 60, `стоял ${run.longestStill} мс подряд`)
    assert.ok(run.ms < 2600, `${run.ms} мс на 6 клеток`)
})

test("GOTO: игрок ушёл вперёд, пока Jev думал, — маршрут подхватывается с его клетки; не на маршруте — blocked", () => {
    const world = c.createWorld(L_CORRIDOR, 0)
    const link = linkFor(world)
    const box = new Box()
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    const obs = link.obs
    world.x = 3 * 1024 + 512
    box.send(cmd("goto", obs, 3, 1, [[3, 3], [5, 3]]))
    c.aiPoll(link, world, box.read)
    assert.equal(link.exec.result, c.AI_RUNNING, "клетка 3,1 лежит на маршруте от клетки снимка 1,1")
    assert.equal(link.exec.leg, 1)
    play(link, world, box, 6000)
    assert.equal(link.exec.result, c.AI_OK)
    assert.deepEqual(cell(world), [5, 3])

    const off = c.createWorld(["#######", "#S....#", "#.....#", "#######"], 0)
    const l2 = linkFor(off)
    const b2 = new Box()
    c.aiSnapshot(l2, off, c.DIFF_NORMAL)
    off.y = 2 * 1024 + 512
    b2.send(cmd("goto", l2.obs, 3, 1))
    c.aiPoll(l2, off, b2.read)
    assert.equal(l2.exec.result, c.AI_BLOCKED, "клетка 1,2 не на маршруте — команда устарела")
})

test("GOTO: диагональный или сквозь стену отрезок отрезает хвост маршрута, первый такой — blocked", () => {
    const world = c.createWorld(["#######", "#S....#", "#.###.#", "#.....#", "#######"], 0)
    const link = linkFor(world)
    c.aiStart(link.exec, world, c.AI_GOTO, 3, 1, [4, 2, 5, 3])
    assert.deepEqual([...link.exec.path], [1, 1, 3, 1], "диагональ 3,1 -> 4,2 отброшена")
    c.aiStart(link.exec, world, c.AI_GOTO, 3, 1, [3, 3])
    assert.deepEqual([...link.exec.path], [1, 1, 3, 1], "3,1 -> 3,3 через стену 3,2 отброшен")
    c.aiStart(link.exec, world, c.AI_GOTO, 1, 3)
    assert.equal(link.exec.result, c.AI_RUNNING, "1,1 -> 1,3 по свободному столбцу")
    c.aiStart(link.exec, world, c.AI_GOTO, 3, 3)
    assert.equal(link.exec.result, c.AI_BLOCKED, "диагональ первым отрезком")
})

test("GOTO: время команды растёт с длиной маршрута", () => {
    const world = c.createWorld(L_CORRIDOR, 0)
    const exec = new c.AiExec()
    c.aiStart(exec, world, c.AI_GOTO, 2, 1)
    assert.equal(exec.limit, c.AI_GOTO_MS)
    c.aiStart(exec, world, c.AI_GOTO, 3, 1, [3, 3, 5, 3])
    assert.equal(exec.limit, 3 * c.AI_GOTO_MS, "6 клеток — по 1500 мс на каждые 2")
})

test("ATTACK b=1: пятится и стреляет; спиной в стену — стреляет стоя", () => {
    const world = c.createWorld(["#########", "#...S..E#", "#########"], 0)
    const link = linkFor(world)
    const box = new Box()
    const x0 = world.x
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    box.send(cmd("attack", link.obs, 0, 1))
    const run = play(link, world, box, 800)
    assert.ok(world.x < x0 - 512, `отошёл на ${x0 - world.x}`)
    assert.ok(run.shots >= 1, "стрелял на ходу")
    assert.equal(Math.abs(world.y - 1536) < 50, true, "пятится по прямой, не в стену")

    const wall = c.createWorld(["#######", "#S...E#", "#######"], 0)
    const l2 = linkFor(wall)
    const b2 = new Box()
    wall.x = 1024 + 260
    c.aiSnapshot(l2, wall, c.DIFF_NORMAL)
    b2.send(cmd("attack", l2.obs, 0, 1))
    const stuck = play(l2, wall, b2, 800)
    assert.ok(stuck.shots >= 1, "у стены продолжает стрелять")
    assert.equal(l2.exec.result, c.AI_OK)
})

test("лава: ATTACK без прицела не шагает в лаву, STRAFE в лаву — blocked, из лавы GOTO выводит", () => {
    const world = c.createWorld(["#######", "#S.L|E#", "#######"], 0)
    world.x = 2 * 1024 + 300
    const link = linkFor(world)
    const box = new Box()
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    box.send(cmd("attack", link.obs, 0))
    const attack = play(link, world, box, 800)
    assert.equal(attack.lava, false, "за закрытой дверью цель не под прицелом, но в лаву не идёт")
    assert.deepEqual(cell(world), [2, 1])

    const side = c.createWorld(["#####", "#...#", "#.S.#", "#.L.#", "#####"], 0)
    const l2 = linkFor(side)
    const b2 = new Box()
    c.aiSnapshot(l2, side, c.DIFF_NORMAL)
    b2.send(cmd("strafe", l2.obs, 1))
    const strafe = play(l2, side, b2, 600)
    assert.equal(strafe.lava, false)
    assert.equal(l2.exec.result, c.AI_BLOCKED, "справа лава")
    c.aiSnapshot(l2, side, c.DIFF_NORMAL)
    b2.send(cmd("strafe", l2.obs, 0))
    play(l2, side, b2, 600)
    assert.equal(l2.exec.result, c.AI_OK, "слева свободно")

    const inLava = c.createWorld(["######", "#S.L.#", "######"], 0)
    inLava.x = 3 * 1024 + 512
    const l3 = linkFor(inLava)
    const b3 = new Box()
    c.aiSnapshot(l3, inLava, c.DIFF_NORMAL)
    b3.send(cmd("goto", l3.obs, 4, 1))
    play(l3, inLava, b3, 2000)
    assert.equal(l3.exec.result, c.AI_OK)
    assert.deepEqual(cell(inLava), [4, 1], "из лавы выходит")
})

test("лава: ранний поворот у лавы во внутреннем углу её не задевает", () => {
    const world = c.createWorld(["#######", "#S....#", "#.L...#", "#.....#", "#######"], 0)
    const link = linkFor(world)
    const box = new Box()
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    box.send(cmd("goto", link.obs, 3, 1, [[3, 3]]))
    const run = play(link, world, box, 4000)
    assert.equal(run.lava, false)
    assert.equal(link.exec.result, c.AI_OK)
    assert.deepEqual(cell(world), [3, 3])
})

test("рефлексы: стреляет по врагу под прицелом на ходу, не останавливая GOTO", () => {
    const world = c.createWorld(["##########", "#S......E#", "##########"], 0)
    const link = linkFor(world)
    const box = new Box()
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    box.send(cmd("goto", link.obs, 3, 1))
    const input = c.aiFrame(link, world, DT, box.read)
    assert.deepEqual([input.fwd, input.fire], [1, true])
    c.update(world, input, DT)
    assert.ok(world.events.includes("shoot"))

    const calm = c.createWorld(["##########", "#S......E#", "##########"], 0)
    const l2 = linkFor(calm)
    l2.reflexes = false
    const b2 = new Box()
    c.aiSnapshot(l2, calm, c.DIFF_NORMAL)
    b2.send(cmd("goto", l2.obs, 3, 1))
    assert.equal(c.aiFrame(l2, calm, DT, b2.read).fire, false, "рефлексы выключены")
})

test("рефлексы: шаг вбок от шара за 300 мс до попадания, не раньше; у стены сбоку — нет; во время ATTACK — нет", () => {
    const room = ["#########", "#.......#", "#..S....#", "#.......#", "#########"]
    const world = c.createWorld(room, 0)
    const link = linkFor(world)
    const box = new Box()
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    box.send(cmd("wait", link.obs, 100))
    world.shots.push(new c.Shot(world.x + 1000, world.y + 150, -2000, 0))
    assert.equal(c.aiFrame(link, world, DT, box.read).strafe, 0, "попадёт через 500 мс — рано")
    world.shots[0] = new c.Shot(world.x + 500, world.y + 150, -2000, 0)
    assert.equal(c.aiFrame(link, world, DT, box.read).strafe, -1, "250 мс, шар правее — влево")

    const narrow = c.createWorld(["#########", "#..S....#", "#########"], 0)
    const l2 = linkFor(narrow)
    const b2 = new Box()
    c.aiSnapshot(l2, narrow, c.DIFF_NORMAL)
    b2.send(cmd("wait", l2.obs, 100))
    narrow.shots.push(new c.Shot(narrow.x + 500, narrow.y + 150, -2000, 0))
    assert.equal(c.aiFrame(l2, narrow, DT, b2.read).strafe, 0, "стены с обеих сторон")

    const fight = c.createWorld([...room.slice(0, 2), "#..S...E#", ...room.slice(3)], 0)
    const l3 = linkFor(fight)
    const b3 = new Box()
    c.aiSnapshot(l3, fight, c.DIFF_NORMAL)
    b3.send(cmd("attack", l3.obs, 0))
    fight.shots.push(new c.Shot(fight.x + 500, fight.y + 150, -2000, 0))
    assert.equal(c.aiFrame(l3, fight, DT, b3.read).strafe, 0, "ATTACK рефлексами не перебивается")
})

test("тревога: строка JEV красная при danger от 60%, без danger — по шару или укусу", () => {
    const world = c.createWorld(["#########", "#..S....#", "#########"], 0)
    const link = linkFor(world)
    const box = new Box()
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    box.send({ ...cmd("wait", link.obs, 25), danger: 0.7 })
    c.aiFrame(link, world, DT, box.read)
    assert.equal(c.aiAlarm(link, world), true)
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    box.send({ ...cmd("wait", link.obs, 25), danger: 0.3 })
    c.aiFrame(link, world, DT, box.read)
    assert.equal(c.aiAlarm(link, world), false)
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    box.send(cmd("wait", link.obs, 25))
    c.aiFrame(link, world, DT, box.read)
    assert.equal(c.aiAlarm(link, world), false, "Jev без danger, угроз нет")
    world.shots.push(new c.Shot(world.x + 1000, world.y, -2000, 0))
    assert.equal(c.aiAlarm(link, world), true, "шар через 500 мс")
    world.shots = []
    world.enemies.push(new c.Enemy(c.ENEMY_IMP, world.x + 800, world.y))
    assert.equal(c.aiAlarm(link, world), true, "имп на дистанции укуса")

    const draw = (alert: boolean) => {
        const view = new r.View()
        view.mode = r.MODE_PLAY
        view.aiLine = "JEV WAIT 80% 500MS"
        view.aiAlert = alert
        const img = new FakeImage(160, 120)
        r.draw(img as never, world, view)
        let red = 0
        let yellow = 0
        for (let y = 12; y < 18; y++) {
            for (let x = 4; x < 80; x++) {
                if (img.getPixel(x, y) === 2) red++
                if (img.getPixel(x, y) === 5) yellow++
            }
        }
        return { red, yellow }
    }
    const calm = draw(false)
    const alarm = draw(true)
    assert.ok(alarm.red > calm.red + 20, `красных пикселей ${calm.red} -> ${alarm.red}`)
    assert.ok(alarm.yellow < calm.yellow, "строка перекрашена, а не дорисована")
})

test("меню: A на PLAYER переключает HUMAN и AI в обе стороны", () => {
    const menu = new c.Menu()
    const pad = new c.Pad()
    menu.index = c.MENU_PLAYER
    pad.tapA = true
    c.menuStep(menu, pad)
    assert.equal(menu.ai, true)
    c.menuStep(menu, pad)
    assert.equal(menu.ai, false)
})

import assert from "node:assert/strict"
import test from "node:test"
import { boxWrites, CMD, encodeBox, nextSeq, type BoxCommand } from "./bridge/mailbox.ts"
import { FakeImage } from "./fake-image.ts"
import { loadGame, type View, type World } from "./load-logic.ts"

const game = loadGame()
const c = game.corridor
const r = game.corridorRender
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

function cmd(name: keyof typeof CMD, obs: number, a = 0, b = 0, label = name): Omit<BoxCommand, "seq"> {
    return { obs, cmd: CMD[name], a, b, conf: 84, latency: 230, label }
}

function linkFor(world: World): any {
    const link = new c.AiLink(4242)
    const session = c.startSession(c.RUN_CAMPAIGN, c.DIFF_NORMAL)
    c.aiEnterLevel(link, session, world)
    return link
}

// Snapshot now (so the next command has an observation to answer), then send.
function answer(link: any, world: World, box: Box, command: (obs: number) => Omit<BoxCommand, "seq">): void {
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    box.send(command(link.obs))
}

function frames(link: any, world: World, box: Box, ms: number, done: () => boolean = () => false): number {
    let t = 0
    while (t < ms) {
        c.update(world, c.aiFrame(link, world, DT, box.read), DT)
        t += DT
        if (done()) break
    }
    return t
}

const cell = (world: World) => [world.x >> 10, world.y >> 10]

test("ящик: команда декодируется целиком, чужая сигнатура и битая сумма отвергаются", () => {
    const box = encodeBox({ seq: 513, obs: 77, cmd: CMD.attack, a: 3, b: 9, conf: 84, latency: 230, label: "attack" })
    const got = c.decodeAiBox((i: number) => box[i])
    assert.deepEqual(
        [got.seq, got.obs, got.cmd, got.a, got.b, got.conf, got.latency, got.label],
        [513, 77, c.AI_ATTACK, 3, 9, 84, 230, "ATTACK"],
    )
    const broken = box.slice()
    broken[14] ^= 1
    assert.equal(c.decodeAiBox((i: number) => broken[i]), null, "сумма не сошлась")
    const alien = encodeBox({ seq: 1, obs: 1, cmd: 1, a: 0, b: 0, conf: 0, latency: 0, label: "" })
    alien[0] = 0x41
    let sum = 0
    for (let i = 0; i < 31; i++) sum += alien[i]
    alien[31] = sum & 0xff
    assert.equal(c.decodeAiBox((i: number) => alien[i]), null, "не наша сигнатура")
})

test("ящик: метка переводится в символы шрифта, seq 0 пропускается при переполнении", () => {
    const box = encodeBox({ seq: 1, obs: 1, cmd: 1, a: 0, b: 0, conf: 150, latency: 99999, label: "dodge_left!?" })
    const got = c.decodeAiBox((i: number) => box[i])
    assert.equal(got.label, "DODGE LE")
    assert.equal(got.conf, 100)
    assert.equal(got.latency, 0xffff)
    assert.equal(nextSeq(0xffff), 1)
    assert.equal(nextSeq(5), 6)
})

test("ящик: запись пополам не исполняется, следующий кадр подхватывает целую", () => {
    const world = c.createWorld(["#######", "#S....#", "#######"], 0)
    const link = linkFor(world)
    const box = new Box()
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    const full = encodeBox({ ...cmd("goto", link.obs, 3, 1), seq: 1 })
    const [body, seqWord] = boxWrites(full)
    box.mem.set(body.data.subarray(0, 10), body.offset)
    c.aiPoll(link, world, box.read)
    assert.equal(link.exec.cmd, c.AI_NONE, "старый seq — тело не читается")

    box.mem.set(seqWord.data, seqWord.offset)
    c.aiPoll(link, world, box.read)
    assert.equal(link.exec.cmd, c.AI_NONE, "seq новый, а тело дописано наполовину — сумма не сходится")
    assert.equal(link.seq, 0)

    box.mem.set(body.data, body.offset)
    c.aiPoll(link, world, box.read)
    assert.equal(link.exec.cmd, c.AI_GOTO)
    assert.equal(link.seq, 1)
})

test("ящик: seq сменился между первым и вторым чтением — команда ждёт следующего кадра", () => {
    const world = c.createWorld(["#######", "#S....#", "#######"], 0)
    const link = linkFor(world)
    const box = new Box()
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    box.send(cmd("wait", link.obs))
    let reads = 0
    const racing = (i: number) => {
        if (i === 8) reads++
        return i === 8 && reads >= 3 ? box.mem[8] + 1 : box.mem[i]
    }
    c.aiPoll(link, world, racing)
    assert.equal(link.exec.cmd, c.AI_NONE)
    c.aiPoll(link, world, box.read)
    assert.equal(link.exec.cmd, c.AI_WAIT)
})

test("устаревание: ответ на снимок старше 1200 мс игрового времени отбрасывается и помечается stale", () => {
    const world = c.createWorld(["#######", "#S....#", "#######"], 0)
    const link = linkFor(world)
    const box = new Box()
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    const oldObs = link.obs
    link.clock += c.AI_STALE_MS + 1
    box.send(cmd("goto", oldObs, 3, 1))
    c.aiPoll(link, world, box.read)
    assert.equal(link.exec.cmd, c.AI_NONE)
    assert.equal(link.stale, true)
    const lines: string[] = c.aiSnapshot(link, world, c.DIFF_NORMAL)
    assert.ok(lines.includes("AI A 1 ok stale"), lines.join("\n"))

    box.send(cmd("goto", link.obs, 3, 1))
    c.aiPoll(link, world, box.read)
    assert.equal(link.exec.cmd, c.AI_GOTO, "свежий ответ исполняется")
    assert.equal(link.stale, false)
    box.send(cmd("wait", link.obs + 3))
    c.aiPoll(link, world, box.read)
    assert.equal(link.exec.cmd, c.AI_GOTO, "ответ на снимок из будущего — мусор")
})

test("устаревание считается по часам связи: пауза (кадры без aiFrame) возраст не прибавляет", () => {
    const world = c.createWorld(["#######", "#S....#", "#######"], 0)
    const link = linkFor(world)
    const box = new Box()
    c.aiSnapshot(link, world, c.DIFF_NORMAL)
    const obs = link.obs
    frames(link, world, box, 1000)
    box.send(cmd("goto", obs, 3, 1))
    c.aiPoll(link, world, box.read)
    assert.equal(link.exec.cmd, c.AI_GOTO, "1000 мс — ещё свежо")
})

test("GOTO: идёт по прямой к центру клетки до 2 клеток, дальше и по диагонали — blocked сразу", () => {
    const world = c.createWorld(["#######", "#S....#", "#.....#", "#.....#", "#######"], 0)
    const link = linkFor(world)
    const box = new Box()
    answer(link, world, box, (obs) => cmd("goto", obs, 3, 1))
    frames(link, world, box, 2000, () => link.exec.result !== c.AI_RUNNING)
    assert.equal(link.exec.result, c.AI_OK)
    assert.deepEqual(cell(world), [3, 1])

    answer(link, world, box, (obs) => cmd("goto", obs, 4, 2))
    frames(link, world, box, DT)
    assert.equal(link.exec.result, c.AI_BLOCKED, "диагональ")
    answer(link, world, box, (obs) => cmd("goto", obs, 3, 4))
    frames(link, world, box, DT)
    assert.equal(link.exec.result, c.AI_BLOCKED, "три клетки")
    assert.deepEqual(cell(world), [3, 1])
})

test("GOTO в стену: упор дольше 400 мс даёт blocked, а не вечную ходьбу", () => {
    const world = c.createWorld(["#####", "#S..#", "#####"], 512)
    const link = linkFor(world)
    const box = new Box()
    answer(link, world, box, (obs) => cmd("goto", obs, 0, 1))
    const t = frames(link, world, box, 3000, () => link.exec.result !== c.AI_RUNNING)
    assert.equal(link.exec.result, c.AI_BLOCKED)
    assert.ok(t < c.AI_GOTO_MS + 100, `${t} мс`)
})

test("GOTO сам открывает обычную дверь и проходит её, синюю без ключа — нет", () => {
    const world = c.createWorld(["#######", "#S.|..#", "#######"], 0)
    const link = linkFor(world)
    const box = new Box()
    answer(link, world, box, (obs) => cmd("goto", obs, 3, 1))
    frames(link, world, box, 2000, () => link.exec.result !== c.AI_RUNNING)
    answer(link, world, box, (obs) => cmd("goto", obs, 4, 1))
    frames(link, world, box, 2000, () => link.exec.result !== c.AI_RUNNING)
    assert.deepEqual(cell(world), [4, 1], `${link.exec.result}`)

    const locked = c.createWorld(["#######", "#S.D..#", "#######"], 0)
    const l2 = linkFor(locked)
    const b2 = new Box()
    answer(l2, locked, b2, (obs) => cmd("goto", obs, 3, 1))
    frames(l2, locked, b2, 2000, () => l2.exec.result !== c.AI_RUNNING)
    assert.equal(l2.exec.result, c.AI_BLOCKED)
    assert.deepEqual(cell(locked), [2, 1])
})

test("ATTACK: доворачивает на врага и стреляет, только когда он под прицелом; повторами убивает", () => {
    const world = c.createWorld(["#########", "#S......#", "#.......#", "#....E..#", "#########"], 0)
    const link = linkFor(world)
    const box = new Box()
    const enemy = world.enemies[0]
    let shotsOffTarget = 0
    for (let i = 0; i < 20 && !enemy.dead && !world.lost; i++) {
        answer(link, world, box, (obs) => cmd("attack", obs, 0))
        frames(link, world, box, 800, () => link.exec.result !== c.AI_RUNNING)
        if (world.events.includes("shoot") && c.target(world) !== 0) shotsOffTarget++
    }
    assert.ok(enemy.dead, "враг убит")
    assert.equal(shotsOffTarget, 0)
    answer(link, world, box, (obs) => cmd("attack", obs, 0))
    frames(link, world, box, DT)
    assert.equal(link.exec.result, c.AI_OK, "мёртвый враг — сразу ok")
})

test("ATTACK по врагу за стеной: ни одного выстрела за 700 мс — blocked, а не ok", () => {
    const world = c.createWorld(["#######", "#S....#", "####..#", "#E....#", "#######"], 0)
    const link = linkFor(world)
    const box = new Box()
    answer(link, world, box, (obs) => cmd("attack", obs, 0))
    const t = frames(link, world, box, 2000, () => link.exec.result !== c.AI_RUNNING)
    assert.equal(link.exec.result, c.AI_BLOCKED)
    assert.ok(Math.abs(t - c.AI_ATTACK_MS) <= DT, `${t}`)
    assert.equal(world.enemies[0].dead, false)
})

test("STRAFE уходит вбок за 300 мс, USE жмёт один раз, WAIT стоит", () => {
    const world = c.createWorld(["#######", "#.....#", "#..S..#", "#.....#", "#######"], 0)
    const link = linkFor(world)
    const box = new Box()
    const y0 = world.y
    answer(link, world, box, (obs) => cmd("strafe", obs, 0))
    const t = frames(link, world, box, 1000, () => link.exec.result !== c.AI_RUNNING)
    assert.ok(world.y < y0 - 300, "влево при взгляде на восток — к северу")
    assert.ok(Math.abs(t - c.AI_STRAFE_MS) <= DT, `${t}`)

    const x0 = world.x
    let fires = 0
    answer(link, world, box, (obs) => cmd("use", obs))
    for (let i = 0; i < 20; i++) {
        const input = c.aiFrame(link, world, DT, box.read)
        if (input.fire) fires++
        c.update(world, input, DT)
    }
    assert.equal(fires, 1)
    assert.equal(link.exec.result, c.AI_OK)

    answer(link, world, box, (obs) => cmd("wait", obs))
    frames(link, world, box, 200)
    assert.equal(link.exec.result, c.AI_RUNNING)
    frames(link, world, box, 100)
    assert.equal(link.exec.result, c.AI_OK)
    assert.equal(world.x, x0)
})

test("оружие: дробовик сам выбирается при 2+ патронах, пистолет — когда их меньше", () => {
    const world = c.createWorld(["#######", "#S....#", "#######"], 0)
    world.hasShotgun = true
    world.weapon = c.WEAPON_PISTOL
    world.ammo = 10
    const exec = new c.AiExec()
    c.aiStart(exec, world, c.AI_WAIT, 0, 0)
    assert.equal(c.aiStep(exec, world, DT).swap, true)
    world.weapon = c.WEAPON_SHOTGUN
    assert.equal(c.aiStep(exec, world, DT).swap, false)
    world.ammo = 1
    assert.equal(c.aiStep(exec, world, DT).swap, true)
})

test("ACK: hurt, если за команду сняли здоровье", () => {
    const world = c.createWorld(["#######", "#S....#", "#######"], 0)
    const link = linkFor(world)
    const box = new Box()
    answer(link, world, box, (obs) => cmd("wait", obs))
    frames(link, world, box, DT)
    world.health -= 10
    frames(link, world, box, DT)
    const lines: string[] = c.aiSnapshot(link, world, c.DIFF_NORMAL)
    assert.ok(lines.includes("AI A 1 hurt"), lines.join("\n"))
})

test("снимок: строки короче 64, рамка S…END с одним n, враги, шары, двери и взятые предметы", () => {
    const world = c.createWorld(["##########", "#S.|.H.E.#", "#..A.....#", "##########"], 0)
    world.items[1].taken = true
    world.shots.push(Object.assign(new c.Shot(), { x: 5000, y: 1500, vx: -80, vy: 0 }))
    const link = linkFor(world)
    link.clock = 1234
    const lines: string[] = c.aiSnapshot(link, world, c.DIFF_HARD)
    for (const line of lines) assert.ok(line.length < 64, line)
    assert.match(lines[0], new RegExp(`^AI S n=1 t=1234 run=4242 lvl=0 h=${link.hash} d=2$`))
    assert.equal(lines.at(-1), "AI END n=1")
    assert.equal(lines[1], `AI P ${world.x} ${world.y} 0 ${world.health} ${world.ammo} 0 0 0`)
    assert.ok(lines.includes(`AI E 0 ${world.enemies[0].kind} ${world.enemies[0].x} ${world.enemies[0].y} ${world.enemies[0].hp} 0`))
    assert.ok(lines.includes("AI F 5000 1500 -80 0"))
    assert.ok(lines.includes("AI D 0"))
    assert.ok(lines.includes("AI I 2"), "второй предмет взят — бит 1")
    world.enemies[0].dead = true
    const next: string[] = c.aiSnapshot(link, world, c.DIFF_HARD)
    assert.equal(next.filter((l) => l.startsWith("AI E ")).length, 0, "мёртвые не шлются")
    assert.equal(next.at(-1), "AI END n=2")
})

test("снимок раз в 250 мс по часам связи", () => {
    const world = c.createWorld(["#######", "#S....#", "#######"], 0)
    const link = linkFor(world)
    let due = 0
    for (let t = 0; t < 1000; t += DT) {
        link.clock += DT
        if (c.aiSnapshotDue(link)) due++
    }
    assert.equal(due, 4)
})

test("хеш карты: один уровень — один хеш, сложность и другой уровень его меняют", () => {
    const easy = c.startSession(c.RUN_CAMPAIGN, c.DIFF_EASY)
    const normal = c.startSession(c.RUN_CAMPAIGN, c.DIFF_NORMAL)
    const h = (s: any) => c.mapHash(c.enterLevel(s))
    assert.equal(h(normal), h(c.startSession(c.RUN_CAMPAIGN, c.DIFF_NORMAL)))
    assert.notEqual(h(easy), h(normal))
    const second = c.startAtLevel(c.DIFF_NORMAL, 1)
    assert.notEqual(h(second), h(normal))
    assert.equal(c.aiLevelId(second), "1")
    assert.equal(c.aiLevelId(c.startSession(c.RUN_ENDLESS, c.DIFF_NORMAL)), "D1")
    const hash = h(normal)
    assert.ok(hash >= 0 && hash <= 0xffff)
})

test("статус: JEV метка уверенность задержка; 3 с без команд — NO LINK", () => {
    const world = c.createWorld(["#######", "#S....#", "#######"], 0)
    const link = linkFor(world)
    const box = new Box()
    assert.equal(c.aiStatus(link), "JEV")
    answer(link, world, box, (obs) => cmd("attack", obs, 0))
    frames(link, world, box, DT)
    assert.equal(c.aiStatus(link), "JEV ATTACK 84% 230MS")
    frames(link, world, box, c.AI_SILENT_MS + DT)
    assert.equal(c.aiStatus(link), "NO LINK")
    const input = c.aiFrame(link, world, DT, box.read)
    assert.deepEqual([input.fwd, input.strafe, input.turn, input.fire], [0, 0, 0, false], "без связи стоит")
    const glyphs = game.corridorArt.GLYPHS as unknown as string
    for (const ch of "JEV ATTACK 84% 230MS NO LINK DODGE LE".replace(/ /g, "")) assert.ok(glyphs.includes(ch), ch)
})

test("автопереход: ждёт заданное время и сбрасывает счётчик", () => {
    const link = new c.AiLink(1)
    let t = 0
    while (!c.aiAutoNext(link, DT, c.AI_RETRY_MS)) t += DT
    assert.equal(t + DT, c.AI_RETRY_MS)
    assert.equal(link.endMs, 0)
})

test("рекорды: забег ИИ ничего не пишет, тот же забег человека — пишет", () => {
    const rec = c.loadRecords(() => 0)
    const run = c.startSession(c.RUN_CAMPAIGN, c.DIFF_NORMAL)
    run.level = c.LEVELS.length
    run.time = 90000
    run.score = 700
    run.ai = true
    assert.equal(c.noteRun(rec, run), false)
    assert.deepEqual([rec.score, ...rec.time], [0, 0, 0, 0])
    run.ai = false
    assert.equal(c.noteRun(rec, run), true)
    assert.equal(rec.score, 700)
})

function frame(world: World, tweak: (v: View) => void): FakeImage {
    const view = new r.View()
    view.mode = r.MODE_PLAY
    tweak(view)
    const img = new FakeImage(160, 120)
    r.draw(img as never, world, view)
    return img
}

const rowHas = (img: FakeImage, y0: number, y1: number, colour: number) => {
    for (let y = y0; y < y1; y++) {
        for (let x = 0; x < 160; x++) if (img.getPixel(x, y) === colour) return true
    }
    return false
}

test("меню: 6 пунктов с шагом 9, PLAYER подсвечивается на своей строке и показывает AI", () => {
    const world = c.createWorld(["#####", "#S..#", "#####"], 0)
    const title = (tweak: (v: View) => void) => frame(world, (v) => { v.mode = r.MODE_TITLE; tweak(v) })
    const player = title((v) => { v.menu.index = c.MENU_PLAYER })
    const y = r.TITLE_ITEM_Y + c.MENU_PLAYER * r.TITLE_ITEM_STEP
    assert.ok(rowHas(player, y, y + 7, 4), "выбранный PLAYER жёлтым")
    assert.equal(rowHas(player, y - r.TITLE_ITEM_STEP, y - 2, 4), false)
    const human = title((v) => { v.menu.index = c.MENU_PLAYER })
    const ai = title((v) => { v.menu.index = c.MENU_PLAYER; v.menu.ai = true })
    assert.deepEqual(human.pixels, player.pixels)
    assert.notDeepEqual(ai.pixels, human.pixels, "HUMAN и AI рисуются по-разному")
    const last = r.TITLE_ITEM_Y + (c.MENU_ITEMS - 1) * r.TITLE_ITEM_STEP
    assert.ok(last + 7 < r.TITLE_HINT_Y, "последний пункт не налезает на подсказку")
    assert.ok(r.TITLE_HINT_Y + 7 <= 96, "подсказка над HUD")
})

test("строка JEV рисуется в игре под FPS и не рисуется для человека", () => {
    const world = c.createWorld(["#####", "#S..#", "#####"], 0)
    const plain = frame(world, () => {})
    const jev = frame(world, (v) => { v.aiLine = "JEV ATTACK 84% 230MS" })
    assert.ok(rowHas(jev, 12, 19, 5))
    for (let y = 0; y < 120; y++) {
        for (let x = 0; x < 160; x++) {
            if (jev.getPixel(x, y) !== plain.getPixel(x, y)) assert.ok(y >= 12 && y < 20, `пиксель ${x},${y}`)
        }
    }
})

// Feature: a scripted bridge answers snapshots through the box with a delay, the game walks a
// corridor with a door to the exit and wins without a single button press.
test("сценарий: мост через ящик ведёт игрока по коридору с дверью к выходу", () => {
    const world = c.createWorld(["#########", "#S..|..X#", "#########"], 0)
    const link = linkFor(world)
    const box = new Box()
    const LAG = 300
    let pending: { at: number; obs: number } | null = null
    let sent = 0
    for (let t = 0; t < 15000 && !world.won; t += DT) {
        c.update(world, c.aiFrame(link, world, DT, box.read), DT)
        if (c.aiSnapshotDue(link)) {
            const lines: string[] = c.aiSnapshot(link, world, c.DIFF_NORMAL)
            const idle = !lines.some((l) => l.startsWith("AI A") && l.includes(" run"))
            if (!pending && idle) pending = { at: t + LAG, obs: link.obs }
        }
        if (pending && t >= pending.at) {
            const [cx] = cell(world)
            box.send(cmd("goto", pending.obs, Math.min(cx + 2, 7), 1))
            sent++
            pending = null
        }
    }
    assert.ok(world.won, `выход не достигнут, клетка ${cell(world)}`)
    assert.ok(sent >= 3 && sent < 20, `${sent} команд`)
})

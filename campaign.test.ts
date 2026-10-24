import assert from "node:assert/strict"
import test from "node:test"
import { loadLogic, type World } from "./load-logic.ts"

const api = loadLogic()
const { FP, createWorld, update } = api
const DT = 20

function run(world: World, ms: number, set: (input: InstanceType<typeof api.Input>, t: number) => void = () => {}): string[] {
    const events: string[] = []
    for (let t = 0; t < ms; t += DT) {
        const input = new api.Input()
        set(input, t)
        update(world, input, DT)
        events.push(...world.events)
    }
    return events
}

const once = (input: InstanceType<typeof api.Input>, t: number) => { input.fire = t === 0 }

test("простая дверь: A открывает за 400 мс, проход после 920, через 3 с закрывается", () => {
    const world = createWorld(["#######", "#.S|..#", "#######"], 0)
    const door = api.doorAt(world, 3, 1)
    assert.equal(door.vertical, true)
    assert.equal(api.blocks(world, 3, 1), true)

    const opened = run(world, DT, once)
    assert.ok(opened.includes("door"))
    assert.equal(world.ammo, api.START_AMMO, "нажатие у двери не тратит патрон")
    assert.equal(door.state, api.DOOR_OPENING)

    run(world, 300)
    assert.ok(door.progress < api.DOOR_PASS, `через 320 мс ещё ${door.progress}`)
    assert.equal(api.blocks(world, 3, 1), true)
    run(world, 100)
    assert.equal(door.state, api.DOOR_OPEN)
    assert.equal(api.blocks(world, 3, 1), false)

    run(world, 1500, (input) => { input.fwd = 1 })
    assert.equal(world.x >> 10, 5, "прошёл сквозь проём")
    const closing = run(world, 3000)
    assert.ok(closing.includes("door"))
    assert.equal(door.state, api.DOOR_CLOSED)
    assert.equal(api.blocks(world, 3, 1), true)
})

test("красная дверь без ключа — стена и звук, после ключа открывается", () => {
    const world = createWorld(["#########", "#r.SR...#", "#########"], 0)
    const door = api.doorAt(world, 4, 1)
    assert.equal(door.key, api.KEY_RED)

    const tried = run(world, DT, once)
    assert.ok(tried.includes("locked"))
    assert.equal(door.state, api.DOOR_CLOSED)
    run(world, 1000, (input) => { input.fwd = 1 })
    assert.ok(world.x < 4 * FP - api.PLAYER_RADIUS + 1, "упёрся в дверь")

    world.ang = 512
    const fetched = run(world, 2000, (input) => { input.fwd = 1 })
    assert.ok(fetched.includes("key"))
    assert.equal(world.keys & api.KEY_RED, api.KEY_RED)
    assert.equal(world.itemsTaken, 1)

    world.ang = 0
    run(world, 2000, (input) => { input.fwd = 1 })
    const opened = run(world, DT, once)
    assert.ok(opened.includes("door"))
    assert.equal(door.state, api.DOOR_OPENING)
})

test("бес на охоте открывает простую дверь, а цветная для него — стена", () => {
    for (const [tile, opens] of [["|", true], ["R", false]] as const) {
        const world = createWorld(["#########", "#S..%..E#", "#########"].map((row) => row.replace("%", tile)), 0)
        const enemy = world.enemies[0]
        enemy.hunting = true
        enemy.lastX = world.x
        enemy.lastY = world.y
        run(world, 3000)
        const door = api.doorAt(world, 4, 1)
        if (opens) {
            assert.notEqual(door.state, api.DOOR_CLOSED, "бес открыл дверь")
            assert.ok(enemy.x < 4 * FP, `бес прошёл, x=${enemy.x}`)
        } else {
            assert.equal(door.state, api.DOOR_CLOSED)
            assert.ok(enemy.x > 5 * FP, `бес остался за дверью, x=${enemy.x}`)
        }
    }
})

test("луч упирается в плоскость двери посередине клетки и проходит в щель полуоткрытой", () => {
    const world = createWorld(["########", "#S..|..#", "########"], 0)
    const hit = new api.Hit()
    api.castRay(world, FP, 0, hit)
    assert.equal(hit.tile, api.TILE_DOOR)
    assert.ok(Math.abs(hit.dist - 3 * FP) < 16, `до двери ${hit.dist}`)

    const door = api.doorAt(world, 4, 1)
    door.progress = 512
    api.castRay(world, FP, -100, hit)
    assert.equal(hit.tile, api.TILE_STONE, "верхняя половина уехала — луч ушёл в дальнюю стену")
    assert.ok(hit.dist > 5 * FP)
    api.castRay(world, FP, 100, hit)
    assert.equal(hit.tile, api.TILE_DOOR)
    assert.equal(hit.texX, (812 - 512) >> 6, "текстура едет вместе с полотном")

    door.progress = FP
    api.castRay(world, FP, 0, hit)
    assert.equal(hit.tile, api.TILE_STONE)
})

test("дверь не закрывается, пока в проёме стоит игрок", () => {
    const world = createWorld(["########", "#.S|...#", "########"], 0)
    const door = api.doorAt(world, 3, 1)
    run(world, 500, once)
    assert.equal(door.state, api.DOOR_OPEN)
    world.x = 3 * FP + FP / 2
    run(world, 5000)
    assert.equal(door.state, api.DOOR_OPEN)
    assert.equal(door.progress, FP)
    world.x = 6 * FP + FP / 2
    run(world, 1000)
    assert.equal(door.state, api.DOOR_CLOSED)
})

test("секретная стена: A сдвигает её за секунду, тайник считается один раз", () => {
    const world = createWorld(["#######", "#.SP..#", "#######"], 0)
    assert.equal(world.secrets, 1)
    const pushed = run(world, DT, once)
    assert.ok(pushed.includes("secret"))
    assert.equal(world.found, 1)
    run(world, 500)
    assert.equal(api.tileAt(world, 3, 1), api.TILE_SECRET)
    run(world, DT, once)
    assert.equal(world.found, 1)
    run(world, 500)
    assert.equal(api.tileAt(world, 3, 1), api.TILE_FLOOR)
})

test("запертый выход не пускает и пищит не чаще раза в секунду", () => {
    const world = createWorld(["#####", "#S.X#", "#####"], 0)
    world.exitLocked = true
    const events = run(world, 2500, (input) => { input.fwd = 1 })
    assert.equal(world.won, false)
    const locked = events.filter((e) => e === "locked").length
    assert.ok(locked >= 1 && locked <= 3, `пищал ${locked} раз`)
})

test("переход уровня несёт здоровье и патроны, смерть возвращает запас на входе", () => {
    const s = api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL)
    const first = api.enterLevel(s)
    assert.equal(first.health, 100)
    assert.equal(first.w, api.LEVELS[0].map[0].length)
    first.health = 63
    first.ammo = 7
    first.kills = 2
    first.total = 5
    first.time = 30000
    assert.equal(api.completeLevel(s, first), true)

    const second = api.enterLevel(s)
    assert.equal(second.w, api.LEVELS[1].map[0].length)
    assert.equal(second.health, 63)
    assert.equal(second.ammo, 7)
    second.health = 0
    second.ammo = 0
    second.lost = true
    const retry = api.enterLevel(s)
    assert.equal(retry.health, 63)
    assert.equal(retry.ammo, 7)

    assert.equal(api.completeLevel(s, retry), true)
    const third = api.enterLevel(s)
    assert.equal(api.completeLevel(s, third), false, "после третьего уровня — победа")
    assert.equal(s.kills, 2)
    assert.equal(s.total, 5 + retry.total + third.total)
    assert.equal(s.time, 30000)
})

test("итоги: проценты убийств, предметов и тайников", () => {
    assert.equal(api.pct(1, 3), 33)
    assert.equal(api.pct(2, 2), 100)
    assert.equal(api.pct(0, 0), 100, "нечего искать — значит, всё найдено")
    for (const level of api.LEVELS) {
        const world = createWorld(level.map, level.ang)
        const pickups = level.map.join("").replace(/[^HArb]/g, "").length
        assert.equal(world.itemsTotal, pickups, level.name)
        assert.equal(world.secrets, level.map.join("").replace(/[^P]/g, "").length, level.name)
        assert.ok(world.secrets >= 1, `${level.name}: есть тайник`)
    }
})

test("меню: курсор ходит по кругу, стрелки меняют сложность, A запускает кампанию", () => {
    const menu = new api.Menu()
    const pad = new api.Pad()
    const press = (dirs: number, a = false, b = false) => {
        pad.tapDirs = dirs
        pad.tapA = a
        pad.tapB = b
        return api.menuStep(menu, pad)
    }
    press(api.DIR_UP)
    assert.equal(menu.index, api.MENU_RECORDS)
    press(api.DIR_DOWN)
    assert.equal(menu.index, api.MENU_CAMPAIGN)
    press(api.DIR_DOWN)
    press(api.DIR_DOWN)
    assert.equal(menu.index, api.MENU_DIFFICULTY)
    press(api.DIR_RIGHT)
    assert.equal(menu.difficulty, api.DIFF_HARD)
    press(api.DIR_RIGHT)
    assert.equal(menu.difficulty, api.DIFF_EASY)
    press(api.DIR_LEFT)
    assert.equal(menu.difficulty, api.DIFF_HARD)
    assert.equal(press(0, true), api.ACT_NONE)

    press(api.DIR_DOWN)
    assert.equal(press(0, true), api.ACT_NONE)
    assert.equal(menu.records, true)
    press(api.DIR_UP)
    assert.equal(menu.index, api.MENU_RECORDS, "в рекордах стрелки не двигают курсор")
    press(0, false, true)
    assert.equal(menu.records, false)

    press(api.DIR_DOWN)
    assert.equal(press(0, true), api.ACT_CAMPAIGN)
    press(api.DIR_DOWN)
    assert.equal(press(0, true), api.ACT_ENDLESS)
})

test("крестовина в меню: нажатие срабатывает один раз, удержание не листает", () => {
    const pad = new api.Pad()
    const input = new api.Input()
    api.readPad(pad, input, 0, false, true, false, false, false, false)
    assert.equal(pad.tapDirs, api.DIR_DOWN)
    api.readPad(pad, input, 20, false, true, false, false, false, false)
    assert.equal(pad.tapDirs, 0)
    api.readPad(pad, input, 40, false, false, false, false, false, false)
    api.readPad(pad, input, 60, false, true, false, false, false, false)
    assert.equal(pad.tapDirs, api.DIR_DOWN)
})

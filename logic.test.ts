import assert from "node:assert/strict"
import test from "node:test"
import { loadLogic, type World } from "./load-logic.ts"

const api = loadLogic()
const { FP, createWorld, castRay, castColumn, update, project, target, canSee } = api

const EAST = 0
const SOUTH = 256
const NORTH = 768

function run(world: World, ms: number, set: (input: InstanceType<typeof api.Input>) => void): string[] {
    const events: string[] = []
    for (let t = 0; t < ms; t += 20) {
        const input = new api.Input()
        set(input)
        update(world, input, 20)
        events.push(...world.events)
    }
    return events
}

test("луч в упор даёт малую дистанцию и правильную сторону", () => {
    const world = createWorld(["#####", "#S..#", "#####"], EAST)
    const hit = new api.Hit()
    castRay(world, FP, 0, hit)
    assert.equal(hit.dist, 2560)
    assert.equal(hit.side, 0)
    assert.equal(hit.tile, api.TILE_STONE)

    castRay(world, 0, -FP, hit)
    assert.equal(hit.dist, 512)
    assert.equal(hit.side, 1)

    world.x = 3 * FP + 700
    castRay(world, FP, 0, hit)
    assert.equal(hit.dist, 324)
    assert.ok(api.wallHeight(hit.dist) > api.VIEW_H)
})

test("луч видит выход и кирпич как отдельные тайлы", () => {
    const world = createWorld(["######", "#S..X#", "#B...#", "######"], EAST)
    const hit = new api.Hit()
    castRay(world, FP, 0, hit)
    assert.equal(hit.tile, api.TILE_EXIT)
    assert.equal(hit.cellX, 4)
    world.ang = SOUTH
    castColumn(world, 0, hit)
    assert.notEqual(hit.tile, api.TILE_FLOOR)
})

test("колонка текстуры идёт по стене монотонно слева направо", () => {
    const world = createWorld([
        "##########",
        "#........#",
        "#........#",
        "#...S....#",
        "##########",
    ], NORTH)
    const hit = new api.Hit()
    let last = -1
    for (let col = 0; col < api.VIEW_W; col++) {
        castColumn(world, col, hit)
        assert.equal(hit.side, 1)
        const u = hit.cellX * 16 + hit.texX
        assert.ok(u >= last, `колонка ${col}: ${u} < ${last}`)
        last = u
    }
    assert.ok(last > 16 * 5, "лучи должны охватить несколько клеток стены")
})

test("дальняя стена темнее, бок по Y на шаг темнее, выход не тускнеет с расстоянием", () => {
    assert.equal(api.shadeFor(1000, 0, api.TILE_STONE), 0)
    assert.equal(api.shadeFor(1000, 1, api.TILE_STONE), 1)
    assert.equal(api.shadeFor(5000, 0, api.TILE_STONE), 2)
    assert.equal(api.shadeFor(20000, 1, api.TILE_STONE), 3)
    assert.equal(api.shadeFor(20000, 0, api.TILE_EXIT), 0)
    assert.equal(api.shadeFor(20000, 1, api.TILE_EXIT), 1)
})

test("движение в стену останавливает у стены", () => {
    const world = createWorld(["#####", "#S..#", "#####"], EAST)
    const events = run(world, 3000, (i) => { i.fwd = 1 })
    assert.ok(world.x <= 4 * FP - api.PLAYER_RADIUS, `упёрся в стену: x=${world.x}`)
    assert.ok(world.x > 4 * FP - api.PLAYER_RADIUS - 200, "дошёл почти до стены")
    assert.equal(world.y, FP + FP / 2)
    assert.ok(events.includes("step"))
})

test("движение по диагонали в стену скользит вдоль неё", () => {
    const world = createWorld(["########", "#S.....#", "########"], EAST)
    world.ang = 896
    const startX = world.x
    run(world, 600, (i) => { i.fwd = 1 })
    assert.ok(world.x > startX + 600, `проехал вдоль стены: ${world.x - startX}`)
    assert.ok(world.y >= FP + api.PLAYER_RADIUS, "не залез в северную стену")
})

test("поворот разгоняется и угол заворачивается в 0..1023", () => {
    const world = createWorld(["#####", "#S..#", "#####"], 10)
    run(world, 100, (i) => { i.turn = -1 })
    const slow = (10 - world.ang + api.ANGLES) % api.ANGLES
    assert.ok(world.ang > 900, `ушёл через ноль: ${world.ang}`)
    const before = world.ang
    run(world, 100, (i) => { i.turn = -1 })
    const fast = (before - world.ang + api.ANGLES) % api.ANGLES
    assert.ok(fast > slow, `второй отрезок быстрее: ${fast} > ${slow}`)
})

test("хитскан не проходит сквозь стену", () => {
    const walled = createWorld(["#######", "#S.#.E#", "#######"], EAST)
    assert.equal(target(walled), -1)
    const events = run(walled, 100, (i) => { i.fire = true })
    assert.ok(events.includes("shoot"))
    assert.equal(walled.enemies[0].hp, api.IMP_HP)

    const open = createWorld(["######", "#S..E#", "######"], EAST)
    assert.equal(target(open), 0)
})

test("два попадания убивают беса, патроны кончаются", () => {
    const world = createWorld(["#######", "#S...E#", "#######"], EAST)
    const events = run(world, 1000, (i) => { i.fire = true })
    assert.ok(events.includes("hit"))
    assert.ok(events.includes("kill"))
    assert.equal(world.kills, 1)
    assert.equal(world.score, 100)
    assert.equal(world.enemies[0].dead, true)

    world.ammo = 0
    world.fireCool = 0
    const dry = run(world, 40, (i) => { i.fire = true })
    assert.ok(dry.includes("empty"))
    assert.ok(!dry.includes("shoot"))
})

test("спрайт за спиной невидим, справа — правее центра", () => {
    const world = createWorld(["#######", "#.....#", "#..S..#", "#.....#", "#######"], EAST)
    const p = new api.Proj()
    project(world, world.x - 2 * FP, world.y, p)
    assert.equal(p.visible, false)
    project(world, world.x + 2 * FP, world.y, p)
    assert.equal(p.visible, true)
    assert.equal(p.screenX, api.VIEW_W / 2)
    assert.equal(p.depth, 2 * FP)
    project(world, world.x + 2 * FP, world.y + FP, p)
    assert.ok(p.screenX > api.VIEW_W / 2 + 40)
})

test("бес без прямой видимости не идёт, с видимостью — идёт", () => {
    const hidden = createWorld(["#########", "#S..#..E#", "#########"], EAST)
    const hx = hidden.enemies[0].x
    assert.equal(canSee(hidden, hidden.x, hidden.y, hx, hidden.enemies[0].y), false)
    run(hidden, 1000, () => {})
    assert.equal(hidden.enemies[0].x, hx)
    assert.equal(hidden.enemies[0].awake, false)

    const open = createWorld(["#########", "#S.....E#", "#########"], EAST)
    const ox = open.enemies[0].x
    const events = run(open, 1000, () => {})
    assert.ok(open.enemies[0].x < ox - FP, "бес подошёл")
    assert.ok(events.includes("alert"))
})

test("бес в упор кусает, на нуле здоровья игра проиграна", () => {
    const world = createWorld(["#####", "#SE.#", "#####"], EAST)
    const first = run(world, 200, () => {})
    assert.ok(first.includes("hurt"))
    assert.equal(world.health, 100 - api.IMP_DAMAGE)
    const rest = run(world, 20000, () => {})
    assert.equal(world.lost, true)
    assert.equal(world.health, 0)
    assert.ok(rest.includes("dead"))
    run(world, 1000, (i) => { i.fwd = 1 })
    assert.equal(world.lost, true)
})

test("подбор: аптечка не берётся при полном здоровье, патроны берутся", () => {
    const world = createWorld(["######", "#SHA.#", "######"], EAST)
    run(world, 900, (i) => { i.fwd = 1 })
    assert.equal(world.items[0].taken, false)
    assert.equal(world.items[1].taken, true)
    assert.equal(world.ammo, api.START_AMMO + api.AMMO_PICKUP)

    world.health = 90
    run(world, 900, (i) => { i.fwd = -1 })
    assert.equal(world.items[0].taken, true)
    assert.equal(world.health, 100)
})

test("упор в жёлтую дверь — победа, дальше игра стоит", () => {
    const world = createWorld(["#####", "#S.X#", "#####"], EAST)
    const events = run(world, 2000, (i) => { i.fwd = 1 })
    assert.equal(world.won, true)
    assert.ok(events.includes("win"))
    const x = world.x
    run(world, 500, (i) => { i.fwd = 1 })
    assert.equal(world.x, x)
})

test("компас по углу", () => {
    assert.equal(api.heading(EAST), "E")
    assert.equal(api.heading(SOUTH), "S")
    assert.equal(api.heading(512), "W")
    assert.equal(api.heading(NORTH), "N")
    assert.equal(api.heading(1000), "E")
})

test("короткий B открывает карту, B со стрелкой — стрейф без карты", () => {
    const pad = new api.Pad()
    const input = new api.Input()
    const press = (now: number, left: boolean, right: boolean, b: boolean) =>
        api.readPad(pad, input, now, false, false, left, right, false, b)

    press(0, false, false, true)
    press(100, false, false, false)
    assert.equal(pad.tapB, true, "быстрый тап B переключает карту")
    press(140, false, false, false)
    assert.equal(pad.tapB, false, "тап срабатывает один кадр")

    press(200, false, false, true)
    press(240, false, true, true)
    assert.equal(input.strafe, 1)
    assert.equal(input.turn, 0)
    press(280, false, false, false)
    assert.equal(pad.tapB, false, "после стрейфа карта не открывается")

    press(400, false, false, true)
    press(400 + api.MAP_TAP_MS + 50, false, false, false)
    assert.equal(pad.tapB, false, "долгое удержание B — не тап")

    press(900, true, false, false)
    assert.equal(input.turn, -1, "без B стрелки поворачивают")
    assert.equal(input.strafe, 0)
})

test("A, зажатая со старта, не стреляет, пока её не отпустят", () => {
    const pad = new api.Pad()
    const input = new api.Input()
    const a = (down: boolean) => api.readPad(pad, input, 0, true, false, false, false, down, false)

    a(true)
    assert.equal(pad.tapA, true)
    assert.equal(input.fire, false, "латч после старта")
    assert.equal(input.fwd, 1)
    a(true)
    assert.equal(pad.tapA, false)
    assert.equal(input.fire, false)
    a(false)
    a(true)
    assert.equal(input.fire, true, "новое нажатие стреляет")
})

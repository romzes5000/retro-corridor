import assert from "node:assert/strict"
import test from "node:test"
import { loadLogic, type World } from "./load-logic.ts"

const api = loadLogic()
const { FP, createWorld, update, distance } = api
const DT = 20

function run(world: World, ms: number, set: (input: InstanceType<typeof api.Input>, t: number) => void = () => {}): string[] {
    const events: string[] = []
    for (let t = 0; t < ms && !world.lost && !world.won; t += DT) {
        const input = new api.Input()
        set(input, t)
        update(world, input, DT)
        events.push(...world.events)
    }
    return events
}

const gap = (world: World) => distance(world.enemies[0].x, world.enemies[0].y, world.x, world.y)

test("стрелок подходит на 3–5 клеток, бросает шар и попадает на 15", () => {
    const world = createWorld(["###############", "#S.......F....#", "###############"], 0)
    const shooter = world.enemies[0]
    assert.equal(shooter.kind, api.ENEMY_SHOOTER)
    assert.equal(shooter.hp, 3)

    const first = run(world, api.SHOT_AIM_MS - 100)
    assert.ok(first.includes("alert"))
    assert.equal(first.includes("fireball"), false, "сначала прицеливается")
    const thrown = run(world, 300)
    assert.ok(thrown.includes("fireball"))
    assert.equal(world.shots.length, 1)
    assert.ok(world.shots[0].vx < 0 && world.shots[0].vy === 0, "шар летит в игрока")

    const later = run(world, 3000)
    assert.ok(later.includes("hurt"))
    assert.equal((100 - world.health) % api.SHOT_DAMAGE, 0, `здоровье ${world.health}`)
    assert.ok(gap(world) >= api.KEEP_NEAR - 200 && gap(world) <= api.KEEP_FAR + 200, `дистанция ${gap(world)}`)
})

test("стрелок, к которому подошли вплотную, пятится", () => {
    const world = createWorld(["###############", "#....S.F......#", "###############"], 0)
    run(world, 100)
    const before = gap(world)
    run(world, 800)
    assert.ok(gap(world) > before + 300, `было ${before}, стало ${gap(world)}`)
})

test("шар гаснет о стену и не задевает игрока за спиной стрелка", () => {
    const world = createWorld(["#######", "#S....#", "#######"], 0)
    world.shots.push(new api.Shot(4 * FP, FP + FP / 2, api.SHOT_SPEED, 0))
    const events = run(world, 1000)
    assert.ok(events.includes("splash"))
    assert.equal(world.shots.length, 0)
    assert.equal(world.health, 100)
})

test("рыцарь живучий (6 HP) и кусает на 25", () => {
    const world = createWorld(["######", "#S.K.#", "######"], 0)
    const knight = world.enemies[0]
    assert.equal(knight.hp, 6)
    run(world, 1000)
    assert.equal(world.health, 100 - api.ENEMY_BITE[api.ENEMY_KNIGHT], "один укус за секунду")
    for (let i = 0; i < 5; i++) api.damageEnemy(world, 0, 1)
    assert.equal(knight.dead, false, "пяти пуль мало")
    api.damageEnemy(world, 0, 1)
    assert.equal(knight.dead, true)
    assert.equal(world.score, api.ENEMY_SCORE[api.ENEMY_KNIGHT])
})

test("босс бросает веер из трёх шаров, выход открывается только после его смерти", () => {
    const world = createWorld(["############", "#S.......Z.X", "############"], 0)
    assert.equal(world.exitLocked, true)
    const boss = world.enemies[0]
    assert.equal(boss.hp, 30)
    const events = run(world, api.SHOT_AIM_MS + 100)
    assert.ok(events.includes("fireball"))
    assert.equal(world.shots.length, 3)
    const dirs = world.shots.map((s) => Math.round(Math.atan2(s.vy, s.vx) * 1000))
    assert.equal(new Set(dirs).size, 3, `направления ${dirs}`)
    for (const s of world.shots) assert.ok(Math.abs(Math.hypot(s.vx, s.vy) - api.SHOT_SPEED) < 30)

    for (let i = 0; i < 29; i++) api.damageEnemy(world, 0, 1)
    assert.equal(world.exitLocked, true)
    world.events = []
    api.damageEnemy(world, 0, 1)
    assert.ok(world.events.includes("unlock"))
    assert.equal(world.exitLocked, false)
})

test("дробовик: три дробины, урон падает с дистанцией, 2 патрона и 700 мс перезарядки", () => {
    assert.equal(api.pelletDamage(FP), 3)
    assert.equal(api.pelletDamage(3 * FP), 2)
    assert.equal(api.pelletDamage(6 * FP), 1)

    const loss = (cells: number) => {
        const row = "#S" + ".".repeat(cells - 1) + "K" + "....#"
        const world = createWorld(["#".repeat(row.length), row, "#".repeat(row.length)], 0)
        world.hasShotgun = true
        world.weapon = api.WEAPON_SHOTGUN
        const events = run(world, DT, (input) => { input.fire = true })
        assert.ok(events.includes("blast"))
        assert.equal(world.ammo, api.START_AMMO - api.SHOTGUN_AMMO)
        return { lost: 6 - world.enemies[0].hp, world }
    }
    const near = loss(1)
    assert.ok(near.lost >= 6, `в упор снял ${near.lost}`)
    const far = loss(6)
    assert.ok(far.lost >= 1 && far.lost <= 3, `издалека снял ${far.lost}`)

    const world = far.world
    const early = run(world, 600, (input) => { input.fire = true })
    assert.equal(early.includes("blast"), false, "перезарядка 700 мс")
    const again = run(world, 200, (input) => { input.fire = true })
    assert.ok(again.includes("blast"))
})

test("дробовик с одним патроном щёлкает вхолостую, пистолет снимает одно очко", () => {
    const world = createWorld(["######", "#S.K.#", "######"], 0)
    world.hasShotgun = true
    world.weapon = api.WEAPON_SHOTGUN
    world.ammo = 1
    assert.ok(run(world, DT, (input) => { input.fire = true }).includes("empty"))
    assert.equal(world.ammo, 1)
    world.weapon = api.WEAPON_PISTOL
    world.fireCool = 0
    assert.ok(run(world, DT, (input) => { input.fire = true }).includes("shoot"))
    assert.equal(world.enemies[0].hp, 5)
})

test("G даёт дробовик и сразу в руки, двойной B меняет оружие, без дробовика — ничего", () => {
    const world = createWorld(["######", "#S.G.#", "######"], 0)
    assert.equal(run(world, 100, (input) => { input.swap = true }).includes("swap"), false)
    const picked = run(world, 1000, (input) => { input.fwd = 1 })
    assert.ok(picked.includes("weapon"))
    assert.equal(world.hasShotgun, true)
    assert.equal(world.weapon, api.WEAPON_SHOTGUN)
    assert.equal(world.ammo, api.START_AMMO + api.SHOTGUN_PICKUP)
    assert.ok(run(world, DT, (input) => { input.swap = true }).includes("swap"))
    assert.equal(world.weapon, api.WEAPON_PISTOL)
    run(world, DT, (input) => { input.swap = true })
    assert.equal(world.weapon, api.WEAPON_SHOTGUN)
})

test("дробовик переносится на следующий уровень и остаётся после смерти", () => {
    const s = api.startSession(api.RUN_CAMPAIGN, api.DIFF_NORMAL)
    s.level = 1
    const warehouse = api.enterLevel(s)
    assert.equal(warehouse.hasShotgun, false)
    warehouse.hasShotgun = true
    warehouse.weapon = api.WEAPON_SHOTGUN
    api.completeLevel(s, warehouse)
    const arena = api.enterLevel(s)
    assert.equal(arena.hasShotgun, true)
    assert.equal(arena.weapon, api.WEAPON_SHOTGUN)
    assert.equal(arena.exitLocked, true, "на арене есть босс")
    assert.equal(api.enterLevel(s).hasShotgun, true, "рестарт после смерти")
})

test("на складе лежит дробовик, на арене — босс, рыцари и стрелки", () => {
    const [, warehouse, arena] = api.LEVELS
    assert.ok(warehouse.map.join("").includes("G"))
    const kinds = createWorld(arena.map, 0).enemies.map((e) => e.kind)
    assert.equal(kinds.filter((k) => k === api.ENEMY_BOSS).length, 1)
    assert.ok(kinds.includes(api.ENEMY_KNIGHT) && kinds.includes(api.ENEMY_SHOOTER))
})

// Pure game logic shared by the console build (MakeCode Static TypeScript) and Node tests.
// All hot-path math is integer fixed point: on hardware a non-integer number is a heap-boxed
// double, so floats in the per-column loop would cost several allocations per pixel column.
namespace corridor {
    export const FP = 1024
    export const ANGLES = 1024
    export const VIEW_W = 160
    export const VIEW_H = 100

    export const TILE_FLOOR = 0
    export const TILE_STONE = 1
    export const TILE_BRICK = 2
    export const TILE_EXIT = 3
    export const TILE_DOOR = 4
    export const TILE_DOOR_RED = 5
    export const TILE_DOOR_BLUE = 6
    export const TILE_SECRET = 7

    export const ITEM_HEALTH = 0
    export const ITEM_AMMO = 1
    export const ITEM_KEY_RED = 2
    export const ITEM_KEY_BLUE = 3
    export const ITEM_SHOTGUN = 4

    export const WEAPON_PISTOL = 0
    export const WEAPON_SHOTGUN = 1
    export const SHOTGUN_AMMO = 2
    export const SHOTGUN_COOLDOWN = 700
    export const SHOTGUN_PICKUP = 6
    // Pellet columns either side of the crosshair: 12 of 1024 angle units with this FOV.
    export const SPREAD_COLS = 9

    export const KEY_RED = 1
    export const KEY_BLUE = 2

    export const DOOR_OPEN_MS = 400
    export const DOOR_HOLD_MS = 3000
    export const DOOR_PASS = 920
    export const SECRET_MS = 1000
    export const USE_REACH = 800
    export const USE_COOLDOWN = 250

    export const DIFF_EASY = 0
    export const DIFF_NORMAL = 1
    export const DIFF_HARD = 2
    export const DIFF_NAMES = ["EASY", "NORMAL", "HARD"]
    // Damage the player takes, percent of nominal, by difficulty.
    export const DIFF_DAMAGE = [50, 100, 150]

    // Distances (FP) where a positional sound drops to the next quieter set.
    export const SOUND_NEAR = 3 * 1024
    export const SOUND_FAR = 7 * 1024

    // Per-cell light: extra darkening steps 0..3, or LIGHT_FLICKER for a failing lamp.
    export const LIGHT_FLICKER = 4
    export const LAVA_DAMAGE = 5
    export const LAVA_TICK_MS = 1000
    export const LAVA_FIRST_MS = 200

    export const DECALS_MAX = 24
    export const DECAL_BLOOD = 0
    export const DECAL_SCORCH = 1
    export const DIE_FRAME_MS = 110
    export const GROWL_MIN_MS = 2000
    export const GROWL_SPREAD_MS = 2000

    export const PLAYER_RADIUS = 225
    export const MOVE_SPEED = 2900
    export const STRAFE_SPEED = 2400
    export const TURN_SLOW = 220
    export const TURN_FAST = 520
    export const TURN_RAMP_MS = 160
    export const STRIDE = 760

    export const FIRE_COOLDOWN = 320
    export const START_AMMO = 20
    export const AMMO_PICKUP = 10
    export const HEALTH_PICKUP = 25

    export const IMP_HP = 2
    export const IMP_SPEED = 1450
    export const IMP_RADIUS = 260
    export const IMP_SIGHT = 9 * 1024
    export const IMP_REACH = 900
    export const IMP_DAMAGE = 12
    export const IMP_COOLDOWN = 900
    export const IMP_ATTACK_MS = 220
    export const IMP_HURT_MS = 160
    export const TOUCH = 520

    const FOV_K = 676
    const MAX_STEPS = 48
    const BIG = 1 << 19

    export const SIN: number[] = []
    for (let i = 0; i < ANGLES; i++) {
        SIN.push(Math.round(Math.sin((i * 2 * Math.PI) / ANGLES) * FP))
    }

    export function sin(a: number): number {
        return SIN[a & (ANGLES - 1)]
    }

    export function cos(a: number): number {
        return SIN[(a + (ANGLES >> 2)) & (ANGLES - 1)]
    }

    // Small deterministic PRNG (ZX81 LCG): products stay far below 2^31 on hardware and in Node.
    export function nextRand(seed: number): number {
        return (seed * 75 + 74) % 65537
    }

    export class Rng {
        seed: number
        constructor(seed: number) {
            this.seed = ((seed % 65537) + 65537) % 65537
        }
        next(n: number): number {
            this.seed = nextRand(this.seed)
            return n <= 1 ? 0 : this.seed % n
        }
    }

    export const CAMX: number[] = []
    for (let c = 0; c < VIEW_W; c++) {
        CAMX.push(Math.idiv((2 * c + 1 - VIEW_W) * FP, VIEW_W))
    }

    export const ENEMY_IMP = 0

    export class Enemy {
        kind: number
        x: number
        y: number
        hp: number
        dead: boolean
        awake: boolean
        sees: boolean
        cool: number
        hurt: number
        attack: number
        walk: number
        hunting: boolean
        lastX: number
        lastY: number
        deadMs: number
        growl: number
        constructor(kind: number, x: number, y: number) {
            this.kind = kind
            this.deadMs = 0
            this.growl = 0
            this.x = x
            this.y = y
            this.hunting = false
            this.lastX = x
            this.lastY = y
            this.hp = ENEMY_HP[kind]
            this.dead = false
            this.awake = false
            this.sees = false
            this.cool = 0
            this.hurt = 0
            this.attack = 0
            this.walk = 0
        }
    }

    export class Decal {
        x: number
        y: number
        kind: number
        constructor(x: number, y: number, kind: number) {
            this.x = x
            this.y = y
            this.kind = kind
        }
    }

    export class Item {
        x: number
        y: number
        kind: number
        taken: boolean
        constructor(x: number, y: number, kind: number) {
            this.x = x
            this.y = y
            this.kind = kind
            this.taken = false
        }
    }

    export class Input {
        fwd: number
        strafe: number
        turn: number
        fire: boolean
        swap: boolean
        constructor() {
            this.fwd = 0
            this.strafe = 0
            this.turn = 0
            this.fire = false
            this.swap = false
        }
    }

    export class World {
        grid: number[]
        w: number
        h: number
        x: number
        y: number
        ang: number
        health: number
        ammo: number
        score: number
        kills: number
        total: number
        time: number
        fireCool: number
        stride: number
        turnHold: number
        won: boolean
        lost: boolean
        enemies: Enemy[]
        items: Item[]
        events: string[]
        doors: Door[]
        doorIndex: number[]
        pushes: Push[]
        keys: number
        exitLocked: boolean
        itemsTotal: number
        itemsTaken: number
        secrets: number
        found: number
        lockedCool: number
        shots: Shot[]
        weapon: number
        hasShotgun: boolean
        eventDist: number[]
        decals: Decal[]
        decalNext: number
        difficulty: number
        rng: Rng
        light: number[]
        lava: number[]
        lavaMs: number
        constructor() {
            this.light = []
            this.lava = []
            this.lavaMs = LAVA_TICK_MS - LAVA_FIRST_MS
            this.eventDist = []
            this.decals = []
            this.decalNext = 0
            this.difficulty = DIFF_NORMAL
            this.rng = new Rng(1)
            this.shots = []
            this.weapon = WEAPON_PISTOL
            this.hasShotgun = false
            this.doors = []
            this.doorIndex = []
            this.pushes = []
            this.keys = 0
            this.exitLocked = false
            this.itemsTotal = 0
            this.itemsTaken = 0
            this.secrets = 0
            this.found = 0
            this.lockedCool = 0
            this.grid = []
            this.w = 0
            this.h = 0
            this.x = FP + (FP >> 1)
            this.y = FP + (FP >> 1)
            this.ang = 0
            this.health = 100
            this.ammo = START_AMMO
            this.score = 0
            this.kills = 0
            this.total = 0
            this.time = 0
            this.fireCool = 0
            this.stride = 0
            this.turnHold = 0
            this.won = false
            this.lost = false
            this.enemies = []
            this.items = []
            this.events = []
        }
    }

    export class Hit {
        dist: number
        side: number
        tile: number
        texX: number
        cellX: number
        cellY: number
        rdx: number
        rdy: number
        light: number
        constructor() {
            this.rdx = 0
            this.rdy = 0
            this.light = 0
            this.dist = 0
            this.side = 0
            this.tile = 0
            this.texX = 0
            this.cellX = 0
            this.cellY = 0
        }
    }

    export class Proj {
        depth: number
        screenX: number
        size: number
        visible: boolean
        constructor() {
            this.depth = 0
            this.screenX = 0
            this.size = 0
            this.visible = false
        }
    }

    function tileOf(ch: string): number {
        if (ch == "#") return TILE_STONE
        if (ch == "B") return TILE_BRICK
        if (ch == "X") return TILE_EXIT
        if (ch == "|") return TILE_DOOR
        if (ch == "R") return TILE_DOOR_RED
        if (ch == "D") return TILE_DOOR_BLUE
        if (ch == "P") return TILE_SECRET
        return TILE_FLOOR
    }

    export function isDoor(tile: number): boolean {
        return tile >= TILE_DOOR && tile <= TILE_DOOR_BLUE
    }

    function center(cell: number): number {
        return cell * FP + (FP >> 1)
    }

    // ang: 0 = east, 256 = south, 512 = west, 768 = north (y grows down the map).
    export function createWorld(source: string[], ang: number): World {
        const world = new World()
        world.h = source.length
        world.w = 0
        for (let r = 0; r < source.length; r++) {
            if (source[r].length > world.w) world.w = source[r].length
        }
        for (let r = 0; r < world.h; r++) {
            const row = source[r]
            for (let c = 0; c < world.w; c++) {
                const ch = c < row.length ? row.charAt(c) : "#"
                world.grid.push(tileOf(ch))
                world.light.push(0)
                world.lava.push(ch == "L" ? 1 : 0)
                if (ch == "S") {
                    world.x = center(c)
                    world.y = center(r)
                } else if (kindOf(ch) >= 0) {
                    world.enemies.push(new Enemy(kindOf(ch), center(c), center(r)))
                    if (ch == "Z") world.exitLocked = true
                } else if (ch == "G") {
                    world.items.push(new Item(center(c), center(r), ITEM_SHOTGUN))
                } else if (ch == "H") {
                    world.items.push(new Item(center(c), center(r), ITEM_HEALTH))
                } else if (ch == "A") {
                    world.items.push(new Item(center(c), center(r), ITEM_AMMO))
                } else if (ch == "r") {
                    world.items.push(new Item(center(c), center(r), ITEM_KEY_RED))
                } else if (ch == "b") {
                    world.items.push(new Item(center(c), center(r), ITEM_KEY_BLUE))
                } else if (ch == "P") {
                    world.secrets += 1
                }
            }
        }
        setupDoors(world)
        world.rng = new Rng(world.w * 131 + world.h * 7 + world.enemies.length)
        world.itemsTotal = world.items.length
        world.total = world.enemies.length
        world.ang = ang & (ANGLES - 1)
        return world
    }

    // Light layer as rectangles: flat [x0, y0, x1, y1, level] tuples, inclusive bounds.
    export function setLights(world: World, rects: number[]): void {
        for (let i = 0; i + 4 < rects.length; i += 5) {
            for (let cy = Math.max(0, rects[i + 1]); cy <= Math.min(world.h - 1, rects[i + 3]); cy++) {
                for (let cx = Math.max(0, rects[i]); cx <= Math.min(world.w - 1, rects[i + 2]); cx++) {
                    world.light[cy * world.w + cx] = rects[i + 4]
                }
            }
        }
    }

    // Darkening steps for a cell right now; flickering cells blink on a per-cell rhythm.
    export function lightAt(world: World, cx: number, cy: number): number {
        if (cx < 0 || cy < 0 || cx >= world.w || cy >= world.h) return 0
        const base = world.light[cy * world.w + cx]
        if (base != LIGHT_FLICKER) return base
        return ((world.time >> 7) * 13 + cx * 7 + cy * 11) % 9 < 3 ? 3 : 0
    }

    export function lavaAt(world: World, cx: number, cy: number): boolean {
        if (cx < 0 || cy < 0 || cx >= world.w || cy >= world.h) return false
        return world.lava[cy * world.w + cx] == 1
    }

    export function tileAt(world: World, cx: number, cy: number): number {
        if (cx < 0 || cy < 0 || cx >= world.w || cy >= world.h) return TILE_STONE
        return world.grid[cy * world.w + cx]
    }

    // A cell stops bodies and sight unless it is floor or a door that is (almost) fully open.
    export function blocks(world: World, cx: number, cy: number): boolean {
        const tile = tileAt(world, cx, cy)
        if (tile == TILE_FLOOR) return false
        if (isDoor(tile)) return world.doors[world.doorIndex[cy * world.w + cx]].progress < DOOR_PASS
        return true
    }

    export function solidAt(world: World, x: number, y: number): boolean {
        return blocks(world, x >> 10, y >> 10)
    }

    // Square body of half-size r centred at (x, y) overlaps no wall.
    export function fits(world: World, x: number, y: number, r: number): boolean {
        return !solidAt(world, x - r, y - r) && !solidAt(world, x + r, y - r)
            && !solidAt(world, x - r, y + r) && !solidAt(world, x + r, y + r)
    }

    // DDA ray through the grid; dist is perpendicular to the camera plane, so walls stay straight.
    export function castRay(world: World, rdx: number, rdy: number, hit: Hit): void {
        const px = world.x
        const py = world.y
        let mx = px >> 10
        let my = py >> 10
        const ddx = rdx == 0 ? BIG : Math.min(BIG, Math.idiv(FP * FP, Math.abs(rdx)))
        const ddy = rdy == 0 ? BIG : Math.min(BIG, Math.idiv(FP * FP, Math.abs(rdy)))
        let stepX = 1
        let stepY = 1
        let sdx = 0
        let sdy = 0
        if (rdx < 0) {
            stepX = -1
            sdx = ((px - (mx << 10)) * ddx) >> 10
        } else {
            sdx = ((((mx + 1) << 10) - px) * ddx) >> 10
        }
        if (rdy < 0) {
            stepY = -1
            sdy = ((py - (my << 10)) * ddy) >> 10
        } else {
            sdy = ((((my + 1) << 10) - py) * ddy) >> 10
        }
        let side = 0
        let tile = TILE_STONE
        let doorDist = -1
        let doorTex = 0
        for (let i = 0; i < MAX_STEPS; i++) {
            if (sdx < sdy) {
                sdx += ddx
                mx += stepX
                side = 0
            } else {
                sdy += ddy
                my += stepY
                side = 1
            }
            tile = tileAt(world, mx, my)
            if (tile == TILE_FLOOR) continue
            if (!isDoor(tile)) break
            const door = world.doors[world.doorIndex[my * world.w + mx]]
            if (door.vertical != (side == 0)) {
                tile = TILE_STONE
                break
            }
            // The door is a plane through the middle of its cell, slid sideways by `progress`.
            const half = side == 0 ? sdx - (ddx >> 1) : sdy - (ddy >> 1)
            if (half >= (side == 0 ? sdy : sdx)) continue
            const frac = (side == 0 ? py + ((half * rdy) >> 10) : px + ((half * rdx) >> 10)) & (FP - 1)
            if (frac < door.progress) continue
            doorDist = half
            doorTex = (frac - door.progress) >> 6
            break
        }
        let dist = doorDist >= 0 ? doorDist : side == 0 ? sdx - ddx : sdy - ddy
        if (dist < 16) dist = 16
        let wall = side == 0 ? py + ((dist * rdy) >> 10) : px + ((dist * rdx) >> 10)
        let texX = (wall & (FP - 1)) >> 6
        if (side == 0 && rdx < 0) texX = 15 - texX
        if (side == 1 && rdy > 0) texX = 15 - texX
        if (doorDist >= 0) texX = doorTex
        hit.dist = dist
        hit.side = side
        hit.tile = tile
        hit.texX = texX
        hit.cellX = mx
        hit.cellY = my
        hit.rdx = rdx
        hit.rdy = rdy
        if (doorDist >= 0) hit.light = lightAt(world, mx, my)
        else hit.light = side == 0 ? lightAt(world, mx - stepX, my) : lightAt(world, mx, my - stepY)
    }

    export function castColumn(world: World, col: number, hit: Hit): void {
        const dx = cos(world.ang)
        const dy = sin(world.ang)
        const k = CAMX[col]
        const planeX = (-dy * FOV_K) >> 10
        const planeY = (dx * FOV_K) >> 10
        castRay(world, dx + ((planeX * k) >> 10), dy + ((planeY * k) >> 10), hit)
    }

    export function wallHeight(dist: number): number {
        return Math.idiv(VIEW_H * FP, dist)
    }

    // 0 = full brightness .. 3 = darkest. Y-facing walls are one step darker so corners read.
    // The exit ignores distance so it stays bright yellow down a long corridor.
    export function shadeFor(dist: number, side: number, tile: number): number {
        if (tile == TILE_EXIT) return side
        const s = (dist >> 11) + side
        return s > 3 ? 3 : s
    }

    export function project(world: World, sx: number, sy: number, out: Proj): void {
        const dx = cos(world.ang)
        const dy = sin(world.ang)
        const planeX = (-dy * FOV_K) >> 10
        const planeY = (dx * FOV_K) >> 10
        const relX = sx - world.x
        const relY = sy - world.y
        const det = (planeX * dy - dx * planeY) >> 10
        const tx = Math.idiv(dy * relX - dx * relY, det)
        const ty = Math.idiv(planeX * relY - planeY * relX, det)
        out.depth = ty
        if (ty < 96) {
            out.visible = false
            out.screenX = 0
            out.size = 0
            return
        }
        out.screenX = (VIEW_W >> 1) + Math.idiv((VIEW_W >> 1) * tx, ty)
        out.size = Math.idiv(VIEW_H * FP, ty)
        const half = out.size >> 1
        out.visible = out.screenX + half >= 0 && out.screenX - half < VIEW_W
    }

    export function canSee(world: World, ax: number, ay: number, bx: number, by: number): boolean {
        const dx = bx - ax
        const dy = by - ay
        const len = Math.max(Math.abs(dx), Math.abs(dy))
        const steps = (len >> 8) + 1
        for (let i = 1; i < steps; i++) {
            if (solidAt(world, ax + Math.idiv(dx * i, steps), ay + Math.idiv(dy * i, steps))) return false
        }
        return true
    }

    export function distance(ax: number, ay: number, bx: number, by: number): number {
        const dx = bx - ax
        const dy = by - ay
        return Math.floor(Math.sqrt(dx * dx + dy * dy))
    }

    // Blocks only steps that bring the player closer to a live enemy, so backing off always works.
    function blockedByEnemy(world: World, x: number, y: number): boolean {
        for (const enemy of world.enemies) {
            if (enemy.dead) continue
            const next = distance(enemy.x, enemy.y, x, y)
            if (next < touchFor(enemy) && next < distance(enemy.x, enemy.y, world.x, world.y)) return true
        }
        return false
    }

    export function emit(world: World, ev: string): void {
        world.events.push(ev)
        world.eventDist.push(0)
    }

    // Event with a source in the world; main.ts picks a quieter sound set the farther it is.
    export function emitAt(world: World, ev: string, x: number, y: number): void {
        world.events.push(ev)
        world.eventDist.push(distance(x, y, world.x, world.y))
    }

    // 0 loud, 1 mid, 2 quiet.
    export function soundLevel(dist: number): number {
        if (dist < SOUND_NEAR) return 0
        if (dist < SOUND_FAR) return 1
        return 2
    }

    // Ring buffer: the 25th decal overwrites the oldest, so memory and draw cost stay flat.
    export function addDecal(world: World, x: number, y: number, kind: number): void {
        const d = new Decal(x, y, kind)
        if (world.decals.length < DECALS_MAX) {
            world.decals.push(d)
        } else {
            world.decals[world.decalNext] = d
        }
        world.decalNext = (world.decalNext + 1) % DECALS_MAX
    }

    // Moves along each axis separately so a diagonal push slides along a wall instead of sticking.
    function movePlayer(world: World, mx: number, my: number): number {
        let moved = 0
        const r = PLAYER_RADIUS
        if (mx != 0) {
            const nx = world.x + mx
            const probe = nx + (mx > 0 ? r : -r)
            if (fits(world, nx, world.y, r) && !blockedByEnemy(world, nx, world.y)) {
                world.x = nx
                moved += Math.abs(mx)
            } else if (tileAt(world, probe >> 10, world.y >> 10) == TILE_EXIT) {
                touchExit(world)
            }
        }
        if (my != 0) {
            const ny = world.y + my
            const probe = ny + (my > 0 ? r : -r)
            if (fits(world, world.x, ny, r) && !blockedByEnemy(world, world.x, ny)) {
                world.y = ny
                moved += Math.abs(my)
            } else if (tileAt(world, world.x >> 10, probe >> 10) == TILE_EXIT) {
                touchExit(world)
            }
        }
        return moved
    }

    function touchExit(world: World): void {
        if (!world.exitLocked) {
            world.won = true
            return
        }
        if (world.lockedCool <= 0) {
            world.lockedCool = 1000
            emit(world, "locked")
        }
    }

    // Nearest live enemy under screen column `col` and in front of the wall, or -1.
    export function targetAt(world: World, col: number): number {
        const hit = new Hit()
        castColumn(world, col, hit)
        const p = new Proj()
        let best = -1
        let bestDepth = hit.dist
        for (let i = 0; i < world.enemies.length; i++) {
            const enemy = world.enemies[i]
            if (enemy.dead) continue
            project(world, enemy.x, enemy.y, p)
            if (!p.visible || p.depth >= bestDepth) continue
            const reach = Math.max(4, Math.idiv(p.size * 3 * ENEMY_SIZE[enemy.kind], 8 * ENEMY_SIZE[ENEMY_IMP]))
            if (Math.abs(p.screenX - col) <= reach) {
                best = i
                bestDepth = p.depth
            }
        }
        return best
    }

    // Nearest live enemy under the crosshair, or -1.
    export function target(world: World): number {
        return targetAt(world, VIEW_W >> 1)
    }

    export function damageEnemy(world: World, i: number, damage: number): void {
        const enemy = world.enemies[i]
        if (enemy.dead) return
        enemy.hp -= damage
        enemy.hurt = IMP_HURT_MS
        enemy.awake = true
        addDecal(world, enemy.x + world.rng.next(301) - 150, enemy.y + world.rng.next(301) - 150, DECAL_BLOOD)
        if (enemy.hp > 0) {
            emitAt(world, "hit", enemy.x, enemy.y)
            return
        }
        enemy.dead = true
        world.kills += 1
        world.score += ENEMY_SCORE[enemy.kind]
        emitAt(world, "kill", enemy.x, enemy.y)
        if (enemy.kind == ENEMY_BOSS) {
            world.exitLocked = false
            emit(world, "unlock")
        }
    }

    // Shotgun pellet damage falls off with range: 3 point blank, 2 mid, 1 far.
    export function pelletDamage(dist: number): number {
        if (dist < 2 * FP) return 3
        if (dist < 4 * FP) return 2
        return 1
    }

    function fire(world: World): void {
        if (world.fireCool > 0) return
        const shotgun = world.weapon == WEAPON_SHOTGUN
        const cost = shotgun ? SHOTGUN_AMMO : 1
        const cool = shotgun ? SHOTGUN_COOLDOWN : FIRE_COOLDOWN
        world.fireCool = cool
        if (world.ammo < cost) {
            emit(world, "empty")
            return
        }
        world.ammo -= cost
        if (!shotgun) {
            emit(world, "shoot")
            const i = target(world)
            if (i >= 0) damageEnemy(world, i, 1)
            return
        }
        emit(world, "blast")
        for (let k = -1; k <= 1; k++) {
            const i = targetAt(world, (VIEW_W >> 1) + k * SPREAD_COLS)
            if (i < 0) continue
            const enemy = world.enemies[i]
            damageEnemy(world, i, pelletDamage(distance(enemy.x, enemy.y, world.x, world.y)))
        }
    }

    // Lava: first burn LAVA_FIRST_MS after stepping in, then LAVA_DAMAGE every LAVA_TICK_MS.
    function burn(world: World, dt: number): void {
        if (!lavaAt(world, world.x >> 10, world.y >> 10)) {
            world.lavaMs = LAVA_TICK_MS - LAVA_FIRST_MS
            return
        }
        world.lavaMs += dt
        while (world.lavaMs >= LAVA_TICK_MS && !world.lost) {
            world.lavaMs -= LAVA_TICK_MS
            hurtPlayer(world, LAVA_DAMAGE)
        }
    }

    function pickUp(world: World): void {
        for (const item of world.items) {
            if (item.taken) continue
            if (Math.abs(item.x - world.x) > TOUCH || Math.abs(item.y - world.y) > TOUCH) continue
            if (item.kind == ITEM_HEALTH) {
                if (world.health >= 100) continue
                world.health = Math.min(100, world.health + HEALTH_PICKUP)
            } else if (item.kind == ITEM_AMMO) {
                world.ammo += AMMO_PICKUP
            } else if (item.kind == ITEM_KEY_RED) {
                world.keys |= KEY_RED
            } else if (item.kind == ITEM_KEY_BLUE) {
                world.keys |= KEY_BLUE
            } else if (item.kind == ITEM_SHOTGUN) {
                world.hasShotgun = true
                world.weapon = WEAPON_SHOTGUN
                world.ammo += SHOTGUN_PICKUP
            }
            item.taken = true
            world.itemsTaken += 1
            world.score += 10
            if (item.kind == ITEM_SHOTGUN) emit(world, "weapon")
            else emit(world, item.kind >= ITEM_KEY_RED && item.kind <= ITEM_KEY_BLUE ? "key" : "pickup")
        }
    }

    export function update(world: World, input: Input, dt: number): void {
        world.events = []
        world.eventDist = []
        if (world.won || world.lost) return
        if (dt > 100) dt = 100
        if (dt < 0) dt = 0
        world.time += dt
        if (world.fireCool > 0) world.fireCool -= dt
        if (world.lockedCool > 0) world.lockedCool -= dt
        updateDoors(world, dt)

        if (input.turn != 0) {
            world.turnHold += dt
            const speed = world.turnHold < TURN_RAMP_MS ? TURN_SLOW : TURN_FAST
            world.ang = (world.ang + input.turn * Math.idiv(speed * dt, 1000)) & (ANGLES - 1)
        } else {
            world.turnHold = 0
        }

        const dx = cos(world.ang)
        const dy = sin(world.ang)
        const fwd = Math.idiv(MOVE_SPEED * dt, 1000) * input.fwd
        const side = Math.idiv(STRAFE_SPEED * dt, 1000) * input.strafe
        const mx = ((dx * fwd) >> 10) - ((dy * side) >> 10)
        const my = ((dy * fwd) >> 10) + ((dx * side) >> 10)
        if (mx != 0 || my != 0) {
            const before = Math.idiv(world.stride, STRIDE)
            world.stride += movePlayer(world, mx, my)
            if (Math.idiv(world.stride, STRIDE) != before) emit(world, "step")
            if (world.won) {
                emit(world, "win")
                return
            }
        }

        if (input.swap && world.hasShotgun) {
            world.weapon = world.weapon == WEAPON_SHOTGUN ? WEAPON_PISTOL : WEAPON_SHOTGUN
            emit(world, "swap")
        }
        if (input.fire && world.fireCool <= 0) {
            if (useAhead(world)) world.fireCool = USE_COOLDOWN
            else fire(world)
        }
        for (const enemy of world.enemies) {
            if (enemy.dead) enemy.deadMs += dt
            else thinkEnemy(world, enemy, dt)
            if (world.lost) return
        }
        updateShots(world, dt)
        if (world.lost) return
        burn(world, dt)
        if (world.lost) return
        pickUp(world)
    }

    export const MAP_TAP_MS = 300
    export const PAUSE_HOLD_MS = 600
    export const DIR_UP = 1
    export const DIR_DOWN = 2
    export const DIR_LEFT = 4
    export const DIR_RIGHT = 8

    export function pct(part: number, total: number): number {
        return total <= 0 ? 100 : Math.idiv(part * 100, total)
    }

    export class Pad {
        aWas: boolean
        aLatch: boolean
        bWas: boolean
        bStart: number
        bStrafed: boolean
        tapA: boolean
        tapB: boolean
        tapB2: boolean
        bPending: boolean
        bUp: number
        bDouble: boolean
        longB: boolean
        bHeld: boolean
        dirsWas: number
        tapDirs: number
        constructor() {
            this.dirsWas = 0
            this.tapDirs = 0
            this.aWas = false
            this.aLatch = true
            this.bWas = false
            this.bStart = 0
            this.bStrafed = false
            this.tapA = false
            this.tapB = false
            this.tapB2 = false
            this.bPending = false
            this.bUp = 0
            this.bDouble = false
            this.longB = false
            this.bHeld = false
        }
    }

    // Buttons -> Input. Holding B turns left/right into strafe. A quick B tap sets tapB (map) only
    // MAP_TAP_MS after release, so a second tap inside that window can become tapB2 (weapon swap).
    // Holding B for PAUSE_HOLD_MS without arrows sets longB (pause) once.
    // A held over a screen change (aLatch) does not fire until released.
    export function readPad(pad: Pad, input: Input, now: number, up: boolean, down: boolean,
        left: boolean, right: boolean, a: boolean, b: boolean): void {
        pad.tapA = a && !pad.aWas
        pad.aWas = a
        if (!a) pad.aLatch = false
        input.fire = a && !pad.aLatch
        const lr = (right ? 1 : 0) - (left ? 1 : 0)
        pad.tapB = false
        pad.tapB2 = false
        pad.longB = false
        if (b && !pad.bWas) {
            pad.bHeld = false
            pad.bDouble = pad.bPending && now - pad.bUp < MAP_TAP_MS
            pad.bPending = false
            pad.bStart = now
            pad.bStrafed = false
        }
        if (b) {
            input.strafe = lr
            input.turn = 0
            if (lr != 0) pad.bStrafed = true
            if (!pad.bStrafed && !pad.bHeld && now - pad.bStart >= PAUSE_HOLD_MS) {
                pad.bHeld = true
                pad.longB = true
            }
        } else {
            input.strafe = 0
            input.turn = lr
            if (pad.bWas && !pad.bStrafed && now - pad.bStart < MAP_TAP_MS) {
                if (pad.bDouble) {
                    pad.tapB2 = true
                } else {
                    pad.bPending = true
                    pad.bUp = now
                }
            }
            if (pad.bPending && now - pad.bUp >= MAP_TAP_MS) {
                pad.bPending = false
                pad.tapB = true
            }
        }
        input.swap = pad.tapB2
        pad.bWas = b
        input.fwd = (up ? 1 : 0) - (down ? 1 : 0)
        const dirs = (up ? DIR_UP : 0) | (down ? DIR_DOWN : 0) | (left ? DIR_LEFT : 0) | (right ? DIR_RIGHT : 0)
        pad.tapDirs = dirs & ~pad.dirsWas
        pad.dirsWas = dirs
    }

    // Facing as a compass letter for the HUD.
    export function heading(ang: number): string {
        const a = (ang + (ANGLES >> 3)) & (ANGLES - 1)
        return "ESWN".charAt(a >> 8)
    }
}

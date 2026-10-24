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

    export const ITEM_HEALTH = 0
    export const ITEM_AMMO = 1

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

    export const CAMX: number[] = []
    for (let c = 0; c < VIEW_W; c++) {
        CAMX.push(Math.idiv((2 * c + 1 - VIEW_W) * FP, VIEW_W))
    }

    export const CAMPAIGN = [
        "################",
        "#S..#....H.....#",
        "#...#.####.###.#",
        "#.A.....E#...#.#",
        "##.####.##.#.#.#",
        "#...E.#....#E#.#",
        "#.###.####.###.#",
        "#.#H#.....E....#",
        "#.#.#####.######",
        "#.....B......A.#",
        "####.BBB.####.##",
        "#E...B...#H#...#",
        "#.##.B.E.#.#.#.#",
        "#.#..BBB.#...#.#",
        "#.#...........HX",
        "################",
    ]

    export class Imp {
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
        constructor(x: number, y: number) {
            this.x = x
            this.y = y
            this.hunting = false
            this.lastX = x
            this.lastY = y
            this.hp = IMP_HP
            this.dead = false
            this.awake = false
            this.sees = false
            this.cool = 0
            this.hurt = 0
            this.attack = 0
            this.walk = 0
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
        constructor() {
            this.fwd = 0
            this.strafe = 0
            this.turn = 0
            this.fire = false
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
        imps: Imp[]
        items: Item[]
        events: string[]
        constructor() {
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
            this.imps = []
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
        constructor() {
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
        return TILE_FLOOR
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
                if (ch == "S") {
                    world.x = center(c)
                    world.y = center(r)
                } else if (ch == "E") {
                    world.imps.push(new Imp(center(c), center(r)))
                } else if (ch == "H") {
                    world.items.push(new Item(center(c), center(r), ITEM_HEALTH))
                } else if (ch == "A") {
                    world.items.push(new Item(center(c), center(r), ITEM_AMMO))
                }
            }
        }
        world.total = world.imps.length
        world.ang = ang & (ANGLES - 1)
        return world
    }

    export function tileAt(world: World, cx: number, cy: number): number {
        if (cx < 0 || cy < 0 || cx >= world.w || cy >= world.h) return TILE_STONE
        return world.grid[cy * world.w + cx]
    }

    export function solidAt(world: World, x: number, y: number): boolean {
        return tileAt(world, x >> 10, y >> 10) != TILE_FLOOR
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
            if (tile != TILE_FLOOR) break
        }
        let dist = side == 0 ? sdx - ddx : sdy - ddy
        if (dist < 16) dist = 16
        let wall = side == 0 ? py + ((dist * rdy) >> 10) : px + ((dist * rdx) >> 10)
        let texX = (wall & (FP - 1)) >> 6
        if (side == 0 && rdx < 0) texX = 15 - texX
        if (side == 1 && rdy > 0) texX = 15 - texX
        hit.dist = dist
        hit.side = side
        hit.tile = tile
        hit.texX = texX
        hit.cellX = mx
        hit.cellY = my
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

    // Blocks only steps that bring the player closer to a live imp, so backing off always works.
    function blockedByImp(world: World, x: number, y: number): boolean {
        for (const imp of world.imps) {
            if (imp.dead) continue
            const next = distance(imp.x, imp.y, x, y)
            if (next < TOUCH && next < distance(imp.x, imp.y, world.x, world.y)) return true
        }
        return false
    }

    function emit(world: World, ev: string): void {
        world.events.push(ev)
    }

    // Moves along each axis separately so a diagonal push slides along a wall instead of sticking.
    function movePlayer(world: World, mx: number, my: number): number {
        let moved = 0
        const r = PLAYER_RADIUS
        if (mx != 0) {
            const nx = world.x + mx
            const probe = nx + (mx > 0 ? r : -r)
            if (fits(world, nx, world.y, r) && !blockedByImp(world, nx, world.y)) {
                world.x = nx
                moved += Math.abs(mx)
            } else if (tileAt(world, probe >> 10, world.y >> 10) == TILE_EXIT) {
                world.won = true
            }
        }
        if (my != 0) {
            const ny = world.y + my
            const probe = ny + (my > 0 ? r : -r)
            if (fits(world, world.x, ny, r) && !blockedByImp(world, world.x, ny)) {
                world.y = ny
                moved += Math.abs(my)
            } else if (tileAt(world, world.x >> 10, probe >> 10) == TILE_EXIT) {
                world.won = true
            }
        }
        return moved
    }

    function moveImp(world: World, imp: Imp, mx: number, my: number): void {
        const r = IMP_RADIUS
        const nx = imp.x + mx
        if (fits(world, nx, imp.y, r) && distance(nx, imp.y, world.x, world.y) >= TOUCH) imp.x = nx
        const ny = imp.y + my
        if (fits(world, imp.x, ny, r) && distance(imp.x, ny, world.x, world.y) >= TOUCH) imp.y = ny
    }

    // Nearest live imp under the crosshair and in front of the wall, or -1.
    export function target(world: World): number {
        const hit = new Hit()
        castColumn(world, VIEW_W >> 1, hit)
        const p = new Proj()
        let best = -1
        let bestDepth = hit.dist
        for (let i = 0; i < world.imps.length; i++) {
            const imp = world.imps[i]
            if (imp.dead) continue
            project(world, imp.x, imp.y, p)
            if (!p.visible || p.depth >= bestDepth) continue
            const reach = Math.max(4, (p.size * 3) >> 3)
            if (Math.abs(p.screenX - (VIEW_W >> 1)) <= reach) {
                best = i
                bestDepth = p.depth
            }
        }
        return best
    }

    function fire(world: World): void {
        if (world.fireCool > 0) return
        if (world.ammo <= 0) {
            world.fireCool = FIRE_COOLDOWN
            emit(world, "empty")
            return
        }
        world.ammo -= 1
        world.fireCool = FIRE_COOLDOWN
        emit(world, "shoot")
        const i = target(world)
        if (i < 0) return
        const imp = world.imps[i]
        imp.hp -= 1
        imp.hurt = IMP_HURT_MS
        imp.awake = true
        if (imp.hp <= 0) {
            imp.dead = true
            world.kills += 1
            world.score += 100
            emit(world, "kill")
        } else {
            emit(world, "hit")
        }
    }

    function thinkImp(world: World, imp: Imp, dt: number): void {
        if (imp.cool > 0) imp.cool -= dt
        if (imp.hurt > 0) imp.hurt -= dt
        if (imp.attack > 0) imp.attack -= dt
        const d = distance(imp.x, imp.y, world.x, world.y)
        imp.sees = d < IMP_SIGHT && canSee(world, imp.x, imp.y, world.x, world.y)
        if (!imp.sees) {
            if (imp.hunting && imp.hurt <= 0) chase(imp, imp.lastX, imp.lastY, dt, world)
            return
        }
        imp.hunting = true
        imp.lastX = world.x
        imp.lastY = world.y
        if (!imp.awake) {
            imp.awake = true
            emit(world, "alert")
        }
        if (d <= IMP_REACH) {
            if (imp.cool <= 0) {
                imp.cool = IMP_COOLDOWN
                imp.attack = IMP_ATTACK_MS
                world.health -= IMP_DAMAGE
                emit(world, "hurt")
                if (world.health <= 0) {
                    world.health = 0
                    world.lost = true
                    emit(world, "dead")
                }
            }
            return
        }
        if (imp.hurt > 0) return
        chase(imp, world.x, world.y, dt, world)
    }

    // Walks toward a point; once the last sighting is reached the imp gives up the hunt.
    function chase(imp: Imp, tx: number, ty: number, dt: number, world: World): void {
        const d = distance(imp.x, imp.y, tx, ty)
        if (d < 160) {
            imp.hunting = imp.sees
            return
        }
        const step = Math.idiv(IMP_SPEED * dt, 1000)
        moveImp(world, imp, Math.idiv((tx - imp.x) * step, d), Math.idiv((ty - imp.y) * step, d))
        imp.walk += step
    }

    function pickUp(world: World): void {
        for (const item of world.items) {
            if (item.taken) continue
            if (Math.abs(item.x - world.x) > TOUCH || Math.abs(item.y - world.y) > TOUCH) continue
            if (item.kind == ITEM_HEALTH) {
                if (world.health >= 100) continue
                world.health = Math.min(100, world.health + HEALTH_PICKUP)
            } else {
                world.ammo += AMMO_PICKUP
            }
            item.taken = true
            world.score += 10
            emit(world, "pickup")
        }
    }

    export function update(world: World, input: Input, dt: number): void {
        world.events = []
        if (world.won || world.lost) return
        if (dt > 100) dt = 100
        if (dt < 0) dt = 0
        world.time += dt
        if (world.fireCool > 0) world.fireCool -= dt

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

        if (input.fire) fire(world)
        for (const imp of world.imps) {
            if (!imp.dead) thinkImp(world, imp, dt)
            if (world.lost) return
        }
        pickUp(world)
    }

    export const MAP_TAP_MS = 300

    export class Pad {
        aWas: boolean
        aLatch: boolean
        bWas: boolean
        bStart: number
        bStrafed: boolean
        tapA: boolean
        tapB: boolean
        constructor() {
            this.aWas = false
            this.aLatch = true
            this.bWas = false
            this.bStart = 0
            this.bStrafed = false
            this.tapA = false
            this.tapB = false
        }
    }

    // Buttons -> Input. Holding B turns left/right into strafe; a quick B tap with no strafe sets
    // tapB (map toggle). A held over a screen change (aLatch) does not fire until released.
    export function readPad(pad: Pad, input: Input, now: number, up: boolean, down: boolean,
        left: boolean, right: boolean, a: boolean, b: boolean): void {
        pad.tapA = a && !pad.aWas
        pad.aWas = a
        if (!a) pad.aLatch = false
        input.fire = a && !pad.aLatch
        const lr = (right ? 1 : 0) - (left ? 1 : 0)
        pad.tapB = false
        if (b && !pad.bWas) {
            pad.bStart = now
            pad.bStrafed = false
        }
        if (b) {
            input.strafe = lr
            input.turn = 0
            if (lr != 0) pad.bStrafed = true
        } else {
            input.strafe = 0
            input.turn = lr
            if (pad.bWas && !pad.bStrafed && now - pad.bStart < MAP_TAP_MS) pad.tapB = true
        }
        pad.bWas = b
        input.fwd = (up ? 1 : 0) - (down ? 1 : 0)
    }

    // Facing as a compass letter for the HUD.
    export function heading(ang: number): string {
        const a = (ang + (ANGLES >> 3)) & (ANGLES - 1)
        return "ESWN".charAt(a >> 8)
    }
}

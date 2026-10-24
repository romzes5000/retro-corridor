// Enemy kinds: per-kind stats, melee and ranged AI, fireballs.
namespace corridor {
    export const ENEMY_SHOOTER = 1
    export const ENEMY_KNIGHT = 2
    export const ENEMY_BOSS = 3

    // Indexed by kind: imp, shooter, knight, boss.
    export const ENEMY_HP = [IMP_HP, 3, 6, 30]
    export const ENEMY_SPEED = [IMP_SPEED, 1100, 1750, 950]
    export const ENEMY_RADIUS = [IMP_RADIUS, 260, 300, 400]
    export const ENEMY_BITE = [IMP_DAMAGE, 0, 25, 25]
    export const ENEMY_COOLDOWN = [IMP_COOLDOWN, 1800, 1100, 1600]
    export const ENEMY_SIZE = [85, 85, 95, 130]
    export const ENEMY_SCORE = [100, 150, 250, 1000]

    export const SHOT_SPEED = 3000
    export const SHOT_DAMAGE = 15
    export const SHOT_RADIUS = 160
    export const SHOT_AIM_MS = 600
    export const KEEP_NEAR = 3 * FP
    export const KEEP_FAR = 5 * FP
    export const BOSS_SPREAD = 40

    export class Shot {
        x: number
        y: number
        vx: number
        vy: number
        constructor(x: number, y: number, vx: number, vy: number) {
            this.x = x
            this.y = y
            this.vx = vx
            this.vy = vy
        }
    }

    export function kindOf(ch: string): number {
        if (ch == "E") return ENEMY_IMP
        if (ch == "F") return ENEMY_SHOOTER
        if (ch == "K") return ENEMY_KNIGHT
        if (ch == "Z") return ENEMY_BOSS
        return -1
    }

    export function isRanged(kind: number): boolean {
        return kind == ENEMY_SHOOTER || kind == ENEMY_BOSS
    }

    // Bigger bodies keep the same gap to the player as an imp does.
    export function touchFor(enemy: Enemy): number {
        return TOUCH + ENEMY_RADIUS[enemy.kind] - IMP_RADIUS
    }

    export function hurtPlayer(world: World, damage: number): void {
        world.health -= Math.max(1, Math.idiv(damage * DIFF_DAMAGE[world.difficulty], 100))
        emit(world, "hurt")
        if (world.health <= 0) {
            world.health = 0
            world.lost = true
            emit(world, "dead")
        }
    }

    export function moveEnemy(world: World, enemy: Enemy, mx: number, my: number): void {
        const r = ENEMY_RADIUS[enemy.kind]
        const touch = touchFor(enemy)
        const nx = enemy.x + mx
        if (fits(world, nx, enemy.y, r)) {
            if (distance(nx, enemy.y, world.x, world.y) >= touch) enemy.x = nx
        } else {
            nudgeDoor(world, enemy.x + (mx > 0 ? r + 128 : -r - 128), enemy.y)
        }
        const ny = enemy.y + my
        if (fits(world, enemy.x, ny, r)) {
            if (distance(enemy.x, ny, world.x, world.y) >= touch) enemy.y = ny
        } else {
            nudgeDoor(world, enemy.x, enemy.y + (my > 0 ? r + 128 : -r - 128))
        }
    }

    // Walks toward a point; once the last sighting is reached the enemy gives up the hunt.
    function chase(enemy: Enemy, tx: number, ty: number, dt: number, world: World): void {
        const d = distance(enemy.x, enemy.y, tx, ty)
        if (d < 160) {
            enemy.hunting = enemy.sees
            return
        }
        const step = Math.idiv(ENEMY_SPEED[enemy.kind] * dt, 1000)
        moveEnemy(world, enemy, Math.idiv((tx - enemy.x) * step, d), Math.idiv((ty - enemy.y) * step, d))
        enemy.walk += step
    }

    function retreat(enemy: Enemy, d: number, dt: number, world: World): void {
        const step = Math.idiv(ENEMY_SPEED[enemy.kind] * dt, 1000)
        moveEnemy(world, enemy, Math.idiv((enemy.x - world.x) * step, d), Math.idiv((enemy.y - world.y) * step, d))
        enemy.walk += step
    }

    // Fireball aimed at the player, turned by `spread` angle units for the boss fan.
    function launch(world: World, enemy: Enemy, d: number, spread: number): void {
        let vx = Math.idiv((world.x - enemy.x) * SHOT_SPEED, d)
        let vy = Math.idiv((world.y - enemy.y) * SHOT_SPEED, d)
        if (spread != 0) {
            const c = cos(spread)
            const s = sin(spread)
            const rx = (vx * c - vy * s) >> 10
            vy = (vx * s + vy * c) >> 10
            vx = rx
        }
        const lead = ENEMY_RADIUS[enemy.kind] + SHOT_RADIUS
        world.shots.push(new Shot(enemy.x + Math.idiv(vx * lead, SHOT_SPEED), enemy.y + Math.idiv(vy * lead, SHOT_SPEED), vx, vy))
    }

    function bite(world: World, enemy: Enemy, d: number): boolean {
        if (d > IMP_REACH + ENEMY_RADIUS[enemy.kind] - IMP_RADIUS) return false
        if (enemy.cool <= 0) {
            enemy.cool = ENEMY_COOLDOWN[enemy.kind]
            enemy.attack = IMP_ATTACK_MS
            hurtPlayer(world, ENEMY_BITE[enemy.kind])
        }
        return true
    }

    // Shooters and the boss hold a 3-5 cell gap and throw fireballs; the boss bites when cornered.
    function ranged(world: World, enemy: Enemy, d: number, dt: number): void {
        if (enemy.kind == ENEMY_BOSS && bite(world, enemy, d)) return
        if (enemy.cool <= 0) {
            enemy.cool = ENEMY_COOLDOWN[enemy.kind]
            enemy.attack = IMP_ATTACK_MS * 2
            launch(world, enemy, d, 0)
            if (enemy.kind == ENEMY_BOSS) {
                launch(world, enemy, d, BOSS_SPREAD)
                launch(world, enemy, d, -BOSS_SPREAD)
            }
            emitAt(world, "fireball", enemy.x, enemy.y)
        }
        if (enemy.hurt > 0) return
        if (d > KEEP_FAR) chase(enemy, world.x, world.y, dt, world)
        else if (d < KEEP_NEAR) retreat(enemy, d, dt, world)
    }

    export function thinkEnemy(world: World, enemy: Enemy, dt: number): void {
        if (enemy.cool > 0) enemy.cool -= dt
        if (enemy.hurt > 0) enemy.hurt -= dt
        if (enemy.attack > 0) enemy.attack -= dt
        const d = distance(enemy.x, enemy.y, world.x, world.y)
        enemy.sees = d < IMP_SIGHT && canSee(world, enemy.x, enemy.y, world.x, world.y)
        if (!enemy.sees) {
            if (!enemy.hunting) return
            enemy.growl -= dt
            if (enemy.growl <= 0) {
                enemy.growl = GROWL_MIN_MS + world.rng.next(GROWL_SPREAD_MS + 1)
                emitAt(world, "growl", enemy.x, enemy.y)
            }
            if (enemy.hurt <= 0) chase(enemy, enemy.lastX, enemy.lastY, dt, world)
            return
        }
        enemy.growl = GROWL_MIN_MS + world.rng.next(GROWL_SPREAD_MS + 1)
        enemy.hunting = true
        enemy.lastX = world.x
        enemy.lastY = world.y
        if (!enemy.awake) {
            enemy.awake = true
            if (isRanged(enemy.kind)) enemy.cool = SHOT_AIM_MS
            emitAt(world, "alert", enemy.x, enemy.y)
        }
        if (isRanged(enemy.kind)) {
            ranged(world, enemy, d, dt)
            return
        }
        if (bite(world, enemy, d)) return
        if (enemy.hurt > 0) return
        chase(enemy, world.x, world.y, dt, world)
    }

    export function updateShots(world: World, dt: number): void {
        const reach = PLAYER_RADIUS + SHOT_RADIUS
        for (let i = world.shots.length - 1; i >= 0; i--) {
            const s = world.shots[i]
            s.x += Math.idiv(s.vx * dt, 1000)
            s.y += Math.idiv(s.vy * dt, 1000)
            if (solidAt(world, s.x, s.y)) {
                world.shots.splice(i, 1)
                const bx = s.x - Math.idiv(s.vx * 120, SHOT_SPEED)
                const by = s.y - Math.idiv(s.vy * 120, SHOT_SPEED)
                addDecal(world, bx, by, DECAL_SCORCH)
                emitAt(world, "splash", bx, by)
            } else if (Math.abs(s.x - world.x) < reach && Math.abs(s.y - world.y) < reach) {
                world.shots.splice(i, 1)
                hurtPlayer(world, SHOT_DAMAGE)
                if (world.lost) return
            }
        }
    }
}

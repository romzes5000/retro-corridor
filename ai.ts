// AI player link: the console streams snapshots over HF2 console.log, a host bridge answers with
// short commands written straight into a mailbox buffer in RAM. The game never waits for it.
namespace corridor {
    export const AI_NONE = 0
    export const AI_GOTO = 1
    export const AI_ATTACK = 2
    export const AI_STRAFE = 3
    export const AI_USE = 4
    export const AI_WAIT = 5
    // GOTO over (a, b) and the point in bytes 26-27 while facing the cell in bytes 28-29.
    export const AI_PEEK = 6

    export const AI_RUNNING = 0
    export const AI_OK = 1
    export const AI_BLOCKED = 2

    export const AI_SIG = "CRDRAI01"
    export const AI_BOX_SIZE = 32
    export const AI_SNAPSHOT_MS = 250
    // A command answering a snapshot older than this (link clock) is dropped.
    export const AI_STALE_MS = 1200
    export const AI_SILENT_MS = 3000
    export const AI_RETRY_MS = 2000
    export const AI_NEXT_MS = 3000
    export const AI_TITLE_MS = 5000
    export const AI_GOTO_MS = 1500
    export const AI_ATTACK_MS = 700
    export const AI_STRAFE_MS = 300
    export const AI_USE_MS = 250
    export const AI_STUCK_MS = 400
    // A fireball landing sooner than this is sidestepped by the console itself.
    export const AI_DODGE_MS = 300
    // Jev's danger at or above this paints the JEV line red; AI_NO_DANGER means Jev sent none.
    export const AI_ALARM = 60
    export const AI_NO_DANGER = 0xff
    export const AI_ROUTE_AT = 26
    export const AI_DANGER_AT = 30
    const OBS_RING = 8
    const ARRIVE = 110
    const AIM = 10
    // Walk while the goal is within 45 degrees, turn on the spot beyond that.
    const WALK_GAP = 128
    // Past a corner the turn happens on the move; a wall ahead only makes the player slide along it.
    const CORNER_GAP = 256
    // Switch to the next route point this close to the current one.
    const TURN_EARLY = 512
    const FIRST_LEG = 2
    const NEXT_LEG = 3
    const ALARM_SHOT_MS = 700

    // Box layout: 0-7 signature, 8-9 seq, 10-11 obs, 12 cmd, 13 a, 14 b, 15 confidence %,
    // 16-17 latency ms, 18-25 label, 26-29 two more GOTO points as x+1, y+1 (0 = none),
    // 30 danger % (0xff = none), 31 checksum (low byte of the sum of bytes 0-30).
    export class AiCmd {
        seq: number
        obs: number
        cmd: number
        a: number
        b: number
        conf: number
        latency: number
        label: string
        // Extra GOTO points after (a, b), flattened x, y.
        route: number[]
        danger: number
        constructor() {
            this.seq = 0
            this.obs = 0
            this.cmd = AI_NONE
            this.a = 0
            this.b = 0
            this.conf = 0
            this.latency = 0
            this.label = ""
            this.route = []
            this.danger = AI_NO_DANGER
        }
    }

    function u16(read: (i: number) => number, at: number): number {
        return read(at) | (read(at + 1) << 8)
    }

    export function aiBoxSeq(read: (i: number) => number): number {
        return u16(read, 8)
    }

    // Decodes the box, or null on a wrong signature or checksum (e.g. a write still in flight).
    export function decodeAiBox(read: (i: number) => number): AiCmd {
        let sum = 0
        for (let i = 0; i < AI_BOX_SIZE - 1; i++) sum += read(i)
        if ((sum & 0xff) != read(AI_BOX_SIZE - 1)) return null
        for (let i = 0; i < AI_SIG.length; i++) {
            if (read(i) != AI_SIG.charCodeAt(i)) return null
        }
        const c = new AiCmd()
        c.seq = u16(read, 8)
        c.obs = u16(read, 10)
        c.cmd = read(12)
        c.a = read(13)
        c.b = read(14)
        c.conf = read(15)
        c.latency = u16(read, 16)
        let label = ""
        for (let i = 18; i < 26; i++) {
            const ch = read(i)
            if (ch == 0) break
            label += String.fromCharCode(ch)
        }
        c.label = label
        for (let i = 0; i < 2; i++) {
            const x = read(AI_ROUTE_AT + i * 2)
            const y = read(AI_ROUTE_AT + i * 2 + 1)
            if (x == 0 || y == 0) break
            c.route.push(x - 1)
            c.route.push(y - 1)
        }
        c.danger = read(AI_DANGER_AT)
        return c
    }

    export class AiExec {
        cmd: number
        a: number
        b: number
        elapsed: number
        result: number
        hurt: boolean
        startHp: number
        lastX: number
        lastY: number
        still: number
        pressed: boolean
        fired: boolean
        // GOTO route: origin cell, then up to 3 points, flattened x, y; `leg` is the point walked to.
        path: number[]
        leg: number
        limit: number
        // Console reflexes on top of the command: shoot what is under the crosshair, sidestep balls.
        reflexes: boolean
        // Last frame asked to move, and distance covered since the command started.
        pushing: boolean
        travel: number
        // The lava ban held the player back during this command.
        lavaStop: boolean
        // GOTO route an ATTACK interrupted, picked up again once the target is dead.
        resume: number[]
        // PEEK: the cell to face.
        lookX: number
        lookY: number
        constructor() {
            this.cmd = AI_NONE
            this.a = 0
            this.b = 0
            this.elapsed = 0
            this.result = AI_OK
            this.hurt = false
            this.startHp = 0
            this.lastX = 0
            this.lastY = 0
            this.still = 0
            this.pressed = false
            this.fired = false
            this.path = []
            this.leg = 0
            this.limit = AI_GOTO_MS
            this.reflexes = true
            this.pushing = false
            this.travel = 0
            this.lavaStop = false
            this.resume = []
            this.lookX = -1
        }
    }

    // `route` adds GOTO points after (a, b); `fromX, fromY` is the cell the bridge planned from
    // (the snapshot cell), so a player who walked on while Jev thought picks the route up mid-way.
    export function aiStart(exec: AiExec, world: World, cmd: number, a: number, b: number,
        route: number[] = null, fromX = -1, fromY = -1): void {
        // A PEEK runs as a GOTO over its first two points that keeps facing the third (lookX >= 0).
        exec.lookX = -1
        if (cmd == AI_PEEK) {
            cmd = AI_GOTO
            if (route.length > 3) {
                exec.lookX = route[2]
                exec.lookY = route[3]
                route = route.slice(0, 2)
            }
        }
        const interrupted = exec.cmd == AI_GOTO && exec.result == AI_RUNNING ? exec.path : exec.resume
        exec.resume = cmd == AI_GOTO ? [] : interrupted
        exec.cmd = cmd
        exec.a = a
        exec.b = b
        exec.elapsed = 0
        exec.result = AI_RUNNING
        exec.hurt = false
        exec.startHp = world.health
        exec.lastX = world.x
        exec.lastY = world.y
        exec.still = 0
        exec.pressed = false
        exec.fired = false
        exec.path = []
        exec.leg = 0
        exec.limit = AI_GOTO_MS
        exec.travel = 0
        exec.pushing = false
        exec.lavaStop = false
        if (cmd == AI_GOTO) startRoute(exec, world, route, fromX, fromY)
    }

    // Floor without lava, the exit, plain doors and doors the player has the key for.
    function walkable(world: World, cx: number, cy: number): boolean {
        const tile = tileAt(world, cx, cy)
        if (tile == TILE_FLOOR) return !lavaAt(world, cx, cy)
        if (tile == TILE_EXIT) return true
        if (!isDoor(tile)) return false
        const door = doorAt(world, cx, cy)
        return door.key == 0 || (world.keys & door.key) != 0
    }

    function sign(v: number): number {
        return v > 0 ? 1 : v < 0 ? -1 : 0
    }

    // Length of a straight run along one axis over walkable cells, -1 when it is not one.
    // Only the first leg may be empty.
    function legLen(world: World, x0: number, y0: number, sx: number, sy: number, len: number, first: boolean): number {
        if ((sx != 0 && sy != 0) || len > (first ? FIRST_LEG : NEXT_LEG) || (len == 0 && !first)) return -1
        for (let s = 1; s <= len; s++) {
            if (!walkable(world, x0 + sx * s, y0 + sy * s)) return -1
        }
        return len
    }

    // Keeps the longest valid prefix of the route and finds the player's cell on it; off the
    // route the command is out of date.
    function startRoute(exec: AiExec, world: World, route: number[], fromX: number, fromY: number): void {
        const cx = world.x >> 10
        const cy = world.y >> 10
        const pts = [fromX >= 0 ? fromX : cx, fromY >= 0 ? fromY : cy, exec.a, exec.b]
        if (route) {
            for (let i = 0; i + 1 < route.length && pts.length < 8; i += 2) {
                pts.push(route[i])
                pts.push(route[i + 1])
            }
        }
        let cells = 0
        let at = -1
        let k = 1
        for (; k < pts.length >> 1; k++) {
            const x0 = pts[2 * k - 2]
            const y0 = pts[2 * k - 1]
            const sx = sign(pts[2 * k] - x0)
            const sy = sign(pts[2 * k + 1] - y0)
            const len = legLen(world, x0, y0, sx, sy, Math.abs(pts[2 * k] - x0) + Math.abs(pts[2 * k + 1] - y0), k == 1)
            if (len < 0) break
            for (let s = k == 1 ? 0 : 1; s <= len; s++) {
                if (at < 0 && x0 + sx * s == cx && y0 + sy * s == cy) {
                    exec.leg = k
                    at = cells
                }
                cells += 1
            }
        }
        if (at < 0) {
            exec.result = AI_BLOCKED
            return
        }
        exec.path = pts.slice(0, k * 2)
        exec.limit = AI_GOTO_MS * Math.max(1, Math.idiv(cells - at, 2))
    }

    // An ATTACK that killed its target goes back to the GOTO route it interrupted, if the player
    // still stands on it, instead of waiting half a second for the next command.
    function resumeRoute(exec: AiExec, world: World): boolean {
        const p = exec.resume
        exec.resume = []
        if (p.length < 4) return false
        exec.cmd = AI_GOTO
        exec.a = p[2]
        exec.b = p[3]
        exec.elapsed = 0
        exec.still = 0
        exec.result = AI_RUNNING
        startRoute(exec, world, p.slice(4), p[0], p[1])
        if (exec.result == AI_RUNNING) return true
        exec.cmd = AI_ATTACK
        return false
    }

    // Walking on while still turning a corner must not carry the player off the route.
    function aheadOnRoute(exec: AiExec, world: World): boolean {
        const cx = (world.x + Math.idiv(cos(world.ang) * (PLAYER_RADIUS + 64), FP)) >> 10
        const cy = (world.y + Math.idiv(sin(world.ang) * (PLAYER_RADIUS + 64), FP)) >> 10
        const p = exec.path
        for (let k = 2; k < p.length; k += 2) {
            if (cx >= Math.min(p[k - 2], p[k]) && cx <= Math.max(p[k - 2], p[k])
                && cy >= Math.min(p[k - 1], p[k + 1]) && cy <= Math.max(p[k - 1], p[k + 1])) return true
        }
        return false
    }

    // Centre of route point k, one coordinate (`axis` 0 = x, 1 = y).
    function point(exec: AiExec, k: number, axis: number): number {
        return exec.path[2 * k + axis] * FP + (FP >> 1)
    }

    export function angleToward(world: World, x: number, y: number): number {
        const a = Math.atan2(y - world.y, x - world.x)
        return Math.round((a * ANGLES) / (2 * Math.PI)) & (ANGLES - 1)
    }

    function angleGap(from: number, to: number): number {
        return ((to - from + (ANGLES >> 1)) & (ANGLES - 1)) - (ANGLES >> 1)
    }

    function steer(world: World, input: Input, ang: number, tolerance: number): number {
        const gap = angleGap(world.ang, ang)
        if (Math.abs(gap) > tolerance) input.turn = gap > 0 ? 1 : -1
        return gap
    }

    // Shotgun whenever it has shells, pistol otherwise.
    function pickWeapon(world: World, input: Input): void {
        if (!world.hasShotgun) return
        const want = world.ammo >= SHOTGUN_AMMO ? WEAPON_SHOTGUN : WEAPON_PISTOL
        if (world.weapon != want) input.swap = true
    }

    function doorAhead(world: World): Door {
        const ax = world.x + ((cos(world.ang) * USE_REACH) >> 10)
        const ay = world.y + ((sin(world.ang) * USE_REACH) >> 10)
        return doorAt(world, ax >> 10, ay >> 10)
    }

    const SHOT_LANE = PLAYER_RADIUS + SHOT_RADIUS + 200
    const SHOT_RANGE = 3584
    const DODGE_PROBE = 600

    // Player offset from a fireball's line of flight, left in shotPX, shotPY by shotLine().
    let shotPX = 0
    let shotPY = 0

    // Distance along the line of flight times speed squared; 0 speed gives 0 and no offset.
    function shotLine(world: World, s: Shot): number {
        const rx = world.x - s.x
        const ry = world.y - s.y
        const along = rx * s.vx + ry * s.vy
        const v2 = s.vx * s.vx + s.vy * s.vy
        if (v2 == 0) return 0
        shotPX = rx - Math.idiv(along * s.vx, v2)
        shotPY = ry - Math.idiv(along * s.vy, v2)
        return along
    }

    // Milliseconds until a fireball reaches the player, or -1 when it misses, flies away or is far.
    export function aiShotEta(world: World, s: Shot): number {
        const along = shotLine(world, s)
        if (along <= 0 || distance(world.x, world.y, s.x, s.y) > SHOT_RANGE) return -1
        if (distance(0, 0, shotPX, shotPY) > SHOT_LANE) return -1
        return Math.idiv(along * 1000, s.vx * s.vx + s.vy * s.vy)
    }

    // Floor beside the player, `side` -1 left / 1 right, with room to stand and no lava.
    function sideClear(world: World, side: number, reach: number): boolean {
        const x = world.x - Math.idiv(sin(world.ang) * side * reach, FP)
        const y = world.y + Math.idiv(cos(world.ang) * side * reach, FP)
        return fits(world, x, y, PLAYER_RADIUS) && !lavaAt(world, x >> 10, y >> 10)
    }

    // Sidestep that leaves the fireball's line: -1 left, 1 right, 0 when none does (a ball crossing
    // from the side keeps hitting whatever the strafe direction, or both sides are wall or lava).
    export function aiDodgeSide(world: World, s: Shot): number {
        if (s.vx == 0 && s.vy == 0) return 0
        shotLine(world, s)
        const px = shotPX
        const py = shotPY
        const rightX = -sin(world.ang)
        const rightY = cos(world.ang)
        const lateral = Math.abs(s.vx * rightX + s.vy * rightY)
        const frontal = Math.abs(s.vx * rightY - s.vy * rightX)
        if (lateral > frontal) return 0
        let side = px * rightX + py * rightY >= 0 ? 1 : -1
        if (!sideClear(world, side, DODGE_PROBE)) side = -side
        return sideClear(world, side, DODGE_PROBE) ? side : 0
    }

    function finish(exec: AiExec, result: number): void {
        exec.result = result
    }

    // Walking into lava is never on: no forward or sideways step whose leading edge lands in lava,
    // unless the player already stands in it and is getting out.
    function intoLava(world: World, input: Input): boolean {
        if (input.fwd == 0 && input.strafe == 0) return false
        if (lavaAt(world, world.x >> 10, world.y >> 10)) return false
        const dx = cos(world.ang)
        const dy = sin(world.ang)
        const mx = dx * input.fwd - dy * input.strafe
        const my = dy * input.fwd + dx * input.strafe
        const len = Math.max(1, distance(0, 0, mx, my))
        const px = world.x + Math.idiv(mx * PLAYER_RADIUS, len)
        const py = world.y + Math.idiv(my * PLAYER_RADIUS, len)
        return lavaAt(world, px >> 10, py >> 10)
    }

    // What 500 ms of Jev latency cannot cover: fire at whatever is under the crosshair, and step
    // out of a fireball about to land. The command keeps running underneath.
    function reflex(world: World, input: Input): void {
        const cost = world.weapon == WEAPON_SHOTGUN ? SHOTGUN_AMMO : 1
        if (world.fireCool <= 0 && world.ammo >= cost && target(world) >= 0) input.fire = true
        for (const s of world.shots) {
            const eta = aiShotEta(world, s)
            if (eta < 0 || eta >= AI_DODGE_MS) continue
            const side = aiDodgeSide(world, s)
            if (side == 0) continue
            input.strafe = side
            return
        }
    }

    // Input for this frame; exec.result leaves AI_RUNNING once the command is over.
    export function aiStep(exec: AiExec, world: World, dt: number): Input {
        const input = new Input()
        const attacking = exec.result == AI_RUNNING && exec.cmd == AI_ATTACK
        if (exec.result == AI_RUNNING) runCommand(exec, world, dt, input)
        if (exec.reflexes && !attacking) reflex(world, input)
        exec.pushing = input.fwd != 0 || input.strafe != 0
        if (intoLava(world, input)) {
            input.fwd = 0
            input.strafe = 0
            exec.lavaStop = true
        }
        return input
    }

    // PEEK: face the remembered enemy cell and reach the route point walking forward, back or
    // sideways, each within 60 degrees of the way there (1024 angle units to a turn), so the
    // reflex fires the moment the enemy shows.
    function peek(exec: AiExec, world: World, input: Input, tx: number, ty: number): void {
        steer(world, input, angleToward(world, exec.lookX * FP + 512, exec.lookY * FP + 512), AIM)
        const rel = angleGap(world.ang, angleToward(world, tx, ty))
        const a = Math.abs(rel)
        input.fwd = a < 171 ? 1 : a > 341 ? -1 : 0
        if (a > 85 && a < 427) input.strafe = rel > 0 ? 1 : -1
    }

    function runCommand(exec: AiExec, world: World, dt: number, input: Input): void {
        exec.elapsed += dt
        if (world.health < exec.startHp) exec.hurt = true
        pickWeapon(world, input)
        const moved = Math.abs(world.x - exec.lastX) + Math.abs(world.y - exec.lastY)
        exec.travel += moved
        // Turning on the spot is not being stuck: only frames that tried to move count.
        if (moved > 0) exec.still = 0
        else if (exec.pushing) exec.still += dt
        exec.lastX = world.x
        exec.lastY = world.y
        if (exec.cmd == AI_GOTO) {
            const last = (exec.path.length >> 1) - 1
            if (exec.leg < last && distance(world.x, world.y, point(exec, exec.leg, 0), point(exec, exec.leg, 1)) < TURN_EARLY) exec.leg += 1
            const tx = point(exec, exec.leg, 0)
            const ty = point(exec, exec.leg, 1)
            if (exec.leg == last && distance(world.x, world.y, tx, ty) < ARRIVE) {
                finish(exec, AI_OK)
                return
            }
            if (exec.elapsed >= exec.limit || (exec.elapsed > AI_STUCK_MS && exec.still >= AI_STUCK_MS)) {
                finish(exec, AI_BLOCKED)
                return
            }
            if (exec.lookX >= 0) {
                peek(exec, world, input, tx, ty)
                return
            }
            const gap = Math.abs(steer(world, input, angleToward(world, tx, ty), AIM))
            if (gap < WALK_GAP || (gap < CORNER_GAP && aheadOnRoute(exec, world))) input.fwd = 1
            const door = doorAhead(world)
            const canOpen = door && (door.key == 0 || (world.keys & door.key) != 0)
            if (canOpen && (door.state == DOOR_CLOSED || door.state == DOOR_CLOSING)) input.fire = true
        } else if (exec.cmd == AI_ATTACK) {
            const enemy = exec.a < world.enemies.length ? world.enemies[exec.a] : null
            if (!enemy || enemy.dead) {
                if (!resumeRoute(exec, world)) finish(exec, AI_OK)
                return
            }
            if (world.ammo < 1) {
                finish(exec, AI_BLOCKED)
                return
            }
            // An attack that never got a shot off (enemy behind a wall) reports blocked.
            if (exec.elapsed >= AI_ATTACK_MS) {
                finish(exec, exec.fired ? AI_OK : AI_BLOCKED)
                return
            }
            // b = 1: backpedal while aiming; against a wall it keeps shooting where it stands.
            const back = exec.b == 1
            if (back) input.fwd = -1
            const gap = steer(world, input, angleToward(world, enemy.x, enemy.y), AIM)
            if (Math.abs(gap) <= AIM) {
                if (target(world) == exec.a) {
                    input.fire = true
                    exec.fired = true
                } else if (!back) {
                    input.fwd = 1
                }
            }
        } else if (exec.cmd == AI_STRAFE) {
            if (exec.elapsed >= AI_STRAFE_MS) {
                finish(exec, exec.travel == 0 || exec.lavaStop ? AI_BLOCKED : AI_OK)
                return
            }
            input.strafe = exec.a == 0 ? -1 : 1
        } else if (exec.cmd == AI_USE) {
            if (!exec.pressed) {
                input.fire = true
                exec.pressed = true
            } else if (exec.elapsed >= AI_USE_MS) {
                finish(exec, AI_OK)
            }
        } else if (exec.cmd == AI_WAIT) {
            if (exec.elapsed >= Math.max(AI_SNAPSHOT_MS, exec.a * 10)) finish(exec, AI_OK)
        } else {
            finish(exec, AI_OK)
        }
    }

    export class AiLink {
        run: number
        // Link clock: advances only while the world does, so pauses do not age commands.
        clock: number
        obs: number
        obsTime: number[]
        // Player cell in each snapshot of the ring: where the bridge planned the route from.
        obsCell: number[]
        snapDue: number
        seq: number
        lastCmdAt: number
        ackSeq: number
        stale: boolean
        label: string
        conf: number
        latency: number
        danger: number
        reflexes: boolean
        exec: AiExec
        level: string
        hash: number
        endMs: number
        constructor(run: number) {
            this.run = run
            this.clock = 0
            this.obs = 0
            this.obsTime = []
            this.obsCell = []
            for (let i = 0; i < OBS_RING; i++) {
                this.obsTime.push(-1)
                this.obsCell.push(-1)
                this.obsCell.push(-1)
            }
            this.danger = AI_NO_DANGER
            this.reflexes = true
            this.snapDue = 0
            this.seq = 0
            this.lastCmdAt = 0
            this.ackSeq = 0
            this.stale = false
            this.label = ""
            this.conf = 0
            this.latency = 0
            this.exec = new AiExec()
            this.level = ""
            this.hash = 0
            this.endMs = 0
        }
    }

    // 16-bit FNV-style hash of what the bridge rebuilds on its side: tiles, enemies, items.
    export function mapHash(world: World): number {
        let h = 0x9dc5
        const mix = (v: number) => {
            h = ((h ^ (v & 0xff)) * 403) & 0xffff
        }
        mix(world.w)
        mix(world.h)
        for (let i = 0; i < world.grid.length; i++) mix(world.grid[i])
        for (const e of world.enemies) {
            mix(e.kind)
            mix(e.x >> 10)
            mix(e.y >> 10)
        }
        for (const it of world.items) {
            mix(it.kind)
            mix(it.x >> 10)
            mix(it.y >> 10)
        }
        return h
    }

    // Level id the bridge understands: campaign index, or D<depth> for endless.
    export function aiLevelId(session: Session): string {
        if (session.kind == RUN_ENDLESS) return "D" + (session.level + 1)
        return "" + session.level
    }

    export function aiEnterLevel(link: AiLink, session: Session, world: World): void {
        link.level = aiLevelId(session)
        link.hash = mapHash(world)
        link.exec = new AiExec()
        link.snapDue = 0
        link.endMs = 0
    }

    // Applies a new command from the box if it is fresh; called once per frame before aiStep.
    export function aiPoll(link: AiLink, world: World, read: (i: number) => number): void {
        const seq = aiBoxSeq(read)
        if (seq == link.seq) return
        const cmd = decodeAiBox(read)
        if (!cmd || cmd.seq != seq || aiBoxSeq(read) != seq) return
        link.seq = seq
        link.ackSeq = seq
        const sent = cmd.obs <= link.obs && link.obs - cmd.obs < OBS_RING ? link.obsTime[cmd.obs % OBS_RING] : -1
        if (sent < 0 || link.clock - sent > AI_STALE_MS) {
            link.stale = true
            return
        }
        link.stale = false
        link.lastCmdAt = link.clock
        link.label = cmd.label
        link.conf = cmd.conf
        link.latency = cmd.latency
        link.danger = cmd.danger
        const slot = (cmd.obs % OBS_RING) * 2
        aiStart(link.exec, world, cmd.cmd, cmd.a, cmd.b, cmd.route, link.obsCell[slot], link.obsCell[slot + 1])
    }

    export function aiSilent(link: AiLink): boolean {
        return link.clock - link.lastCmdAt > AI_SILENT_MS
    }

    // One frame of AI play: poll the box, run the command, advance the link clock.
    export function aiFrame(link: AiLink, world: World, dt: number, read: (i: number) => number): Input {
        link.clock += dt
        aiPoll(link, world, read)
        if (aiSilent(link)) return new Input()
        link.exec.reflexes = link.reflexes
        return aiStep(link.exec, world, dt)
    }

    function resultName(exec: AiExec): string {
        if (exec.result == AI_BLOCKED) return "blocked"
        if (exec.hurt) return "hurt"
        return exec.result == AI_RUNNING ? "run" : "ok"
    }

    function mask(n: number, bit: (i: number) => boolean): string {
        let out = ""
        for (let i = 0; i < n; i += 4) {
            let v = 0
            for (let k = 0; k < 4; k++) {
                if (i + k < n && bit(i + k)) v |= 1 << k
            }
            out += "0123456789abcdef".charAt(v)
        }
        return out
    }

    // Snapshot as console lines (each under 64 chars), framed by AI S ... AI END with the same n.
    export function aiSnapshot(link: AiLink, world: World, difficulty: number): string[] {
        link.obs += 1
        link.obsTime[link.obs % OBS_RING] = link.clock
        link.obsCell[(link.obs % OBS_RING) * 2] = world.x >> 10
        link.obsCell[(link.obs % OBS_RING) * 2 + 1] = world.y >> 10
        const n = link.obs
        const out: string[] = []
        out.push("AI S n=" + n + " t=" + link.clock + " run=" + link.run + " lvl=" + link.level + " h=" + link.hash + " d=" + difficulty)
        out.push("AI P " + world.x + " " + world.y + " " + world.ang + " " + world.health + " " + world.ammo + " "
            + world.weapon + " " + world.keys + " " + (world.exitLocked ? 1 : 0))
        for (let i = 0; i < world.enemies.length; i++) {
            const e = world.enemies[i]
            if (e.dead) continue
            out.push("AI E " + i + " " + e.kind + " " + e.x + " " + e.y + " " + e.hp + " " + (e.sees ? 1 : 0))
        }
        for (const s of world.shots) out.push("AI F " + s.x + " " + s.y + " " + s.vx + " " + s.vy)
        let doors = ""
        for (const d of world.doors) doors += d.state
        if (doors.length > 0) out.push("AI D " + doors)
        if (world.items.length > 0) out.push("AI I " + mask(world.items.length, (i) => world.items[i].taken))
        out.push("AI A " + link.ackSeq + " " + resultName(link.exec) + (link.stale ? " stale" : ""))
        out.push("AI END n=" + n)
        return out
    }

    // True when a snapshot is due this frame.
    export function aiSnapshotDue(link: AiLink): boolean {
        if (link.clock < link.snapDue) return false
        link.snapDue = link.clock + AI_SNAPSHOT_MS
        return true
    }

    // Won or lost: true once the screen has been shown long enough to move on by itself.
    export function aiAutoNext(link: AiLink, dt: number, wait: number): boolean {
        link.endMs += dt
        if (link.endMs < wait) return false
        link.endMs = 0
        return true
    }

    // Logged when the player takes the controls mid-level: the bridge drops what it planned. While
    // they play the link sleeps: no snapshots, no commands, its clock stands still.
    export const AI_HUMAN = "AI HUMAN"

    // The AI plays on from wherever the player left the level, and the run can no longer set
    // records. Commands planned before (in the box or still on the way) answer snapshots that the
    // jump in obs pushes out of the ring, so they are dropped as stale. The first snapshot goes out
    // on the next frame.
    export function aiHandBack(link: AiLink, session: Session): void {
        session.ai = true
        link.exec = new AiExec()
        link.obs += OBS_RING
        link.label = ""
        link.snapDue = link.clock
    }

    export const AI_STAY = 0
    export const AI_REPLAY = 1
    export const AI_ADVANCE = 2

    // End of a level under AI control: "AI WON" / "AI DEAD" on the first frame, then the retry
    // (after a death) or the next level (after a win) once the result screen has been up long enough.
    export function aiEndStep(link: AiLink, world: World, dt: number, log: (line: string) => void): number {
        if (!world.won && !world.lost) return AI_STAY
        if (link.endMs == 0) log(world.won ? "AI WON" : "AI DEAD")
        if (!aiAutoNext(link, dt, world.won ? AI_NEXT_MS : AI_RETRY_MS)) return AI_STAY
        return world.won ? AI_ADVANCE : AI_REPLAY
    }

    export const AI_NO_LINK = "NO LINK - RUN NPM RUN AI"

    // On-screen status: "JEV ATTACK 84% 230MS", or a hint to start the bridge while it is silent.
    export function aiStatus(link: AiLink): string {
        if (aiSilent(link)) return AI_NO_LINK
        if (link.label == "") return "JEV"
        return "JEV " + link.label + " " + link.conf + "% " + link.latency + "MS"
    }

    // Red JEV line: Jev's danger is high, or, when Jev sent none, a ball or a bite is imminent.
    export function aiAlarm(link: AiLink, world: World): boolean {
        if (aiSilent(link)) return false
        if (link.danger != AI_NO_DANGER) return link.danger >= AI_ALARM
        for (const s of world.shots) {
            const eta = aiShotEta(world, s)
            if (eta >= 0 && eta < ALARM_SHOT_MS) return true
        }
        for (const e of world.enemies) {
            if (e.dead || ENEMY_BITE[e.kind] == 0) continue
            if (distance(world.x, world.y, e.x, e.y) <= IMP_REACH + ENEMY_RADIUS[e.kind] - IMP_RADIUS) return true
        }
        return false
    }
}

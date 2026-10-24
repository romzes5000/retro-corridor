// AI player link: the console streams snapshots over HF2 console.log, a host bridge answers with
// short commands written straight into a mailbox buffer in RAM. The game never waits for it.
namespace corridor {
    export const AI_NONE = 0
    export const AI_GOTO = 1
    export const AI_ATTACK = 2
    export const AI_STRAFE = 3
    export const AI_USE = 4
    export const AI_WAIT = 5

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
    const OBS_RING = 8
    const ARRIVE = 110
    const AIM = 10
    const STEER = 70

    // Box layout: 0-7 signature, 8-9 seq, 10-11 obs, 12 cmd, 13 a, 14 b, 15 confidence %,
    // 16-17 latency ms, 18-25 label, 31 checksum (low byte of the sum of bytes 0-30).
    export class AiCmd {
        seq: number
        obs: number
        cmd: number
        a: number
        b: number
        conf: number
        latency: number
        label: string
        constructor() {
            this.seq = 0
            this.obs = 0
            this.cmd = AI_NONE
            this.a = 0
            this.b = 0
            this.conf = 0
            this.latency = 0
            this.label = ""
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
        }
    }

    export function aiStart(exec: AiExec, world: World, cmd: number, a: number, b: number): void {
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
        if (cmd == AI_GOTO && !straightGoal(world, a, b)) exec.result = AI_BLOCKED
    }

    // GOTO only follows a straight run of at most 2 cells from the current cell.
    function straightGoal(world: World, cx: number, cy: number): boolean {
        const dx = cx - (world.x >> 10)
        const dy = cy - (world.y >> 10)
        if (dx != 0 && dy != 0) return false
        return Math.abs(dx + dy) <= 2
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

    function finish(exec: AiExec, result: number): void {
        exec.result = result
    }

    // Input for this frame; exec.result leaves AI_RUNNING once the command is over.
    export function aiStep(exec: AiExec, world: World, dt: number): Input {
        const input = new Input()
        if (exec.result != AI_RUNNING) return input
        exec.elapsed += dt
        if (world.health < exec.startHp) exec.hurt = true
        pickWeapon(world, input)
        const moved = Math.abs(world.x - exec.lastX) + Math.abs(world.y - exec.lastY)
        exec.still = moved > 0 ? 0 : exec.still + dt
        exec.lastX = world.x
        exec.lastY = world.y
        if (exec.cmd == AI_GOTO) {
            const tx = exec.a * FP + (FP >> 1)
            const ty = exec.b * FP + (FP >> 1)
            if (distance(world.x, world.y, tx, ty) < ARRIVE) {
                finish(exec, AI_OK)
                return input
            }
            if (exec.elapsed >= AI_GOTO_MS || (exec.elapsed > AI_STUCK_MS && exec.still >= AI_STUCK_MS)) {
                finish(exec, AI_BLOCKED)
                return input
            }
            const gap = steer(world, input, angleToward(world, tx, ty), AIM)
            if (Math.abs(gap) < STEER) input.fwd = 1
            const door = doorAhead(world)
            const canOpen = door && (door.key == 0 || (world.keys & door.key) != 0)
            if (canOpen && (door.state == DOOR_CLOSED || door.state == DOOR_CLOSING)) input.fire = true
        } else if (exec.cmd == AI_ATTACK) {
            const enemy = exec.a < world.enemies.length ? world.enemies[exec.a] : null
            if (!enemy || enemy.dead) {
                finish(exec, AI_OK)
                return input
            }
            if (world.ammo < 1) {
                finish(exec, AI_BLOCKED)
                return input
            }
            // An attack that never got a shot off (enemy behind a wall) reports blocked.
            if (exec.elapsed >= AI_ATTACK_MS) {
                finish(exec, exec.fired ? AI_OK : AI_BLOCKED)
                return input
            }
            const gap = steer(world, input, angleToward(world, enemy.x, enemy.y), AIM)
            if (Math.abs(gap) <= AIM) {
                if (target(world) == exec.a) {
                    input.fire = true
                    exec.fired = true
                } else {
                    input.fwd = 1
                }
            }
        } else if (exec.cmd == AI_STRAFE) {
            if (exec.elapsed >= AI_STRAFE_MS) {
                finish(exec, exec.still >= exec.elapsed ? AI_BLOCKED : AI_OK)
                return input
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
        return input
    }

    export class AiLink {
        run: number
        // Link clock: advances only while the world does, so pauses do not age commands.
        clock: number
        obs: number
        obsTime: number[]
        snapDue: number
        seq: number
        lastCmdAt: number
        ackSeq: number
        stale: boolean
        label: string
        conf: number
        latency: number
        exec: AiExec
        level: string
        hash: number
        endMs: number
        constructor(run: number) {
            this.run = run
            this.clock = 0
            this.obs = 0
            this.obsTime = []
            for (let i = 0; i < OBS_RING; i++) this.obsTime.push(-1)
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
        aiStart(link.exec, world, cmd.cmd, cmd.a, cmd.b)
    }

    export function aiSilent(link: AiLink): boolean {
        return link.clock - link.lastCmdAt > AI_SILENT_MS
    }

    // One frame of AI play: poll the box, run the command, advance the link clock.
    export function aiFrame(link: AiLink, world: World, dt: number, read: (i: number) => number): Input {
        link.clock += dt
        aiPoll(link, world, read)
        if (aiSilent(link)) return new Input()
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

    // On-screen status: "JEV ATTACK 84% 230MS", or NO LINK while the bridge is silent.
    export function aiStatus(link: AiLink): string {
        if (aiSilent(link)) return "NO LINK"
        if (link.label == "") return "JEV"
        return "JEV " + link.label + " " + link.conf + "% " + link.latency + "MS"
    }
}

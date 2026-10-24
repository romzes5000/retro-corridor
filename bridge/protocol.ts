// Parses the console stream from ai.ts (AI S ... AI END) into snapshots and end-of-level events.
export interface SnapEnemy {
    i: number
    kind: number
    x: number
    y: number
    hp: number
    sees: boolean
}

export interface SnapShot {
    x: number
    y: number
    vx: number
    vy: number
}

export interface Snapshot {
    n: number
    t: number
    run: number
    lvl: string
    hash: number
    difficulty: number
    x: number
    y: number
    ang: number
    hp: number
    ammo: number
    weapon: number
    keys: number
    locked: boolean
    enemies: SnapEnemy[]
    shots: SnapShot[]
    doors: number[]
    taken: boolean[]
    ack: { seq: number; result: string; stale: boolean }
}

export type Message = { kind: "snapshot"; snap: Snapshot } | { kind: "won" } | { kind: "dead" }

function fields(rest: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const part of rest.split(" ")) {
        const eq = part.indexOf("=")
        if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1)
    }
    return out
}

function nums(rest: string): number[] | null {
    const out = rest.trim().split(/\s+/).map(Number)
    return out.every(Number.isFinite) ? out : null
}

function maskBits(hex: string): boolean[] {
    const out: boolean[] = []
    for (const ch of hex) {
        const v = parseInt(ch, 16)
        for (let k = 0; k < 4; k++) out.push(((v >> k) & 1) === 1)
    }
    return out
}

// Feed it one console line at a time; a frame broken by a lost or garbled line is dropped whole.
export class Parser {
    private cur: Snapshot | null = null

    line(raw: string): Message | null {
        const line = raw.trim()
        if (!line.startsWith("AI ")) return null
        const tag = line.slice(3, line.indexOf(" ", 3) < 0 ? undefined : line.indexOf(" ", 3))
        const rest = line.slice(4 + tag.length)
        if (tag === "WON") return { kind: "won" }
        if (tag === "DEAD") return { kind: "dead" }
        if (tag === "S") {
            const f = fields(rest)
            this.cur = {
                n: Number(f.n), t: Number(f.t), run: Number(f.run), lvl: f.lvl ?? "", hash: Number(f.h),
                difficulty: Number(f.d), x: 0, y: 0, ang: 0, hp: 0, ammo: 0, weapon: 0, keys: 0, locked: false,
                enemies: [], shots: [], doors: [], taken: [], ack: { seq: 0, result: "ok", stale: false },
            }
            if (![this.cur.n, this.cur.t, this.cur.run, this.cur.hash, this.cur.difficulty].every(Number.isFinite)) this.cur = null
            return null
        }
        const cur = this.cur
        if (!cur) return null
        if (tag === "P") {
            const v = nums(rest)
            if (!v || v.length !== 8) return this.drop()
            ;[cur.x, cur.y, cur.ang, cur.hp, cur.ammo, cur.weapon, cur.keys] = v
            cur.locked = v[7] === 1
        } else if (tag === "E") {
            const v = nums(rest)
            if (!v || v.length !== 6) return this.drop()
            cur.enemies.push({ i: v[0], kind: v[1], x: v[2], y: v[3], hp: v[4], sees: v[5] === 1 })
        } else if (tag === "F") {
            const v = nums(rest)
            if (!v || v.length !== 4) return this.drop()
            cur.shots.push({ x: v[0], y: v[1], vx: v[2], vy: v[3] })
        } else if (tag === "D") {
            if (!/^[0-3]+$/.test(rest)) return this.drop()
            cur.doors = [...rest].map(Number)
        } else if (tag === "I") {
            if (!/^[0-9a-f]+$/.test(rest)) return this.drop()
            cur.taken = maskBits(rest)
        } else if (tag === "A") {
            const [seq, result, stale] = rest.split(" ")
            cur.ack = { seq: Number(seq), result: result ?? "", stale: stale === "stale" }
        } else if (tag === "END") {
            this.cur = null
            if (Number(fields(rest).n) !== cur.n) return null
            return { kind: "snapshot", snap: cur }
        }
        return null
    }

    private drop(): null {
        this.cur = null
        return null
    }
}

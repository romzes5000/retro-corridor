// Reproduction of the first, step-based sprite view (the previous main.ts) for the
// before/after GIF. Draws in the default Arcade palette, indices 0..15.
import { FakeImage } from "../fake-image.ts"

export const DEFAULT_PALETTE = [
    0x000000, 0xffffff, 0xff2121, 0xff93c4, 0xff8135, 0xfff609, 0x249ca3, 0x78dc52,
    0x003fad, 0x87f2ff, 0x8e2ec4, 0xa4839f, 0x5c406c, 0xe5cdc4, 0x91463d, 0x000000,
]

const WALL = [
    "eeefeeef",
    "eeefeeef",
    "ffffffff",
    "efeeefee",
    "efeeefee",
    "ffffffff",
    "eeefeeef",
    "ffffffff",
]

const IMP = [
    "........",
    ".ff..ff.",
    ".f2..2f.",
    ".ffffff.",
    "..2222..",
    "..f22f..",
    "...ff...",
    "........",
]

const SKY = ["88888888", "88888888", "88888888"]
const FLOOR = ["eeeeeeee", "edededed", "eeeeeeee"]

const HEART = [
    ".22.22.",
    "2222222",
    "2222222",
    ".22222.",
    "..222..",
    "...2...",
]

const DX = [0, 1, 0, -1]
const DY = [-1, 0, 1, 0]

export interface LegacyWorld {
    map: string[]
    x: number
    y: number
    dir: number
    lives: number
    score: number
    imps: Array<{ x: number; y: number }>
}

export function legacyWorld(source: string[], dir: number): LegacyWorld {
    const imps: Array<{ x: number; y: number }> = []
    let x = 1
    let y = 1
    const map = source.map((row, r) => row.split("").map((ch, c) => {
        if (ch === "S") {
            x = c
            y = r
            return "."
        }
        if (ch === "E") {
            imps.push({ x: c, y: r })
            return "."
        }
        return ch === "#" || ch === "X" || ch === "B" ? ch : "."
    }).join(""))
    return { map, x, y, dir, lives: 3, score: 0, imps }
}

function isWall(w: LegacyWorld, x: number, y: number): boolean {
    if (y < 0 || x < 0 || y >= w.map.length || x >= w.map[y].length) return true
    return w.map[y].charAt(x) === "#" || w.map[y].charAt(x) === "B"
}

function ahead(w: LegacyWorld, n: number): [number, number] {
    return [w.x + DX[w.dir] * n, w.y + DY[w.dir] * n]
}

function sideOf(w: LegacyWorld, depth: number, side: number): [number, number] {
    const [fx, fy] = ahead(w, depth)
    const perp = side < 0 ? (w.dir + 3) % 4 : (w.dir + 1) % 4
    return [fx + DX[perp], fy + DY[perp]]
}

function metrics(depth: number) {
    if (depth === 1) return { scale: 6, y: 64, spread: 56 }
    if (depth === 2) return { scale: 4, y: 60, spread: 34 }
    return { scale: 2, y: 56, spread: 16 }
}

const HEX = "0123456789abcdef"

// Arcade sprite: image scaled by an integer factor, centred on (cx, cy).
function sprite(target: FakeImage, rows: string[], cx: number, cy: number, scale: number): void {
    const w = rows[0].length * scale
    const h = rows.length * scale
    const x0 = Math.floor(cx - w / 2)
    const y0 = Math.floor(cy - h / 2)
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const ch = rows[Math.floor(y / scale)].charAt(Math.floor(x / scale))
            if (ch !== ".") target.setPixel(x0 + x, y0 + y, HEX.indexOf(ch))
        }
    }
}

export function drawLegacy(target: FakeImage, w: LegacyWorld): void {
    target.fill(15)
    sprite(target, SKY, 80, 30, 20)
    sprite(target, FLOOR, 80, 90, 20)
    const items: Array<{ z: number; draw: () => void }> = []
    let limit = 3
    for (let depth = 1; depth <= 3; depth++) {
        const [fx, fy] = ahead(w, depth)
        if (isWall(w, fx, fy)) {
            limit = depth
            break
        }
    }
    for (let depth = limit; depth >= 1; depth--) {
        const m = metrics(depth)
        const [fx, fy] = ahead(w, depth)
        const [lx, ly] = sideOf(w, depth, -1)
        const [rx, ry] = sideOf(w, depth, 1)
        if (isWall(w, lx, ly)) items.push({ z: 20 - depth, draw: () => sprite(target, WALL, 80 - m.spread, m.y, m.scale) })
        if (isWall(w, rx, ry)) items.push({ z: 20 - depth, draw: () => sprite(target, WALL, 80 + m.spread, m.y, m.scale) })
        if (depth === limit && isWall(w, fx, fy)) {
            items.push({ z: 20 - depth, draw: () => sprite(target, WALL, 80, m.y, m.scale) })
        } else if (w.imps.some((imp) => imp.x === fx && imp.y === fy)) {
            items.push({ z: 30 - depth, draw: () => sprite(target, IMP, 80, m.y + 6, Math.max(1, m.scale - 1)) })
        }
    }
    items.sort((a, b) => a.z - b.z).forEach((item) => item.draw())
    target.fillRect(0, 0, 3 * 9 + 4, 11, 1)
    for (let i = 0; i < w.lives; i++) sprite(target, HEART, 6 + i * 9, 5, 1)
}

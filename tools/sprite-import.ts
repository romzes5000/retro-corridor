// Imports the enemy sprite sheet (art-src/demons.png) into art-enemies.ts: cuts the cells listed in
// SHEET, drops the background by flooding from the cell border, maps every pixel to the game palette
// and shrinks each kind with one scale, so death frames and corpses stay low on the floor.
// Run: npm run sprites  ->  art-enemies.ts, demo/out/sheet-enemies.png, demo/out/sheet-cells.png
import fs from "node:fs"
import vm from "node:vm"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { PNG } from "pngjs"

export interface Rgba {
    width: number
    height: number
    data: Uint8Array
}

export interface Box {
    x0: number
    y0: number
    x1: number
    y1: number
}

export interface Band {
    name: string
    size: number
    // "walk": bottom-centred, scaled by the first frame's height; "fit": centred, scaled to fit.
    anchor: "walk" | "fit"
    // Palette slots this kind may use, so dark body shading stays on the kind's own ramp.
    colours: number[]
    y0: number
    y1: number
    cells: Array<[number, number]>
}

// Inclusive pixel boxes, measured on the sheet; labels under each row stay outside y0..y1.
export const SHEET: Band[] = [
    {
        name: "imp", size: 16, anchor: "walk", colours: [1, 2, 3, 4, 5, 9, 15], y0: 28, y1: 162,
        cells: [[5, 124], [128, 236], [238, 380], [382, 490], [494, 620], [622, 734], [736, 886], [888, 1018]],
    },
    {
        name: "shooter", size: 16, anchor: "walk", colours: [1, 4, 5, 9, 10, 11, 12, 15], y0: 228, y1: 354,
        cells: [[10, 118], [122, 244], [246, 370], [372, 484], [486, 620], [622, 746], [748, 876], [878, 1020]],
    },
    {
        name: "knight", size: 16, anchor: "walk", colours: [1, 2, 3, 4, 6, 7, 8, 9, 15], y0: 405, y1: 536,
        cells: [[8, 124], [126, 238], [240, 376], [378, 490], [492, 618], [620, 746], [748, 880], [882, 1020]],
    },
    {
        name: "boss", size: 24, anchor: "walk", colours: [1, 2, 3, 4, 5, 8, 9, 15], y0: 588, y1: 756,
        cells: [[5, 121], [122, 236], [238, 372], [374, 490], [492, 624], [626, 746], [748, 872], [874, 1020]],
    },
    { name: "fireball", size: 8, anchor: "fit", colours: [1, 2, 3, 4, 5], y0: 820, y1: 876, cells: [[30, 110], [140, 220]] },
]

// Sheet columns are walk A, walk B, attack, hurt, die 1-3, corpse; the game indexes frames as
// walk A, walk B, attack, corpse, hurt, die A-C (FRAME_* in render.ts).
export const GAME_ORDER = [0, 1, 2, 7, 3, 4, 5, 6]

export const COVERAGE = 0.35
// The sheet's 1-px black outline and shading dominate 8x8 blocks; at 16 px that reads as holes, so
// black only wins a block when it clearly outnumbers the body colours.
export const BLACK = 15
export const BLACK_WEIGHT = 0.4
// Transparent, key blue and ceiling never appear on a monster.
export const BLOCKED = [0, 13, 14]
const LIGHT = 235

// [band, sheet column, x, y, colour or -1 for transparent], applied after shrinking.
export const OVERRIDES: Array<[string, number, number, number, number]> = []

const HEX = "0123456789abcdef"

export function loadPalette(): number[] {
    const src = fs.readFileSync(new URL("../art.ts", import.meta.url), "utf8")
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText
    const context: Record<string, unknown> = {}
    vm.createContext(context)
    vm.runInContext(js + "\nthis.__palette = corridorArt.PALETTE", context)
    return context.__palette as number[]
}

export function readSheet(path: string): Rgba {
    const png = PNG.sync.read(fs.readFileSync(path))
    return { width: png.width, height: png.height, data: png.data }
}

// Closest allowed palette slot by the "redmean" weighted RGB distance.
export function nearest(palette: number[], r: number, g: number, b: number, allowed: number[] = []): number {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < palette.length; i++) {
        if (BLOCKED.includes(i) || (allowed.length > 0 && !allowed.includes(i))) continue
        const pr = (palette[i] >> 16) & 255
        const pg = (palette[i] >> 8) & 255
        const pb = palette[i] & 255
        const rm = (r + pr) / 2
        const dr = r - pr
        const dg = g - pg
        const db = b - pb
        const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db
        if (d < bestD) {
            bestD = d
            best = i
        }
    }
    return best
}

function backgroundLike(img: Rgba, x: number, y: number): boolean {
    const i = (y * img.width + x) * 4
    if (img.data[i + 3] < 128) return true
    return Math.min(img.data[i], img.data[i + 1], img.data[i + 2]) > LIGHT
}

// Foreground mask of the box (1 = sprite): background is whatever transparent or near-white area
// touches the box border, so light pixels inside the silhouette (bone horns, teeth) survive.
export function foreground(img: Rgba, box: Box): Uint8Array {
    const w = box.x1 - box.x0 + 1
    const h = box.y1 - box.y0 + 1
    const bg = new Uint8Array(w * h)
    const queue: number[] = []
    const seed = (x: number, y: number) => {
        const k = y * w + x
        if (bg[k] || !backgroundLike(img, box.x0 + x, box.y0 + y)) return
        bg[k] = 1
        queue.push(k)
    }
    for (let x = 0; x < w; x++) {
        seed(x, 0)
        seed(x, h - 1)
    }
    for (let y = 0; y < h; y++) {
        seed(0, y)
        seed(w - 1, y)
    }
    for (let head = 0; head < queue.length; head++) {
        const k = queue[head]
        const x = k % w
        const y = (k - x) / w
        if (x > 0) seed(x - 1, y)
        if (x < w - 1) seed(x + 1, y)
        if (y > 0) seed(x, y - 1)
        if (y < h - 1) seed(x, y + 1)
    }
    const fg = new Uint8Array(w * h)
    for (let k = 0; k < fg.length; k++) {
        const x = k % w
        const y = (k - x) / w
        fg[k] = bg[k] || img.data[((box.y0 + y) * img.width + box.x0 + x) * 4 + 3] < 128 ? 0 : 1
    }
    return fg
}

export function bounds(mask: Uint8Array, w: number): Box | null {
    let box: Box | null = null
    for (let k = 0; k < mask.length; k++) {
        if (!mask[k]) continue
        const x = k % w
        const y = (k - x) / w
        if (!box) box = { x0: x, y0: y, x1: x, y1: y }
        box.x0 = Math.min(box.x0, x)
        box.x1 = Math.max(box.x1, x)
        box.y0 = Math.min(box.y0, y)
        box.y1 = Math.max(box.y1, y)
    }
    return box
}

export interface Cell {
    w: number
    h: number
    mask: Uint8Array
    colour: Int8Array
    content: Box
}

export function cutCell(img: Rgba, box: Box, palette: number[], allowed: number[] = []): Cell {
    const mask = foreground(img, box)
    const w = box.x1 - box.x0 + 1
    const h = box.y1 - box.y0 + 1
    const colour = new Int8Array(w * h).fill(-1)
    for (let k = 0; k < mask.length; k++) {
        if (!mask[k]) continue
        const x = k % w
        const y = (k - x) / w
        const i = ((box.y0 + y) * img.width + box.x0 + x) * 4
        colour[k] = nearest(palette, img.data[i], img.data[i + 1], img.data[i + 2], allowed)
    }
    const content = bounds(mask, w)
    if (!content) throw new Error(`empty cell at ${box.x0},${box.y0}`)
    return { w, h, mask, colour, content }
}

// Shrinks a cell into size x size rows. Source x `cx` lands on the middle column and source row
// `bottom` on the last row; each target pixel takes the most common colour of its source block,
// or stays transparent when less than COVERAGE of the block is sprite.
export function shrink(cell: Cell, scale: number, size: number, cx: number, bottom: number): string[] {
    const rows: string[] = []
    const step = 1 / scale
    for (let ty = 0; ty < size; ty++) {
        let row = ""
        const sy0 = bottom + 1 - (size - ty) * step
        for (let tx = 0; tx < size; tx++) {
            const sx0 = cx + (tx - size / 2) * step
            const counts = new Map<number, number>()
            let area = 0
            let solid = 0
            for (let sy = Math.floor(sy0); sy < Math.ceil(sy0 + step); sy++) {
                for (let sx = Math.floor(sx0); sx < Math.ceil(sx0 + step); sx++) {
                    area++
                    if (sx < 0 || sy < 0 || sx >= cell.w || sy >= cell.h) continue
                    const c = cell.colour[sy * cell.w + sx]
                    if (c < 0) continue
                    solid++
                    counts.set(c, (counts.get(c) ?? 0) + 1)
                }
            }
            if (area === 0 || solid / area < COVERAGE) {
                row += "."
                continue
            }
            let best = -1
            let bestN = -1
            for (const [c, count] of [...counts].sort((a, b) => a[0] - b[0])) {
                const n = c === BLACK ? count * BLACK_WEIGHT : count
                if (n > bestN) {
                    best = c
                    bestN = n
                }
            }
            row += HEX.charAt(best)
        }
        rows.push(row)
    }
    return rows
}

export function applyOverrides(rows: string[], fixes: Array<[number, number, number]>): string[] {
    const out = rows.map((row) => row.split(""))
    for (const [x, y, c] of fixes) out[y][x] = c < 0 ? "." : HEX.charAt(c)
    return out.map((row) => row.join(""))
}

export interface Imported {
    enemies: string[][][]
    fireball: string[][]
}

// Frames of one band in sheet order.
export function importBand(img: Rgba, band: Band, palette: number[]): string[][] {
    const cells = band.cells.map(([x0, x1]) => cutCell(img, { x0, y0: band.y0, x1, y1: band.y1 }, palette, band.colours))
    const first = cells[0].content
    return cells.map((cell, col) => {
        const c = cell.content
        const cx = (c.x0 + c.x1 + 1) / 2
        let rows: string[]
        if (band.anchor === "walk") {
            const scale = (band.size - 1) / (first.y1 - first.y0 + 1)
            rows = shrink(cell, scale, band.size, cx, c.y1)
        } else {
            const scale = band.size / Math.max(c.x1 - c.x0 + 1, c.y1 - c.y0 + 1)
            const bottom = (c.y0 + c.y1 + 1) / 2 + band.size / 2 / scale - 1
            rows = shrink(cell, scale, band.size, cx, bottom)
        }
        const fixes = OVERRIDES.filter((o) => o[0] === band.name && o[1] === col).map((o): [number, number, number] => [o[2], o[3], o[4]])
        return applyOverrides(rows, fixes)
    })
}

export function importSheet(img: Rgba, palette: number[]): Imported {
    const enemies: string[][][] = []
    let fireball: string[][] = []
    for (const band of SHEET) {
        const frames = importBand(img, band, palette)
        if (band.name === "fireball") fireball = frames
        else enemies.push(GAME_ORDER.map((col) => frames[col]))
    }
    return { enemies, fireball }
}

function block(frames: string[][], indent: string): string {
    return frames.map((rows) => `${indent}[\n${rows.map((r) => `${indent}    "${r}",`).join("\n")}\n${indent}],`).join("\n")
}

export function formatArt(art: Imported): string {
    const kinds = art.enemies.map((frames) => `        [\n${block(frames, "            ")}\n        ],`).join("\n")
    return `// Generated by \`npm run sprites\` from art-src/demons.png. Do not edit by hand: change the sheet,
// SHEET or OVERRIDES in tools/sprite-import.ts and re-run.
namespace corridorArt {
    // [kind][frame]: imp, shooter, knight, boss; frames in FRAME_* order (walk A, walk B, attack,
    // corpse, hurt, die A, die B, die C).
    export const ENEMY_ART = [
${kinds}
    ]

    export const FIREBALL_FRAMES = [
${block(art.fireball, "        ")}
    ]
}
`
}

function writeRgba(path: string, w: number, h: number, data: Uint8Array): void {
    const png = new PNG({ width: w, height: h })
    png.data = Buffer.from(data)
    fs.writeFileSync(path, PNG.sync.write(png))
}

// Every frame at x6 on the ceiling colour, one row per kind.
function preview(art: Imported, palette: number[], path: string): void {
    const zoom = 6
    const rows = [...art.enemies, art.fireball]
    const cell = 26 * zoom
    const w = cell * 8
    const h = cell * rows.length
    const data = new Uint8Array(w * h * 4)
    const bg = palette[14]
    for (let i = 0; i < w * h; i++) data.set([(bg >> 16) & 255, (bg >> 8) & 255, bg & 255, 255], i * 4)
    rows.forEach((frames, r) => frames.forEach((frame, f) => {
        frame.forEach((line, y) => [...line].forEach((ch, x) => {
            if (ch === ".") return
            const c = palette[HEX.indexOf(ch)]
            for (let dy = 0; dy < zoom; dy++) {
                for (let dx = 0; dx < zoom; dx++) {
                    const px = f * cell + x * zoom + dx
                    const py = r * cell + y * zoom + dy
                    data.set([(c >> 16) & 255, (c >> 8) & 255, c & 255, 255], (py * w + px) * 4)
                }
            }
        }))
    }))
    writeRgba(path, w, h, data)
}

// The sheet with every SHEET box outlined, to check the table against the art.
function cellsOverlay(img: Rgba, path: string): void {
    const data = new Uint8Array(img.data)
    const mark = (x: number, y: number) => data.set([255, 0, 255, 255], (y * img.width + x) * 4)
    for (const band of SHEET) {
        for (const [x0, x1] of band.cells) {
            for (let x = x0; x <= x1; x++) {
                mark(x, band.y0)
                mark(x, band.y1)
            }
            for (let y = band.y0; y <= band.y1; y++) {
                mark(x0, y)
                mark(x1, y)
            }
        }
    }
    writeRgba(path, img.width, img.height, data)
}

function main(): void {
    const img = readSheet(fileURLToPath(new URL("../art-src/demons.png", import.meta.url)))
    const palette = loadPalette()
    const art = importSheet(img, palette)
    fs.writeFileSync(new URL("../art-enemies.ts", import.meta.url), formatArt(art))
    const out = new URL("../demo/out/", import.meta.url)
    fs.mkdirSync(out, { recursive: true })
    preview(art, palette, fileURLToPath(new URL("sheet-enemies.png", out)))
    cellsOverlay(img, fileURLToPath(new URL("sheet-cells.png", out)))
    console.log(`art-enemies.ts: ${art.enemies.length} kinds x ${art.enemies[0].length} frames, ${art.fireball.length} fireball frames`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()

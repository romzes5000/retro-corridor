// Frame renderer. Uses only fill/fillRect/setPixel/drawImage/blitRow/blit/drawTransparentImage
// so fake-image.ts can run this exact file in Node for tests and demo GIFs.
namespace corridorRender {
    export const MODE_TITLE = 0
    export const MODE_PLAY = 1
    export const MODE_VICTORY = 2

    export const MELT_ROWS = 120

    export const FACE_OK = 0
    export const FACE_HURT = 1
    export const FACE_GRIN = 2
    export const FACE_DEAD = 3

    const W = corridor.VIEW_W
    const VH = corridor.VIEW_H
    const HORIZON = VH >> 1
    const HEX = "0123456789abcdef"

    const FRAME_WALK_A = 0
    const FRAME_WALK_B = 1
    const FRAME_ATTACK = 2
    const FRAME_DEAD = 3
    const FRAME_HURT = 4
    const FRAME_DIE_A = 5
    const FRAME_DIE_B = 6
    const FRAME_DIE_C = 7

    export class View {
        mode: number
        mapOpen: boolean
        flash: number
        recoil: number
        hurt: number
        shake: number
        pickup: number
        face: number
        faceTime: number
        showFps: boolean
        fps: number
        frames: number
        acc: number
        colStep: number
        quality: number
        slowFor: number
        menu: corridor.Menu
        session: corridor.Session
        records: string[]
        meltOn: boolean
        melt: number[]
        pause: corridor.Pause
        // AI player status line ("JEV ATTACK 84% 230MS"); empty when a human plays.
        aiLine: string
        // The line turns red when the AI is in danger.
        aiAlert: boolean
        constructor() {
            this.pause = null
            this.aiLine = ""
            this.aiAlert = false
            this.menu = new corridor.Menu()
            this.session = null
            this.records = []
            this.meltOn = false
            this.melt = []
            this.mode = MODE_TITLE
            this.mapOpen = false
            this.flash = 0
            this.recoil = 0
            this.hurt = 0
            this.shake = 0
            this.pickup = 0
            this.face = FACE_OK
            this.faceTime = 0
            this.showFps = false
            this.fps = 0
            this.frames = 0
            this.acc = 0
            this.colStep = 1
            this.quality = QUALITY_FULL
            this.slowFor = 0
        }
    }

    // Quality ladder: textured floor per pixel, floor in 2x2 blocks, flat floor bands (lava still
    // drawn in 4x4 blocks so it stays visible), then also 80 rays (2-pixel wall columns).
    export const QUALITY_FULL = 0
    export const QUALITY_HALF = 1
    export const QUALITY_BANDS = 2
    export const QUALITY_LOW = 3
    export const SLOW_FPS = 20
    export const SLOW_MS = 3000

    // One rung down each time the measured FPS stays under SLOW_FPS for SLOW_MS; never back up.
    export function adapt(view: View, dt: number): void {
        if (view.quality >= QUALITY_LOW || view.fps == 0) return
        view.slowFor = view.fps < SLOW_FPS ? view.slowFor + dt : 0
        if (view.slowFor > SLOW_MS) {
            view.quality += 1
            view.slowFor = 0
        }
        view.colStep = view.quality >= QUALITY_LOW ? 2 : 1
    }

    let walls: Image[][] = []
    let lockedExit: Image[] = []
    let meltImg: Image = null
    let enemyFrames: Image[][][] = []
    let fireball: Image[][] = []
    let decalImages: Image[][] = []
    let shotgun: Image = null
    let itemImages: Image[][] = []
    let faces: Image[] = []
    let gun: Image = null
    let muzzle: Image = null
    let backdrop: Image = null
    let hud: Image = null
    let hudKey = ""
    const zbuf: number[] = []
    const cRdx: number[] = []
    const cRdy: number[] = []
    const cBottom: number[] = []
    const lit: number[] = []
    const ROWDIST: number[] = []
    // Rows closer to the horizon than this (floor beyond ~8 cells) keep the dark backdrop band.
    const FLOOR_MIN_R = 6
    let floorTex: number[][] = []
    let lavaTex: number[] = []
    const order: number[] = []
    const depths: number[] = []
    const hit = new corridor.Hit()
    const proj = new corridor.Proj()

    export function decode(rows: string[]): Image {
        const h = rows.length
        const w = rows[0].length
        const img = image.create(w, h)
        for (let y = 0; y < h; y++) {
            const row = rows[y]
            for (let x = 0; x < w; x++) {
                const ch = row.charAt(x)
                if (ch != ".") img.setPixel(x, y, HEX.indexOf(ch))
            }
        }
        return img
    }

    export function darken(src: Image, steps: number): Image {
        const out = image.create(src.width, src.height)
        for (let y = 0; y < src.height; y++) {
            for (let x = 0; x < src.width; x++) {
                let c = src.getPixel(x, y)
                for (let s = 0; s < steps && c != 0; s++) c = corridorArt.DARKER[c]
                if (c != 0) out.setPixel(x, y, c)
            }
        }
        return out
    }

    // Replaces template char "x" in art rows with a palette colour.
    function tint(rows: string[], c: number): string[] {
        const out: string[] = []
        const ch = HEX.charAt(c)
        for (const row of rows) {
            let line = ""
            for (let i = 0; i < row.length; i++) line += row.charAt(i) == "x" ? ch : row.charAt(i)
            out.push(line)
        }
        return out
    }

    // Frames of one enemy kind from the imported sheet (art-enemies.ts), each with 3 distance shades.
    function enemySet(kind: number): Image[][] {
        const out: Image[][] = []
        for (const rows of corridorArt.ENEMY_ART[kind]) out.push(shades(decode(rows), 3))
        return out
    }

    function overlay(base: Image, top: Image): Image {
        const out = base.clone()
        out.drawTransparentImage(top, 0, 0)
        return out
    }

    function texels(img: Image): number[] {
        const out: number[] = []
        for (let i = 0; i < 256; i++) out.push(img.getPixel(i & 15, i >> 4))
        return out
    }

    function shades(src: Image, count: number): Image[] {
        const out: Image[] = [src]
        for (let s = 1; s < count; s++) out.push(darken(src, s))
        return out
    }

    function buildBackdrop(): Image {
        const img = image.create(W, VH)
        for (const band of corridorArt.BANDS) {
            for (let y = band[0]; y <= band[1]; y++) {
                if (band[2] == band[3]) {
                    img.fillRect(0, y, W, 1, band[2])
                } else {
                    for (let x = 0; x < W; x++) img.setPixel(x, y, ((x + y) & 1) == 0 ? band[2] : band[3])
                }
            }
        }
        return img
    }

    export function init(): void {
        if (walls.length > 0) return
        const stoneImg = decode(corridorArt.STONE)
        const stone = shades(stoneImg, 4)
        const secret = stoneImg.clone()
        for (let i = 3; i < 12; i++) secret.setPixel(i, i + 2, 9)
        const exitImg = decode(corridorArt.EXIT)
        walls = [
            stone,
            stone,
            shades(decode(corridorArt.BRICK), 4),
            shades(exitImg, 4),
            shades(decode(tint(corridorArt.DOOR, 4)), 4),
            shades(decode(tint(corridorArt.DOOR, 2)), 4),
            shades(decode(tint(corridorArt.DOOR, 13)), 4),
            shades(secret, 4),
        ]
        lockedExit = shades(overlay(exitImg, decode(corridorArt.EXIT_BARS)), 4)
        enemyFrames = []
        for (let kind = 0; kind < corridorArt.ENEMY_ART.length; kind++) enemyFrames.push(enemySet(kind))
        fireball = []
        for (const rows of corridorArt.FIREBALL_FRAMES) fireball.push(shades(decode(rows), 2))
        decalImages = [shades(decode(corridorArt.BLOOD), 3), shades(decode(corridorArt.SCORCH), 3)]
        shotgun = decode(corridorArt.SHOTGUN)
        itemImages = [
            shades(decode(corridorArt.MEDKIT), 3),
            shades(decode(corridorArt.AMMO), 3),
            shades(decode(tint(corridorArt.KEY, 2)), 3),
            shades(decode(tint(corridorArt.KEY, 13)), 3),
            shades(decode(corridorArt.SHOTGUN_ITEM), 3),
        ]
        faces = [
            decode(corridorArt.FACE_OK),
            decode(corridorArt.FACE_HURT),
            decode(corridorArt.FACE_GRIN),
            decode(corridorArt.FACE_DEAD),
        ]
        gun = decode(corridorArt.GUN)
        muzzle = decode(corridorArt.FLASH)
        backdrop = buildBackdrop()
        hud = image.create(W, 20)
        for (let i = 0; i < W; i++) {
            zbuf.push(0)
            cRdx.push(0)
            cRdy.push(0)
            cBottom.push(0)
        }
        for (let r = 0; r <= 2 * VH; r++) ROWDIST.push(r == 0 ? 0 : Math.idiv((VH >> 1) * corridor.FP, r))
        const floor = decode(corridorArt.FLOOR)
        floorTex = []
        for (let sh = 0; sh < 4; sh++) floorTex.push(texels(sh == 0 ? floor : darken(floor, sh)))
        lavaTex = texels(decode(corridorArt.LAVA))
        for (let i = 0; i < 96; i++) {
            order.push(0)
            depths.push(0)
        }
    }

    export function textWidth(s: string, scale: number): number {
        return s.length * 4 * scale - scale
    }

    // A glyph in corridorArt.FONT: 15 bits and a newline.
    export const FONT_STRIDE = 16

    export function text(target: Image, s: string, x: number, y: number, c: number, scale: number): void {
        let cx = x
        for (let i = 0; i < s.length; i++) {
            const g = corridorArt.GLYPHS.indexOf(s.charAt(i))
            if (g >= 0) {
                const at = g * FONT_STRIDE
                for (let b = 0; b < 15; b++) {
                    if (corridorArt.FONT.charAt(at + b) == "1") {
                        target.fillRect(cx + (b % 3) * scale, y + Math.idiv(b, 3) * scale, scale, scale, c)
                    }
                }
            }
            cx += 4 * scale
        }
    }

    function shadowText(target: Image, s: string, x: number, y: number, c: number, scale: number): void {
        text(target, s, x + 1, y + 1, 15, scale)
        text(target, s, x, y, c, scale)
    }

    function centered(target: Image, s: string, y: number, c: number, scale: number): void {
        shadowText(target, s, (W - textWidth(s, scale)) >> 1, y, c, scale)
    }

    function drawSprite(target: Image, img: Image, depth: number, screenX: number, size: number,
        pct: number, ox: number, horizon: number): void {
        const dh = Math.idiv(size * pct, 100)
        if (dh < 2) return
        const dw = Math.idiv(dh * img.width, img.height)
        const x0 = screenX - (dw >> 1)
        const y0 = horizon + (size >> 1) - dh
        const c0 = Math.max(0, x0)
        const c1 = Math.min(W - 1, x0 + dw - 1)
        for (let c = c0; c <= c1; c++) {
            if (depth >= zbuf[c]) continue
            const sx = Math.idiv((c - x0) * img.width, dw)
            target.blit(c + ox, y0, 1, dh, img, sx, 0, 1, img.height, true, false)
        }
    }

    // Fireballs fly at chest height instead of standing on the floor like other sprites.
    function drawFireball(target: Image, depth: number, screenX: number, size: number, ox: number, horizon: number, time: number): void {
        const d = Math.max(2, size >> 2)
        const img = fireball[(time >> 7) & 1][depth > 4 * corridor.FP ? 1 : 0]
        const x0 = screenX - (d >> 1)
        const y0 = horizon - (d >> 1) + (size >> 4)
        for (let c = Math.max(0, x0); c <= Math.min(W - 1, x0 + d - 1); c++) {
            if (depth >= zbuf[c]) continue
            const sx = Math.idiv((c - x0) * img.width, d)
            target.blit(c + ox, y0, 1, d, img, sx, 0, 1, img.height, true, false)
        }
    }

    function enemyFrame(enemy: corridor.Enemy): number {
        if (enemy.dead) {
            const f = Math.idiv(enemy.deadMs, corridor.DIE_FRAME_MS)
            if (f == 0) return FRAME_DIE_A
            if (f == 1) return FRAME_DIE_B
            if (f == 2) return FRAME_DIE_C
            return FRAME_DEAD
        }
        if (enemy.hurt > 0) return FRAME_HURT
        if (enemy.attack > 0) return FRAME_ATTACK
        return ((enemy.walk >> 9) & 1) == 1 ? FRAME_WALK_B : FRAME_WALK_A
    }

    function spriteShade(world: corridor.World, x: number, y: number, depth: number): number {
        const cx = x >> 10
        const cy = y >> 10
        const light = cx >= 0 && cy >= 0 && cx < world.w && cy < world.h ? lit[cy * world.w + cx] : 0
        return Math.min(2, (depth >> 12) + light)
    }

    function updateLit(world: corridor.World): void {
        const n = world.w * world.h
        while (lit.length < n) lit.push(0)
        for (let cy = 0; cy < world.h; cy++) {
            for (let cx = 0; cx < world.w; cx++) lit[cy * world.w + cx] = corridor.lightAt(world, cx, cy)
        }
    }

    // Floor casting per column below the wall bottom: screen row y maps to the fixed floor distance
    // rowDist = (VH / 2) * FP / (y - horizon), with the horizon already moved by bob and shake.
    // fs > 1 fills fs x fs blocks; lavaOnly leaves plain floor to the backdrop bands.
    function drawFloor(target: Image, world: corridor.World, horizon: number, ox: number, fs: number, lavaOnly: boolean): void {
        const px = world.x
        const py = world.y
        const mapW = world.w
        const cells = world.w * world.h
        const flow = (world.time >> 3) & 1023
        for (let col = 0; col < W; col += fs) {
            let y = cBottom[col]
            for (let k = 1; k < fs && col + k < W; k++) y = Math.min(y, cBottom[col + k])
            if (y < horizon + FLOOR_MIN_R) y = horizon + FLOOR_MIN_R
            const rdx = cRdx[col]
            const rdy = cRdy[col]
            for (; y < VH; y += fs) {
                const d = ROWDIST[y - horizon]
                const fx = px + ((d * rdx) >> 10)
                const fy = py + ((d * rdy) >> 10)
                const cell = (fy >> 10) * mapW + (fx >> 10)
                if (fx < 0 || fy < 0 || cell >= cells) continue
                let c = 0
                if (world.lava[cell] == 1) {
                    c = lavaTex[((((fy + flow) >> 6) & 15) << 4) + (((fx + flow) >> 6) & 15)]
                } else if (lavaOnly) {
                    continue
                } else {
                    let sh = (d >> 11) + lit[cell]
                    if (sh > 3) sh = 3
                    c = floorTex[sh][(((fy >> 6) & 15) << 4) + ((fx >> 6) & 15)]
                }
                if (fs == 1) target.setPixel(col + ox, y, c)
                else target.fillRect(col + ox, y, fs, fs, c)
            }
        }
    }

    function drawThings(target: Image, world: corridor.World, ox: number, horizon: number): void {
        let n = 0
        for (let i = 0; i < world.enemies.length && n < order.length; i++) {
            const enemy = world.enemies[i]
            corridor.project(world, enemy.x, enemy.y, proj)
            if (!proj.visible) continue
            order[n] = i
            depths[n] = proj.depth
            n++
        }
        for (let j = 0; j < world.shots.length && n < order.length; j++) {
            const shot = world.shots[j]
            corridor.project(world, shot.x, shot.y, proj)
            if (!proj.visible) continue
            order[n] = 2000 + j
            depths[n] = proj.depth
            n++
        }
        for (let j = 0; j < world.items.length && n < order.length; j++) {
            const item = world.items[j]
            if (item.taken) continue
            corridor.project(world, item.x, item.y, proj)
            if (!proj.visible) continue
            order[n] = 1000 + j
            depths[n] = proj.depth
            n++
        }
        // Decals go last so a full order buffer drops floor stains, never enemies or items.
        for (let j = 0; j < world.decals.length && n < order.length; j++) {
            const decal = world.decals[j]
            corridor.project(world, decal.x, decal.y, proj)
            if (!proj.visible) continue
            order[n] = 3000 + j
            depths[n] = proj.depth
            n++
        }
        for (let i = 1; i < n; i++) {
            const o = order[i]
            const d = depths[i]
            let k = i - 1
            while (k >= 0 && depths[k] < d) {
                order[k + 1] = order[k]
                depths[k + 1] = depths[k]
                k--
            }
            order[k + 1] = o
            depths[k + 1] = d
        }
        for (let i = 0; i < n; i++) {
            const id = order[i]
            if (id >= 3000) {
                const decal = world.decals[id - 3000]
                corridor.project(world, decal.x, decal.y, proj)
                const s = spriteShade(world, decal.x, decal.y, proj.depth)
                drawSprite(target, decalImages[decal.kind][s], proj.depth, proj.screenX, proj.size, 14, ox, horizon)
            } else if (id >= 2000) {
                const shot = world.shots[id - 2000]
                corridor.project(world, shot.x, shot.y, proj)
                drawFireball(target, proj.depth, proj.screenX, proj.size, ox, horizon, world.time)
            } else if (id >= 1000) {
                const item = world.items[id - 1000]
                corridor.project(world, item.x, item.y, proj)
                const s = spriteShade(world, item.x, item.y, proj.depth)
                drawSprite(target, itemImages[item.kind][s], proj.depth, proj.screenX, proj.size, 38, ox, horizon)
            } else {
                const enemy = world.enemies[id]
                corridor.project(world, enemy.x, enemy.y, proj)
                const s = spriteShade(world, enemy.x, enemy.y, proj.depth)
                const pct = corridor.ENEMY_SIZE[enemy.kind]
                drawSprite(target, enemyFrames[enemy.kind][enemyFrame(enemy)][s], proj.depth, proj.screenX, proj.size, pct, ox, horizon)
            }
        }
    }

    function drawMap(target: Image, world: corridor.World): void {
        const cell = Math.max(2, Math.min(5, Math.idiv(84, Math.max(world.w, world.h))))
        const mw = world.w * cell
        const mh = world.h * cell
        const mx = (W - mw) >> 1
        const my = ((VH - mh) >> 1) + 3
        target.fillRect(mx - 3, my - 9, mw + 6, mh + 12, 8)
        target.fillRect(mx - 2, my - 8, mw + 4, mh + 10, 15)
        text(target, "MAP", mx, my - 7, 6, 1)
        text(target, corridor.heading(world.ang), mx + mw - 3, my - 7, 4, 1)
        for (let cy = 0; cy < world.h; cy++) {
            for (let cx = 0; cx < world.w; cx++) {
                const tile = corridor.tileAt(world, cx, cy)
                let c = 12
                if (tile == corridor.TILE_STONE || tile == corridor.TILE_SECRET) c = 7
                else if (tile == corridor.TILE_BRICK) c = 10
                else if (tile == corridor.TILE_EXIT) c = world.exitLocked ? 3 : 4
                else if (tile == corridor.TILE_DOOR) c = 6
                else if (tile == corridor.TILE_DOOR_RED) c = 2
                else if (tile == corridor.TILE_DOOR_BLUE) c = 13
                else if (corridor.lavaAt(world, cx, cy)) c = 5
                target.fillRect(mx + cx * cell, my + cy * cell, cell, cell, c)
            }
        }
        const dot = Math.max(1, cell - 2)
        for (const item of world.items) {
            if (item.taken) continue
            const ix = mx + ((item.x * cell) >> 10) - (dot >> 1)
            const iy = my + ((item.y * cell) >> 10) - (dot >> 1)
            let ic = 5
            if (item.kind == corridor.ITEM_HEALTH) ic = 1
            else if (item.kind == corridor.ITEM_KEY_RED) ic = 2
            else if (item.kind == corridor.ITEM_KEY_BLUE) ic = 13
            target.fillRect(ix, iy, dot, dot, ic)
        }
        for (const enemy of world.enemies) {
            if (enemy.dead || !enemy.sees) continue
            const ix = mx + ((enemy.x * cell) >> 10) - (dot >> 1)
            const iy = my + ((enemy.y * cell) >> 10) - (dot >> 1)
            target.fillRect(ix, iy, dot, dot, 2)
        }
        const px = mx + ((world.x * cell) >> 10)
        const py = my + ((world.y * cell) >> 10)
        const dx = corridor.cos(world.ang)
        const dy = corridor.sin(world.ang)
        for (let i = 1; i <= cell * 2; i++) {
            target.setPixel(px + ((dx * i) >> 10), py + ((dy * i) >> 10), 4)
        }
        target.fillRect(px - 1, py - 1, 3, 3, 1)
    }

    function faceFor(world: corridor.World, view: View): number {
        if (world.lost) return FACE_DEAD
        if (view.faceTime > 0) return view.face
        if (world.health < 35) return FACE_HURT
        return FACE_OK
    }

    function drawHud(target: Image, world: corridor.World, view: View): void {
        const face = faceFor(world, view)
        const dir = corridor.heading(world.ang)
        const key = world.health + "," + world.ammo + "," + world.kills + "," + face + "," + dir + "," + world.keys
        if (key != hudKey) {
            hudKey = key
            hud.fill(9)
            hud.fillRect(0, 0, W, 1, 7)
            hud.fillRect(0, 1, W, 1, 8)
            text(hud, "HEALTH", 4, 3, 6, 1)
            const hc = world.health > 50 ? 1 : world.health > 25 ? 4 : 2
            text(hud, "" + world.health, 4, 9, hc, 2)
            text(hud, "KILLS", 36, 3, 6, 1)
            text(hud, world.kills + "/" + world.total, 36, 11, 1, 1)
            hud.fillRect(70, 2, 20, 18, 15)
            hud.drawTransparentImage(faces[face], 72, 3)
            if ((world.keys & corridor.KEY_RED) != 0) hud.fillRect(91, 5, 3, 5, 2)
            if ((world.keys & corridor.KEY_BLUE) != 0) hud.fillRect(91, 12, 3, 5, 13)
            text(hud, "DIR", 96, 3, 6, 1)
            text(hud, dir, 98, 9, 4, 2)
            text(hud, "AMMO", 124, 3, 6, 1)
            text(hud, "" + world.ammo, 124, 9, world.ammo > 0 ? 4 : 2, 2)
        }
        target.drawImage(hud, 0, VH)
    }

    function panel(target: Image, y: number, h: number, border: number): void {
        target.fillRect(12, y, W - 24, h, border)
        target.fillRect(14, y + 2, W - 28, h - 4, 15)
    }

    export const TITLE_ITEM_Y = 29
    export const TITLE_ITEM_STEP = 9
    export const TITLE_HINT_Y = 86

    function drawTitle(target: Image, view: View): void {
        const menu = view.menu
        panel(target, 6, 90, 5)
        centered(target, "CORRIDOR", 12, 4, 2)
        if (menu.records) {
            centered(target, "RECORDS", 30, 6, 1)
            if (view.records.length == 0) centered(target, "NONE YET", 46, 1, 1)
            for (let i = 0; i < view.records.length && i < 5; i++) centered(target, view.records[i], 40 + i * 8, 1, 1)
            centered(target, "A BACK", 86, 6, 1)
            return
        }
        if (menu.levels) {
            centered(target, "LEVELS", 30, 6, 1)
            for (let i = 0; i < corridor.LEVELS.length; i++) {
                const sel = i == menu.level
                const label = (i + 1) + " " + corridor.LEVELS[i].name
                centered(target, sel ? "> " + label : label, 42 + i * 10, sel ? 4 : 1, 1)
            }
            centered(target, "A START  B BACK", 86, 6, 1)
            return
        }
        const labels = ["CAMPAIGN", "LEVELS", "ENDLESS", "- " + corridor.DIFF_NAMES[menu.difficulty] + " +",
            "PLAYER " + (menu.ai ? "AI" : "HUMAN"), "RECORDS"]
        for (let i = 0; i < labels.length; i++) {
            const sel = i == menu.index
            centered(target, sel ? "> " + labels[i] : labels[i], TITLE_ITEM_Y + i * TITLE_ITEM_STEP, sel ? 4 : 1, 1)
        }
        centered(target, "A SELECT", TITLE_HINT_Y, 6, 1)
    }

    function drawSummary(target: Image, world: corridor.World, view: View): void {
        panel(target, 8, 86, 4)
        const name = view.session ? corridor.levelName(view.session) : "LEVEL"
        centered(target, name, 14, 6, 1)
        centered(target, "CLEAR", 22, 4, 2)
        centered(target, "KILLS " + corridor.pct(world.kills, world.total) + "%", 40, 1, 1)
        centered(target, "ITEMS " + corridor.pct(world.itemsTaken, world.itemsTotal) + "%", 48, 1, 1)
        centered(target, "SECRETS " + corridor.pct(world.found, world.secrets) + "%", 56, 1, 1)
        centered(target, "TIME " + corridor.clock(world.time), 64, 1, 1)
        centered(target, "A NEXT", 80, 6, 1)
    }

    function drawVictory(target: Image, view: View): void {
        panel(target, 8, 86, 4)
        centered(target, "VICTORY", 16, 4, 2)
        const s = view.session
        if (s) {
            centered(target, "KILLS " + s.kills + "/" + s.total, 40, 1, 1)
            centered(target, "TIME " + corridor.clock(s.time), 50, 1, 1)
        }
        centered(target, "A TITLE", 80, 6, 1)
    }

    export const PAUSE_ITEM_Y = 33
    export const PAUSE_ITEM_STEP = 9
    export const PAUSE_HINT_Y = 81

    function drawPause(target: Image, pause: corridor.Pause): void {
        panel(target, 10, 82, 6)
        centered(target, "PAUSED", 16, 4, 2)
        const labels = ["RESUME", "MUSIC " + (pause.music ? "ON" : "OFF"), "- " + corridor.DIFF_NAMES[pause.difficulty] + " +",
            pause.ai ? "TAKE OVER" : "GIVE TO AI", "QUIT"]
        for (let i = 0; i < labels.length; i++) {
            const sel = i == pause.index
            centered(target, sel ? "> " + labels[i] : labels[i], PAUSE_ITEM_Y + i * PAUSE_ITEM_STEP, sel ? 4 : 1, 1)
        }
        centered(target, "B BACK", PAUSE_HINT_Y, 6, 1)
    }

    function drawOverlay(target: Image, world: corridor.World, view: View): void {
        if (view.pause) {
            drawPause(target, view.pause)
            return
        }
        if (view.mode == MODE_TITLE) {
            drawTitle(target, view)
            return
        }
        if (view.mode == MODE_VICTORY) {
            drawVictory(target, view)
            return
        }
        if (world.won) {
            drawSummary(target, world, view)
            return
        }
        if (!world.lost) return
        panel(target, 18, 64, 2)
        centered(target, "YOU DIED", 26, 2, 2)
        centered(target, "KILLS " + world.kills + "/" + world.total, 44, 1, 1)
        centered(target, "TIME " + corridor.clock(world.time), 52, 1, 1)
        centered(target, "A RETRY", 70, 6, 1)
    }

    // Doom-style wipe: the previous frame slides down in uneven columns over the new one.
    export function startMelt(view: View, from: Image, seed: number): void {
        meltImg = from.clone()
        const rng = new corridor.Rng(seed)
        view.melt = []
        let o = -rng.next(16)
        for (let c = 0; c < W; c++) {
            o += rng.next(3) - 1
            if (o > 0) o = 0
            if (o < -15) o = -15
            view.melt.push(o)
        }
        view.meltOn = true
    }

    export function meltTick(view: View, dt: number): void {
        if (!view.meltOn) return
        const base = Math.max(1, dt >> 3)
        let done = true
        for (let c = 0; c < view.melt.length; c++) {
            let o = view.melt[c]
            if (o < 0) o += base
            else o += base + (o >> 2) + 1
            if (o < MELT_ROWS) done = false
            view.melt[c] = o
        }
        if (done) view.meltOn = false
    }

    function drawMelt(target: Image, view: View): void {
        if (!view.meltOn || !meltImg) return
        for (let c = 0; c < W && c < view.melt.length; c++) {
            const o = Math.max(0, view.melt[c])
            if (o >= MELT_ROWS) continue
            target.blit(c, o, 1, MELT_ROWS - o, meltImg, c, 0, 1, MELT_ROWS - o, false, false)
        }
    }

    export function bobPhase(world: corridor.World): number {
        return Math.idiv((world.stride % (2 * corridor.STRIDE)) * 512, corridor.STRIDE)
    }

    export function draw(target: Image, world: corridor.World, view: View): void {
        init()
        target.fill(15)
        let ox = 0
        let oy = 0
        if (view.shake > 0) {
            const amp = view.shake > 120 ? 2 : 1
            ox = ((world.time >> 5) & 1) == 1 ? amp : -amp
            oy = ((world.time >> 6) & 1) == 1 ? amp : -amp
        }
        const phase = bobPhase(world)
        const horizon = HORIZON + oy + ((Math.abs(corridor.sin(phase)) * 3) >> 11)
        target.drawImage(backdrop, ox, horizon - HORIZON)

        updateLit(world)
        const step = view.colStep < 1 ? 1 : view.colStep
        for (let col = 0; col < W; col += step) {
            corridor.castColumn(world, col, hit)
            const h = corridor.wallHeight(hit.dist)
            const set = hit.tile == corridor.TILE_EXIT && world.exitLocked ? lockedExit : walls[hit.tile]
            let shade = corridor.shadeFor(hit.dist, hit.side, hit.tile)
            if (hit.tile != corridor.TILE_EXIT) shade = Math.min(3, shade + hit.light)
            const tex = set[shade]
            const y0 = horizon - (h >> 1)
            for (let k = 0; k < step && col + k < W; k++) {
                zbuf[col + k] = hit.dist
                cRdx[col + k] = hit.rdx
                cRdy[col + k] = hit.rdy
                cBottom[col + k] = y0 + h
                target.blitRow(col + k + ox, y0, tex, hit.texX, h)
            }
        }
        if (view.quality == QUALITY_FULL) drawFloor(target, world, horizon, ox, 1, false)
        else if (view.quality == QUALITY_HALF) drawFloor(target, world, horizon, ox, 2, false)
        else drawFloor(target, world, horizon, ox, 4, true)

        drawThings(target, world, ox, horizon)

        if (!world.lost && view.mode == MODE_PLAY) {
            const gx = 56 + ((corridor.cos(phase) * 5) >> 10)
            const gy = 64 + ((Math.abs(corridor.sin(phase)) * 4) >> 10) + (view.recoil > 0 ? 5 : 0)
            if (world.weapon == corridor.WEAPON_SHOTGUN) {
                if (view.flash > 0) target.blit(gx + 6, gy - 20, 36, 26, muzzle, 0, 0, 12, 10, true, false)
                target.blit(gx - 8, gy, 64, 36, shotgun, 0, 0, 32, 18, true, false)
            } else {
                if (view.flash > 0) target.blit(gx + 12, gy - 16, 24, 20, muzzle, 0, 0, 12, 10, true, false)
                target.blit(gx, gy, 48, 36, gun, 0, 0, 24, 18, true, false)
            }
        }

        if (view.hurt > 0 || world.lost) {
            target.fillRect(0, 0, W, 3, 2)
            target.fillRect(0, VH - 3, W, 3, 2)
            target.fillRect(0, 0, 3, VH, 2)
            target.fillRect(W - 3, 0, 3, VH, 2)
        } else if (view.pickup > 0) {
            target.fillRect(0, 0, W, 1, 4)
            target.fillRect(0, VH - 1, W, 1, 4)
            target.fillRect(0, 0, 1, VH, 4)
            target.fillRect(W - 1, 0, 1, VH, 4)
        }

        if (view.mapOpen && view.mode == MODE_PLAY) drawMap(target, world)
        drawHud(target, world, view)
        drawOverlay(target, world, view)
        drawMelt(target, view)
        if (view.showFps) shadowText(target, view.fps + "FPS", 4, 4, 4, 1)
        if (view.aiLine != "" && view.mode == MODE_PLAY) shadowText(target, view.aiLine, 4, 12, view.aiAlert ? 2 : 5, 1)
    }

    function decay(v: number, dt: number): number {
        return v > dt ? v - dt : 0
    }

    // Turns game events into short-lived screen effects; sound and vibration live in main.ts.
    export function react(view: View, events: string[]): void {
        for (const ev of events) {
            if (ev == "shoot") {
                view.flash = 70
                view.recoil = 110
            } else if (ev == "blast") {
                view.flash = 90
                view.recoil = 220
                view.shake = Math.max(view.shake, 80)
            } else if (ev == "weapon" || ev == "unlock") {
                view.pickup = 300
                view.face = FACE_GRIN
                view.faceTime = 700
            } else if (ev == "hurt") {
                view.hurt = 220
                view.shake = Math.max(view.shake, 200)
                view.face = FACE_HURT
                view.faceTime = 500
            } else if (ev == "hit") {
                view.shake = Math.max(view.shake, 60)
            } else if (ev == "kill") {
                view.shake = Math.max(view.shake, 90)
                view.face = FACE_GRIN
                view.faceTime = 700
            } else if (ev == "pickup") {
                view.pickup = 160
                view.face = FACE_GRIN
                view.faceTime = 300
            } else if (ev == "dead") {
                view.shake = 300
            }
        }
    }

    export function tick(view: View, dt: number): void {
        view.flash = decay(view.flash, dt)
        view.recoil = decay(view.recoil, dt)
        view.hurt = decay(view.hurt, dt)
        view.shake = decay(view.shake, dt)
        view.pickup = decay(view.pickup, dt)
        view.faceTime = decay(view.faceTime, dt)
        view.frames += 1
        view.acc += dt
        if (view.acc >= 1000) {
            view.fps = Math.idiv(view.frames * 1000, view.acc)
            view.frames = 0
            view.acc = 0
        }
    }
}

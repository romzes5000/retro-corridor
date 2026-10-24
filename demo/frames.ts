import fs from "node:fs"
import zlib from "node:zlib"
import { createRequire } from "node:module"
import type { FakeImage } from "../fake-image.ts"

const require = createRequire(import.meta.url)
const { GIFEncoder } = require("gifenc") as {
    GIFEncoder: () => {
        writeFrame: (index: Uint8Array, w: number, h: number, opts: { palette?: number[][]; delay?: number; repeat?: number }) => void
        finish: () => void
        bytes: () => Uint8Array
    }
}

// Indexed frame of arbitrary size; palette indices may exceed 15 when two palettes are combined.
export class Frame {
    readonly width: number
    readonly height: number
    readonly pixels: Uint8Array
    constructor(width: number, height: number) {
        this.width = width
        this.height = height
        this.pixels = new Uint8Array(width * height)
    }
}

export function rgbList(palette: number[]): number[][] {
    return palette.map((c) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff])
}

// Nearest-neighbour upscale, like the console stretching 160x120 onto its 320x240 panel.
export function paste(dst: Frame, src: FakeImage | Frame, x: number, y: number, scale: number, offset = 0): void {
    for (let sy = 0; sy < src.height; sy++) {
        for (let sx = 0; sx < src.width; sx++) {
            const c = src.pixels[sy * src.width + sx] + offset
            for (let dy = 0; dy < scale; dy++) {
                const row = (y + sy * scale + dy) * dst.width
                for (let dx = 0; dx < scale; dx++) dst.pixels[row + x + sx * scale + dx] = c
            }
        }
    }
}

export function encodeGif(frames: Frame[], palette: number[][], delay: number): Uint8Array {
    const size = 2 ** Math.ceil(Math.log2(Math.max(2, palette.length)))
    const padded = palette.slice()
    while (padded.length < size) padded.push([0, 0, 0])
    const gif = GIFEncoder()
    frames.forEach((f, i) => {
        gif.writeFrame(f.pixels, f.width, f.height, i === 0 ? { palette: padded, delay, repeat: 0 } : { delay })
    })
    gif.finish()
    return gif.bytes()
}

function crc32(buf: Buffer): number {
    let c = ~0
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i]
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
}

export function writePng(path: string, frame: Frame, palette: number[][]): void {
    const raw = Buffer.alloc((frame.width * 3 + 1) * frame.height)
    for (let y = 0; y < frame.height; y++) {
        const row = y * (frame.width * 3 + 1)
        for (let x = 0; x < frame.width; x++) {
            const [r, g, b] = palette[frame.pixels[y * frame.width + x]] ?? [255, 0, 255]
            raw[row + 1 + x * 3] = r
            raw[row + 2 + x * 3] = g
            raw[row + 3 + x * 3] = b
        }
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(frame.width, 0)
    ihdr.writeUInt32BE(frame.height, 4)
    ihdr[8] = 8
    ihdr[9] = 2
    fs.writeFileSync(path, Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]))
}

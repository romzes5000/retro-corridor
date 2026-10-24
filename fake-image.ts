// Node stand-in for the Arcade `Image` API used by render.ts. Pixel loops mirror
// pxt-common-packages screen/image.cpp (blitRow, blit), so demo frames match the console.
export class FakeImage {
    readonly width: number
    readonly height: number
    readonly pixels: Uint8Array

    constructor(width: number, height: number) {
        this.width = width
        this.height = height
        this.pixels = new Uint8Array(width * height)
    }

    private inside(x: number, y: number): boolean {
        return x >= 0 && y >= 0 && x < this.width && y < this.height
    }

    getPixel(x: number, y: number): number {
        x |= 0
        y |= 0
        return this.inside(x, y) ? this.pixels[y * this.width + x] : 0
    }

    setPixel(x: number, y: number, c: number): void {
        x |= 0
        y |= 0
        if (this.inside(x, y)) this.pixels[y * this.width + x] = c & 0xf
    }

    fill(c: number): void {
        this.pixels.fill(c & 0xf)
    }

    fillRect(x: number, y: number, w: number, h: number, c: number): void {
        x |= 0
        y |= 0
        w |= 0
        h |= 0
        const x0 = Math.max(0, x)
        const y0 = Math.max(0, y)
        const x1 = Math.min(this.width, x + w)
        const y1 = Math.min(this.height, y + h)
        for (let yy = y0; yy < y1; yy++) {
            this.pixels.fill(c & 0xf, yy * this.width + x0, yy * this.width + Math.max(x0, x1))
        }
    }

    drawImage(from: FakeImage, x: number, y: number): void {
        for (let yy = 0; yy < from.height; yy++) {
            for (let xx = 0; xx < from.width; xx++) {
                this.setPixel(x + xx, y + yy, from.pixels[yy * from.width + xx])
            }
        }
    }

    drawTransparentImage(from: FakeImage, x: number, y: number): void {
        for (let yy = 0; yy < from.height; yy++) {
            for (let xx = 0; xx < from.width; xx++) {
                const c = from.pixels[yy * from.width + xx]
                if (c) this.setPixel(x + xx, y + yy, c)
            }
        }
    }

    blitRow(x: number, y: number, from: FakeImage, fromX: number, fromH: number): void {
        x |= 0
        y |= 0
        fromX |= 0
        fromH |= 0
        if (x < 0 || x >= this.width || fromX < 0 || fromX >= from.width || fromH <= 0) return
        let fy = 0
        const stepFY = Math.trunc((from.width << 16) / fromH)
        let endY = y + fromH
        if (endY > this.height) endY = this.height
        if (y < 0) {
            fy += -y * stepFY
            y = 0
        }
        while (y < endY) {
            const p = fy >> 16
            this.pixels[y * this.width + x] = p < from.height ? from.pixels[p * from.width + fromX] : 0
            y++
            fy += stepFY
        }
    }

    blit(xDst: number, yDst: number, wDst: number, hDst: number, src: FakeImage,
        xSrc: number, ySrc: number, wSrc: number, hSrc: number, transparent: boolean, check: boolean): boolean {
        xDst |= 0; yDst |= 0; wDst |= 0; hDst |= 0; xSrc |= 0; ySrc |= 0; wSrc |= 0; hSrc |= 0
        if (wDst <= 0 || hDst <= 0) return false
        const xSrcStep = Math.trunc((wSrc << 16) / wDst)
        const ySrcStep = Math.trunc((hSrc << 16) / hDst)
        const xDstClip = Math.abs(Math.min(0, xDst))
        const yDstClip = Math.abs(Math.min(0, yDst))
        const xDstStart = xDst + xDstClip
        const yDstStart = yDst + yDstClip
        const xDstEnd = Math.min(this.width, xDst + wDst)
        const yDstEnd = Math.min(this.height, yDst + hDst)
        const xSrcStart = Math.max(0, (xSrc << 16) + xDstClip * xSrcStep)
        const ySrcStart = Math.max(0, (ySrc << 16) + yDstClip * ySrcStep)
        const xSrcEnd = Math.min(src.width, xSrc + wSrc) << 16
        const ySrcEnd = Math.min(src.height, ySrc + hSrc) << 16
        for (let yd = yDstStart, ys = ySrcStart; yd < yDstEnd && ys < ySrcEnd; ++yd, ys += ySrcStep) {
            const ysi = ys >> 16
            for (let xd = xDstStart, xs = xSrcStart; xd < xDstEnd && xs < xSrcEnd; ++xd, xs += xSrcStep) {
                const c = src.pixels[ysi * src.width + (xs >> 16)]
                if (check && c) {
                    if (this.pixels[yd * this.width + xd]) return true
                    continue
                }
                if (!transparent || c) this.pixels[yd * this.width + xd] = c
            }
        }
        return false
    }
}

export const imageApi = {
    create(width: number, height: number): FakeImage {
        return new FakeImage(width, height)
    },
}

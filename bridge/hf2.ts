// HF2 over raw USB bulk: console lines in, mailbox writes out. Only bridge/main.ts imports this,
// so tests and --sim never need the native usb module.
import { usb, getDeviceList } from "usb"
import type { Transport } from "./loop.ts"
import { BOX_SIZE, isBox, type BoxWrite } from "./mailbox.ts"
import { framePackets, globalCandidates, LineSplitter, packetBody, readRequest, writeRequest } from "./hf2-frame.ts"

const VENDOR = 1155
const HF2_BININFO = 0x0001
const HF2_READ_WORDS = 0x0008
const HF2_WRITE_WORDS = 0x0009
const HF2_GLOBAL_STATE = 0x53fc66e0
const CMD_TIMEOUT_MS = 2000

type Endpoint = usb.InEndpoint | usb.OutEndpoint

export class Hf2Transport implements Transport {
    private device: usb.Device | null = null
    private iface: usb.Interface | null = null
    private inEp: usb.InEndpoint | null = null
    private outEp: usb.OutEndpoint | null = null
    private listeners: Array<(line: string) => void> = []
    private readonly lines = new LineSplitter((line) => this.listeners.forEach((l) => l(line)))
    private reply: Buffer[] = []
    private waiter: ((data: Buffer) => void) | null = null
    private queue: Promise<unknown> = Promise.resolve()
    private tag = 1
    private boxAddr = 0

    open(): void {
        const device = getDeviceList().find((d) => d.deviceDescriptor.idVendor === VENDOR)
        if (!device) throw new Error("no HF2 device (is the console plugged in and running the game?)")
        device.open()
        const iface = device.interface(0)
        iface.claim()
        const eps = iface.endpoints as Endpoint[]
        this.inEp = eps.find((e) => e.direction === "in") as usb.InEndpoint
        this.outEp = eps.find((e) => e.direction === "out") as usb.OutEndpoint
        this.device = device
        this.iface = iface
        this.inEp.on("data", (buf: Buffer) => this.data(buf))
        this.inEp.on("error", (err: Error) => console.error(`hf2 in: ${err.message}`))
        this.inEp.startPoll(4, 64)
    }

    async close(): Promise<void> {
        const inEp = this.inEp
        if (!inEp) return
        await new Promise<void>((resolve) => inEp.stopPoll(() => resolve()))
        await new Promise<void>((resolve) => this.iface?.release(true, () => resolve()))
        this.device?.close()
        this.inEp = null
    }

    onLine(listener: (line: string) => void): void {
        this.listeners.push(listener)
    }

    reset(): void {
        this.boxAddr = 0
    }

    private data(buf: Buffer): void {
        for (let off = 0; off < buf.length; off += 64) {
            const { serial, last, body } = packetBody(buf.subarray(off, off + 64))
            if (serial) {
                this.lines.push(body.toString("utf8"))
                continue
            }
            this.reply.push(Buffer.from(body))
            if (last && this.waiter) {
                const all = Buffer.concat(this.reply)
                this.reply = []
                const w = this.waiter
                this.waiter = null
                w(all)
            }
        }
    }

    private transfer(packet: Buffer): Promise<void> {
        return new Promise((resolve, reject) => this.outEp!.transfer(packet, (err) => (err ? reject(err) : resolve())))
    }

    // One command at a time; resolves with the response payload after the 4-byte header.
    private cmd(id: number, data: Buffer = Buffer.alloc(0)): Promise<Buffer> {
        const run = async () => {
            const tag = this.tag++ & 0xffff
            const response = new Promise<Buffer>((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.waiter = null
                    reject(new Error(`hf2 timeout 0x${id.toString(16)}`))
                }, CMD_TIMEOUT_MS)
                this.waiter = (all) => {
                    clearTimeout(timer)
                    resolve(all)
                }
            })
            for (const packet of framePackets(id, tag, data)) await this.transfer(packet)
            const all = await response
            if (all[2] !== 0) throw new Error(`hf2 status ${all[2]} for 0x${id.toString(16)}`)
            return all.subarray(4)
        }
        const next = this.queue.then(run, run)
        this.queue = next.catch(() => {})
        return next
    }

    async bininfo(): Promise<number> {
        const info = await this.cmd(HF2_BININFO)
        return info.readUInt32LE(0)
    }

    private async readWords(addr: number, count: number): Promise<Buffer> {
        return this.cmd(HF2_READ_WORDS, readRequest(addr, count))
    }

    // Scans the game's globals for a pointer to a Buffer that starts with the mailbox signature.
    async findBox(): Promise<number> {
        const gs = await this.cmd(HF2_GLOBAL_STATE)
        const count = gs.readUInt32LE(0)
        const addr = gs.readUInt32LE(4)
        const words: number[] = []
        for (let off = 0; off < count; off += 64) {
            const chunk = await this.readWords(addr + off * 4, Math.min(64, count - off))
            for (let i = 0; i + 4 <= chunk.length; i += 4) words.push(chunk.readUInt32LE(i))
        }
        for (const ptr of globalCandidates(words)) {
            const head = await this.readWords(ptr, 4)
            for (const skip of [8, 4]) {
                if (isBox(head.subarray(skip))) {
                    this.boxAddr = ptr + skip
                    return this.boxAddr
                }
            }
        }
        throw new Error(`mailbox not found among ${count} globals (is this the AI build?)`)
    }

    async readBox(): Promise<Uint8Array> {
        if (!this.boxAddr) await this.findBox()
        return new Uint8Array(await this.readWords(this.boxAddr, BOX_SIZE / 4))
    }

    async writeBox(writes: BoxWrite[]): Promise<void> {
        if (!this.boxAddr) await this.findBox()
        try {
            for (const w of writes) {
                if (w.offset + w.data.length > BOX_SIZE) throw new Error("write past the box")
                await this.cmd(HF2_WRITE_WORDS, writeRequest(this.boxAddr + w.offset, w.data))
            }
        } catch (err) {
            this.boxAddr = 0
            throw err
        }
    }
}

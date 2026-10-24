// Pure HF2 framing, kept apart from the usb module so it can be tested without a device.
// Packet: 1 header byte (type in the top 2 bits, length in the low 6) + up to 63 bytes.
const LAST = 0x40
const SERIAL = 0x80
const PAYLOAD = 63

export function framePackets(id: number, tag: number, data: Uint8Array): Buffer[] {
    const msg = Buffer.alloc(8 + data.length)
    msg.writeUInt32LE(id >>> 0, 0)
    msg.writeUInt16LE(tag & 0xffff, 4)
    Buffer.from(data).copy(msg, 8)
    const out: Buffer[] = []
    for (let off = 0; off < msg.length; off += PAYLOAD) {
        const part = msg.subarray(off, off + PAYLOAD)
        const packet = Buffer.alloc(64)
        packet[0] = (off + PAYLOAD >= msg.length ? LAST : 0) | part.length
        part.copy(packet, 1)
        out.push(packet)
    }
    return out
}

export function packetBody(packet: Uint8Array): { serial: boolean; last: boolean; body: Buffer } {
    const type = packet[0] & 0xc0
    const body = Buffer.from(packet.subarray(1, 1 + (packet[0] & 0x3f)))
    return { serial: (type & SERIAL) !== 0, last: type === LAST, body }
}

export function readRequest(addr: number, count: number): Buffer {
    const rq = Buffer.alloc(8)
    rq.writeUInt32LE(addr >>> 0, 0)
    rq.writeUInt32LE(count, 4)
    return rq
}

// WRITE_WORDS takes whole little-endian words, so the data length must be a multiple of 4.
export function writeRequest(addr: number, data: Uint8Array): Buffer {
    if (addr % 4 !== 0 || data.length % 4 !== 0) throw new Error(`unaligned write ${addr} +${data.length}`)
    const rq = Buffer.alloc(8 + data.length)
    rq.writeUInt32LE(addr >>> 0, 0)
    rq.writeUInt32LE(data.length / 4, 4)
    Buffer.from(data).copy(rq, 8)
    return rq
}

// Global slots that can hold a heap pointer on the STM32F401 (RAM at 0x20000000, 96 KB).
export function globalCandidates(words: number[]): number[] {
    const seen = new Set<number>()
    for (const w of words) {
        if (w >= 0x20000000 && w < 0x20018000 && w % 4 === 0) seen.add(w)
    }
    return [...seen]
}

// Serial output arrives in arbitrary chunks; emits whole lines.
export class LineSplitter {
    private rest = ""
    private readonly emit: (line: string) => void

    constructor(emit: (line: string) => void) {
        this.emit = emit
    }

    push(chunk: string): void {
        this.rest += chunk
        let nl: number
        while ((nl = this.rest.indexOf("\n")) >= 0) {
            const line = this.rest.slice(0, nl).replace(/\r$/, "")
            this.rest = this.rest.slice(nl + 1)
            if (line.length > 0) this.emit(line)
        }
    }
}

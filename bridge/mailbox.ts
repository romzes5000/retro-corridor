// Host side of the 32-byte command mailbox that lives in the game's RAM (see ai.ts for the layout).
export const SIG = "CRDRAI01"
export const BOX_SIZE = 32

export const CMD = { none: 0, goto: 1, attack: 2, strafe: 3, use: 4, wait: 5 } as const
export type CmdName = keyof typeof CMD

export interface BoxCommand {
    seq: number
    obs: number
    cmd: number
    a: number
    b: number
    conf: number
    latency: number
    label: string
}

// Characters the console font can draw; anything else becomes a space.
const GLYPHS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ:!/-.>+%"

export function boxLabel(text: string): string {
    let out = ""
    for (const ch of text.toUpperCase().replace(/_/g, " ")) out += GLYPHS.includes(ch) ? ch : " "
    return out.slice(0, 8).trimEnd()
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, Math.round(v)))
}

export function encodeBox(c: BoxCommand): Uint8Array {
    const box = new Uint8Array(BOX_SIZE)
    for (let i = 0; i < SIG.length; i++) box[i] = SIG.charCodeAt(i)
    const seq = c.seq & 0xffff
    const obs = c.obs & 0xffff
    box[8] = seq & 0xff
    box[9] = seq >> 8
    box[10] = obs & 0xff
    box[11] = obs >> 8
    box[12] = c.cmd & 0xff
    box[13] = clamp(c.a, 0, 255)
    box[14] = clamp(c.b, 0, 255)
    box[15] = clamp(c.conf, 0, 100)
    const latency = clamp(c.latency, 0, 0xffff)
    box[16] = latency & 0xff
    box[17] = latency >> 8
    const label = boxLabel(c.label)
    for (let i = 0; i < label.length; i++) box[18 + i] = label.charCodeAt(i)
    let sum = 0
    for (let i = 0; i < BOX_SIZE - 1; i++) sum += box[i]
    box[BOX_SIZE - 1] = sum & 0xff
    return box
}

export interface BoxWrite {
    offset: number
    data: Uint8Array
}

// The game reads seq, body, seq again: the body goes first and the seq word last, so a write
// caught halfway shows either the old seq (ignored) or a checksum mismatch (retried next frame).
export function boxWrites(box: Uint8Array): BoxWrite[] {
    return [
        { offset: 12, data: box.slice(12, BOX_SIZE) },
        { offset: 8, data: box.slice(8, 12) },
    ]
}

// Seq 0 means "nothing yet" on the game side, so it is skipped on wrap-around.
export function nextSeq(seq: number): number {
    const next = (seq + 1) & 0xffff
    return next === 0 ? 1 : next
}

export function isBox(bytes: Uint8Array): boolean {
    if (bytes.length < SIG.length) return false
    for (let i = 0; i < SIG.length; i++) {
        if (bytes[i] !== SIG.charCodeAt(i)) return false
    }
    return true
}

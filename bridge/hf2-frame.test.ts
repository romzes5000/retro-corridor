import assert from "node:assert/strict"
import test from "node:test"
import { framePackets, globalCandidates, LineSplitter, packetBody, readRequest, writeRequest } from "./hf2-frame.ts"

test("HF2: команда режется на пакеты по 63 байта, последний помечен 0x40", () => {
    const small = framePackets(0x0001, 7, new Uint8Array(0))
    assert.equal(small.length, 1)
    assert.equal(small[0][0], 0x40 | 8)
    assert.equal(small[0].readUInt32LE(1), 1)
    assert.equal(small[0].readUInt16LE(5), 7)

    const big = framePackets(0x0009, 1, new Uint8Array(100).fill(9))
    assert.equal(big.length, 2)
    assert.equal(big[0][0], 63, "первый — полный, без флага конца")
    assert.equal(big[1][0], 0x40 | (108 - 63))
})

test("HF2: серийный вывод и ответы различаются по типу пакета", () => {
    const serial = Buffer.alloc(64)
    serial[0] = 0x80 | 3
    serial.write("AI ", 1)
    assert.deepEqual(packetBody(serial), { serial: true, last: false, body: Buffer.from("AI ") })
    const err = Buffer.alloc(64)
    err[0] = 0xc0 | 1
    assert.equal(packetBody(err).serial, true)
    const reply = Buffer.alloc(64)
    reply[0] = 0x40 | 4
    assert.deepEqual([packetBody(reply).serial, packetBody(reply).last], [false, true])
})

test("HF2: чтение и запись слов, невыровненная запись отвергается", () => {
    const rq = readRequest(0x20001000, 4)
    assert.deepEqual([rq.readUInt32LE(0), rq.readUInt32LE(4)], [0x20001000, 4])
    const wr = writeRequest(0x2000100c, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))
    assert.deepEqual([wr.readUInt32LE(0), wr.readUInt32LE(4), wr.readUInt32LE(8)], [0x2000100c, 2, 0x04030201])
    assert.throws(() => writeRequest(0x2000100e, new Uint8Array(4)))
    assert.throws(() => writeRequest(0x2000100c, new Uint8Array(6)))
})

test("HF2: кандидаты в указатели — выровненные адреса ОЗУ без повторов", () => {
    assert.deepEqual(globalCandidates([0, 5, 0x20000100, 0x20000101, 0x20000100, 0x08001000, 0x20017ffc, 0x20018000]), [0x20000100, 0x20017ffc])
})

test("HF2: строки собираются из кусков, \\r и пустые строки отбрасываются", () => {
    const out: string[] = []
    const split = new LineSplitter((l) => out.push(l))
    split.push("AI S n=1 t")
    split.push("=2\r\nAI END n=1\n\nfp")
    split.push("s 30\n")
    assert.deepEqual(out, ["AI S n=1 t=2", "AI END n=1", "fps 30"])
})

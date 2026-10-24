import assert from "node:assert/strict"
import test from "node:test"
import { encodeGif } from "./frames.ts"
import { DT, SCENARIOS, frameHash, record } from "./make-gifs.ts"

const LIMIT = 2 * 1024 * 1024

test("сценарий детерминирован: повторный прогон даёт тот же кадр", () => {
    const scenario = SCENARIOS.find((s) => s.name === "03-imp-fight")!
    const a = record(scenario)
    const b = record(scenario)
    assert.equal(a.frames.length, b.frames.length)
    const mid = Math.floor(a.frames.length / 2)
    assert.equal(frameHash(a.frames[mid]), frameHash(b.frames[mid]))
    assert.equal(frameHash(a.frames.at(-1)!), frameHash(b.frames.at(-1)!))
})

test("каждый GIF не больше 2 МБ и сценарий доигрывает свою сцену", () => {
    const outcomes: Record<string, (w: { won: boolean; kills: number; lost: boolean }) => boolean> = {
        "01-before-after": (w) => w.won,
        "03-imp-fight": (w) => w.kills === 1,
        "05-exit-door": (w) => w.won,
    }
    for (const scenario of SCENARIOS) {
        const rec = record(scenario)
        const bytes = encodeGif(rec.frames, rec.palette, DT)
        assert.ok(bytes.length <= LIMIT, `${scenario.name}: ${bytes.length} байт`)
        assert.equal(rec.world.lost, false, scenario.name)
        const ok = outcomes[scenario.name]
        if (ok) assert.ok(ok(rec.world), `${scenario.name} не доиграл`)
    }
})

test("до/после — две половины по 320x240, остальные 320x240", () => {
    for (const scenario of SCENARIOS) {
        const rec = record(scenario)
        assert.equal(rec.frames[0].height, 240)
        assert.equal(rec.frames[0].width, scenario.legacy ? 640 : 320)
        assert.equal(rec.palette.length, scenario.legacy ? 32 : 16)
    }
})

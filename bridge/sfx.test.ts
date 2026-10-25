// Voices are data: a shot is more than one layer, and the page script plays that same table.
import assert from "node:assert/strict"
import vm from "node:vm"
import test from "node:test"
import { SFX, sfxFor, sfxPlayerSource } from "./sfx.ts"

const GAME_EVENTS = [
    "shoot", "blast", "empty", "step", "hit", "kill", "hurt", "alert", "growl",
    "pickup", "key", "weapon", "swap", "unlock", "door", "locked", "fireball",
    "splash", "secret", "win", "dead",
]

test("у каждого события игры есть голос, у выстрела и дробовика — несколько слоёв", () => {
    for (const name of GAME_EVENTS) {
        const s = sfxFor(name)
        assert.ok(s, name)
        assert.ok(s.tones.length >= 1)
        for (const tone of s.tones) {
            assert.ok(tone.from > 0 && tone.to > 0 && tone.ms > 0 && tone.gain > 0)
        }
    }
    assert.equal(sfxFor("nope"), null)
    const shoot = SFX.shoot.tones
    const blast = SFX.blast.tones
    assert.ok(shoot.length >= 2)
    assert.ok(blast.length >= 2)
    assert.ok(shoot.some((t) => t.wave === "noise") && shoot.some((t) => t.wave !== "noise"))
    assert.ok(blast.some((t) => t.wave === "noise") && blast.some((t) => (t.delay ?? 0) > 0))
})

test("скрипт страницы играет ту же таблицу и молчит без WebAudio", () => {
    const source = sfxPlayerSource()
    assert.match(source, /lowpass/)
    assert.match(source, /corridorSfx/)
    const context: Record<string, unknown> = {
        console,
        addEventListener: () => {},
        globalThis: {},
    }
    context.globalThis = context
    vm.createContext(context)
    vm.runInContext(source, context, { filename: "sfx.js" })
    const sfx = context.corridorSfx as { play: (name: string) => void }
    sfx.play("shoot")
    sfx.play("nope")
    const table = vm.runInContext("SFX", context) as typeof SFX
    assert.equal(table.shoot.tones.length, SFX.shoot.tones.length)
    assert.equal(table.blast.tones.length, SFX.blast.tones.length)
})

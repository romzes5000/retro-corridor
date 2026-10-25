// Layered WebAudio voices for the live page and the browser game.
// The handheld keeps its own beeper; this is what a viewer hears.

export interface Tone {
    wave: "sine" | "square" | "sawtooth" | "triangle" | "noise"
    from: number
    to: number
    ms: number
    gain: number
    delay?: number
}

export interface Sfx {
    tones: Tone[]
}

// Two layers minimum on the loud events: a noise body plus a pitched transient.
export const SFX: Record<string, Sfx> = {
    shoot: { tones: [
        { wave: "noise", from: 2200, to: 500, ms: 70, gain: 0.45 },
        { wave: "square", from: 220, to: 80, ms: 50, gain: 0.22 },
    ] },
    blast: { tones: [
        { wave: "noise", from: 400, to: 80, ms: 220, gain: 0.6 },
        { wave: "noise", from: 2400, to: 600, ms: 40, gain: 0.35 },
        { wave: "sine", from: 90, to: 40, ms: 180, gain: 0.3, delay: 10 },
    ] },
    empty: { tones: [
        { wave: "noise", from: 3000, to: 1500, ms: 25, gain: 0.2 },
        { wave: "square", from: 140, to: 90, ms: 30, gain: 0.08, delay: 20 },
    ] },
    step: { tones: [
        { wave: "noise", from: 280, to: 120, ms: 35, gain: 0.08 },
    ] },
    hit: { tones: [
        { wave: "noise", from: 1600, to: 300, ms: 50, gain: 0.28 },
        { wave: "square", from: 180, to: 60, ms: 40, gain: 0.12 },
    ] },
    kill: { tones: [
        { wave: "noise", from: 900, to: 120, ms: 160, gain: 0.4 },
        { wave: "sawtooth", from: 240, to: 50, ms: 140, gain: 0.16 },
    ] },
    hurt: { tones: [
        { wave: "noise", from: 200, to: 60, ms: 140, gain: 0.4 },
        { wave: "square", from: 110, to: 45, ms: 120, gain: 0.2 },
    ] },
    alert: { tones: [
        { wave: "square", from: 520, to: 480, ms: 70, gain: 0.14 },
        { wave: "square", from: 700, to: 640, ms: 90, gain: 0.14, delay: 90 },
    ] },
    growl: { tones: [
        { wave: "sawtooth", from: 70, to: 55, ms: 280, gain: 0.16 },
        { wave: "noise", from: 240, to: 140, ms: 260, gain: 0.1 },
    ] },
    pickup: { tones: [
        { wave: "sine", from: 660, to: 880, ms: 70, gain: 0.16 },
        { wave: "sine", from: 990, to: 1320, ms: 90, gain: 0.12, delay: 70 },
    ] },
    key: { tones: [
        { wave: "sine", from: 880, to: 880, ms: 60, gain: 0.14 },
        { wave: "sine", from: 1320, to: 1320, ms: 90, gain: 0.12, delay: 60 },
    ] },
    weapon: { tones: [
        { wave: "square", from: 200, to: 400, ms: 80, gain: 0.14 },
        { wave: "sine", from: 600, to: 900, ms: 120, gain: 0.12, delay: 60 },
    ] },
    swap: { tones: [
        { wave: "noise", from: 1800, to: 600, ms: 40, gain: 0.16 },
        { wave: "square", from: 300, to: 180, ms: 50, gain: 0.1 },
    ] },
    unlock: { tones: [
        { wave: "sine", from: 520, to: 520, ms: 70, gain: 0.12 },
        { wave: "sine", from: 780, to: 780, ms: 90, gain: 0.1, delay: 70 },
        { wave: "sine", from: 1040, to: 1040, ms: 140, gain: 0.1, delay: 140 },
    ] },
    door: { tones: [
        { wave: "sawtooth", from: 70, to: 180, ms: 340, gain: 0.22 },
        { wave: "noise", from: 280, to: 900, ms: 300, gain: 0.32 },
        { wave: "square", from: 160, to: 70, ms: 70, gain: 0.14, delay: 280 },
    ] },
    locked: { tones: [
        { wave: "square", from: 160, to: 110, ms: 50, gain: 0.14 },
        { wave: "square", from: 140, to: 90, ms: 50, gain: 0.1, delay: 70 },
    ] },
    fireball: { tones: [
        { wave: "noise", from: 600, to: 1800, ms: 140, gain: 0.28 },
        { wave: "sawtooth", from: 180, to: 420, ms: 120, gain: 0.1 },
    ] },
    splash: { tones: [
        { wave: "noise", from: 2000, to: 400, ms: 90, gain: 0.2 },
        { wave: "sine", from: 900, to: 300, ms: 70, gain: 0.06 },
    ] },
    secret: { tones: [
        { wave: "sine", from: 1200, to: 1600, ms: 80, gain: 0.1 },
        { wave: "sine", from: 1800, to: 2200, ms: 120, gain: 0.08, delay: 80 },
    ] },
    win: { tones: [
        { wave: "square", from: 440, to: 440, ms: 100, gain: 0.14 },
        { wave: "square", from: 554, to: 554, ms: 100, gain: 0.14, delay: 110 },
        { wave: "square", from: 659, to: 659, ms: 180, gain: 0.16, delay: 220 },
    ] },
    dead: { tones: [
        { wave: "sawtooth", from: 300, to: 50, ms: 400, gain: 0.2 },
        { wave: "noise", from: 800, to: 80, ms: 350, gain: 0.25 },
    ] },
}

export function sfxFor(name: string): Sfx | null {
    return SFX[name] ?? null
}

// Classic script: defines globalThis.corridorSfx.play(name). Safe when WebAudio is missing.
export function sfxPlayerSource(): string {
    return `const SFX = ${JSON.stringify(SFX)}
let audioCtx = null
let master = null
let noise = null
function corridorUnlock() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext
  if (!AC) return
  if (!audioCtx) {
    audioCtx = new AC()
    master = audioCtx.createGain()
    master.gain.value = 0.45
    master.connect(audioCtx.destination)
    const n = (audioCtx.sampleRate * 0.4) | 0
    noise = audioCtx.createBuffer(1, n, audioCtx.sampleRate)
    const d = noise.getChannelData(0)
    let last = 0
    for (let i = 0; i < n; i++) {
      last = last * 0.82 + (Math.random() * 2 - 1) * 0.18
      d[i] = last * 3
    }
  }
  if (audioCtx.state === "suspended") audioCtx.resume()
}
function corridorTone(spec) {
  const start = audioCtx.currentTime + (spec.delay || 0) / 1000
  const dur = spec.ms / 1000
  const attack = Math.min(0.012, dur * 0.35)
  let node
  let out
  if (spec.wave === "noise") {
    node = audioCtx.createBufferSource()
    node.buffer = noise
    node.loop = true
    const f = audioCtx.createBiquadFilter()
    f.type = "lowpass"
    f.frequency.setValueAtTime(Math.max(40, spec.from), start)
    f.frequency.exponentialRampToValueAtTime(Math.max(40, spec.to), start + dur)
    node.connect(f)
    out = f
  } else {
    node = audioCtx.createOscillator()
    node.type = spec.wave
    node.frequency.setValueAtTime(Math.max(30, spec.from), start)
    node.frequency.exponentialRampToValueAtTime(Math.max(30, spec.to), start + dur)
    out = node
  }
  const g = audioCtx.createGain()
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, spec.gain), start + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  out.connect(g)
  g.connect(master)
  node.start(start)
  node.stop(start + dur + 0.02)
}
function corridorPlay(name) {
  corridorUnlock()
  const s = SFX[name]
  if (!s || !audioCtx) return
  for (let i = 0; i < s.tones.length; i++) corridorTone(s.tones[i])
}
addEventListener("pointerdown", corridorUnlock)
addEventListener("keydown", corridorUnlock)
globalThis.corridorSfx = { play: corridorPlay, unlock: corridorUnlock }
`
}

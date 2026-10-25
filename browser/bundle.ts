// One classic script: the image stand-in, the transpiled game, and the human loop.
import fs from "node:fs"
import ts from "typescript"
import { gameSource } from "../load-logic.ts"

const OPTS: ts.TranspileOptions = { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }

// transpileModule emits CommonJS `exports.*` when the file has `export`. The page is a classic
// script, so those lines are dropped; imageApi is added back by hand.
function script(file: string): string {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8")
    const js = ts.transpileModule(source, OPTS).outputText
        .replace(/exports\.imageApi = \{[\s\S]*?\n\};/, "")
        .replace(/exports\.FakeImage = FakeImage;/, "")
    return js.split("\n")
        .filter((line) => line !== '"use strict";' && !line.includes("exports.") && !line.startsWith("Object.defineProperty(exports"))
        .join("\n")
}

let cached = ""

export function browserBundle(): string {
    if (cached) return cached
    cached = [
        script("../fake-image.ts"),
        "var image = { create: function (width, height) { return new FakeImage(width, height); } };",
        "Math.idiv = function (a, b) { return (a / b) | 0; };",
        gameSource(),
        script("./host.ts"),
    ].join("\n")
    return cached
}

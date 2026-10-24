const fs = require("node:fs");
const path = require("node:path");

const source = path.dirname(require.resolve("alawmulaw/package.json"));
const destination = path.join(__dirname, "..", "UI", "wwwroot", "js", "vendor", "alawmulaw");
const checking = process.argv.includes("--check");

for (const [input, output] of [[path.join("lib", "mulaw.js"), "mulaw.js"], ["LICENSE", "LICENSE"]]) {
    const original = path.join(source, input);
    const target = path.join(destination, output);
    if (checking) {
        if (!fs.readFileSync(original).equals(fs.readFileSync(target))) {
            throw new Error(`Vendored ${output} differs from the installed alawmulaw package; run npm install`);
        }
    } else {
        fs.mkdirSync(destination, { recursive: true });
        fs.copyFileSync(original, target);
    }
}

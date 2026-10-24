const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const shell = process.platform === "win32"
    ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "/bin/sh";

test("coturn startup selects transports and fails explicitly on missing TLS configuration", {
    skip: !existsSync(shell) && "A POSIX shell is required"
}, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "turn-startup-"));
    try {
        writeFileSync(path.join(directory, "turnserver"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
        const certificate = path.join(directory, "fullchain.pem");
        const key = path.join(directory, "privkey.pem");
        writeFileSync(certificate, "test-only certificate placeholder");
        writeFileSync(key, "test-only key placeholder");
        const environment = Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !/^TURN_/i.test(name)));
        const run = overrides => spawnSync(shell, [path.join(__dirname, "..", "scripts", "start-turn.sh")], {
            encoding: "utf8",
            timeout: 10000,
            env: {
                ...environment,
                PATH: `${directory}${path.delimiter}${process.env.PATH}`,
                TURN_SECRET: "test-only-secret",
                TURN_EXTERNAL_IP: "203.0.113.10",
                ...overrides
            }
        });

        const legacy = run({});
        assert.equal(legacy.status, 0, legacy.stderr || legacy.error?.message);
        assert.match(legacy.stdout, /^--no-tls$/m);
        assert.match(legacy.stdout, /^--no-dtls$/m);
        assert.match(legacy.stdout, /^--listening-port=3478$/m);
        assert.match(legacy.stdout, /^--static-auth-secret=test-only-secret$/m);
        assert.doesNotMatch(legacy.stdout, /^--cert=/m);

        const tls = run({
            TURN_TLS_ONLY: "true",
            TURN_TLS_CERT_FILE: certificate,
            TURN_TLS_KEY_FILE: key,
            TURN_TLS_PORT: "5349",
            TURN_MIN_PORT: "50000",
            TURN_MAX_PORT: "50010"
        });
        assert.equal(tls.status, 0, tls.stderr || tls.error?.message);
        assert.match(tls.stdout, /^--tls-listening-port=5349$/m);
        assert.match(tls.stdout, /^--cert=.+fullchain\.pem$/m);
        assert.match(tls.stdout, /^--pkey=.+privkey\.pem$/m);
        assert.match(tls.stdout, /^--min-port=50000$/m);
        assert.match(tls.stdout, /^--max-port=50010$/m);
        assert.match(tls.stdout, /^--no-tcp$/m);
        assert.match(tls.stdout, /^--no-tlsv1$/m);
        assert.match(tls.stdout, /^--no-tlsv1_1$/m);
        assert.doesNotMatch(tls.stdout, /^--no-tls$/m);

        const tlsDefaults = run({
            TURN_TLS_ONLY: "TRUE", TURN_TLS_CERT_FILE: certificate, TURN_TLS_KEY_FILE: key
        });
        assert.equal(tlsDefaults.status, 0, tlsDefaults.stderr);
        assert.match(tlsDefaults.stdout, /^--tls-listening-port=443$/m);

        for (const [overrides, message] of [
            [{ TURN_TLS_ONLY: "true" }, /TURN_TLS_CERT_FILE/],
            [{ TURN_TLS_ONLY: "true", TURN_TLS_CERT_FILE: certificate }, /TURN_TLS_KEY_FILE/],
            [{
                TURN_TLS_ONLY: "true", TURN_TLS_CERT_FILE: path.join(directory, "missing.pem"),
                TURN_TLS_KEY_FILE: key
            }, /must be readable/],
            [{ TURN_TLS_ONLY: "invalid" }, /TURN_TLS_ONLY must be true or false/],
            [{ TURN_SECRET: "" }, /TURN_SECRET must be set/],
            [{ TURN_EXTERNAL_IP: "" }, /TURN_EXTERNAL_IP must be set/]
        ]) {
            const result = run(overrides);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, message);
            assert.equal(result.stdout, "", "Invalid configuration must not start coturn");
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

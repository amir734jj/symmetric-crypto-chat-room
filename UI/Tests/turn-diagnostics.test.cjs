const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const tlsCredentials = {
    host: "turn.example.com", port: 443, tlsOnly: true, relayOnly: true,
    username: "test-username", credential: "test-secret"
};

async function createHarness(options = {}) {
    const connections = [];
    const timers = new Map();
    let nextTimer = 0;
    const scope = vm.createContext({
        AbortController,
        window: { location: { hostname: "localhost" } },
        setTimeout(callback, milliseconds) {
            const id = ++nextTimer;
            timers.set(id, { callback, milliseconds });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        RTCPeerConnection: class {
            constructor(configuration) {
                if (options.constructorError) throw new Error("WebRTC unavailable");
                this.configuration = configuration;
                this.closeCount = 0;
                connections.push(this);
            }
            createDataChannel(name) {
                if (options.channelError) throw new Error("Data channel unavailable");
                this.channel = name;
            }
            createOffer() {
                return options.offerError
                    ? Promise.reject(new Error("Offer unavailable"))
                    : Promise.resolve({ type: "offer", sdp: "diagnostic" });
            }
            setLocalDescription(description) {
                this.localDescription = description;
                return options.descriptionError
                    ? Promise.reject(new Error("Description rejected"))
                    : Promise.resolve();
            }
            close() { this.closeCount++; }
        }
    });
    const filename = path.join(__dirname, "..", "wwwroot", "js", "turn-diagnostics.js");
    const module = new vm.SourceTextModule(await readFile(filename, "utf8"), { context: scope });
    await module.link(() => { throw new Error("Diagnostics must not load media modules"); });
    await module.evaluate();
    return {
        diagnostics: module.namespace, connections, timers, options,
        relay(index = 0) {
            connections[index].onicecandidate({ candidate: { type: "relay" } });
        },
        complete(index = 0) { connections[index].onicecandidate({ candidate: null }); }
    };
}

test("TLS diagnostics authenticate using only TURN/TLS and do not expose credentials", async () => {
    const h = await createHarness();
    const pending = h.diagnostics.testTurnConnection(tlsCredentials);
    const connection = h.connections[0];
    assert.equal(connection.configuration.iceTransportPolicy, "relay");
    assert.deepEqual(JSON.parse(JSON.stringify(connection.configuration.iceServers)), [{
        urls: ["turns:turn.example.com:443?transport=tcp"],
        username: "test-username", credential: "test-secret"
    }]);
    assert.equal(connection.channel, "relay-connectivity-test");
    h.relay();
    h.complete();
    const result = await pending;
    assert.equal(result.succeeded, true);
    assert.equal(result.tls, true);
    assert.match(result.message, /authenticated TURN relay over TLS/);
    assert.doesNotMatch(JSON.stringify(result), /test-username|test-secret/);
    assert.equal(connection.closeCount, 1);
    assert.equal(h.timers.size, 0);
});

test("legacy diagnostics force relay routing without STUN and never claim TLS success", async () => {
    const h = await createHarness();
    const pending = h.diagnostics.testTurnConnection({
        ...tlsCredentials, host: "", port: 3478, tlsOnly: false, relayOnly: false
    });
    const configuration = h.connections[0].configuration;
    assert.equal(configuration.iceTransportPolicy, "relay");
    assert.equal(configuration.iceServers.length, 1);
    assert.deepEqual(Array.from(configuration.iceServers[0].urls), [
        "turn:localhost:3478?transport=udp", "turn:localhost:3478?transport=tcp"
    ]);
    h.relay();
    const result = await pending;
    assert.equal(result.succeeded, true);
    assert.equal(result.tls, false);
    assert.match(result.message, /TLS is not configured/);
});

test("a reachable interface can succeed despite another interface's ICE error", async () => {
    const h = await createHarness();
    const pending = h.diagnostics.testTurnConnection(tlsCredentials);
    h.connections[0].onicecandidateerror({ errorCode: 701, errorText: "IPv6 unavailable" });
    h.relay();
    assert.equal((await pending).succeeded, true);
});

test("non-relay candidates cannot produce a successful TLS result", async () => {
    const h = await createHarness();
    const pending = h.diagnostics.testTurnConnection(tlsCredentials);
    h.connections[0].onicecandidate({ candidate: { type: "host" } });
    h.connections[0].onicecandidate({ candidate: { type: "srflx" } });
    h.complete();
    const result = await pending;
    assert.equal(result.succeeded, false);
    assert.match(result.message, /without an authenticated relay candidate/);
    assert.equal(h.connections[0].closeCount, 1);
    assert.equal(h.timers.size, 0);
});

test("allocation failure includes explicit ICE error details", async () => {
    const h = await createHarness();
    const pending = h.diagnostics.testTurnConnection(tlsCredentials);
    h.connections[0].onicecandidateerror({ errorCode: 701, errorText: "Failed to establish connection" });
    h.complete();
    const result = await pending;
    assert.equal(result.succeeded, false);
    assert.equal(result.tls, true);
    assert.match(result.message, /701: Failed to establish connection/);
});

test("a stalled relay test times out at 15 seconds and closes the connection", async () => {
    const h = await createHarness();
    const pending = h.diagnostics.testTurnConnection(tlsCredentials);
    const timer = [...h.timers.values()][0];
    assert.equal(timer.milliseconds, 15000);
    timer.callback();
    const result = await pending;
    assert.equal(result.succeeded, false);
    assert.match(result.message, /within 15 seconds/);
    assert.equal(h.connections[0].closeCount, 1);
    assert.equal(h.timers.size, 0);
});

test("cancellation releases the relay and timer and permits another test", async () => {
    const h = await createHarness();
    const pending = h.diagnostics.testTurnConnection(tlsCredentials);
    await assert.rejects(h.diagnostics.testTurnConnection(tlsCredentials), /already running/);
    h.diagnostics.cancelTurnConnectionTest();
    const result = await pending;
    assert.equal(result.succeeded, false);
    assert.match(result.message, /cancelled/);
    assert.equal(h.connections[0].closeCount, 1);
    assert.equal(h.timers.size, 0);
    const second = h.diagnostics.testTurnConnection(tlsCredentials);
    h.relay(1);
    assert.equal((await second).succeeded, true);
});

for (const [option, message] of [
    ["channelError", /Data channel unavailable/],
    ["offerError", /Offer unavailable/],
    ["descriptionError", /Description rejected/]
]) {
    test(`${option} releases the diagnostic connection and timer`, async () => {
        const h = await createHarness({ [option]: true });
        const pending = h.diagnostics.testTurnConnection(tlsCredentials);
        if (option === "channelError") {
            await assert.rejects(pending, message);
        } else {
            const result = await pending;
            assert.equal(result.succeeded, false);
            assert.match(result.message, message);
        }
        assert.equal(h.connections[0].closeCount, 1);
        assert.equal(h.timers.size, 0);
    });
}

test("WebRTC construction failure does not leave a stuck active test", async () => {
    const h = await createHarness({ constructorError: true });
    await assert.rejects(h.diagnostics.testTurnConnection(tlsCredentials), /WebRTC unavailable/);
    h.options.constructorError = false;
    const pending = h.diagnostics.testTurnConnection(tlsCredentials);
    h.relay();
    assert.equal((await pending).succeeded, true);
});

test("browser TLS controls stay visible without debug mode and remain separate from server health", async () => {
    const markup = await readFile(path.join(__dirname, "..", "Components", "VoiceChannel.razor"), "utf8");
    const browserButton = markup.indexOf("OnClick=\"TestBrowserRelay\"");
    assert.ok(browserButton > 0 && browserButton < markup.indexOf("@if (AdvancedMode"));
    assert.ok(browserButton < markup.indexOf("@if (DebugMode)"));
    assert.match(markup, /TURN TLS verified/);
    assert.match(markup, /TURN TLS failed/);
    assert.match(markup, /TURN reachable \(no TLS\)/);
    assert.match(markup, /Browser relay: not tested/);
    assert.match(markup, /not a continuous connection monitor or a two-way media test/);
    assert.match(markup, /Server TURN TLS verified/);
    assert.match(markup, /InvokeVoidAsync\("cancelTurnConnectionTest"\)/);
});

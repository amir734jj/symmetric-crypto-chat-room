const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

test("notification actions wrap with spacing and keep long labels within narrow screens", async () => {
    const source = await readFile(path.join(__dirname, "..", "Components", "ChannelNotifications.razor"), "utf8");
    const actions = source.match(/<div class="d-flex flex-wrap gap-2">([\s\S]*?)<\/div>/);
    assert.ok(actions, "Notification actions need a wrapping container with horizontal and vertical gaps");
    assert.equal((actions[1].match(/<HxButton\b/g) || []).length, 2);
    assert.equal((actions[1].match(/CssClass="mw-100 text-wrap"/g) || []).length, 2,
        "Both Havit buttons must fit the container and allow their labels to wrap");
});

test("all push hub operations use a locally derived password scope, reset on login and logout", async () => {
    const source = await readFile(path.join(__dirname, "..", "SignalRStateManager.cs"), "utf8");
    for (const call of [
        "_server.HasChannelPush(deviceToken, await GetPushScope())",
        "_server.SubscribeChannelPush(deviceToken, subscription, await GetPushScope())",
        "_server.UnsubscribeChannelPush(deviceToken, await GetPushScope())",
        "_server.NotifyChannel(await GetPushScope())"
    ]) assert.ok(source.includes(call), `${call} must not omit the password scope`);
    assert.match(source, /_pushScope \?\?= _payloadEncryptionService\.DerivePushScopeAsync\(login\.Password, login\.Channel\)/);
    assert.match(source, /public async Task Login[\s\S]*?_pushScope = null;/);
    assert.match(source, /public async Task Logout[\s\S]*?_pushScope = null;/);
    assert.doesNotMatch(source, /_server\.(?:HasChannelPush|SubscribeChannelPush|UnsubscribeChannelPush|NotifyChannel)\([^;\n]*\.Password/);
});

async function harness({ permission = "granted", secure = true } = {}) {
    const storage = new Map();
    const calls = [];
    const key = new Uint8Array(65).fill(4);
    let subscription = null;
    const registration = { pushManager: {
        getSubscription: async () => subscription,
        async subscribe(options) {
            calls.push("subscribe");
            assert.equal(options.userVisibleOnly, true);
            subscription = {
                options,
                toJSON: () => ({ endpoint: "https://fcm.googleapis.com/push/test", keys: { p256dh: "public", auth: "secret" } }),
                async unsubscribe() { calls.push("unsubscribe"); subscription = null; return true; }
            };
            return subscription;
        }
    } };
    const context = vm.createContext({
        window: { isSecureContext: secure, PushManager: {}, Notification: {} },
        document: { baseURI: "https://chat.example/" },
        navigator: { serviceWorker: {
            getRegistration: async () => registration,
            async register(url, options) {
                calls.push("register");
                assert.equal(url.href, "https://chat.example/push-service-worker.js");
                assert.equal(options.scope, "/");
                return registration;
            },
            ready: Promise.resolve(registration)
        } },
        Notification: { permission, async requestPermission() { calls.push("permission"); return permission; } },
        localStorage: { getItem: name => storage.get(name), setItem: (name, value) => storage.set(name, value) },
        crypto: webcrypto, Uint8Array, URL, btoa, atob
    });
    const source = await readFile(path.join(__dirname, "..", "wwwroot", "js", "channel-push.js"), "utf8");
    const module = new vm.SourceTextModule(source, { context });
    await module.link(() => { throw new Error("Unexpected import"); });
    await module.evaluate();
    return { push: module.namespace, calls, key: Buffer.from(key).toString("base64url"), storage };
}

test("push permission is opt-in, device identity persists, and enabling a second channel reuses the endpoint", async () => {
    const h = await harness();
    const firstState = await h.push.getState();
    assert.equal(firstState.supported, true);
    assert.equal(firstState.subscribed, false);
    assert.equal(h.calls.length, 0);
    assert.equal(Buffer.from(firstState.deviceToken, "base64url").length, 32);
    const registration = await h.push.subscribe(h.key);
    assert.equal(registration.deviceToken, firstState.deviceToken);
    assert.equal(registration.subscription.endpoint, "https://fcm.googleapis.com/push/test");
    assert.deepEqual(h.calls, ["permission", "register", "subscribe"]);
    await h.push.subscribe(h.key);
    assert.equal(h.calls.filter(call => call === "subscribe").length, 1);
    assert.equal((await h.push.getState()).subscribed, true);
    assert.equal(h.storage.size, 1, "Only a device capability, not passwords or channel content, is stored");
});

test("permission denial does not register a worker or subscribe", async () => {
    const h = await harness({ permission: "denied" });
    await assert.rejects(h.push.subscribe(h.key), /permission was not granted/);
    assert.deepEqual(h.calls, ["permission"]);
});

test("insecure contexts fail explicitly without asking for permission", async () => {
    const h = await harness({ secure: false });
    assert.equal((await h.push.getState()).supported, false);
    await assert.rejects(h.push.subscribe(h.key), /HTTPS/);
    assert.deepEqual(h.calls, []);
});

test("key rotation replaces the browser subscription explicitly", async () => {
    const h = await harness();
    await h.push.subscribe(h.key);
    await h.push.subscribe(Buffer.alloc(65, 5).toString("base64url"));
    assert.deepEqual(h.calls, ["permission", "register", "subscribe", "permission", "register", "unsubscribe", "subscribe"]);
});

async function workerHarness() {
    const listeners = new Map();
    const notifications = [];
    const opened = [];
    const windows = [];
    const scope = {
        registration: {
            scope: "https://chat.example/",
            async showNotification(title, options) { notifications.push({ title, options }); }
        },
        clients: {
            matchAll: async () => windows,
            openWindow: async url => opened.push(url)
        },
        addEventListener: (type, callback) => listeners.set(type, callback)
    };
    const source = await readFile(path.join(__dirname, "..", "wwwroot", "push-service-worker.js"), "utf8");
    vm.runInNewContext(source, { self: scope, URL });
    async function dispatch(type, event) {
        let promise;
        listeners.get(type)({ ...event, waitUntil(value) { promise = value; } });
        await promise;
    }
    return { notifications, opened, windows, dispatch };
}

test("closed-tab push shows only a generic reminder with an encoded channel login link", async () => {
    const h = await workerHarness();
    await h.dispatch("push", { data: { json: () => ({
        channel: "friends & family", message: "SECRET", title: "SECRET", url: "https://evil.example"
    }) } });
    const notification = h.notifications[0];
    assert.equal(notification.title, "Check your chat channel");
    assert.equal(notification.options.body, "Someone invited you to check #friends & family.");
    const target = new URL(notification.options.data.url);
    assert.equal(target.origin, "https://chat.example");
    assert.equal(target.pathname, "/login");
    assert.equal(target.searchParams.get("channel"), "friends & family");
    assert.equal(JSON.stringify(notification).includes("SECRET"), false);
    let closed = false;
    await h.dispatch("notificationclick", { notification: {
        data: notification.options.data, close() { closed = true; }
    } });
    assert.equal(closed, true);
    assert.deepEqual(h.opened, [target.href]);
});

test("click focuses a matching login window, never an unrelated channel window", async () => {
    const h = await workerHarness();
    const target = "https://chat.example/login?channel=one";
    let focused = false;
    h.windows.push({ url: "https://chat.example/chat", focus() { throw new Error("Wrong channel tab"); } });
    h.windows.push({ url: target, async focus() { focused = true; } });
    await h.dispatch("notificationclick", { notification: { data: { url: target }, close() {} } });
    assert.equal(focused, true);
    assert.equal(h.opened.length, 0);
});

test("notification clicks cannot open external URLs or arbitrary application routes", async () => {
    const h = await workerHarness();
    for (const url of ["https://evil.example/", "https://chat.example/arbitrary"]) {
        await h.dispatch("notificationclick", { notification: { data: { url }, close() {} } });
    }
    assert.deepEqual(h.opened, ["https://chat.example/login", "https://chat.example/login"]);
});

const tokenKey = "SYMMETRIC_CRYPTO_PUSH_DEVICE";

function deviceToken() {
    let token = localStorage.getItem(tokenKey);
    if (!token) {
        token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
            .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
        localStorage.setItem(tokenKey, token);
    }
    return token;
}

function supported() {
    return window.isSecureContext && "serviceWorker" in navigator &&
        "PushManager" in window && "Notification" in window;
}

export async function getState() {
    if (!supported()) return { supported: false, subscribed: false, deviceToken: "" };
    const registration = await navigator.serviceWorker.getRegistration(new URL("./", document.baseURI));
    const subscription = registration && await registration.pushManager.getSubscription();
    return {
        supported: true,
        subscribed: Notification.permission === "granted" && !!subscription,
        deviceToken: deviceToken()
    };
}

export async function subscribe(publicKey) {
    if (!supported()) throw new Error("Web Push requires HTTPS and a supported browser. On iPhone/iPad, add this site to your Home Screen first.");
    // Request permission in the click handler, before asynchronous service-worker work.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted. Check this site's browser notification settings.");
    const registration = await navigator.serviceWorker.register(
        new URL("push-service-worker.js", document.baseURI), { scope: new URL("./", document.baseURI).pathname });
    await navigator.serviceWorker.ready;
    const padded = publicKey.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - publicKey.length % 4) % 4);
    const key = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
        const currentKey = new Uint8Array(subscription.options.applicationServerKey || []);
        if (currentKey.length !== key.length || !currentKey.every((value, index) => value === key[index])) {
            if (!await subscription.unsubscribe()) throw new Error("Could not replace the old push subscription.");
            subscription = null;
        }
    }
    subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = subscription.toJSON();
    return {
        deviceToken: deviceToken(),
        subscription: { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }
    };
}

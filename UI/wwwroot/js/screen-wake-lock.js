import { isMobileDevice } from "./media-defaults.js";

export function supportsMobileScreenWakeLock() {
    return isMobileDevice() && "wakeLock" in navigator;
}

export function createScreenWakeLock(getSession) {
    let lock;
    let requestId = 0;
    let enabled = false;
    let listening = false;

    function stopListening() {
        if (listening) document.removeEventListener("visibilitychange", visibilityChanged);
        listening = false;
    }

    function release() {
        enabled = false;
        requestId++;
        stopListening();
        const previous = lock;
        lock = undefined;
        previous?.release().catch(error => console.warn("Unable to release the screen wake lock", error));
    }

    async function request() {
        const session = getSession();
        if (!enabled || !supportsMobileScreenWakeLock() || !session ||
            document.visibilityState !== "visible") return false;
        if (lock && !lock.released) return true;
        const id = ++requestId;
        try {
            const requested = await navigator.wakeLock.request("screen");
            if (id !== requestId || !enabled || getSession() !== session ||
                document.visibilityState !== "visible") {
                await requested.release();
                return false;
            }
            lock = requested;
            requested.addEventListener("release", () => {
                if (lock === requested) lock = undefined;
            }, { once: true });
            return true;
        } catch (error) {
            console.warn("Unable to keep the screen awake during the voice call", error);
            if (id === requestId) {
                enabled = false;
                stopListening();
            }
            return false;
        }
    }

    function visibilityChanged() {
        if (enabled && document.visibilityState === "visible" && getSession() && !lock) {
            request();
        }
    }

    return {
        get active() { return Boolean(lock && !lock.released); },
        async setEnabled(value) {
            enabled = Boolean(value) && supportsMobileScreenWakeLock() && Boolean(getSession());
            if (!enabled) {
                release();
                return false;
            }
            if (!listening) {
                document.addEventListener("visibilitychange", visibilityChanged);
                listening = true;
            }
            return await request();
        },
        release
    };
}

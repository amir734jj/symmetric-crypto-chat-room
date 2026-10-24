const forceStealthStorageKey = "SYMMETRIC_CRYPTO_FORCE_HTTPS_AUDIO";

export function getForceStealthPreference() {
    const value = localStorage.getItem(forceStealthStorageKey);
    if (value !== null && value !== "true" && value !== "false") {
        throw new Error("The saved Stealth audio preference is invalid");
    }
    return value === "true";
}

export function setForceStealthPreference(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("Stealth audio preference must be a boolean");
    localStorage.setItem(forceStealthStorageKey, String(enabled));
}

export function isMobileDevice() {
    return navigator.userAgentData?.mobile === true ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function getDefaultMediaQuality() {
    return isMobileDevice() ? "very-low" : "auto";
}

export function getNetworkConnection() {
    return navigator.connection ?? navigator.mozConnection ?? navigator.webkitConnection;
}

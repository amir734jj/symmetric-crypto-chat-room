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

export function isLowBandwidthMobileConnection() {
    if (!isMobileDevice()) return false;
    const connection = getNetworkConnection();
    return connection?.saveData === true ||
        ["slow-2g", "2g", "3g"].includes(connection?.effectiveType) ||
        (Number.isFinite(connection?.downlink) && connection.downlink >= 0 && connection.downlink < 1.5);
}

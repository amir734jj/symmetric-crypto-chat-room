export function isMobileDevice() {
    return navigator.userAgentData?.mobile === true ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function getDefaultMediaQuality() {
    return isMobileDevice() ? "low" : "auto";
}

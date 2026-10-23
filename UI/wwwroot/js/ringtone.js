let activeRingtone;
let playbackVersion = 0;

function resetAudio(element) {
    element.pause();
    element.currentTime = 0;
    element.load();
}

function stopOnAnswer(event) {
    const button = event.target.closest?.("button");
    if (button?.closest("[data-stop-ringtone]")) stopRingtone();
}

export async function playRingtone(element) {
    if (!element || typeof element.play !== "function") {
        throw new TypeError("The incoming-call audio element is unavailable");
    }
    stopRingtone();
    const version = playbackVersion;
    activeRingtone = element;
    document.addEventListener("click", stopOnAnswer, true);

    try {
        await element.play();
    } catch (error) {
        if (version !== playbackVersion) return false;
        stopRingtone();
        console.warn("Unable to play the incoming-call ringtone", error);
        return false;
    }

    if (version !== playbackVersion) {
        if (activeRingtone !== element) resetAudio(element);
        return false;
    }
    return true;
}

export function stopRingtone() {
    playbackVersion++;
    const element = activeRingtone;
    activeRingtone = undefined;
    if (element) resetAudio(element);
}

export function dispose() {
    stopRingtone();
    document.removeEventListener("click", stopOnAnswer, true);
}

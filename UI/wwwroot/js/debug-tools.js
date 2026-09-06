(function () {
    const storageKey = "SYMMETRIC_CRYPTO_DEBUG_LOG";
    const maxEntries = 200;

    function readEntries() {
        try {
            const entries = JSON.parse(localStorage.getItem(storageKey) || "[]");
            return Array.isArray(entries) ? entries : [];
        } catch {
            return [];
        }
    }

    function record(source, message, detail) {
        try {
            const entries = readEntries();
            entries.push({
                timestamp: new Date().toISOString(),
                source,
                message,
                detail: detail ? String(detail) : ""
            });
            localStorage.setItem(storageKey, JSON.stringify(entries.slice(-maxEntries)));
        } catch {
        }
    }

    function formatBrowserReport() {
        const lines = [
            `User agent: ${navigator.userAgent}`,
            `Page: ${location.pathname}`,
            `Online: ${navigator.onLine}`,
            ""
        ];
        for (const entry of readEntries()) {
            lines.push(`${entry.timestamp} [${entry.source}] ${entry.message}`);
            if (entry.detail) lines.push(entry.detail);
        }
        return lines.join("\n");
    }

    window.appDiagnostics = { record };
    window.getAppDebugReport = async function () {
        let nativeReport = "Native diagnostics unavailable (browser mode or incompatible APK).";
        const plugin = window.Capacitor?.Plugins?.VoiceAudioRouter;
        if (typeof plugin?.getDebugLog === "function") {
            try {
                const result = await plugin.getDebugLog();
                nativeReport = result?.report || "No native diagnostic entries.";
            } catch (error) {
                nativeReport = `Unable to read native diagnostics: ${error?.message || error}`;
            }
        }
        return `=== Browser / WebView ===\n${formatBrowserReport()}\n\n=== Android native ===\n${nativeReport}`;
    };
    window.copyAppDebugReport = async function (report) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(report);
            return;
        }
        const textArea = document.createElement("textarea");
        textArea.value = report;
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.select();
        const copied = document.execCommand("copy");
        textArea.remove();
        if (!copied) throw new Error("Clipboard access is unavailable");
    };
    window.clearAppDebugReport = async function () {
        localStorage.removeItem(storageKey);
        const plugin = window.Capacitor?.Plugins?.VoiceAudioRouter;
        if (typeof plugin?.clearDebugLog === "function") {
            try {
                await plugin.clearDebugLog();
            } catch {
            }
        }
        record("Diagnostics", "Browser log cleared");
    };

    window.addEventListener("error", event => {
        record("window.error", event.message || "Unknown JavaScript error",
            `${event.filename || "unknown"}:${event.lineno || 0}:${event.colno || 0}`);
    });
    window.addEventListener("unhandledrejection", event => {
        const reason = event.reason;
        record("unhandledrejection", reason?.message || String(reason || "Unknown rejection"), reason?.stack);
    });
    record("WebView", "Page script initialized");
})();

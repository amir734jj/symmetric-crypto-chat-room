let activeProbe;

export function createIceConfiguration(credentials) {
    const host = credentials.host || window.location.hostname;
    const port = credentials.port ?? (credentials.tlsOnly ? 443 : 3478);
    const endpoint = `${host}:${port}`;
    return {
        iceTransportPolicy: credentials.tlsOnly || credentials.relayOnly ? "relay" : "all",
        iceServers: credentials.tlsOnly ? [
            {
                urls: [`turns:${endpoint}?transport=tcp`],
                username: credentials.username,
                credential: credentials.credential
            }
        ] : [
            { urls: [`stun:${endpoint}`] },
            {
                urls: [`turn:${endpoint}?transport=udp`, `turn:${endpoint}?transport=tcp`],
                username: credentials.username,
                credential: credentials.credential
            }
        ]
    };
}

export async function testTurnConnection(credentials) {
    if (activeProbe) throw new Error("A browser relay test is already running");

    const controller = new AbortController();
    activeProbe = controller;
    let connection;
    let timer;
    let cancel;
    try {
        const configuration = createIceConfiguration(credentials);
        const iceServers = configuration.iceServers.filter(server =>
            server.urls.some(url => url.startsWith("turn:") || url.startsWith("turns:")));
        const url = iceServers.flatMap(server => server.urls).join(", ");
        connection = new RTCPeerConnection({
            ...configuration,
            iceTransportPolicy: "relay",
            iceServers
        });

        return await new Promise(resolve => {
            let settled = false;
            const errors = new Set();
            const finish = (succeeded, message) => {
                if (settled) return;
                settled = true;
                resolve({ succeeded, tls: !!credentials.tlsOnly, url, message });
            };
            const failure = message => finish(false,
                errors.size ? `${message} ${[...errors].join("; ")}` : message);
            cancel = () => finish(false, "Browser relay test cancelled.");
            controller.signal.addEventListener("abort", cancel);
            timer = setTimeout(() => failure("No authenticated relay candidate within 15 seconds."), 15000);
            connection.onicecandidateerror = event => {
                errors.add(`${event.errorCode}: ${event.errorText || "TURN connection failed"}`);
            };
            connection.onicecandidate = event => {
                if (event.candidate?.type === "relay") {
                    finish(true, credentials.tlsOnly
                        ? "This browser obtained an authenticated TURN relay over TLS."
                        : "This browser obtained an authenticated TURN relay. TLS is not configured.");
                } else if (!event.candidate) {
                    failure("ICE gathering completed without an authenticated relay candidate.");
                }
            };
            connection.createDataChannel("relay-connectivity-test");
            connection.createOffer()
                .then(offer => connection.setLocalDescription(offer))
                .catch(error => failure(`Unable to test the browser relay: ${error.message}`));
        });
    } finally {
        clearTimeout(timer);
        if (cancel) controller.signal.removeEventListener("abort", cancel);
        connection?.close();
        activeProbe = undefined;
    }
}

export function cancelTurnConnectionTest() {
    activeProbe?.abort();
}

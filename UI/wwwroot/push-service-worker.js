self.addEventListener("push", event => {
    event.waitUntil((async () => {
        const payload = event.data ? event.data.json() : {};
        const channel = typeof payload.channel === "string" ? payload.channel.slice(0, 200) : "";
        const url = new URL("login", self.registration.scope);
        if (channel) url.searchParams.set("channel", channel);
        await self.registration.showNotification("Check your chat channel", {
            body: channel ? `Someone invited you to check #${channel}.` : "Open the website to check your channel.",
            tag: `channel:${channel}`,
            data: { url: url.href }
        });
    })());
});

self.addEventListener("notificationclick", event => {
    event.notification.close();
    event.waitUntil((async () => {
        const fallback = new URL("login", self.registration.scope);
        const url = new URL(event.notification.data?.url || fallback.href, self.registration.scope);
        // Notification data must never navigate to an external origin or an arbitrary path.
        const target = url.origin === fallback.origin && url.pathname === fallback.pathname ? url : fallback;
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of windows) {
            if (client.url === target.href) {
                await client.focus();
                return;
            }
        }
        await self.clients.openWindow(target.href);
    })());
});

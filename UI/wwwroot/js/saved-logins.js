const storageKey = "symmetric-crypto-chat-room.saved-logins.v1";
const maximumSavedLogins = 10;

export function getSavedLogins() {
    return readSavedLogins();
}

export function saveLogin(login) {
    const name = login?.name?.trim();
    const channel = login?.channel?.trim();
    const password = login?.password;
    if (!name || !channel || !password) return readSavedLogins();

    const savedLogins = readSavedLogins();
    const existing = savedLogins.find(saved =>
        saved.name.toLocaleLowerCase() === name.toLocaleLowerCase() &&
        saved.channel.toLocaleLowerCase() === channel.toLocaleLowerCase());
    const savedLogin = {
        id: existing?.id ?? crypto.randomUUID(),
        name,
        channel,
        password,
        lastUsedAt: new Date().toISOString()
    };
    const updated = [
        savedLogin,
        ...savedLogins.filter(saved => saved.id !== savedLogin.id)
    ].slice(0, maximumSavedLogins);
    localStorage.setItem(storageKey, JSON.stringify(updated));
    return updated;
}

export function removeSavedLogin(id) {
    const updated = readSavedLogins().filter(saved => saved.id !== id);
    localStorage.setItem(storageKey, JSON.stringify(updated));
    return updated;
}

function readSavedLogins() {
    try {
        const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
        if (!Array.isArray(parsed)) return [];

        return parsed.filter(saved =>
            typeof saved?.id === "string" &&
            typeof saved?.name === "string" &&
            typeof saved?.channel === "string" &&
            typeof saved?.password === "string" &&
            typeof saved?.lastUsedAt === "string");
    } catch {
        return [];
    }
}

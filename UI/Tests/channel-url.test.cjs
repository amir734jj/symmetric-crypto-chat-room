const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");

test("chat URL follows the joined channel and name on login, session restore and query changes", async () => {
    const source = await readFile(path.join(__dirname, "..", "Pages", "Chat.razor"), "utf8");
    assert.match(source, /\[SupplyParameterFromQuery\(Name = "channel"\)\]\s+public string\? Channel/);
    assert.match(source, /\[SupplyParameterFromQuery\(Name = "name"\)\]\s+public string\? Name/);
    const parameters = source.match(/protected override void OnParametersSet\(\)([\s\S]*?)protected override async Task OnInitializedAsync/)[1];
    assert.match(parameters, /State\.UserInfo is \{ \} login && \(Channel != login\.Channel \|\| Name != login\.Name\)/);
    assert.match(parameters, /Navigation\.NavigateTo\(Navigation\.GetUriWithQueryParameters/);
    assert.match(parameters, /\["channel"\] = login\.Channel/);
    assert.match(parameters, /\["name"\] = login\.Name/);
    assert.match(parameters, /replace: true/);
    assert.doesNotMatch(parameters, /login\.Password/);
});

test("logged-out chat links preserve and prefill the encoded channel and name", async () => {
    const source = await readFile(path.join(__dirname, "..", "Pages", "Chat.razor"), "utf8");
    assert.match(source, /if \(!SignalRStateManager\.IsLoggedIn\(\)\)[\s\S]*?Navigation\.GetUriWithQueryParameters\(\s+Navigation\.ToAbsoluteUri\("\/login"\)/);
    for (const [key, property] of [["channel", "Channel"], ["name", "Name"]]) {
        assert.ok(source.includes(`["${key}"] = string.IsNullOrWhiteSpace(${property}) ? null : ${property}`));
    }
    const login = await readFile(path.join(__dirname, "..", "Pages", "Login.razor"), "utf8");
    assert.match(login, /\[SupplyParameterFromQuery\(Name = "name"\)\]\s+public string\? NameFromQuery/);
    assert.match(login, /!string\.IsNullOrWhiteSpace\(NameFromQuery\) && NameFromQuery\.Length <= 50\)\s+_model\.Name = NameFromQuery/);
});

test("chat waits for session restoration before redirecting to channel login", async () => {
    const chat = await readFile(path.join(__dirname, "..", "Pages", "Chat.razor"), "utf8");
    assert.match(chat, /protected override async Task OnInitializedAsync\(\)\s+\{\s+await SignalRStateManager\.Initialize\(\);\s+if \(!SignalRStateManager\.IsLoggedIn\(\)\)/);
    const manager = await readFile(path.join(__dirname, "..", "SignalRStateManager.cs"), "utf8");
    const initialize = manager.match(/public async Task Initialize\(\)([\s\S]*?)public async Task Login/)[1];
    assert.ok(initialize.indexOf("_state.StateEnum = SignalRStateEnum.Initialized;") >
        initialize.indexOf("await Login("), "Initialization must include restoring the saved login");
});

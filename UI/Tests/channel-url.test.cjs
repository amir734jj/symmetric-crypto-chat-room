const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");

test("chat URL follows the joined channel on login, session restore and query changes", async () => {
    const source = await readFile(path.join(__dirname, "..", "Pages", "Chat.razor"), "utf8");
    assert.match(source, /\[SupplyParameterFromQuery\(Name = "channel"\)\]\s+public string\? Channel/);
    const parameters = source.match(/protected override void OnParametersSet\(\)([\s\S]*?)protected override async Task OnInitializedAsync/)[1];
    assert.match(parameters, /State\.UserInfo is \{ \} login && Channel != login\.Channel/);
    assert.match(parameters, /Navigation\.NavigateTo\(Navigation\.GetUriWithQueryParameter\("channel", login\.Channel\), replace: true\)/);
    assert.doesNotMatch(parameters, /login\.(Name|Password)/);
});

test("logged-out channel links preserve the encoded channel on the login page", async () => {
    const source = await readFile(path.join(__dirname, "..", "Pages", "Chat.razor"), "utf8");
    assert.match(source, /if \(!SignalRStateManager\.IsLoggedIn\(\)\)[\s\S]*?string\.IsNullOrWhiteSpace\(Channel\)\s+\? "\/login"\s+: \$"\/login\?channel=\{Uri\.EscapeDataString\(Channel\)\}"/);
});

test("chat waits for session restoration before redirecting to channel login", async () => {
    const chat = await readFile(path.join(__dirname, "..", "Pages", "Chat.razor"), "utf8");
    assert.match(chat, /protected override async Task OnInitializedAsync\(\)\s+\{\s+await SignalRStateManager\.Initialize\(\);\s+if \(!SignalRStateManager\.IsLoggedIn\(\)\)/);
    const manager = await readFile(path.join(__dirname, "..", "SignalRStateManager.cs"), "utf8");
    const initialize = manager.match(/public async Task Initialize\(\)([\s\S]*?)public async Task Login/)[1];
    assert.ok(initialize.indexOf("_state.StateEnum = SignalRStateEnum.Initialized;") >
        initialize.indexOf("await Login("), "Initialization must include restoring the saved login");
});

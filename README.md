## SymmetricCryptoChatRoom

[![Docker Hub badge][dockerhub-badge]][dockerhub]

Simple secure chat room web (+ file transfer) application using SignalR (dotnet core) and Blazor for front-end and most importantly:
- `PBKDF2-HMAC-SHA256` (210,000 iterations) to derive 256-bit encryption keys locally from the password
- `AES-256-CTR` to encrypt/decrypt the messages

### Note
- `password` is never sent via a socket, You are responsible to exchange the symmetric key
- Both encryption and decryption is all done in client-slide, only ciphertexts are transmitted via Sockets
- File name is transmitted as plaintext but file blob is transmitted as ciphertext
- Combined attachment size per message is limited to `25 MB`
- Attachments use managed gzip compression before encryption when it reduces their size
- Each new message uses a random 16-byte salt for PBKDF2. The salt and an HMAC key confirmation travel with the ciphertext in a versioned token; neither the password nor the derived key is transmitted. A short password is accepted without padding, but remains easier to guess.
- Updated clients can still decrypt cached messages using the legacy SHA-256 key derivation. Older clients cannot decrypt the new PBKDF2 message format and should be refreshed.
- This key-derivation upgrade retains AES-CTR and does not add authenticated encryption or fix its existing zero-IV reuse across fields within a message. Password-derived confirmation values also permit offline password guessing; use a strong passphrase.
- The active session password is stored as plaintext in browser `sessionStorage`. Successful logins are also retained in `localStorage` for optional quick login until individually removed or the site's storage is cleared.
- Used [LiteDB](https://www.litedb.org/) to playback messages from 10 minutes ago to just joined users
- [Fody.PropertyChanged](https://github.com/Fody/PropertyChanged) to detect if any of state's properties changes which triggers re-renders of UI

### Self-hosted voice and video channel

Encryption is mandatory for transmitted message/file contents and call media. Mobile presets, bandwidth adaptation, keyframe recovery, camera changes, and screen sharing never disable it. If encrypted media setup fails, the affected sender is not attached or its track is removed; browsers without encoded-transform support cannot join calls. Encryption failures never fall back to plaintext or transport-only media.

The chat page starts with **Advanced settings** and **Debug mode** off. Everyday call controls, including **Keep screen on** during calls on supported mobile browsers, stay visible; **Advanced settings** reveals audio/camera quality, the transcription model, and the transcription download warning. **Debug mode** reveals STUN/TURN health checks, ICE diagnostics, message state, and invalid-message controls. These switches are independent and apply only to the current chat page. Hiding advanced settings preserves selected values and does not stop active call features; disabling debug mode hides diagnostic output and invalid messages and stops ICE diagnostic polling.

While joined to the voice/video bridge, a small signal icon beside the heading shows measured WebRTC call health, not just whether SignalR is connected. Every five seconds it checks packet loss, round-trip latency, jitter, and available outgoing bandwidth relative to the selected audio/video presets, including screen sharing. Three green bars indicate healthy measurements; two amber bars indicate degradation (over 2% loss, 150 ms round-trip latency, 30 ms jitter, insufficient bandwidth headroom, or browser-reported bandwidth limitation); one red bar indicates poor health (over 5% loss, 300 ms latency, 60 ms jitter, less than half the required outgoing bitrate, or a disconnected/failed peer). The worst participant connection determines the icon. Gray bars mean waiting for a participant, connecting, or measurements unavailable, never an assumed healthy connection. A tooltip and screen-reader status provide measurement details. This indicator is independent of advanced/debug settings.

The chat application and coturn are deployed as separate Dockerfile-based services. The coturn image is maintained in the sibling `stun-turn-setup` repository. No public STUN/TURN service is configured. Encoded audio and video frames are encrypted with AES-256-CTR using a PBKDF2 key derived from the channel name and shared chat password. Each encrypted frame carries its header length and an eight-byte counter so decryption remains consistent across browsers. WebRTC DTLS-SRTP authenticates and encrypts the media transport as a second protection layer.

Password-encrypted calls require a browser with `RTCRtpScriptTransform` support. Offers and answers include an HMAC confirmation of the derived media key without transmitting the password or key. Participants using different passwords can join the same channel and establish calls, but incompatible peers show **Unreadable media - different password** instead of playing noise or displaying corrupted video. Incoming frames are discarded before decoding until the peer's key confirmation matches; incompatible audio is also excluded from transcription. Missing confirmations are treated as unreadable rather than blocking the call. Matching-password participants in the same call can still hear and see one another normally. The connection fails closed when encoded transforms are unavailable; it never sends audio or video protected only by WebRTC transport encryption. Joining the bridge alone does not open the microphone; audio capture starts when another voice participant connects and stops again when the last peer leaves. Separate sessions can use the same display name and call each other. Matching names in a channel (case-insensitive) receive distinct `(session N)` labels in presence, call controls, video captions, and newly sent messages. These labels identify browser sessions, not hardware; reconnecting the same client instance still replaces its stale connection. Calling the current connection remains blocked. When calling between your own devices, mute one microphone or use headphones to avoid feedback. Calls start as audio-only. Use **Start video** during a call to grant camera access and share video, and **Stop video** to stop the camera and remove its WebRTC sender. Receive-only transceivers also initialize their sender encryption before answering, so enabling the second camera can safely reuse them. **Share screen** uses the browser's screen picker and replaces the encrypted camera track without creating another participant tile. Stopping the share restores the camera when it was active beforehand, or returns the call to audio-only otherwise.

Answering an incoming invitation stops its ringtone and acknowledges acceptance before media initialization or microphone permission completes, so the caller stops ringing instead of timing out during setup. Both **Accept** and **Join call** accept a pending incoming invitation. Voice key derivation uses C#/.NET `Rfc2898DeriveBytes.Pbkdf2` with the same PBKDF2 parameters and channel salt as before. This synchronous derivation can briefly block the browser during call setup.

Live transcription is opt-in. Until **Start transcription** is selected, the application does not download or evaluate the transcription audio-processing module, create a transcription worker or audio-processing graph, import Transformers.js, or request model files. The default Auto option chooses quantized multilingual Whisper Tiny, Base, or Small from browser-reported memory, logical processor count, and mobile input characteristics. Manual multilingual and English-only Tiny, Base, and Small options are also available; larger models improve accuracy but increase download size, memory use, and processing latency. Enabling transcription lazily downloads only the selected model, mixes local and remote call audio in the browser, and transcribes short windows on-device. Call audio is not uploaded for inference. The browser can cache downloaded model files for later sessions; stopping transcription terminates the worker and audio graph, and leaving the bridge clears the displayed transcript.

Live transcription is desktop-only. On phones and tablets, including iPads using a desktop user agent, **Start transcription**, its download warning, and the model selector are hidden regardless of connection speed or Network Information API support. Mobile startup attempts are rejected before transcription modules, workers, or models are loaded. Desktop transcription remains opt-in and an already-running session retains **Stop transcription**.

Transcription, bandwidth adaptation, and encrypted video recovery regression tests use Node.js's built-in test runner (no npm dependencies). From the repository root, run:

```powershell
node --experimental-vm-modules --test UI\Tests\voice-chat.test.cjs UI\Tests\voice-crypto-worker.test.cjs UI\Tests\password-key-derivation.test.cjs
dotnet run --project Tests\MessageHub.Tests
dotnet run --project Tests\PayloadEncryption.Tests
```

Message/file password derivation uses the browser's asynchronous Web Crypto API to avoid blocking the UI. The password-derivation Node tests verify Web Crypto PBKDF2 against the platform implementation, short and Unicode passwords without padding, salt validation, and explicit failure without weaker fallbacks. The payload encryption regression executable verifies C# voice key derivation against independent PBKDF2 vectors and uses a platform-PBKDF2 interop test double to verify random per-message salts, password/key exclusion from serialized payloads, wrong-password behavior, message and attachment round-trips, legacy cached-message compatibility, and rejection of malformed or unsupported encryption tokens.

For real-browser coverage, serve the repository root locally (`python -m http.server 8765 --bind 127.0.0.1`) and open `http://127.0.0.1:8765/UI/Tests/voice-chat.browser.html` in a browser supporting encoded transforms. It uses synthetic cameras and audio, without requesting device access, and checks continuous two-way decoding and rendered pixels, recipient resolution changes (144p, 720p, and 240p), camera restarts, simultaneous camera activation, encrypted audio and mute/unmute, screen sharing with and without a camera, camera restoration at the selected quality, and leaving/rejoining with the opposite offerer. It also checks that different-password peers establish connections and exchange encrypted packets while showing unreadable-media indicators, muting audio, hiding video, and discarding incompatible video before decoding. The local-only test disables network adaptation to measure the selected resolutions deterministically; Node tests cover per-recipient bandwidth constraints. The hub regression executable checks matching-name presence, ring/accept/decline/cancel behavior, signaling, preservation of encrypted message/attachment data, voice rejoin, stale reconnect cleanup, and channel isolation.

On phones and tablets, audio and camera quality start at the **Very low** presets: 12 kbps audio with a preferred 16 kHz capture rate, and 144p camera video at up to 8 fps and 100 kbps. This includes Android, iPhone, and iPad browsers (including iPads reporting a desktop user agent). These defaults do not automatically increase beyond the selected preset's bandwidth ceiling; users can still choose Low, Medium, High, or Auto, and their selection is retained when rejoining or reconnecting within the same chat page. Device detection loads only a small helper, not the voice or transcription modules. Desktop defaults remain Auto.

On desktop, voice quality defaults to Auto at the 32 kbps Medium profile. It promotes to the 64 kbps High profile after sustained good packet loss, round-trip time, and outgoing-bandwidth measurements, then falls back to Medium when conditions degrade. Manual Low, Medium, and High modes remain available.

Desktop camera quality defaults to Auto. It starts at Medium (480p, 24 fps, up to 700 kbps), promotes to High (720p, 30 fps, up to 1.5 Mbps) when network measurements remain strong, and steps down to Low (240p, 15 fps, up to 250 kbps) as conditions degrade. Very low, Low, Medium, and High profiles can be selected manually before or during a call.

Camera quality changes update both capture constraints and every recipient's encoder resolution, bitrate, and frame-rate limits. Encoder scaling accounts for the actual capture dimensions, including cameras that retain a larger capture size. Resolution changes do not rely on the browser's separate balanced spatial adaptation; per-recipient network adaptation below still applies. Capture constraint failures are reported instead of claiming the new quality was applied. Debug diagnostics include encoded and decoded frame dimensions and frame rates.

When renegotiation delivers a replacement video track, the participant tile switches to that track rather than accumulating inactive video tracks. Mute/end events from a superseded track cannot hide the current video.

Regardless of Auto or manual camera quality, each recipient's reported outgoing bandwidth, round-trip time, and video packet loss can temporarily lower that recipient's video bitrate, frame rate, and encoded resolution below the preset. Bandwidth estimates reserve room for audio and transport overhead; constrained video can drop to 50 kbps and 5 fps. Recovery is gradual and never exceeds the selected preset. Screen sharing also honors the per-recipient bitrate/frame-rate limits while preserving text resolution. Auto only promotes camera quality when an outgoing bandwidth estimate supports it. These are best-effort limits, not a guarantee that video is usable on every connection.

The encrypted video receiver detects gaps in frame counters and requests a fresh keyframe, throttled to once per second. It holds dependent delta frames until a keyframe arrives rather than feeding broken references to the decoder. A poor connection may therefore briefly freeze the last good image instead of displaying corrupted blocks. The encrypted frame format and audio handling remain unchanged.

Microphone audio uses real-time echo cancellation, noise suppression, and automatic gain control. Browsers that expose native voice isolation use it automatically; other browsers retain the standard WebRTC noise suppression fallback. The ICE debug view reports which processing features are supported and active.

While voice is active, supported mobile browsers keep the screen awake and use their communication audio-session mode. Manually locking the device can still suspend a browser call when the mobile operating system does not allow background microphone or WebRTC activity.

Supported iOS browsers show an in-call **Audio output** selector with Auto, Earpiece, and Speaker modes. Auto delegates routing to the phone's call audio session so the operating system can apply its proximity behavior; browsers do not expose the raw proximity sensor to the application. Earpiece and Speaker request a fixed handset route. Browsers implementing the Audio Output Devices API instead show **Choose output** for selecting a speaker, wired headset, or Bluetooth device through the system picker. Browsers without either API continue using the operating system's default route.

`TURN_RELAY_ONLY` defaults to `true`. In this mode WebRTC uses `iceTransportPolicy: "relay"`, so voice fails instead of connecting directly when the configured coturn service is unavailable. Set it to `false` only when direct peer-to-peer paths through the configured STUN server are acceptable.

Set `TURN_EXTERNAL_IP` on the coturn service to its Docker host's public IPv4 address. Also publish and allow TCP/UDP 3478 and UDP 49160-49200 through the host firewall and network security rules. Set `TURN_HOST` on the chat service to the public DNS name clients should use.

Set `TURN_SECRET` explicitly. The API uses it to issue short-lived credentials, and the coturn service uses the same value to validate them.

Password derivation through Web Crypto and microphone/camera access require a secure browser context. Use a trusted HTTPS certificate in production, either at a reverse proxy on the same host or by configuring ASP.NET Core HTTPS and mounting the certificate into the container. Plain HTTP works only on `localhost` or a loopback address for these browser features.

#### Coolify

Create a Dockerfile resource for this repository and route `chat.coolify.hesamian.com` to container port `3000`. Configure persistent storage at `/app/data` for LiteDB playback data.

The chat image checks `http://127.0.0.1:3000/health` every 30 seconds. Coolify should report the container as healthy after its startup grace period.

Create a second Dockerfile resource from the `stun-turn-setup` repository. Do not add `turn.coolify.hesamian.com` to Coolify's Domains panel because STUN/TURN is not HTTP. Publish TCP/UDP 3478 and UDP 49160-49200 directly from the coturn container to the host.

Set these environment variables on the chat service:

```env
TURN_HOST=turn.coolify.hesamian.com
TURN_SECRET=replace-with-a-long-random-secret
TURN_RELAY_ONLY=true
```

Set these environment variables on the coturn service:

```env
TURN_EXTERNAL_IP=203.0.113.10
TURN_REALM=chat.coolify.hesamian.com
TURN_SECRET=replace-with-the-same-long-random-secret
```

Create a DNS-only `A` record at your DNS provider for `turn.coolify.hesamian.com`, pointing to the value of `TURN_EXTERNAL_IP`. When using Cloudflare, set it to DNS only. Allow TCP/UDP 3478 and UDP 49160-49200 in the server provider's firewall.

To verify relay routing in Chromium or Edge, open `chrome://webrtc-internals` or `edge://webrtc-internals` during a call and inspect the selected ICE candidate pair. The local candidate type must be `relay`, and its relay protocol/address must correspond to the configured `TURN_HOST`. With `TURN_RELAY_ONLY=true`, a non-relay candidate cannot be selected.

### Screenshots

![Login](screenshots/blazor/login.png)
--
![Board](screenshots/blazor/board.png)

[dockerhub-badge]: https://img.shields.io/docker/pulls/amir734jj/symmetric-crypto-chatroom
[dockerhub]: https://hub.docker.com/repository/docker/amir734jj/symmetric-crypto-chatroom

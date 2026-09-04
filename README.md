## SymmetricCryptoChatRoom

[![Docker Hub badge][dockerhub-badge]][dockerhub]

Simple secure chat room web (+ file transfer) application using SignalR (dotnet core) and Blazor for front-end and most importantly:
- `SHA-256` to hash the given password
- `AES-256-CTR` to encrypt/decrypt the messages

### Note
- `password` is never sent via a socket, You are responsible to exchange the symmetric key
- Both encryption and decryption is all done in client-slide, only ciphertexts are transmitted via Sockets
- File name is transmitted as plaintext but file blob is transmitted as ciphertext
- Max file size is `50mb` (binary format for transport)
- Session password is store as plaintext via a cookie in your browser
- Used [LiteDB](https://www.litedb.org/) to playback messages from 10 minutes ago to just joined users
- [Fody.PropertyChanged](https://github.com/Fody/PropertyChanged) to detect if any of state's properties changes which triggers re-renders of UI

### Self-hosted voice channel

The Compose deployment runs a dedicated coturn WebRTC service next to the API. No public STUN/TURN service is configured. Encoded audio frames are encrypted and authenticated with AES-256-GCM using a PBKDF2 key derived from the channel name and shared chat password. WebRTC DTLS-SRTP adds a second transport-encryption layer.

Password-encrypted voice requires a browser with `RTCRtpScriptTransform` support. The voice connection fails closed when encoded transforms are unavailable; it never sends voice protected only by WebRTC transport encryption.

`TURN_RELAY_ONLY` defaults to `true`. In this mode WebRTC uses `iceTransportPolicy: "relay"`, so voice fails instead of connecting directly when the configured coturn service is unavailable. Set it to `false` only when direct peer-to-peer paths through the configured STUN server are acceptable.

Set `TURN_EXTERNAL_IP` to the Docker host's public IPv4 address. Also allow TCP/UDP 3478 and UDP 49160-49200 through the host firewall and network security rules. `TURN_HOST` may be set to the public DNS name clients should use; by default the browser uses the chat site's hostname.

Set `TURN_SECRET` explicitly. The API uses it to issue short-lived credentials, and the coturn service uses the same value to validate them.

Microphone access requires a secure browser context. Use a trusted HTTPS certificate in production, either at a reverse proxy on the same host or by configuring ASP.NET Core HTTPS and mounting the certificate into the container. Plain HTTP works only on `localhost` for browser media capture.

#### Coolify with Docker Compose

Create a Docker Compose resource in Coolify and select `/docker-compose.yaml`. The `SERVICE_FQDN_CHAT_3000` marker makes Coolify recognize `chat` as an application service routed to container port `3000`. Keep `https://chat.coolify.hesamian.com:3000` on the `chat` service in the Domains panel; the `:3000` suffix tells Coolify which container port to proxy and is not part of the public browser URL.

Do not add `turn.coolify.hesamian.com` to Coolify's Domains panel. That panel creates HTTP/HTTPS routes, but STUN/TURN is not HTTP. Remove any `https://turn.coolify.hesamian.com:3478` entries from Coolify. The `turn` service is exposed directly by the Compose `ports` mappings.

Set these environment variables in Coolify:

```env
TURN_HOST=turn.coolify.hesamian.com
TURN_EXTERNAL_IP=203.0.113.10
TURN_REALM=chat.coolify.hesamian.com
TURN_SECRET=replace-with-a-long-random-secret
TURN_RELAY_ONLY=true
```

Create a DNS-only `A` record at your DNS provider for `turn.coolify.hesamian.com`, pointing to the value of `TURN_EXTERNAL_IP`. When using Cloudflare, set it to DNS only. Allow TCP/UDP 3478 and UDP 49160-49200 in the server provider's firewall.

To verify relay routing in Chromium or Edge, open `chrome://webrtc-internals` or `edge://webrtc-internals` during a call and inspect the selected ICE candidate pair. The local candidate type must be `relay`, and its relay protocol/address must correspond to the configured `TURN_HOST`. With `TURN_RELAY_ONLY=true`, a non-relay candidate cannot be selected.

### Screenshots

![Login](screenshots/blazor/login.png)
--
![Board](screenshots/blazor/board.png)

[dockerhub-badge]: https://img.shields.io/docker/pulls/amir734jj/symmetric-crypto-chatroom
[dockerhub]: https://hub.docker.com/repository/docker/amir734jj/symmetric-crypto-chatroom

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

The chat application and coturn are deployed as separate Dockerfile-based services. The coturn image is maintained in the sibling `stun-turn-setup` repository. No public STUN/TURN service is configured. Encoded audio frames are encrypted and authenticated with AES-256-GCM using a PBKDF2 key derived from the channel name and shared chat password. WebRTC DTLS-SRTP adds a second transport-encryption layer.

Password-encrypted voice requires a browser with `RTCRtpScriptTransform` support. The voice connection fails closed when encoded transforms are unavailable; it never sends voice protected only by WebRTC transport encryption.

`TURN_RELAY_ONLY` defaults to `true`. In this mode WebRTC uses `iceTransportPolicy: "relay"`, so voice fails instead of connecting directly when the configured coturn service is unavailable. Set it to `false` only when direct peer-to-peer paths through the configured STUN server are acceptable.

Set `TURN_EXTERNAL_IP` on the coturn service to its Docker host's public IPv4 address. Also publish and allow TCP/UDP 3478 and UDP 49160-49200 through the host firewall and network security rules. Set `TURN_HOST` on the chat service to the public DNS name clients should use.

Set `TURN_SECRET` explicitly. The API uses it to issue short-lived credentials, and the coturn service uses the same value to validate them.

Microphone access requires a secure browser context. Use a trusted HTTPS certificate in production, either at a reverse proxy on the same host or by configuring ASP.NET Core HTTPS and mounting the certificate into the container. Plain HTTP works only on `localhost` for browser media capture.

#### Coolify

Create a Dockerfile resource for this repository and route `chat.coolify.hesamian.com` to container port `3000`. Configure persistent storage at `/app/data` for LiteDB playback data.

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

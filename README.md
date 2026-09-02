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

The Compose deployment runs a dedicated coturn WebRTC service next to the API. No public STUN/TURN service is used. Voice media is encrypted by WebRTC and travels directly between peers when possible, falling back to the self-hosted relay.

Set `TURN_EXTERNAL_IP` to the Docker host's public IPv4 address. Also allow TCP/UDP 3478 and UDP 49160-49200 through the host firewall and network security rules. `TURN_HOST` may be set to the public DNS name clients should use; by default the browser uses the chat site's hostname.

Set `TURN_SECRET` explicitly. The API uses it to issue short-lived credentials, and the coturn service uses the same value to validate them.

Microphone access requires a secure browser context. Use a trusted HTTPS certificate in production, either at a reverse proxy on the same host or by configuring ASP.NET Core HTTPS and mounting the certificate into the container. Plain HTTP works only on `localhost` for browser media capture.

#### Coolify with Docker Compose

Create a Docker Compose resource in Coolify and select `/compose.yaml`. Configure only the `chat` service domain as `https://chat.coolify.hesamian.com` with container port `3000`. The separate `turn` service has no HTTP domain; its coturn ports are published directly by Compose.

Set these environment variables in Coolify:

```env
TURN_HOST=turn.coolify.hesamian.com
TURN_EXTERNAL_IP=203.0.113.10
TURN_REALM=chat.coolify.hesamian.com
TURN_SECRET=replace-with-a-long-random-secret
```

Create a DNS-only `A` record for `turn.coolify.hesamian.com` pointing to the value of `TURN_EXTERNAL_IP`. When using Cloudflare, do not proxy this record. Allow TCP/UDP 3478 and UDP 49160-49200 in the server provider's firewall.

### Screenshots

![Login](screenshots/blazor/login.png)
--
![Board](screenshots/blazor/board.png)

[dockerhub-badge]: https://img.shields.io/docker/pulls/amir734jj/symmetric-crypto-chatroom
[dockerhub]: https://hub.docker.com/repository/docker/amir734jj/symmetric-crypto-chatroom

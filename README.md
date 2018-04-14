## SymmetricCryptoChatRoom ([Heroku Url](https://symmetric-crypto-chat-room.herokuapp.com/))

Simple secure chat room web application using SignalR (dotnet core build) and Angular.js for front-end and most importantly:
- `SHA-256` to hash the given password
- `AES-256-CTR` to encrypt/decrypt the messages

### Note
- `password` is never sent via a socket, You are responsible to exchange the symmetric key
- both encryption and decryption is all done in client-slide, only ciphertexts are transmitted via Sockets




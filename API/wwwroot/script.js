angular.module("chatApp", [])
  .controller("chatCtrl", $scope => {
    $scope.name = "";
    $scope.password = "";
    $scope.initialized = false;

    var crypto = (key) => {
      var hash = sha256.create();
      hash.update(key);
      key = hash.array();

      return {
        encrypt: (plaintext) => {
          // Convert text to bytes
          var text = plaintext;
          var textBytes = aesjs.utils.utf8.toBytes(text);

          // The counter is optional, and if omitted will begin at 1
          var aesCtr = new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(5));
          var encryptedBytes = aesCtr.encrypt(textBytes);

          // To print or store the binary data, you may convert it to hex
          var encryptedHex = aesjs.utils.hex.fromBytes(encryptedBytes);

          return encryptedHex;
        },
        decrypt: (ciphertext) => {
          // When ready to decrypt the hex string, convert it back to bytes
          var encryptedBytes = aesjs.utils.hex.toBytes(ciphertext);

          // The counter mode of operation maintains internal state, so to
          // decrypt a new instance must be instantiated.
          var aesCtr = new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(5));
          var decryptedBytes = aesCtr.decrypt(encryptedBytes);

          // Convert our bytes back into text
          var decryptedText = aesjs.utils.utf8.fromBytes(decryptedBytes);

          return decryptedText;
        }
      };
    };

    $scope.initialize = () => {
      $scope.initialized = true;
      $scope.crypto = crypto($scope.password)
      init();
    };

    var init = () => {
      $scope.messages = [];
      var conn = new signalR.HubConnection("./chat");

      conn.on("SendMessage", data => {
        $scope.$apply(() => {
          $scope.messages.unshift({
            name: data.name,
            raw: data.message,
            message: $scope.crypto.decrypt(data.message),
            date: moment(data.date).format('h:mm:ss a')
          });
        });
      });

      conn.on("SendAction", data => {
        console.log(data);
      });

      $scope.send = () => {
        var data = document.getElementById("message").value;
        conn.invoke("Send", { name: $scope.name, message: $scope.crypto.encrypt($scope.message), date: new Date() });
      };

      conn.start()
          .then(() => {
          console.log("Started");
      })
      .catch(err => {
          console.log("error")
      });
    };
  });

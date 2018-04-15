angular.module("chatApp", [])
  .config(['$compileProvider', function ($compileProvider) {
      $compileProvider.aHrefSanitizationWhitelist(/^\s*(https?|local|data|chrome-extension):/);
  }])
  .directive('fileModel', [
   '$parse',
   function ($parse) {
     return {
       restrict: 'A',
       link: function(scope, element, attrs) {
         var model = $parse(attrs.fileModel);
         var modelSetter = model.assign;

         element.bind('change', function(){
           scope.$apply(function(){
             if (attrs.multiple) {
               modelSetter(scope, element[0].files);
             }
             else {
               modelSetter(scope, element[0].files[0]);
             }
           });
         });
       }
     };
   }])
  .directive("fileRead", [function () {
      return {
          scope: {
              fileRead: "="
          },
          link: function (scope, element, attributes) {
              element.bind("change", function (changeEvent) {
                  var reader = new FileReader();
                  reader.onload = function (loadEvent) {
                      scope.$apply(function () {
                          scope.fileRead = loadEvent.target.result;
                      });
                  }
                  reader.readAsDataURL(changeEvent.target.files[0]);
              });

              scope.$watch(attributes.fileRead, function(file) {
                element.val(file);
              });
          }
      }
  }])
  .controller("chatCtrl", ["$scope", "$timeout", ($scope, $timeout) => {
    $scope.name = "";
    $scope.password = "";
    $scope.initialized = false;
    $scope.activeUserCount = 0;

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
          // Add to the head of array
          $scope.messages.unshift({
            name: data.name,
            raw: data.message,
            message: $scope.crypto.decrypt(data.message),
            date: moment(data.date).format('h:mm:ss a'),
            file: data.file ? { name: data.file.name, data: $scope.crypto.decrypt(data.file.data) } : null
          });
        });
      });

      conn.on("SendAction", (data, activeUserCount) => {
        $scope.$apply(() => $scope.activeUserCount = activeUserCount );
      });

      $scope.download = (base64, name) => {
        download(base64, name);
      };

      $scope.clean = () => {
        angular.element("input[type='file']").val(null);
        $scope.message = "";
        $scope.fileInfo = null;
        $scope.fileData = null;
      };

      $scope.validateBase64 = (base64) => {
        base64 = base64.split(',')[1];
        return new RegExp(/^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/).test(base64);
      };

      $scope.send = () => {
        var data = document.getElementById("message").value;

        if ($scope.fileInfo) {
          if (!$scope.fileData) {
            var errorMessage = "File is being converted to base64";
            alert(errorMessage);
            throw new Error(errorMessage);
          }

          $timeout(() => {
            conn.invoke("Send", {
              name: $scope.name,
              message: $scope.crypto.encrypt($scope.message),
              date: new Date(),
              file: {
                name: $scope.fileInfo.name,
                data: $scope.crypto.encrypt($scope.fileData)
              }
            });

          $scope.clean();

          }, 100);
        } else {
          conn.invoke("Send", {
            name: $scope.name,
            message: $scope.crypto.encrypt($scope.message),
            date: new Date()
          });

          $scope.clean();
        }
      };

      conn.start()
          .then(() => {
          console.log("Started");
      })
      .catch(err => {
          console.log("error")
      });
    };
  }]);

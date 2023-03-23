DOCKER=sudo docker
DOCKER_TAG= amir734jj/symmetric-crypto-chatroom

all: publish

.PHONY: build publish

build: Dockerfile
	$(DOCKER) build . -t $(DOCKER_TAG)

publish: build
	$(DOCKER) push $(DOCKER_TAG)

DOCKER=sudo docker
DOCKER_TAG= amir734jj/symmetric-crypto-chatroom

all: publish

.PHONY: build publish run

build: Dockerfile
	$(DOCKER) build . -t $(DOCKER_TAG)

publish: build
	$(DOCKER) push $(DOCKER_TAG)

run: build
	$(DOCKER) run -p 8080:80 -it --rm $(DOCKER_TAG)

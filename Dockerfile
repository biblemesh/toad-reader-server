# This file modified from https://gist.github.com/abstractvector/ed3f892ec0114e28b3d6dcdc4c39b1f2

ARG ALPINE_VERSION=3.21
ARG NODE_VERSION=gallium-alpine

##########################
# Cache-preserving image #
##########################

FROM alpine:${ALPINE_VERSION} AS deps

RUN apk --no-cache add jq

# prevent cache invalidation from changes in fields other than dependencies

COPY package.json .
COPY package-lock.json .

# override the current package version (arbitrarily set to 1.0.0) so it doesn't invalidate the build cache later

RUN (jq '{ dependencies, devDependencies }') < package.json > deps.json
RUN (jq '.version = "1.0.0"' | jq '.packages."".version = "1.0.0"') < package-lock.json > deps-lock.json

#################
# Builder image #
#################

FROM node:${NODE_VERSION} AS builder

WORKDIR /app

COPY --from=deps deps.json ./package.json
COPY --from=deps deps-lock.json ./package-lock.json

RUN npm clean-install

COPY package.json .

##################
# Docs generator #
##################
FROM dcycle/md2html:2 AS docs

WORKDIR /docs
COPY *.md .
RUN find *.md -exec sh -c 'pandoc -t html5 "{}" > $(basename "{}" .md).html' \;

#####################
# Development image #
#####################

FROM builder AS development
LABEL org.opencontainers.image.source="https://github.com/biblemesh/toad-reader-server"

COPY ./ ./

COPY --from=docs /docs/*.html docs/
RUN ln -sv ./docs/README.html index.html

HEALTHCHECK --interval=5s --timeout=10s --start-period=10s \
   CMD ["bash", "-c", "curl http://127.0.0.1:8080/ || exit 1"]

CMD ["npm", "start"]

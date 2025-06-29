# This file modified from https://gist.github.com/abstractvector/ed3f892ec0114e28b3d6dcdc4c39b1f2

ARG ALPINE_VERSION=3.21
ARG NODE_VERSION=16

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

FROM bitnami/node:${NODE_VERSION} AS builder

WORKDIR /app

COPY --from=deps deps.json ./package.json
COPY --from=deps deps-lock.json ./package-lock.json

RUN npm clean-install

COPY package.json .

#####################
# Development image #
#####################

# TODO switch to gcr.io/distroless after we upgrade to Node.js 18 (see ereader-callback Dockerfile)
FROM node:${NODE_VERSION}-slim AS development

ARG AUTHOR
ARG DATETIMENOW
ARG REVISION
ARG RUNTIME_NODE_TAG
ARG TAG_VERSION_NUMBER

# https://github.com/opencontainers/image-spec/blob/main/annotations.md
LABEL org.opencontainers.image.authors=${AUTHOR} \
  org.opencontainers.image.base.name="node:${NODE_VERSION}-slim" \
  org.opencontainers.image.created=${DATETIMENOW} \
  org.opencontainers.image.description="eReader" \
  org.opencontainers.image.source="https://github.com/biblemesh/toad-reader-server" \
  org.opencontainers.image.revision=${REVISION:-unspecified} \
  org.opencontainers.image.title="biblemesh/toad-reader-server" \
  org.opencontainers.image.vendor="BI Ltd" \
  org.opencontainers.image.version=${TAG_VERSION_NUMBER}

WORKDIR /app
COPY ./ ./

COPY --from=builder /app/node_modules ./node_modules
RUN echo "DEVELOPMENT index.html" > index.html

HEALTHCHECK --interval=60s --timeout=10s --start-period=10s \
   CMD ["node", "./healthcheck.js"]

CMD ["npm", "start"]

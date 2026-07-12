# Release builder image. Ubuntu 22.04 = glibc 2.35, the oldest floor we target: native
# modules (better-sqlite3, libsignal) link the builder's glibc, so artifacts built HERE
# run on Ubuntu 22.04+/Debian 12+/Fedora 36+. Building on a rolling host instead raises
# the floor silently (observed: host build demanded glibc 2.38 and broke Debian 12).
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git python3 make g++ \
      dpkg fakeroot rpm squashfs-tools zip unzip \
    && rm -rf /var/lib/apt/lists/*
# Node 22 (matches package.json engines) straight from nodejs.org — no distro repo drift.
ARG NODE_VERSION=22.22.1
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1
WORKDIR /build

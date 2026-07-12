#!/bin/bash
# Runs INSIDE the builder container (see make:linux:portable in package.json).
# Copies the repo (sans node_modules/out/.git) into the container-local /build,
# does a clean install + make there, and drops artifacts into the host-mounted
# /src/out. Never touches the host node_modules (its native builds target the host).
set -euo pipefail
cd /build
tar -C /src --exclude=./node_modules --exclude=./out --exclude=./.git -cf - . | tar -xf -
npm ci --no-audit --no-fund
npm run make:linux
rm -rf /src/out/make-portable
mkdir -p /src/out
cp -a out/make /src/out/make-portable
echo "[builder] portable artifacts → out/make-portable/"

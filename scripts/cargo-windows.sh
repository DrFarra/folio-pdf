#!/usr/bin/env bash
set -euo pipefail
folio_workspace="$(cd "$(dirname "$0")/../../.." && pwd)"
exec env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock run --rm \
  --mount "type=bind,src=${folio_workspace},dst=${folio_workspace}" \
  --mount type=bind,src=/etc/ssl/certs/ca-certificates.crt,dst=/etc/ssl/certs/ca-certificates.crt,readonly \
  --mount type=volume,src=folio-xwin-cache,dst=/root/.cache/cargo-xwin \
  --mount type=volume,src=folio-cargo-registry,dst=/usr/local/cargo/registry \
  -e CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt \
  -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
  -e XWIN_ACCEPT_LICENSE=1 \
  -e "FOLIO_UID=$(id -u)" -e "FOLIO_GID=$(id -g)" \
  -w "$PWD" folio-windows-build sh -c '
    folio_status=0
    cargo xwin "$@" || folio_status=$?
    chown -R "$FOLIO_UID:$FOLIO_GID" target Cargo.lock
    exit "$folio_status"
  ' sh "$@"

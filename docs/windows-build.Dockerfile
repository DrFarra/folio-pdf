# syntax=docker/dockerfile:1
FROM rust:slim-bookworm
RUN --mount=type=secret,id=ca_bundle,required=true \
    SSL_CERT_FILE=/run/secrets/ca_bundle CURL_CA_BUNDLE=/run/secrets/ca_bundle \
    apt-get update && apt-get install -y --no-install-recommends clang lld llvm nsis pkg-config libssl-dev curl ca-certificates make
RUN --mount=type=secret,id=ca_bundle,required=true \
    CARGO_HTTP_CAINFO=/run/secrets/ca_bundle cargo install cargo-xwin --locked
RUN --mount=type=secret,id=ca_bundle,target=/etc/ssl/certs/ca-certificates.crt,required=true \
    RUSTUP_USE_CURL=1 rustup target add x86_64-pc-windows-msvc

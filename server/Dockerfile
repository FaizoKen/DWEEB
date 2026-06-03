# syntax=docker/dockerfile:1

# ---- Build stage ------------------------------------------------------------
FROM rust:1-slim AS builder
WORKDIR /app

# Compile dependencies first against a stub main so this layer is cached and
# only re-runs when the manifest or lockfile changes — not on every source edit.
# Copying Cargo.lock and building with --locked pins the exact dependency
# versions CI resolves, so images are reproducible instead of drifting.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
 && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src

# Now build the real binary; cached dependency artifacts are reused.
COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

# ---- Runtime stage ----------------------------------------------------------
FROM debian:bookworm-slim
# Root certificates so the TLS client can verify discord.com.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/dweeb-proxy /usr/local/bin/dweeb-proxy

ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080
# Run unprivileged.
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/dweeb-proxy"]

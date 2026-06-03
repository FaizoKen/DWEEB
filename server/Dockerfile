# syntax=docker/dockerfile:1

# ---- Build stage ------------------------------------------------------------
FROM rust:1-slim AS builder
WORKDIR /app

# Compile dependencies first against a stub main so this layer is cached and
# only re-runs when Cargo.toml changes — not on every source edit.
COPY Cargo.toml ./
RUN mkdir src \
 && echo 'fn main() {}' > src/main.rs \
 && cargo build --release \
 && rm -rf src

# Now build the real binary; cached dependency artifacts are reused.
COPY src ./src
RUN touch src/main.rs && cargo build --release

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

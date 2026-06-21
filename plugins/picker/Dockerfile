# Build a tiny image for the Picker plugin.
# Multi-stage: compile in the Rust image, run on a slim Debian. This plugin
# makes NO outbound HTTP at all (a pick is answered straight from the
# interaction payload), so it needs no TLS client and no extra system libs —
# SQLite is bundled into the binary. CA certs are included only for parity with
# the other plugin images; nothing here dials out.

FROM rust:1-bookworm AS build
WORKDIR /app
# Cache deps first.
COPY Cargo.toml ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release || true
# Real sources.
COPY src ./src
COPY static ./static
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/dweeb-picker /usr/local/bin/dweeb-picker
# Persist the SQLite file outside the layer.
ENV DATABASE_PATH=/data/picker.db
VOLUME ["/data"]
EXPOSE 8097
CMD ["dweeb-picker"]

# Build a tiny image for the Quick Replies plugin.
# Multi-stage: compile in the Rust image, run on a slim Debian with just the
# CA certs reqwest needs for TLS to discord.com (the one optional call — listing
# roles for the gate picker). SQLite is bundled into the binary, so there's no
# system database dependency.

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
COPY --from=build /app/target/release/dweeb-quick-replies /usr/local/bin/dweeb-quick-replies
# Persist the SQLite file outside the layer.
ENV DATABASE_PATH=/data/quick-replies.db
VOLUME ["/data"]
EXPOSE 8096
CMD ["dweeb-quick-replies"]

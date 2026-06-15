# Build a tiny image for the Tickets plugin.
# Multi-stage: compile in the Rust image, run on a slim Debian with just the
# CA certs reqwest needs for TLS to discord.com. SQLite is bundled into the
# binary, so there's no system database dependency.

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
COPY --from=build /app/target/release/dweeb-tickets /usr/local/bin/dweeb-tickets
# Persist the SQLite file outside the layer.
ENV DATABASE_PATH=/data/tickets.db
VOLUME ["/data"]
EXPOSE 8093
CMD ["dweeb-tickets"]

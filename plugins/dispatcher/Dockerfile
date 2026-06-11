# Build a tiny image for the interactions dispatcher. Multi-stage: compile in
# the Rust image, run on a slim Debian with just the CA certs reqwest needs.

FROM rust:1-bookworm AS build
WORKDIR /app
# Cache deps first.
COPY Cargo.toml ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release || true
# Real sources.
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/dweeb-interactions-dispatcher /usr/local/bin/dweeb-interactions-dispatcher
# Per-guild permanent-message slots live in one SQLite file (rusqlite is
# bundled, no system libsqlite needed). Mount /data to persist them.
ENV DATABASE_PATH=/data/dispatcher.db
VOLUME ["/data"]
EXPOSE 8095
CMD ["dweeb-interactions-dispatcher"]

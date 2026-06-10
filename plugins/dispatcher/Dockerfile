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
EXPOSE 8095
CMD ["dweeb-interactions-dispatcher"]

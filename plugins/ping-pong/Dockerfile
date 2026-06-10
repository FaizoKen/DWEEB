# Build a tiny image for the Ping Pong plugin. Multi-stage: compile in the
# Rust image, run on a slim Debian with just CA certs. No database — the
# plugin is fully stateless (config travels inside the custom_id).

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
COPY --from=build /app/target/release/dweeb-ping-pong /usr/local/bin/dweeb-ping-pong
EXPOSE 8091
CMD ["dweeb-ping-pong"]

FROM rust:1.85.1-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates pkg-config libfuse3-dev libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY .cargo .cargo
COPY core core
COPY sdk/js sdk/js
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --manifest-path core/Cargo.toml --locked --release --jobs 2 \
      -p layerfs-node -p layerfs-daemon

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git fuse3 libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/core/target/release/layerfs-daemon /opt/layerfs/layerfs-daemon
COPY --from=build /src/core/target/release/liblayerfs_node.so /opt/layerfs/sdk/js/native/layerfs.node
COPY sdk/js/src /opt/layerfs/sdk/js/src
COPY sdk/js/package.json /opt/layerfs/sdk/js/package.json
LABEL org.opencontainers.image.source="https://github.com/Ephemeral-AI-Lab/layerfs" \
      org.opencontainers.image.revision="e7713d034b029c358c657959b7737e8d23c9d1e7" \
      io.rakazo.purpose="layerfs-native-smoke"
WORKDIR /work
ENV LAYERFS_SDK_MODULE=/opt/layerfs/sdk/js/src/index.js \
    LAYERFS_DAEMON=/opt/layerfs/layerfs-daemon \
    LAYERFS_HOME=/work/layerfs-home \
    LAYERFS_DOCKER=/var/run/docker.sock \
    LAYERFS_CONSTRUCTION_WORKERS=1
CMD ["node", "/smoke/layerfs-native-smoke.mjs"]

FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y curl wget ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Standalone build path. The service node does not use this file — it builds from the
# inline template in src/services/docker.ts. Keep the default in sync with
# DEFAULT_TELEMT_VERSION in src/config.ts; override with --build-arg TELEMT_VERSION=X.Y.Z.
ARG TELEMT_VERSION=3.5.2

RUN wget -qO- "https://github.com/telemt/telemt/releases/download/${TELEMT_VERSION}/telemt-x86_64-linux-gnu.tar.gz" | tar -xz -C /usr/local/bin/ && \
    chmod +x /usr/local/bin/telemt

RUN useradd -r -s /bin/false telemt && \
    mkdir -p /etc/telemt /opt/telemt && \
    chown -R telemt:telemt /etc/telemt /opt/telemt

WORKDIR /opt/telemt

USER telemt

ENV RUST_LOG=info

CMD ["/usr/local/bin/telemt", "/etc/telemt/config.toml"]

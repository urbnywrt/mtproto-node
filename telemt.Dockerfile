FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y curl wget ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Keep this version in sync with TELEMT_VERSION in src/config.ts.
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

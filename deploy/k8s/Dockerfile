FROM node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash bzip2 ca-certificates curl fuse3 g++ make openssl python3 tini util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@10.34.5

ARG TARGETARCH
ARG KUBECTL_VERSION=v1.35.7
ARG KUBECTL_SHA256_AMD64=12e97f9d23a9f6cbb87b89becd6bd291e1a858a3379a4e11e2c822c4c1530052
ARG KUBECTL_SHA256_ARM64=5103d45b8881434d417694057b8ccb5ae79fd310a5c5c13e403c5e62e15909be
RUN test "$(dpkg --print-architecture)" = "$TARGETARCH" \
 && case "$TARGETARCH" in amd64) checksum="$KUBECTL_SHA256_AMD64" ;; arm64) checksum="$KUBECTL_SHA256_ARM64" ;; *) exit 2 ;; esac \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
 && echo "${checksum}  /usr/local/bin/kubectl" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/kubectl

ARG GOCRYPTFS_VERSION=2.6.1
ARG GOCRYPTFS_SHA256_AMD64=49b8c0eb0f6373b6ac99c394a52909d8478e74c08d0961527c1162967cc28c44
ARG GOCRYPTFS_SHA256_ARM64=64576d550ab8af3f1dc729e93779540c5ecc00967d0185aae51a29a3755d86d0
ARG RESTIC_VERSION=0.18.1
ARG RESTIC_SHA256_AMD64=680838f19d67151adba227e1570cdd8af12c19cf1735783ed1ba928bc41f363d
ARG RESTIC_SHA256_ARM64=87f53fddde38764095e9c058a3b31834052c37e5826d2acf34e18923c006bd45
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) gocryptfs_sha="$GOCRYPTFS_SHA256_AMD64"; restic_sha="$RESTIC_SHA256_AMD64" ;; \
      arm64) gocryptfs_sha="$GOCRYPTFS_SHA256_ARM64"; restic_sha="$RESTIC_SHA256_ARM64" ;; \
      *) exit 2 ;; \
    esac; \
    curl -fsSLo /tmp/gocryptfs.tar.gz "https://github.com/rfjakob/gocryptfs/releases/download/v${GOCRYPTFS_VERSION}/gocryptfs_v${GOCRYPTFS_VERSION}_linux-static_${arch}.tar.gz"; \
    echo "$gocryptfs_sha  /tmp/gocryptfs.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gocryptfs.tar.gz -C /usr/local/bin gocryptfs; \
    curl -fsSLo /tmp/restic.bz2 "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${arch}.bz2"; \
    echo "$restic_sha  /tmp/restic.bz2" | sha256sum -c -; \
    bunzip2 /tmp/restic.bz2; \
    install -m 0755 /tmp/restic /usr/local/bin/restic; \
    rm -f /tmp/gocryptfs.tar.gz /tmp/restic; \
    gocryptfs -version; \
    restic version; \
    flock --version

RUN groupadd --gid 10001 nanoclaw \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/nanoclaw --shell /bin/sh nanoclaw \
 && install -d -o 10001 -g 10001 /opt/nanoclaw /opt/nanoclaw/bootstrap

WORKDIR /opt/nanoclaw
COPY --chown=10001:10001 package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./
COPY --chown=10001:10001 src/ ./src/
COPY --chown=10001:10001 bin/ ./bin/
COPY --chown=10001:10001 scripts/ ./scripts/
COPY --chown=10001:10001 container/ ./container/
COPY --chown=10001:10001 templates/ ./templates/
COPY --chown=10001:10001 deploy/k8s/ ./deploy/k8s/
RUN chmod -R a+rX /opt/nanoclaw/src /opt/nanoclaw/scripts
RUN chmod 0755 /opt/nanoclaw/deploy/k8s/entrypoint.sh

# @types/better-sqlite3 7.6.13 models the default import as the database
# instance type directly. Older NanoClaw source spells it as the removed
# Database.Database namespace member. This is type-only and becomes a no-op
# once upstream adopts the direct type spelling.
RUN sed -i 's/Database\.Database/Database/g' \
      src/db/drivers/sqlite.ts src/mailbox/sqlite/session-db.ts \
 && ! grep -R 'Database\.Database' \
      src/db/drivers/sqlite.ts src/mailbox/sqlite/session-db.ts

USER 10001:10001
RUN HUSKY=0 pnpm install --frozen-lockfile \
 && pnpm run build \
 && test -f dist/index.js \
 && node -e "const fs=require('fs');const p=require('./package.json');fs.writeFileSync('/opt/nanoclaw/bootstrap/upgrade-state.json',JSON.stringify({version:p.version,commit:'unknown',tree:'unknown',updatedAt:new Date().toISOString(),via:'nanoco-recipes-host-image'},null,2)+'\\n')"

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/nanoclaw/deploy/k8s/entrypoint.sh"]

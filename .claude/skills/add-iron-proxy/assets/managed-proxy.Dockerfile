FROM rust:1.93.0-alpine AS approval-summary
WORKDIR /summary
COPY _approval-summary/ ./
RUN cargo test --locked && cargo build --release --locked

FROM golang:1.26.1-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go test ./cmd/iron-proxy ./internal/config ./internal/transform/grpc
RUN cd _front-proxy && go test -mod=readonly ./... && CGO_ENABLED=0 go build -mod=readonly -trimpath -o /out/nanoclaw-iron-front .
RUN CGO_ENABLED=0 go build -trimpath -o /out/iron-proxy ./cmd/iron-proxy
FROM alpine:3.22
RUN apk add --no-cache ca-certificates openssl
COPY --from=build /out/iron-proxy /usr/local/bin/iron-proxy
COPY --from=approval-summary /summary/target/release/gateway-approval-summary /usr/local/bin/gateway-approval-summary
COPY --from=approval-summary /summary/LICENSE.onecli /usr/share/licenses/onecli-summary/LICENSE
COPY --from=build /out/nanoclaw-iron-front /usr/local/bin/nanoclaw-iron-front
COPY --chmod=755 _entrypoint.sh /usr/local/bin/nanoclaw-iron-entrypoint
ENTRYPOINT ["nanoclaw-iron-entrypoint"]

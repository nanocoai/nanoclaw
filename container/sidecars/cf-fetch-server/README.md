# cf-fetch-server

Container-local Cloudflare-bypass fetch sidecar for NanoClaw v2.

The Docker image copies this directory to `/opt/cf-fetch-server`, and
`/app/entrypoint.sh` starts `server.py` before the agent runner. The web-fetch
skill talks to it through `CF_FETCH_SIDECAR_URL`, which defaults to
`http://127.0.0.1:8765`.

## Runtime Contract

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness and backend status probe. |
| `POST` | `/fetch` | JSON body `{url, timeout?, headers?}` to fetch through nodriver. |
| `GET` | `/fetch?url=...` | Curl-friendly probe form. |

Default bind address is loopback only:

```bash
CF_FETCH_SERVER_HOST=127.0.0.1
CF_FETCH_SERVER_PORT=8765
```

`nodriver` and `pyvirtualdisplay` are installed in the NanoClaw Docker image.
If they are unavailable, the sidecar keeps serving a structured `backend=stub`
response so the wrapper receives a stable envelope instead of a connection
failure.

## Proxy Credentials

`HTTP_PROXY_URL` may be injected into the container from the host secret store.
The container runner passes it as a key-only env passthrough, so the raw secret
value is not embedded in the Docker command arguments or image layers.

The sidecar strips credentials from the Chromium `--proxy-server` argument and
supplies proxy auth through the Chrome DevTools Protocol. Health responses and
logs only expose a redacted proxy descriptor.

## Useful Local Checks

```bash
python3 -m unittest test_server -v
CF_FETCH_SERVER_PORT=18765 CF_FETCH_SERVER_WATCHDOG_INTERVAL=0 python3 server.py
curl -fsS http://127.0.0.1:18765/healthz
```

Inside the full image, the entrypoint owns startup and cleanup:

```bash
CF_FETCH_SIDECAR_ENABLED=1
CF_FETCH_SIDECAR_URL=http://127.0.0.1:8765
```

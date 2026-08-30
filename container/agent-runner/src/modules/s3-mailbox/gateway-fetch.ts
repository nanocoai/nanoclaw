export interface MailboxFetch {
  /** Production session transport binds exactly one Host-minted capability
   * before any S3 request. Constructor-injected memory transports may omit it. */
  bindCapability?(capability: string): void;
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

type ProxyRequestInit = RequestInit & { proxy: string };
type ProxyFetch = (input: string, init: ProxyRequestInit) => Promise<Response>;

const AWS_AUTH_HEADERS = [
  "authorization",
  "x-amz-content-sha256",
  "x-amz-date",
  "x-amz-security-token",
] as const;
const STORAGE_CAPABILITY_HEADER = "x-nanoco-scope-storage-capability";

/**
 * The runner is not an AWS principal. It sends one unsigned HTTPS request
 * through the loopback session sidecar; Gateway owns policy, workload identity,
 * SigV4, and upstream TLS.
 */
export function gatewayUnsignedFetch(
  proxyValue: string | undefined,
  fetch_: ProxyFetch = fetch as unknown as ProxyFetch,
): MailboxFetch {
  const proxy = loopbackProxy(proxyValue);
  let capability: string | undefined;
  return {
    bindCapability(value) {
      if (!/^[a-f0-9]{64}$/.test(value)) {
        throw new Error("Gateway mailbox transport requires a valid session capability");
      }
      if (capability !== undefined && capability !== value) {
        throw new Error("Gateway mailbox transport cannot change session capability");
      }
      capability = value;
    },
    async fetch(input, init = {}) {
      if (!capability) {
        throw new Error("Gateway mailbox transport is not bound to a session capability");
      }
      const target = new URL(input);
      if (target.protocol !== "https:" || target.username || target.password || target.hash) {
        throw new Error("S3 mailbox target must be credential-free HTTPS without a fragment");
      }

      const headers = new Headers(init.headers);
      for (const name of AWS_AUTH_HEADERS) {
        if (headers.has(name)) {
          throw new Error(`S3 mailbox runner must not supply AWS authentication header ${name}`);
        }
      }
      if (headers.has(STORAGE_CAPABILITY_HEADER)) {
        throw new Error("S3 mailbox runner must not supply its Gateway capability header");
      }
      headers.set(STORAGE_CAPABILITY_HEADER, capability);
      return fetch_(target.toString(), { ...init, headers, proxy });
    },
  };
}

function loopbackProxy(value: string | undefined): string {
  if (!value) throw new Error("S3 mailbox runner requires the session HTTPS_PROXY");
  const proxy = new URL(value);
  const loopback = proxy.hostname === "127.0.0.1" || proxy.hostname === "[::1]";
  if (
    proxy.protocol !== "http:" ||
    !loopback ||
    !proxy.port ||
    proxy.username ||
    proxy.password ||
    proxy.pathname !== "/" ||
    proxy.search ||
    proxy.hash
  ) {
    throw new Error("S3 mailbox runner HTTPS_PROXY must be a credential-free loopback HTTP origin");
  }
  return proxy.origin;
}

import { describe, expect, test } from "bun:test";

import { gatewayUnsignedFetch } from "./gateway-fetch.js";

describe("Gateway-owned S3 mailbox transport", () => {
  test("sends unsigned HTTPS through only the loopback session proxy", async () => {
    const seen: Array<{ input: string; init: RequestInit & { proxy: string } }> = [];
    const transport = gatewayUnsignedFetch(
      "http://127.0.0.1:15001",
      async (input, init) => {
        seen.push({ input, init });
        return new Response("ok");
      },
    );
    transport.bindCapability?.("a".repeat(64));

    await transport.fetch("https://s3.us-east-1.amazonaws.com/mailbox/object.json", {
      method: "PUT",
      body: "{}",
      headers: { "content-type": "application/json", "if-none-match": "*" },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].init.proxy).toBe("http://127.0.0.1:15001");
    const headers = new Headers(seen[0].init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("if-none-match")).toBe("*");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-amz-security-token")).toBe(false);
    expect(headers.get("x-nanoco-scope-storage-capability")).toBe("a".repeat(64));
  });

  test("refuses every direct or credential-bearing transport shape", async () => {
    for (const proxy of [
      undefined,
      "http://169.254.169.254:80",
      "http://sidecar.system.svc:15001",
      "http://user:secret@127.0.0.1:15001",
      "https://127.0.0.1:15001",
      "http://127.0.0.1:15001/path",
    ]) {
      expect(() => gatewayUnsignedFetch(proxy)).toThrow();
    }

    const transport = gatewayUnsignedFetch("http://127.0.0.1:15001", async () => new Response());
    await expect(
      transport.fetch("https://s3.us-east-1.amazonaws.com/bucket/key"),
    ).rejects.toThrow("not bound to a session capability");
    expect(() => transport.bindCapability?.("wrong")).toThrow("valid session capability");
    transport.bindCapability?.("a".repeat(64));
    expect(() => transport.bindCapability?.("b".repeat(64))).toThrow("cannot change");
    await expect(transport.fetch("http://s3.us-east-1.amazonaws.com/bucket/key")).rejects.toThrow(
      "credential-free HTTPS",
    );
    await expect(
      transport.fetch("https://s3.us-east-1.amazonaws.com/bucket/key", {
        headers: { authorization: "AWS4-HMAC-SHA256 forbidden" },
      }),
    ).rejects.toThrow("must not supply AWS authentication header authorization");
    await expect(
      transport.fetch("https://s3.us-east-1.amazonaws.com/bucket/key", {
        headers: { "x-amz-security-token": "forbidden" },
      }),
    ).rejects.toThrow("must not supply AWS authentication header x-amz-security-token");
    await expect(
      transport.fetch("https://s3.us-east-1.amazonaws.com/bucket/key", {
        headers: { "x-nanoco-scope-storage-capability": "a".repeat(64) },
      }),
    ).rejects.toThrow("must not supply its Gateway capability header");
  });
});

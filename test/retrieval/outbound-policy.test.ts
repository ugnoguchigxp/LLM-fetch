import { describe, expect, it } from "vitest";
import {
  isPublicIpAddress,
  resolveSafeOutboundUrl,
} from "../../src/retrieval/outbound-policy.js";

describe("outbound URL policy", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "2001:2::1",
    "2001:20::1",
    "2002:7f00:1::",
    "3fff::1",
    "not-an-ip",
  ])("blocks non-public address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );

  it.each([
    "file:///etc/passwd",
    "http://localhost/admin",
    "http://service.local/status",
    "http://user:password@example.com/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://example.com:8080/",
    "https://example.com:8443/",
    "not a url",
  ])("rejects unsafe URL %s", async (url) => {
    await expect(resolveSafeOutboundUrl(url)).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });

  it("rejects the entire hostname if one DNS answer is private", async () => {
    await expect(
      resolveSafeOutboundUrl("https://example.com", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });

  it("returns validated addresses for connection pinning", async () => {
    await expect(
      resolveSafeOutboundUrl("https://example.com/path", async () => [
        { address: "93.184.216.34", family: 4 },
      ]),
    ).resolves.toMatchObject({
      url: new URL("https://example.com/path"),
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });
  });

  it("blocks the local home.arpa namespace before DNS resolution", async () => {
    let called = false;
    await expect(
      resolveSafeOutboundUrl("https://router.home.arpa/", async () => {
        called = true;
        return [{ address: "93.184.216.34", family: 4 }];
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
    expect(called).toBe(false);
  });

  it("bounds custom resolver output", async () => {
    await expect(
      resolveSafeOutboundUrl("https://example.com/", async () =>
        Array.from({ length: 65 }, () => ({
          address: "93.184.216.34",
          family: 4 as const,
        }))),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });

  it("rejects malformed custom resolver output", async () => {
    await expect(
      resolveSafeOutboundUrl(
        "https://example.com/",
        async () => [{ address: "93.184.216.34", family: 5 }] as never,
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });
});

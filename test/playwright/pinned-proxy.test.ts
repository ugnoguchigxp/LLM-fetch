import net from "node:net";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPinnedProxy,
  type PinnedProxy,
} from "../../src/playwright/pinned-proxy.js";

const proxies: PinnedProxy[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

function connectRequest(
  server: string,
  request: string,
): Promise<string> {
  const url = new URL(server);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname);
    const chunks: Buffer[] = [];
    socket.setTimeout(2_000, () => socket.destroy(new Error("socket timeout")));
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
  });
}

describe("Playwright pinned proxy", () => {
  it("requires proxy authentication", async () => {
    const proxy = await createPinnedProxy({
      connectTimeoutMs: 1_000,
      maxResponseBytes: 1_000_000,
    });
    proxies.push(proxy);

    const response = await connectRequest(
      proxy.server,
      "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
    );

    expect(response).toContain("407 Proxy Authentication Required");
  });

  it("rejects a CONNECT target that resolves to a private address", async () => {
    const proxy = await createPinnedProxy({
      connectTimeoutMs: 1_000,
      maxResponseBytes: 1_000_000,
      async resolver() {
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    proxies.push(proxy);
    const authorization = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");

    const response = await connectRequest(
      proxy.server,
      "CONNECT attacker.example:443 HTTP/1.1\r\n" +
        "Host: attacker.example:443\r\n" +
        `Proxy-Authorization: Basic ${authorization}\r\n\r\n`,
    );

    expect(response).toContain("403 Forbidden");
  });

  it("rejects a body on an otherwise allowed GET request", async () => {
    const proxy = await createPinnedProxy({
      connectTimeoutMs: 1_000,
      maxResponseBytes: 1_000_000,
      async resolver() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    });
    proxies.push(proxy);
    const authorization = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");

    const response = await connectRequest(
      proxy.server,
      "GET http://example.com/ HTTP/1.1\r\n" +
        "Host: example.com\r\n" +
        `Proxy-Authorization: Basic ${authorization}\r\n` +
        "Content-Length: 1\r\n\r\nx",
    );

    expect(response).toContain("400 Bad Request");
  });

  it("validates resource limits before starting a proxy", async () => {
    await expect(createPinnedProxy({
      connectTimeoutMs: 0,
      maxResponseBytes: 1_000_000,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("bounds a resolver that does not settle", async () => {
    const proxy = await createPinnedProxy({
      connectTimeoutMs: 100,
      maxResponseBytes: 1_000_000,
      async resolver() {
        return new Promise(() => undefined);
      },
    });
    proxies.push(proxy);
    const authorization = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");

    const response = await connectRequest(
      proxy.server,
      "CONNECT example.com:443 HTTP/1.1\r\n" +
        "Host: example.com:443\r\n" +
        `Proxy-Authorization: Basic ${authorization}\r\n\r\n`,
    );

    expect(response).toContain("502 Bad Gateway");
  });

  it("shares one close operation across concurrent callers", async () => {
    const proxy = await createPinnedProxy({
      connectTimeoutMs: 1_000,
      maxResponseBytes: 1_000_000,
    });
    const first = proxy.close();
    const second = proxy.close();
    expect(first).toBe(second);
    await Promise.all([first, second]);
  });
});

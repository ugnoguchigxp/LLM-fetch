import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import net, { type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { LlmFetchError } from "../errors.js";
import { waitWithSignal } from "../internal/abort-signal.js";
import {
  defaultAddressResolver,
  resolveSafeOutboundUrl,
  type AddressResolver,
  type ResolvedAddress,
} from "../retrieval/outbound-policy.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface PinnedProxyOptions {
  resolver?: AddressResolver;
  connectTimeoutMs: number;
  maxResponseBytes: number;
}

export interface PinnedProxy {
  server: string;
  username: string;
  password: string;
  close(): Promise<void>;
}

function proxyAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function publicHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const connectionTokens = String(headers.connection ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...connectionTokens]);
  const result: Record<string, string | string[]> = {};
  let count = 0;
  let totalLength = 0;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (blocked.has(name) || rawValue === undefined) continue;
    count += 1;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    totalLength +=
      name.length + values.reduce((total, value) => total + value.length, 0);
    if (
      count > 100 ||
      totalLength > 64 * 1024 ||
      values.some((value) => value.length > 16_384)
    ) {
      throw new LlmFetchError(
        "UPSTREAM_HTTP",
        "Proxy headers exceeded the safety limit.",
      );
    }
    result[name] = Array.isArray(rawValue) ? [...rawValue] : rawValue;
  }
  return result;
}

function sendProxyAuthenticationRequired(
  response: ServerResponse | Socket,
): void {
  if ("writeHead" in response) {
    response.writeHead(407, {
      "proxy-authenticate": 'Basic realm="llm-fetch"',
    });
    response.end();
    return;
  }
  response.end(
    "HTTP/1.1 407 Proxy Authentication Required\r\n" +
      'Proxy-Authenticate: Basic realm="llm-fetch"\r\n' +
      "Connection: close\r\n\r\n",
  );
}

function sendSocketError(
  socket: Socket | Duplex,
  status: 400 | 403 | 502,
): void {
  const message =
    status === 403
      ? "Forbidden"
      : status === 502
        ? "Bad Gateway"
        : "Bad Request";
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
}

function requestPath(url: URL): string {
  return `${url.pathname || "/"}${url.search}`;
}

function firstAddress(addresses: readonly ResolvedAddress[]): ResolvedAddress {
  const address = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  if (!address) {
    throw new LlmFetchError(
      "UNSAFE_URL",
      "The proxy target resolved to no addresses.",
    );
  }
  return address;
}

export async function createPinnedProxy(
  options: PinnedProxyOptions,
): Promise<PinnedProxy> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Pinned proxy options must be an object.",
    );
  }
  const resolver = options.resolver ?? defaultAddressResolver;
  if (typeof resolver !== "function") {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Pinned proxy resolver must be a function.",
    );
  }
  if (
    !Number.isInteger(options.connectTimeoutMs) ||
    options.connectTimeoutMs < 100 ||
    options.connectTimeoutMs > 60_000
  ) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Pinned proxy connectTimeoutMs must be an integer between 100 and 60000.",
    );
  }
  if (
    !Number.isInteger(options.maxResponseBytes) ||
    options.maxResponseBytes < 1 ||
    options.maxResponseBytes > 50_000_000
  ) {
    throw new LlmFetchError(
      "INVALID_INPUT",
      "Pinned proxy maxResponseBytes must be an integer between 1 and 50000000.",
    );
  }
  const username = "llm-fetch";
  const password = randomBytes(24).toString("base64url");
  const expectedAuthorization = proxyAuthorization(username, password);
  const sockets = new Set<Socket>();
  let closePromise: Promise<void> | undefined;

  const isAuthorized = (headers: IncomingHttpHeaders) => {
    const actual = headers["proxy-authorization"];
    return (
      typeof actual === "string" &&
      constantTimeEqual(actual, expectedAuthorization)
    );
  };

  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      if (!isAuthorized(request.headers)) {
        sendProxyAuthenticationRequired(response);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { connection: "close" });
        response.end();
        return;
      }
      const contentLength = request.headers["content-length"];
      if (
        request.headers["transfer-encoding"] !== undefined ||
        (contentLength !== undefined && contentLength !== "0")
      ) {
        response.writeHead(400, { connection: "close" });
        response.end();
        return;
      }
      const rawUrl = request.url ?? "";
      if (!/^https?:\/\//iu.test(rawUrl)) {
        response.writeHead(400, { connection: "close" });
        response.end();
        return;
      }
      const resolved = await waitWithSignal(
        resolveSafeOutboundUrl(rawUrl, resolver),
        AbortSignal.timeout(options.connectTimeoutMs),
      );
      if (response.destroyed) return;
      if (resolved.url.protocol !== "http:") {
        response.writeHead(400, { connection: "close" });
        response.end();
        return;
      }
      const pinnedAddress = firstAddress(resolved.addresses);
      const headers = publicHeaders(request.headers);
      headers.host = resolved.url.host;
      const upstream = http.request(
        {
          host: pinnedAddress.address,
          family: pinnedAddress.family,
          port: 80,
          method: request.method,
          path: requestPath(resolved.url),
          headers,
          agent: false,
        },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode ?? 502;
          const rawContentLength = upstreamResponse.headers["content-length"];
          if (
            status < 200 ||
            status > 599 ||
            Array.isArray(rawContentLength) ||
            (rawContentLength !== undefined &&
              (!/^\d+$/u.test(rawContentLength) ||
                !Number.isSafeInteger(Number(rawContentLength)) ||
                Number(rawContentLength) > options.maxResponseBytes))
          ) {
            upstreamResponse.destroy();
            response.writeHead(502, { connection: "close" });
            response.end();
            return;
          }
          let receivedBytes = 0;
          let responseHeaders: Record<string, string | string[]>;
          try {
            responseHeaders = publicHeaders(upstreamResponse.headers);
          } catch {
            upstreamResponse.destroy();
            response.destroy();
            return;
          }
          response.writeHead(status, responseHeaders);
          upstreamResponse.on("data", (chunk: Buffer) => {
            receivedBytes += chunk.length;
            if (receivedBytes > options.maxResponseBytes) {
              upstreamResponse.destroy();
              response.destroy();
            }
          });
          upstreamResponse.once("error", () => response.destroy());
          upstreamResponse.pipe(response);
        },
      );
      request.once("aborted", () => upstream.destroy());
      response.once("close", () => {
        if (!response.writableEnded) upstream.destroy();
      });
      upstream.on("socket", trackSocket);
      upstream.setTimeout(options.connectTimeoutMs, () => upstream.destroy());
      upstream.once("error", () => {
        if (!response.headersSent)
          response.writeHead(502, { connection: "close" });
        response.end();
      });
      upstream.end();
    })().catch((error: unknown) => {
      const status =
        error instanceof LlmFetchError && error.code === "UNSAFE_URL"
          ? 403
          : 502;
      if (!response.headersSent)
        response.writeHead(status, { connection: "close" });
      response.end();
    });
  });

  server.on("connection", trackSocket);
  server.on(
    "connect",
    (request: IncomingMessage, clientSocket: Socket, head: Buffer) => {
      void (async () => {
        if (!isAuthorized(request.headers)) {
          sendProxyAuthenticationRequired(clientSocket);
          return;
        }
        const authority = request.url ?? "";
        if (!authority || /[@/?#]/u.test(authority)) {
          sendSocketError(clientSocket, 400);
          return;
        }
        let target: URL;
        try {
          target = new URL(`https://${authority}/`);
        } catch {
          sendSocketError(clientSocket, 400);
          return;
        }
        const resolved = await waitWithSignal(
          resolveSafeOutboundUrl(target.toString(), resolver),
          AbortSignal.timeout(options.connectTimeoutMs),
        );
        if (clientSocket.destroyed) return;
        const pinnedAddress = firstAddress(resolved.addresses);
        const upstreamSocket = trackSocket(
          net.connect({
            host: pinnedAddress.address,
            family: pinnedAddress.family,
            port: 443,
          }),
        );
        let receivedBytes = 0;
        let sentBytes = head.length;
        upstreamSocket.setTimeout(options.connectTimeoutMs, () =>
          upstreamSocket.destroy(),
        );
        upstreamSocket.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > options.maxResponseBytes) {
            upstreamSocket.destroy();
            clientSocket.destroy();
          }
        });
        clientSocket.on("data", (chunk: Buffer) => {
          sentBytes += chunk.length;
          if (sentBytes > 512 * 1024) {
            upstreamSocket.destroy();
            clientSocket.destroy();
          }
        });
        upstreamSocket.once("connect", () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstreamSocket.write(head);
          clientSocket.pipe(upstreamSocket);
          upstreamSocket.pipe(clientSocket);
        });
        upstreamSocket.once("error", () => {
          if (!clientSocket.destroyed) sendSocketError(clientSocket, 502);
        });
        clientSocket.once("error", () => upstreamSocket.destroy());
        clientSocket.once("close", () => upstreamSocket.destroy());
      })().catch((error: unknown) => {
        sendSocketError(
          clientSocket,
          error instanceof LlmFetchError && error.code === "UNSAFE_URL"
            ? 403
            : 502,
        );
      });
    },
  );
  server.on("clientError", (_error, socket) => sendSocketError(socket, 400));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new LlmFetchError(
      "CONFIG_MISSING",
      "The pinned browser proxy could not start.",
    );
  }
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });

  return {
    server: `http://127.0.0.1:${address.port}`,
    username,
    password,
    close() {
      closePromise ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closePromise;
    },
  };
}

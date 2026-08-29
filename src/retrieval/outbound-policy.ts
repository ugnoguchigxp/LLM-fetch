import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { LlmFetchError } from "../errors.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (
    !octets.every(
      (octet, index) =>
        Number.isInteger(octet) &&
        octet >= 0 &&
        octet <= 255 &&
        String(octet) === parts[index],
    )
  ) {
    return null;
  }
  return octets as [number, number, number, number];
}

function isPublicIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b, c] = octets;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 31 && c === 196) return false;
  if (a === 192 && b === 52 && c === 193) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 175 && c === 48) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  const firstPart = normalized.split(":", 1)[0];
  if (!firstPart) return false;
  const firstHextet = Number.parseInt(firstPart, 16);
  if (!Number.isInteger(firstHextet) || firstHextet < 0x2000 || firstHextet > 0x3fff) {
    return false;
  }
  return !RESERVED_IPV6.check(normalized, "ipv6");
}

const RESERVED_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 32], // Teredo
  ["2001:2::", 48], // benchmarking
  ["2001:10::", 28], // deprecated ORCHID
  ["2001:20::", 28], // ORCHIDv2
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 can tunnel to an otherwise blocked IPv4 target
  ["3fff::", 20], // documentation
] as const) {
  RESERVED_IPV6.addSubnet(network, prefix, "ipv6");
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

export const defaultAddressResolver: AddressResolver = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

function unsafe(message: string, url?: string): LlmFetchError {
  const options = url === undefined ? {} : { url };
  return new LlmFetchError("UNSAFE_URL", message, options);
}

export async function resolveSafeOutboundUrl(
  rawUrl: string,
  resolver: AddressResolver = defaultAddressResolver,
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  if (typeof rawUrl !== "string" || !rawUrl.trim() || rawUrl.length > 2_048) {
    throw unsafe("URL must contain between 1 and 2048 characters.");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw unsafe("URL is invalid.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw unsafe("Only HTTP and HTTPS URLs can be retrieved.", rawUrl);
  }
  if (url.username || url.password) {
    throw unsafe("URLs containing credentials are not allowed.", rawUrl);
  }
  const expectedPort = url.protocol === "https:" ? 443 : 80;
  const effectivePort = Number(url.port || expectedPort);
  if (effectivePort !== expectedPort) {
    throw unsafe("Only standard HTTP and HTTPS ports are allowed.", rawUrl);
  }

  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "home.arpa" ||
    hostname.endsWith(".home.arpa")
  ) {
    throw unsafe("Local network hostnames are not allowed.", rawUrl);
  }

  const literalFamily = isIP(hostname);
  let addresses: ResolvedAddress[];
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await resolver(hostname);
  } catch (error) {
    throw new LlmFetchError("UNSAFE_URL", "The URL hostname could not be resolved.", {
      url: rawUrl,
      cause: error,
      retryable: true,
    });
  }

  if (!Array.isArray(addresses)) {
    throw unsafe("The URL hostname resolver returned an invalid result.", rawUrl);
  }
  if (addresses.length === 0) {
    throw unsafe("The URL hostname resolved to no addresses.", rawUrl);
  }
  if (addresses.length > 64) {
    throw unsafe("The URL hostname resolved to too many addresses.", rawUrl);
  }
  for (const entry of addresses) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.address !== "string" ||
      (entry.family !== 4 && entry.family !== 6) ||
      isIP(entry.address) !== entry.family ||
      !isPublicIpAddress(entry.address)
    ) {
      throw unsafe("Private or reserved network destinations are not allowed.", rawUrl);
    }
  }

  return { url, addresses };
}

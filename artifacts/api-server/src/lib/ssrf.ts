import * as dns from "node:dns/promises";

const PRIVATE_CIDRS: Array<[number, number]> = [
  [0x7f000000, 0xff000000],  // 127.0.0.0/8   loopback
  [0x0a000000, 0xff000000],  // 10.0.0.0/8
  [0xac100000, 0xfff00000],  // 172.16.0.0/12
  [0xc0a80000, 0xffff0000],  // 192.168.0.0/16
  [0xa9fe0000, 0xffff0000],  // 169.254.0.0/16  link-local + AWS metadata
  [0xc0000000, 0xffffff00],  // 192.0.0.0/24  IANA special
  [0x00000000, 0xff000000],  // 0.0.0.0/8
];
const BLOCKED_HOSTNAMES = new Set(["localhost"]);
const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".corp", ".home"];

export function isPrivateIp(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => p >= 0 && p <= 255)) {
    const n = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
    return PRIVATE_CIDRS.some(([net, mask]) => (n & mask) === (net & mask));
  }
  if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) {
    return true;
  }
  return false;
}

/**
 * Validate that a pool URL is safe to connect to.
 * Re-resolves DNS on each call so it can be used at both booking time and
 * reconnect time to guard against DNS-rebinding attacks.
 *
 * Returns null if valid, or an error string if rejected.
 */
export async function validatePoolUrl(poolUrl: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(poolUrl);
  } catch {
    return "poolUrl is not a valid URL";
  }
  if (u.protocol !== "stratum+tcp:" && u.protocol !== "stratum:") {
    return "poolUrl must use stratum+tcp:// or stratum:// (TLS not supported by proxy)";
  }
  const host = u.hostname.toLowerCase();
  const port = u.port ? parseInt(u.port, 10) : null;
  if (!port || port < 1 || port > 65535) {
    return "poolUrl must include an explicit port (1–65535)";
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    return "poolUrl hostname is not permitted";
  }
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return "poolUrl hostname is not permitted";
  }
  if (isPrivateIp(host)) {
    return "poolUrl hostname resolves to a reserved/private address";
  }
  try {
    const [v4, v6] = await Promise.allSettled([
      dns.resolve4(host),
      dns.resolve6(host),
    ]);
    const ips: string[] = [];
    if (v4.status === "fulfilled") ips.push(...v4.value);
    if (v6.status === "fulfilled") ips.push(...v6.value);
    if (ips.length === 0) return "poolUrl hostname could not be resolved";
    for (const ip of ips) {
      if (isPrivateIp(ip)) {
        return "poolUrl hostname resolves to a reserved/private address";
      }
    }
  } catch {
    return "poolUrl hostname could not be resolved";
  }
  return null;
}

/**
 * Validate that a resolved IP address is safe to connect to.
 * Lighter-weight check used at connect/reconnect time by the upstream client.
 */
export function validateResolvedIp(ip: string): string | null {
  if (isPrivateIp(ip)) {
    return `Resolved IP ${ip} is a reserved/private address (DNS rebinding prevention)`;
  }
  return null;
}

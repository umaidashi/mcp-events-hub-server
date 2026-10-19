// Addresses a webhook callback must not reach unless HUB_ALLOW_PRIVATE_CALLBACKS=1: this-network,
// private, CGNAT, loopback, link-local, IETF protocol, benchmarking and multicast/reserved, plus the
// IPv6 unspecified/loopback, IPv4-mapped, NAT64, ULA, link-local and multicast ranges.
import { BlockList } from "node:net";

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 127], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) PRIVATE.addSubnet(net, bits, "ipv6");

export const isPrivateAddress = (address: string): boolean => PRIVATE.check(address, address.includes(":") ? "ipv6" : "ipv4");

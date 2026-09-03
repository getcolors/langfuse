// Everything that turns desired state into the six machines and their
// addresses.
//
// Six machines carry far more derived identity than one: a ClickHouse replica
// that names a peer wrongly forms no quorum, an app host that points at a
// stale VPC address fails only after the migration timeout, and a firewall
// rule sourced from the wrong `/32` is a silent denial. Everything here is a
// pure function of desired state plus the compute stage's output, so the whole
// of it is reachable from the test suite and visible in the goldens. Nothing
// in this file may read the environment, the filesystem, or the network.

import type { Opts } from "red/workflow";

export const clickhouseNodeCount = 3;

export type Role = "neon" | "redis" | "clickhouse" | "app";

// The roles in play order. `app` is last because it is the consumer of the
// other three.
export const roles: Role[] = ["neon", "redis", "clickhouse", "app"];

export interface HostId {
  role: Role;
  index: number | null;
}

export interface Host {
  role: string;
  index: number | null;
  name: string;
  ip: string;
  "vpc-ip": string;
  user: string;
  sudoer: string;
}

// The compute stage's `hosts` output, in this package's vocabulary.
export interface HostParam {
  role?: unknown;
  index?: unknown;
  ip?: unknown;
  "vpc-ip"?: unknown;
  user?: unknown;
  sudoer?: unknown;
  [key: string]: unknown;
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function blank(value: unknown): boolean {
  return str(value).trim() === "";
}

// The deployment's base machine name (Compute Name Standard §1-2): the
// profile, unless desired state overrides it with `vultr-name`.
export function computeName(opts: Opts): string {
  const override = str(opts["vultr-name"]);
  if (blank(override) || override.trim() === "REPLACE_ME") return str(opts.profile);
  return override.trim();
}

// The label of a machine: `<name>-<role>` for the singletons and
// `<name>-clickhouse-<i>` for the replicas.
export function machineName(opts: Opts, role: string, index?: number | null): string {
  const base = `${computeName(opts)}-${role}`;
  return index === null || index === undefined ? base : `${base}-${index}`;
}

export function clickhouseIndexes(): number[] {
  return Array.from({ length: clickhouseNodeCount }, (_, i) => i);
}

// Every machine this deployment claims, as `{role, index}` in play order.
// `index` is null for the singletons and the replica ordinal for ClickHouse.
export function hostIds(): HostId[] {
  return [
    { role: "neon", index: null },
    { role: "redis", index: null },
    ...clickhouseIndexes().map((i): HostId => ({ role: "clickhouse", index: i })),
    { role: "app", index: null },
  ];
}

export function hostName(opts: Opts, id: HostId): string {
  return machineName(opts, id.role, id.index);
}

export function planKey(role: string): string {
  return `vultr-plan-${role}`;
}

// ------------------------------------------------------------------ fallback

// The network address of `vultr-vpc-subnet`, `10.50.0.0/24` -> `10.50.0.0`.
export function vpcBlock(opts: Opts): string {
  return str(opts["vultr-vpc-subnet"] ?? "10.50.0.0/24").split("/")[0]!;
}

function placeholderVpcIp(opts: Opts, offset: number): string {
  const octets = vpcBlock(opts).split(".");
  return [...octets.slice(0, 3), String(offset)].join(".");
}

// Where each role's placeholder lands inside the subnet on a credential-free
// build. Documentation ranges (RFC 5737 for the public side), fixed so a
// build is byte-identical on every workstation.
const fallbackOffsets: Record<Role, number> = { neon: 10, redis: 11, app: 12, clickhouse: 20 };

export function fallbackHost(opts: Opts, id: HostId): Host {
  const offset = fallbackOffsets[id.role] + (id.index ?? 0);
  return {
    role: id.role,
    index: id.index,
    name: hostName(opts, id),
    ip: `192.0.2.${offset}`,
    "vpc-ip": placeholderVpcIp(opts, offset),
    user: "root",
    sudoer: "root",
  };
}

export function fallbackHosts(opts: Opts): Host[] {
  return hostIds().map((id) => fallbackHost(opts, id));
}

// --------------------------------------------------------------------- hosts

function keyOf(role: unknown, index: unknown): string {
  const i = typeof index === "number" ? Math.trunc(index) : null;
  return `${str(role)}/${i === null ? "" : i}`;
}

function byKey(params: HostParam[]): Map<string, HostParam> {
  const map = new Map<string, HostParam>();
  for (const p of params) map.set(keyOf(p.role, p.index), p);
  return map;
}

// The host list the Ansible stage, the DNS stage and the acceptance consume.
//
// `params` is the compute stage's `hosts` output. On a build there is none, so
// the fallbacks stand in. On a real run a missing or short list is a hard
// error rather than a silent partial cluster (see `missingHostError`).
export function hosts(opts: Opts, params?: HostParam[] | null): Host[] {
  const list = params === undefined ? (opts["langfuse/hosts"] as HostParam[] | undefined) : params;
  if (!list || list.length === 0) return fallbackHosts(opts);
  const known = byKey(list);
  return hostIds().map((id) => {
    const p = known.get(keyOf(id.role, id.index));
    const host = fallbackHost(opts, id);
    if (!p) return host;
    // `select-keys`: only the keys the param carries override the fallback.
    if ("ip" in p) host.ip = p.ip as string;
    if ("vpc-ip" in p) host["vpc-ip"] = p["vpc-ip"] as string;
    if ("user" in p) host.user = p.user as string;
    if ("sudoer" in p) host.sudoer = p.sudoer as string;
    return host;
  });
}

// The error for a compute output that does not cover every machine, or that
// omits an address. Returned rather than thrown so the workflow reports it the
// way it reports every other failure.
export function missingHostError(opts: Opts, params?: HostParam[] | null): string | undefined {
  if (!params || params.length === 0) return undefined;
  const known = byKey(params);
  const missing = hostIds().filter((id) => {
    const p = known.get(keyOf(id.role, id.index));
    return !(p && !blank(p.ip) && !blank(p["vpc-ip"]));
  });
  if (missing.length === 0) return undefined;
  return "the compute stage did not report an address for " +
    missing.map((id) => hostName(opts, id)).join(", ") +
    ". Refusing to render a partial deployment: a ClickHouse cluster " +
    "config naming fewer replicas than exist forms no quorum, and an " +
    "app environment pointing at a missing address fails only after " +
    "the migration timeout.";
}

// The single host for `role`, or the `i`th ClickHouse node.
export function hostOf(list: Host[], role: string, i?: number): Host | undefined {
  if (i === undefined) return list.find((h) => h.role === role && h.index === null);
  return list.find((h) => h.role === role && h.index === i);
}

export function clickhouseHosts(list: Host[]): Host[] {
  return list.filter((h) => h.role === "clickhouse")
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

// --------------------------------------------------------------------- ports

export function port(opts: Opts, key: string, fallback: number): number {
  const value = opts[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return fallback;
}

export const clickhouseHttpPort = (opts: Opts) => port(opts, "clickhouse-http-port", 8123);
export const clickhouseNativePort = (opts: Opts) => port(opts, "clickhouse-native-port", 9000);
export const clickhouseInterserverPort = (opts: Opts) => port(opts, "clickhouse-interserver-port", 9009);
export const clickhouseKeeperPort = (opts: Opts) => port(opts, "clickhouse-keeper-port", 9181);
export const clickhouseRaftPort = (opts: Opts) => port(opts, "clickhouse-raft-port", 9234);
export const redisPort = (opts: Opts) => port(opts, "redis-port", 6379);
export const neonComputePort = 55433;

// What the three replicas need from each other: the native port for
// distributed queries and `clusterAllReplicas`, interserver for part
// exchange, the Keeper client port, and raft.
export function clickhouseInternalPorts(opts: Opts): number[] {
  return [clickhouseNativePort(opts), clickhouseInterserverPort(opts),
    clickhouseKeeperPort(opts), clickhouseRaftPort(opts)];
}

// What the app host needs from ClickHouse: HTTP for queries, native for the
// migration runner. Never Keeper, never raft.
export function appClickhousePorts(opts: Opts): number[] {
  return [clickhouseHttpPort(opts), clickhouseNativePort(opts)];
}

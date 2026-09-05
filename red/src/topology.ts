// Everything that turns desired state into the six machines and their
// addresses.
//
// Six machines carry far more derived identity than one: a ClickHouse replica
// that names a peer wrongly forms no quorum, an app host that points at a
// stale VPC address fails only after the migration timeout, and a firewall
// rule sourced from the wrong `/32` is a silent denial.
//
// The node set itself — the six ids, the fallback addresses a `build` renders
// with, the aliases, and the refusal of a state that does not describe every
// machine — is the Compute Cluster Standard's
// (`workspace/standards/compute-cluster.md`) and is ONCE's `computeCluster`
// module, called with the `spec` below and never copied. What stays here is
// Langfuse's: the roles and their fixed counts, the per-role plan key, the
// host lookups the plays and the DNS stage use, and the ports. Everything here
// is a pure function of desired state plus the compute stage's output, so the
// whole of it is reachable from the test suite and visible in the goldens.
// Nothing in this file may read the environment, the filesystem, or the
// network.

import type { Opts } from "red/workflow";
import { compute, computeCluster } from "package-once-red";

// ---------------------------------------------------------------- the spec

// provider-compute -> what that choice implies.
//
// `required` are the non-secret keys the provider's template interpolates,
// `secrets` the credentials it needs through COLORS_PAR_*, `tofuEnv` the
// subset OpenTofu reads from the process environment itself, and `network` the
// private network every database connection crosses — created by this package
// from `vultr-vpc-subnet`, never discovered. Keeping them together is what
// stops a provider being validated against one set of keys and run with
// another. The keys of this map are the advertised providers; Vultr is the
// only one this package has a template and a golden for.
//
// Two keys the template reads are deliberately not required. `vultr-name` is
// an optional override of the profile (Compute Name Standard), and
// `vultr-ssh-keys` is meaningful by its absence (SSH Keypair Standard).
// `vultr-http-sources` is required but deliberately NOT one of the spec's
// `sources`: it accepts the symbolic value `cloudflare`, which the package
// resolves itself (see `tools.httpSources`).
export const computeProviders: computeCluster.ClusterRegistry = {
  vultr: {
    required: ["vultr-region", "vultr-os-id", "vultr-vpc-subnet",
      "vultr-plan-neon", "vultr-plan-redis", "vultr-plan-clickhouse", "vultr-plan-app",
      "vultr-ssh-sources", "vultr-http-sources"],
    secrets: ["vultr-api-key"],
    tofuEnv: { "vultr-api-key": "VULTR_API_KEY" },
    network: { mode: "created", key: "vultr-vpc-subnet" },
  },
};

// The provider a deployment created before this package recorded one in its
// compute output must be running: the only one it ever offered.
export const defaultComputeProvider = "vultr";

export const clickhouseNodeCount = 3;

// How this package describes itself to ONCE's `computeCluster`. Four roles in
// play order — `app` last because it is the consumer of the other three — with
// fixed counts: one shard of three ClickHouse replicas, and one machine each
// for the storage tier, the cache and the application. The bare `<profile>`
// alias reaches the app host, the machine an operator most often means. The
// fallback offsets are where each role's placeholder landed inside the subnet
// before adoption, so the committed goldens carry the same addresses: 10, 11,
// 12 for the singletons and 20-22 for the replicas.
export const spec: computeCluster.ClusterSpec = {
  registry: computeProviders,
  default: defaultComputeProvider,
  sources: { nonEmpty: ["ssh-sources"], mayBeEmpty: [] },
  roles: [
    { role: "neon", count: 1, fallbackOffset: 10 },
    { role: "redis", count: 1, fallbackOffset: 11 },
    { role: "clickhouse", count: clickhouseNodeCount, fallbackOffset: 20 },
    { role: "app", count: 1, fallbackOffset: 12 },
  ],
  entry: { role: "app", index: 0 },
};

export type Role = "neon" | "redis" | "clickhouse" | "app";

// The roles in play order.
export const roles: Role[] = spec.roles.map((r) => r.role as Role);

// A host as this package's renderers read it: ONCE's five fields with `vpc-ip`
// in the package's kebab spelling, a null index on the singletons, plus
// whatever else the template recorded.
export interface Host {
  role: string;
  index: number | null;
  name: string;
  ip: string;
  "vpc-ip": string;
  user: string;
  sudoer: string;
  [extra: string]: unknown;
}

// The deployment's base machine name (Compute Name Standard §1-2): the
// profile, unless desired state overrides it with `vultr-name`. ONCE's, so
// every label derives from the same value.
export function computeName(opts: Opts): string {
  return compute.computeName(opts);
}

// The label of a machine: `<name>-<role>` for the singletons and
// `<name>-clickhouse-<i>` for the replicas — the Cluster Standard's fallback
// name, which is also what the template labels the instance.
export function machineName(opts: Opts, role: string, index?: number | null): string {
  return computeCluster.fallbackNodeName(spec, opts, { role, index: index ?? 0 });
}

export function planKey(role: string): string {
  return `vultr-plan-${role}`;
}

// --------------------------------------------------------------------- hosts

// Whether `role` is declared with a count of one.
function singletonRole(role: unknown): boolean {
  return computeCluster.nodeCount(spec, {}, role as string | null) === 1;
}

// One of ONCE's nodes as this package's renderers read it. Two respellings,
// both at this boundary so every rendered file stays byte-identical: ONCE
// records `vpc_ip` with the underscore where the templates, the inventory and
// the firewall data were written against `vpc-ip`; and ONCE gives every node
// an index (a singleton's is 0) where the inventory writes an `ordinal` only
// for the replicas, so a singleton's index reads as null here. Nothing else is
// touched: the name is the label the template gave the instance, never
// recomputed, and extension fields ride through.
function langfuseHost(node: computeCluster.Node): Host {
  const { vpc_ip, ...rest } = node;
  const host = { ...rest, "vpc-ip": vpc_ip as string } as Host;
  if (singletonRole(node.role)) host.index = null;
  return host;
}

// What a credential-free `build` renders in place of a compute output: ONCE's
// fallbacks — public addresses from `192.0.2.0/24`, private ones cut from
// `vultr-vpc-subnet`, each at its role's offset — so a build is byte-identical
// on every workstation and the committed goldens mean something.
export function fallbackHosts(opts: Opts): Host[] {
  return computeCluster.fallbackNodes(spec, opts).map(langfuseHost);
}

// The host list the Ansible stage, the DNS stage and the acceptance consume.
//
// `params` is the compute stage's recorded `params` map, adopted under
// `once/cluster` on a real run. On a build there is none, so the fallbacks
// stand in. On a real run ONCE refuses a state that does not describe every
// declared machine with every field, and never substitutes a fallback: a
// ClickHouse cluster config naming fewer replicas than exist forms no quorum,
// and an app environment pointing at a missing address fails only after the
// migration timeout.
export function hosts(opts: Opts, params?: computeCluster.ClusterParams | null): Host[] {
  const recorded = params === undefined
    ? (opts["once/cluster"] as computeCluster.ClusterParams | undefined)
    : params;
  return computeCluster.nodes(spec, opts, recorded).map(langfuseHost);
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

import { createHash, randomBytes } from "node:crypto";
import * as ansible from "red/ansible";
import { stageDir } from "red/cli";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { runtime, type ExecResult } from "red/runtime";
import type { Opts } from "red/workflow";
import { failed } from "red/workflow";
import { neonResource } from "./neon.ts";
import * as sshConfig from "./ssh-config.ts";
import * as topology from "./topology.ts";
import * as validate from "./validate.ts";

import ansibleLocalMainYml from "../resources/tools/ansible-local/main.yml" with { type: "text" };
import ansibleSiteYml from "../resources/tools/ansible/site.yml" with { type: "text" };
import ansibleCommonYml from "../resources/tools/ansible/common.yml" with { type: "text" };
import ansibleNeonPreYml from "../resources/tools/ansible/neon-pre.yml" with { type: "text" };
import ansibleNeonComposeOverride from "../resources/tools/ansible/neon-compose.override.yml" with { type: "text" };
import ansibleClickhouseYml from "../resources/tools/ansible/clickhouse.yml" with { type: "text" };
import ansibleClickhouseConfigXml from "../resources/tools/ansible/clickhouse-config.xml" with { type: "text" };
import ansibleClickhouseUsersXml from "../resources/tools/ansible/clickhouse-users.xml" with { type: "text" };
import ansibleClickhouseBackupXml from "../resources/tools/ansible/clickhouse-backup.xml" with { type: "text" };
import ansibleClickhouseBackupSh from "../resources/tools/ansible/clickhouse-backup.sh" with { type: "text" };
import ansibleClickhouseRestoreCheckSh from "../resources/tools/ansible/clickhouse-restore-check.sh" with { type: "text" };
import ansibleClickhouseMonitorSh from "../resources/tools/ansible/clickhouse-monitor.sh" with { type: "text" };
import ansibleRedisYml from "../resources/tools/ansible/redis.yml" with { type: "text" };
import ansibleRedisComposeYml from "../resources/tools/ansible/redis-compose.yml" with { type: "text" };
import ansibleRedisMonitorSh from "../resources/tools/ansible/redis-monitor.sh" with { type: "text" };
import ansibleLangfuseYml from "../resources/tools/ansible/langfuse.yml" with { type: "text" };
import ansibleLangfuseComposeYml from "../resources/tools/ansible/langfuse-compose.yml" with { type: "text" };
import ansibleCaddyfile from "../resources/tools/ansible/Caddyfile" with { type: "text" };
import ansibleLangfuseEnv from "../resources/tools/ansible/langfuse.env" with { type: "text" };
import ansibleLangfuseSmokeSh from "../resources/tools/ansible/langfuse-smoke.sh" with { type: "text" };
import ansibleLangfuseCredentialSh from "../resources/tools/ansible/langfuse-credential.sh" with { type: "text" };
import ansibleLangfuseMonitorSh from "../resources/tools/ansible/langfuse-monitor.sh" with { type: "text" };
import ansibleLangfuseRehearsalSh from "../resources/tools/ansible/langfuse-rehearsal.sh" with { type: "text" };
import ansibleLangfuseStatusSh from "../resources/tools/ansible/langfuse-status.sh" with { type: "text" };
import ansibleBackupsYml from "../resources/tools/ansible/backups.yml" with { type: "text" };
import ansibleR2EnvSh from "../resources/tools/ansible/r2-env.sh" with { type: "text" };
import ansiblePostgresBackupSh from "../resources/tools/ansible/postgres-backup.sh" with { type: "text" };
import ansiblePostgresRestoreCheckSh from "../resources/tools/ansible/postgres-restore-check.sh" with { type: "text" };
import ansibleMediaBackupSh from "../resources/tools/ansible/media-backup.sh" with { type: "text" };
import ansibleNeonMonitorSh from "../resources/tools/ansible/neon-monitor.sh" with { type: "text" };
import ansibleRehearsalYml from "../resources/tools/ansible/rehearsal.yml" with { type: "text" };
import ansibleCleanupYml from "../resources/tools/ansible/cleanup.yml" with { type: "text" };
import dnsMainTf from "../resources/tools/dns/main.tf" with { type: "text" };
import infrastructureMainTf from "../resources/tools/infrastructure/main.tf" with { type: "text" };

export const infrastructureTool = "langfuse-infrastructure";
export const dnsTool = "langfuse-dns";
export const ansibleTool = "langfuse-ansible";
export const ansibleLocalTool = "langfuse-ansible-local";
export const templateOpts = PRESERVE_JINJA_DELIMITERS;

export function toolDir(opts: Opts, tool: string): string {
  return stageDir(opts, tool, { defaultProfile: "langfuse" });
}

const template = (name: string, content: string): Template => ({ name, content });

// The storage tier's templates come from the SHA-pinned `package-neon-red`
// dependency, not from this repository. See neon.ts: they are read off the
// installed package and never copied in here, never edited. A copy of a tier
// this subtle drifts, and the drift is silent.
const neonTemplate = (path: string, file: string): Template =>
  template(`neon/${path}/${file}`, neonResource(path, file));

function spec(source: Template, target: string, data: Opts): Spec {
  return { template: source, target, data, opts: templateOpts };
}

const rawSpec = (target: string, content: string): Spec => contentSpec(target, content);

export function cidrs(opts: Opts, key: string): string[] {
  const value = opts[key];
  const parts = Array.isArray(value) ? value : validate.s(value).split(/[,\s]+/);
  return parts.map((part) => String(part).trim()).filter((part) => part.length > 0);
}

export function credentialEnv(opts: Opts, ...slots: string[]): Record<string, string> | undefined {
  const mapping: Record<string, string> = Object.assign(
    {},
    ...[...slots, "provider-backend"].map((slot) => validate.tofuEnv(opts, slot)),
  );
  const env: Record<string, string> = {};
  for (const [key, envVar] of Object.entries(mapping)) {
    const value = validate.s(opts[key]);
    if (value.length > 0) env[envVar] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export const backendCredentialEnv = (opts: Opts) => credentialEnv(opts);

// Cheshire's pretty printer, in insertion order — Green's byte-level artifact
// contract for the two documents this package writes itself. `tofu.constructs`
// sorts keys, which is right for a Terraform document and wrong for
// http-sources.json, whose keys stay in the order they are declared; the
// inventory sorts its own keys before it gets here.
function pretty(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[ ${value.map((item) => pretty(item, indent)).join(", ")} ]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{ }";
    const pad = " ".repeat(indent + 2);
    return `{\n${entries
      .map(([key, nested]) => `${pad}${JSON.stringify(key)} : ${pretty(nested, indent + 2)}`)
      .join(",\n")}\n${" ".repeat(indent)}}`;
  }
  return JSON.stringify(value ?? null);
}

// A copy of `value` with its keys in sorted order — Clojure's `sorted-map`,
// which green uses throughout the inventory so an object of this size keeps a
// stable order across colours.
function sorted<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ------------------------------------------------------------- compute output

// `vpc_ip` -> `vpc-ip`, recursively. Tofu outputs snake_case; the rest of this
// package speaks kebab-case keys.
function hyphenateKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hyphenateKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [key.replaceAll("_", "-"), hyphenateKeys(nested)]));
  }
  return value;
}

export interface Params {
  "ssh-key-id"?: unknown;
  hosts: topology.HostParam[];
  [key: string]: unknown;
}

// The compute stage's `params` output in this package's vocabulary:
// `{ssh-key-id, hosts: [{role, index, name, ip, vpc-ip, user, sudoer}]}`.
// `index` arrives as a number or null; a JSON parser may hand back a double.
export function normalizeParams(params: unknown): Params | undefined {
  if (params === null || params === undefined) return undefined;
  const p = hyphenateKeys(params) as Record<string, unknown>;
  const hosts = Array.isArray(p.hosts) ? (p.hosts as Record<string, unknown>[]) : [];
  return {
    ...p,
    hosts: hosts.map((h) => ({
      ...h,
      index: typeof h.index === "number" ? Math.trunc(h.index) : null,
    })),
  };
}

export function outputParams(result: Opts): Params | undefined {
  return normalizeParams((result["tofu/outputs"] as Record<string, unknown> | undefined)?.params);
}

// The host list for every stage after compute (see topology.hosts).
export function hosts(opts: Opts): topology.Host[] {
  return topology.hosts(opts, opts["langfuse/hosts"] as topology.HostParam[] | undefined);
}

// ---------------------------------------------------------------- compute

// Cloudflare's published ranges, current as of 2026-09-01. Used when
// `vultr-http-sources` is the symbolic value `cloudflare` and the live fetch is
// unavailable — a `build` on a fresh checkout with no network must still
// render. A real converge prefers the fetch and never silently widens.
export const cloudflareRangesFallback = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];

export const USER_AGENT = "colors-langfuse";

// Cloudflare's published ranges, or undefined when they cannot be fetched.
// Never widens on failure: the caller decides.
export async function fetchCloudflareRanges(): Promise<string[] | undefined> {
  try {
    const pull = async (url: string) => {
      // An explicit User-Agent, because Cloudflare answers some runtime
      // defaults with 403 Forbidden — an earlier port's did, and the fallback
      // list then rendered on every build, so the colours disagreed on
      // `origin` for one desired state. Nothing here should depend on which
      // runtime a colour is written in, so every colour names itself the same
      // way.
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return (await response.text()).split("\n")
        .map((line) => line.trim()).filter((line) => line.length > 0);
    };
    const ranges = [
      ...await pull("https://www.cloudflare.com/ips-v4"),
      ...await pull("https://www.cloudflare.com/ips-v6"),
    ];
    return ranges.length > 0 ? ranges : undefined;
  } catch {
    return undefined;
  }
}

export interface HttpSources {
  source: "explicit" | "fetched" | "fallback";
  ranges: string[];
}

// The origin ingress list. `cloudflare` is a symbolic source this package
// RESOLVES; the result carries how it was obtained so the caller can record a
// checksum and a real converge can refuse a stale fallback.
export async function httpSources(opts: Opts): Promise<HttpSources> {
  if (validate.s(opts["vultr-http-sources"]) !== "cloudflare") {
    return { source: "explicit", ranges: cidrs(opts, "vultr-http-sources") };
  }
  const live = await fetchCloudflareRanges();
  return live
    ? { source: "fetched", ranges: live }
    : { source: "fallback", ranges: cloudflareRangesFallback };
}

export function rangesChecksum(values: string[]): string {
  return createHash("sha256").update([...values].sort().join("\n"))
    .digest("hex").slice(0, 16);
}

export async function infrastructureData(opts: Opts): Promise<Opts> {
  const { source, ranges } = await httpSources(opts);
  return {
    ...opts,
    "compute-name": validate.computeName(opts),
    "ssh-keygen": validate.keygen(opts),
    "ssh-sources-hcl": tofu.hclList(cidrs(opts, "vultr-ssh-sources")),
    "http-sources-hcl": tofu.hclList(ranges),
    "http-sources-origin": source,
    "http-sources-ranges": [...ranges],
    "http-sources-checksum": rangesChecksum(ranges),
    "clickhouse-node-count": topology.clickhouseNodeCount,
    // Rendered into the firewall: a template key that is absent renders as
    // empty rather than failing, and `port = ""` survives build, golden and
    // dry-run to be rejected only by the provider.
    "neon-compute-port": topology.neonComputePort,
    "redis-port-value": topology.redisPort(opts),
    "app-clickhouse-ports-hcl": tofu.hclList(topology.appClickhousePorts(opts).map(String)),
    "clickhouse-internal-ports-hcl": tofu.hclList(topology.clickhouseInternalPorts(opts).map(String)),
  };
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, infrastructureTool);
  const data = await infrastructureData(opts);
  const specs = [
    spec(template("infrastructure/main.tf", infrastructureMainTf), `${dir}/main.tf`, data),
    // The resolved range set is recorded, with a checksum, so a firewall
    // change is explainable after the fact.
    rawSpec(`${dir}/http-sources.json`, pretty({
      origin: data["http-sources-origin"],
      checksum: data["http-sources-checksum"],
      ranges: data["http-sources-ranges"],
    })),
  ];
  const result = await tofu.tofuWithSpec(opts, specs,
    { dir, env: credentialEnv(opts, "provider-compute") });
  if (failed(result)) return result;
  if (opts["red/event"] === "build") return result;
  if (opts["red/event"] === "delete") return result;
  const params = outputParams(result);
  const error = topology.missingHostError(opts, params?.hosts);
  if (error) return { ...result, "red/exit": 1, "red/err": error };
  return { ...result, "langfuse/hosts": params?.hosts, "langfuse/ssh-key-id": params?.["ssh-key-id"] };
}

// ------------------------------------------------------------------- dns

export const zoneId = "${data.cloudflare_zone.zone.id}";

// One proxied A record for the public name, pointing at the app host. `ttl 1`
// means automatic: Cloudflare rejects an explicit TTL on a proxied record.
export function dnsJson(opts: Opts, appIp: string | undefined): string {
  return tofu.constructsJson([
    tofu.construct("resource", "cloudflare_dns_record", "langfuse", {
      zone_id: zoneId,
      name: opts["langfuse-host"],
      type: "A",
      content: appIp,
      ttl: 1,
      proxied: Boolean(opts["cloudflare-proxied"]),
    }),
  ]);
}

export async function dnsStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, dnsTool);
  const app = topology.hostOf(hosts(opts), "app");
  const specs = [
    spec(template("dns/main.tf", dnsMainTf), `${dir}/main.tf`, opts),
    rawSpec(`${dir}/record.tf.json`, dnsJson(opts, app?.ip)),
  ];
  return tofu.tofuWithSpec(opts, specs, { dir, env: credentialEnv(opts, "provider-dns") });
}

// ------------------------------------------------------- ssh config (local)

// Only what a `build` genuinely knows. Addresses are run-time facts and reach
// the play as extra-vars instead, so the rendered playbook carries no IP and
// is identical on every workstation (SSH Config Standard §6).
export function ansibleLocalData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts),
    "ssh-config-identity-file": sshConfig.identityFile(opts),
  };
}

export function ansibleLocalSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleLocalTool);
  const data = ansibleLocalData(opts);
  // ansible.cfg and the inventory are the dependency's, unchanged; the play
  // is this package's own because it writes six stanzas, not one.
  return [
    spec(neonTemplate("ansible-local", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    spec(neonTemplate("ansible-local", "inventory.ini"), `${dir}/inventory.ini`, data),
    spec(template("ansible-local/main.yml", ansibleLocalMainYml), `${dir}/main.yml`, data),
  ];
}

export interface SshConfigHost {
  name: string;
  ip: string | undefined;
}

// The stanzas the managed block carries: the bare profile reaching the app
// host, then one per machine.
export function sshConfigHosts(opts: Opts, list: topology.Host[]): SshConfigHost[] {
  const app = topology.hostOf(list, "app");
  return [
    { name: sshConfig.hostAlias(opts), ip: app?.ip },
    ...list.map((h) => ({ name: sshConfig.machineAlias(opts, h), ip: h.ip })),
  ];
}

// Write or remove the `~/.ssh/config` block. The same playbook serves both
// events; `block_state` is what distinguishes them.
export async function ansibleLocalStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleLocalTool);
  const isDelete = opts["red/event"] === "delete";
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.ini",
    playbooks: { create: "main.yml", delete: "main.yml" },
    extraVars: {
      host_alias: sshConfig.hostAlias(opts),
      ssh_hosts: sshConfigHosts(opts, hosts(opts)),
      block_state: isDelete ? "absent" : "present",
    },
  }, ansibleLocalSpecs(opts));
}

// ------------------------------------------------------------------ ansible

// Six hosts in four groups, each carrying the facts only it has.
//
// Every value is a HOST var and no group carries variables: the imported neon
// play targets `neon`, this package's plays target the other three, and
// group_vars precedence would be a live hazard. Cluster-wide facts the plays
// need — the app host's address for the firewall mirrors, the three replica
// addresses for the ClickHouse config — are read through `hostvars` at
// execution time, so one inventory is the single source of every address.
//
// Sorted objects throughout: green renders sorted maps, and every golden would
// churn on an order that differed between colours.
export function inventory(_opts: Opts, list: topology.Host[]): string {
  const hostEntry = (h: topology.Host): [string, Record<string, unknown>] => [
    h.name,
    sorted({
      ansible_host: h.ip,
      ansible_user: h.user ?? "root",
      vpc_ip: h["vpc-ip"],
      role: h.role,
      ...(h.index !== null && h.index !== undefined ? { ordinal: h.index } : {}),
    }),
  ];
  const group = (role: string) => ({
    hosts: sorted(Object.fromEntries(list.filter((h) => h.role === role).map(hostEntry))),
  });
  return pretty({
    all: {
      children: sorted({
        neon: group("neon"),
        redis: group("redis"),
        clickhouse: group("clickhouse"),
        app: group("app"),
      }),
    },
  });
}

// Template values for the Ansible stage.
//
// Deliberately carries no operator secret. Every credential reaches a host as
// an Ansible `lookup('env', ...)` expression written literally into a play,
// where `preserve-jinja-delimiters` passes it through untouched — routing it
// through this map would let the template engine HTML-escape the quotes and
// hand Ansible `&#39;`.
export function ansibleData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts),
    "compute-name": validate.computeName(opts),
    "neon-compute-port": topology.neonComputePort,
    "clickhouse-node-count": topology.clickhouseNodeCount,
  };
}

export const neonFiles = [
  "ansible.cfg", "main.yml", "cleanup.yml", "compose.yml",
  "pageserver.toml", "identity.toml", "config.json", "scramgen.py",
  "bootstrap.sh", "smoke.sh", "status.sh", "rotate.sh",
];

// The storage tier, rendered UNCHANGED from the pinned dependency into its own
// `neon/` subdirectory. The upstream play copies its files by relative `src:`
// name, so rendering them flat beside this package's templates would let a
// same-named file win silently.
export function neonSpecs(dir: string, data: Opts): Spec[] {
  const sub = `${dir}/neon`;
  return neonFiles.map((file) =>
    spec(neonTemplate("ansible", file), `${sub}/${file}`, data));
}

// This package's own convergence tree: plays, templates, and the scripts the
// plays install. Rendered flat into the stage beside `neon/`.
export const ansibleFiles = [
  "site.yml", "common.yml", "neon-pre.yml", "neon-compose.override.yml",
  "clickhouse.yml", "clickhouse-config.xml", "clickhouse-users.xml",
  "clickhouse-backup.xml", "clickhouse-backup.sh", "clickhouse-restore-check.sh",
  "clickhouse-monitor.sh",
  "redis.yml", "redis-compose.yml", "redis-monitor.sh",
  "langfuse.yml", "langfuse-compose.yml", "Caddyfile", "langfuse.env",
  "langfuse-smoke.sh", "langfuse-credential.sh", "langfuse-monitor.sh",
  "langfuse-rehearsal.sh", "langfuse-status.sh",
  "backups.yml", "r2-env.sh", "postgres-backup.sh", "postgres-restore-check.sh",
  "media-backup.sh", "neon-monitor.sh",
  "rehearsal.yml", "cleanup.yml",
];

// The template tree this colour carries, keyed the way green names its
// classpath resources. Bun's own types declare `*.xml` imports as a Document;
// at runtime a `with { type: "text" }` import is a string, so the cast
// restores the truth.
const ansibleTemplates: Record<string, string> = {
  "site.yml": ansibleSiteYml,
  "common.yml": ansibleCommonYml,
  "neon-pre.yml": ansibleNeonPreYml,
  "neon-compose.override.yml": ansibleNeonComposeOverride,
  "clickhouse.yml": ansibleClickhouseYml,
  "clickhouse-config.xml": ansibleClickhouseConfigXml as unknown as string,
  "clickhouse-users.xml": ansibleClickhouseUsersXml as unknown as string,
  "clickhouse-backup.xml": ansibleClickhouseBackupXml as unknown as string,
  "clickhouse-backup.sh": ansibleClickhouseBackupSh,
  "clickhouse-restore-check.sh": ansibleClickhouseRestoreCheckSh,
  "clickhouse-monitor.sh": ansibleClickhouseMonitorSh,
  "redis.yml": ansibleRedisYml,
  "redis-compose.yml": ansibleRedisComposeYml,
  "redis-monitor.sh": ansibleRedisMonitorSh,
  "langfuse.yml": ansibleLangfuseYml,
  "langfuse-compose.yml": ansibleLangfuseComposeYml,
  "Caddyfile": ansibleCaddyfile,
  "langfuse.env": ansibleLangfuseEnv,
  "langfuse-smoke.sh": ansibleLangfuseSmokeSh,
  "langfuse-credential.sh": ansibleLangfuseCredentialSh,
  "langfuse-monitor.sh": ansibleLangfuseMonitorSh,
  "langfuse-rehearsal.sh": ansibleLangfuseRehearsalSh,
  "langfuse-status.sh": ansibleLangfuseStatusSh,
  "backups.yml": ansibleBackupsYml,
  "r2-env.sh": ansibleR2EnvSh,
  "postgres-backup.sh": ansiblePostgresBackupSh,
  "postgres-restore-check.sh": ansiblePostgresRestoreCheckSh,
  "media-backup.sh": ansibleMediaBackupSh,
  "neon-monitor.sh": ansibleNeonMonitorSh,
  "rehearsal.yml": ansibleRehearsalYml,
  "cleanup.yml": ansibleCleanupYml,
};

export function ansibleTemplate(name: string): Template {
  const content = ansibleTemplates[name];
  if (content === undefined) throw new Error(`no ansible template named ${name}`);
  return template(`ansible/${name}`, content);
}

export function ansibleSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleTool);
  const data = ansibleData(opts);
  return [
    ...neonSpecs(dir, data),
    // The dependency's ansible.cfg, not a local copy: it carries the
    // keygen-mode `private_key_file` conditional, and reusing it is the only
    // version that stays correct when the standard moves.
    spec(neonTemplate("ansible", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    ...ansibleFiles.map((name) => spec(ansibleTemplate(name), `${dir}/${name}`, data)),
    rawSpec(`${dir}/inventory.json`, inventory(data, hosts(data))),
  ];
}

export async function ansibleStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleTool);
  const known = opts["langfuse/hosts"] as unknown[] | undefined;
  if (opts["red/event"] === "delete" && (!known || known.length === 0)) {
    // No compute in state: there is no host to stop, and the cleanup play
    // would only fail against the placeholder addresses.
    return { ...opts, "red/exit": 0 };
  }
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.json",
    playbooks: { create: "site.yml", delete: "cleanup.yml" },
    hostKeyChecking: false,
  }, ansibleSpecs(opts));
}

// The recovery rehearsal: restore both stores from their newest completed
// sets, boot the pinned image against the restored data, read it back through
// the public API, then the node-loss and Redis-restart drills. Only then the
// recovery marker lands. Runs the same rendered tree as the converge.
export async function rehearsalStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleTool);
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.json",
    playbooks: { create: "rehearsal.yml" },
    hostKeyChecking: false,
  }, ansibleSpecs(opts));
}

// ------------------------------------------------------------- acceptance

// Run `args` with `env` overlaid, returning the result map. Nothing from the
// child is echoed; callers decide what becomes an error message, so a secret
// passed through `env` can never leak into output by default.
export async function runQuiet(args: string[], env: Record<string, string>, timeoutMs: number): Promise<ExecResult> {
  return runtime.exec(args, Object.keys(env).length > 0 ? { env, timeoutMs } : { timeoutMs });
}

// A file's content read over SSH through the generated alias, held only in
// this process. Never merged into opts, never printed.
export async function sshRead(alias: string, path: string): Promise<string | undefined> {
  const r = await runQuiet(["ssh", "-o", "BatchMode=yes", alias, "cat", path], {}, 20000);
  return r.exit === 0 ? String(r.out ?? "").trim() : undefined;
}

// curl with the status code on the last line and a bounded time budget.
export function curlArgs(...args: string[]): string[] {
  return ["curl", "-sS", "--max-time", "30", "-w", "\n%{http_code}", ...args];
}

// Clojure's `split-lines`: on `\r?\n`, trailing empty strings dropped.
function splitLines(text: string): string[] {
  const parts = text.split(/\r?\n/);
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function statusOf(r: { out?: string }): string | undefined {
  return splitLines(String(r.out ?? "").trim()).at(-1);
}

function bodyOf(r: { out?: string }): string {
  return splitLines(String(r.out ?? "")).slice(0, -1).join("\n");
}

// An OTel id: `n` random bytes as lowercase hex (16 for a trace, 8 for a span).
export function hexId(n: number): string {
  return randomBytes(n).toString("hex");
}

// One OTLP/JSON request: a root span named for the operator path, tagged so
// it can be found, with the observation type and an input/output pair. This
// is the v4 ingestion contract; the legacy batch endpoint rejects every event
// on a fresh v4 deployment.
export function otlpBody(traceId: string, spanId: string): string {
  // Nanoseconds since the epoch exceed 2^53; a BigInt keeps every digit.
  const now = BigInt(Date.now()) * 1000000n;
  const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
  return JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [attr("service.name", "colors-operator")] },
      scopeSpans: [{
        scope: { name: "colors-operator" },
        spans: [{
          traceId, spanId, name: "colors-operator-acceptance", kind: 1,
          startTimeUnixNano: String(now), endTimeUnixNano: String(now + 1000000n),
          attributes: [
            attr("langfuse.observation.type", "span"),
            attr("langfuse.trace.name", "colors-operator-acceptance"),
            { key: "langfuse.trace.tags",
              value: { arrayValue: { values: [{ stringValue: "colors-operator" }] } } },
            attr("langfuse.observation.input", "public-name"),
            attr("langfuse.observation.output", "ok"),
          ],
        }],
      }],
    }],
  });
}

// How many observation rows the v2 API returns for a trace, from a curl
// result, or 0 when the body is not what the API promises.
export function observationsCount(r: { out?: string }): number {
  try {
    const data = (JSON.parse(bodyOf(r)) as { data?: unknown }).data;
    if (Array.isArray(data)) return data.length;
    if (typeof data === "string") return data.length;
    if (data && typeof data === "object") return Object.keys(data).length;
    return 0;
  } catch {
    return 0;
  }
}

function fail(opts: Opts, message: string): Opts {
  return { ...opts, "red/exit": 1, "red/err": message };
}

// The operator-path gate, after a real create.
//
// The server-side gates already ran inside the playbook. What is checked from
// here is what only this side can check: the public name over TLS through
// Cloudflare, an ingestion with the generated project keys read over SSH and a
// read-back through the same edge, the refusal of a wrong key, and the SSH
// alias of every machine.
export async function acceptanceStep(opts: Opts): Promise<Opts> {
  if (opts["red/event"] !== "create") return { ...opts, "red/exit": 0 };
  const host = validate.s(opts["langfuse-host"]);
  const appAlias = sshConfig.hostAlias(opts);
  const pk = await sshRead(appAlias, "/etc/langfuse/secrets/project_public_key");
  const sk = await sshRead(appAlias, "/etc/langfuse/secrets/project_secret_key");
  const base = `https://${host}`;
  const health = await runQuiet(curlArgs(`${base}/api/public/health?failIfDatabaseUnavailable=true`), {}, 40000);
  if (statusOf(health) !== "200") {
    return fail(opts, `acceptance: ${base}/api/public/health answered ${statusOf(health)} through the public name`);
  }
  if (validate.s(pk).trim() === "" || validate.s(sk).trim() === "") {
    return fail(opts, "acceptance: could not read the generated project keys over ssh");
  }
  const traceId = hexId(16);
  const auth = `${pk}:${sk}`;
  const ingest = await runQuiet(curlArgs("-u", auth, "-H", "Content-Type: application/json",
    "-H", "x-langfuse-ingestion-version: 4",
    "-X", "POST", "--data-binary", otlpBody(traceId, hexId(8)),
    `${base}/api/public/otel/v1/traces`), {}, 40000);
  const v2 = `${base}/api/public/v2/observations?traceId=${traceId}&limit=10`;
  const deadline = Date.now() + 120000;
  let readBack: ExecResult;
  for (;;) {
    readBack = await runQuiet(curlArgs("-u", auth, v2), {}, 40000);
    if (statusOf(readBack) === "200" && observationsCount(readBack) > 0) break;
    if (Date.now() >= deadline) break;
    await Bun.sleep(5000);
  }
  const denied = await runQuiet(curlArgs("-u", `${pk}:not-the-key`, v2), {}, 40000);
  const anonymous = await runQuiet(curlArgs(v2), {}, 40000);
  const aliases = sshConfig.aliases(opts);
  const unreachable: string[] = [];
  for (const alias of aliases) {
    const r = await runQuiet(["ssh", "-o", "BatchMode=yes", alias, "true"], {}, 20000);
    if (r.exit !== 0) unreachable.push(alias);
  }
  if (statusOf(ingest) !== "200") {
    return fail(opts, "acceptance: OTLP ingestion through the public name answered " +
      `${statusOf(ingest)}: ${bodyOf(ingest).trim()}`);
  }
  if (statusOf(readBack) !== "200" || observationsCount(readBack) === 0) {
    return fail(opts, `acceptance: trace ${traceId} was not readable through the public name within 120s (last status ` +
      `${statusOf(readBack)}, ${observationsCount(readBack)} rows)`);
  }
  if (statusOf(denied) === "200") {
    return fail(opts, "acceptance: a wrong secret key was accepted through the public name");
  }
  if (statusOf(anonymous) === "200") {
    return fail(opts, "acceptance: an unauthenticated request was accepted through the public name");
  }
  if (unreachable.length > 0) {
    return fail(opts, `acceptance: ssh alias unreachable: ${unreachable.join(", ")}`);
  }
  return {
    ...opts,
    "red/exit": 0,
    "langfuse/acceptance": {
      "public-health": "200", ingested: traceId,
      "read-back": "200", "wrong-key": "refused",
      anonymous: "refused",
      "ssh-aliases": aliases.length,
    },
  };
}

// --------------------------------------------------------------- describe

export const monitorFiles: Record<string, string> = {
  neon: "/var/lib/colors/neon-monitor.json",
  redis: "/var/lib/colors/redis-monitor.json",
  clickhouse: "/var/lib/colors/clickhouse-monitor.json",
  app: "/var/lib/colors/langfuse-monitor.json",
};

export interface DescribeRow {
  host: string;
  reachable: boolean;
  healthy: boolean;
  checked: unknown;
  problems: unknown[] | undefined;
}

// Read every host's last monitor result over SSH and print them. Exits
// non-zero when any host is unreachable or reports unhealthy; this is the
// aggregation the README points an external poller at.
export async function describeStep(opts: Opts): Promise<Opts> {
  const rows: DescribeRow[] = [];
  for (const h of hosts(opts)) {
    const alias = sshConfig.machineAlias(opts, h);
    const file = monitorFiles[h.role] ?? "";
    const r = await runQuiet(["ssh", "-o", "BatchMode=yes", alias, "cat", file], {}, 20000);
    const body = String(r.out ?? "").trim();
    let parsed: Record<string, unknown> | undefined;
    try {
      const value = JSON.parse(body);
      parsed = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
    } catch {
      parsed = undefined;
    }
    const reported = parsed?.problems;
    rows.push({
      host: h.name,
      reachable: r.exit === 0,
      healthy: Boolean(parsed?.healthy),
      checked: parsed?.checked,
      problems: (Array.isArray(reported) && reported.length > 0 ? reported : undefined) ??
        (r.exit !== 0 ? ["unreachable or no monitor result yet"] : undefined),
    });
  }
  for (const { host, reachable, healthy, checked, problems } of rows) {
    const status = !reachable ? "UNKNOWN" : healthy ? "ok" : "UNHEALTHY";
    const detail = validate.s(checked) +
      (problems && problems.length > 0 ? ` ${problems.map(String).join("; ")}` : "");
    runtime.log(`${host.padEnd(32)} ${status.padEnd(10)} ${detail}`);
  }
  return {
    ...opts,
    "red/exit": rows.every((row) => row.reachable && row.healthy) ? 0 : 1,
    "langfuse/describe": rows,
  };
}

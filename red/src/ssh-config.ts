// The deployment's `~/.ssh/config` block, per the workspace SSH Config Standard.
//
// The block itself is written by the `ansible-local` stage, because that is the
// one place the addresses are known and because `blockinfile` already handles
// the idempotent replace. What lives here is everything that must happen before
// the stage renders: the aliases, the identity file, and the refusal to adopt a
// stanza this package did not write.
//
// Unlike the keypair, this play is the package's own copy rather than ONCE's
// (standard §7). The file is shared with every other host the operator reaches,
// so an unrelated change upstream must not be able to rewrite it at pin-bump
// time. The alias list, though, is the Compute Cluster Standard's (§6) and
// comes from ONCE.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Opts } from "red/workflow";
import { computeCluster } from "package-once-red";
import * as topology from "./topology.ts";

// The profile, unchanged. Standard §2: the profile already keys remote state,
// which is what makes it unique enough to name a host by. It reaches the app
// host, the machine an operator most often means.
export function hostAlias(opts: Opts): string {
  return String(opts.profile ?? "langfuse");
}

// `~/.ssh/<profile>`, written with a literal tilde rather than an expanded
// home directory. OpenSSH expands it, and leaving it unexpanded is what keeps
// the rendered block identical on every workstation.
export function identityFile(opts: Opts): string {
  return `~/.ssh/${hostAlias(opts)}`;
}

// Every alias this deployment owns: the bare profile, and one per machine —
// `<profile>-<role>` for the singletons, `<profile>-clickhouse-<i>` for the
// replicas. ONCE derives the list from the spec (Compute Cluster Standard §6).
// Six machines are operable only if each can be reached by name; the bare
// profile keeps `ssh <profile>` meaning what it means in every other
// deployment.
export function aliases(opts: Opts): string[] {
  return computeCluster.aliases(topology.spec, opts);
}

// The alias for one machine: its entry in ONCE's list, paired with the host by
// id. Derived from the profile, not from the machine's label, so an operator
// who set `vultr-name` still reaches every machine as `<profile>-<role>[-<i>]`.
export function machineAlias(opts: Opts, host: topology.Host): string {
  const [, ...perNode] = aliases(opts);
  const ids = computeCluster.nodeIds(topology.spec, opts);
  const position = ids.findIndex((id) => id.role === host.role && id.index === (host.index ?? 0));
  return perNode[position] ?? "";
}

export function configPath(): string {
  return join(process.env.HOME ?? homedir(), ".ssh", "config");
}

export function beginMarker(alias: string): string {
  return `# BEGIN ${alias} ANSIBLE MANAGED BLOCK`;
}

export function endMarker(alias: string): string {
  return `# END ${alias} ANSIBLE MANAGED BLOCK`;
}

export function ownedMarkers(alias: string): { begin: Set<string>; end: Set<string> } {
  return { begin: new Set([beginMarker(alias)]), end: new Set([endMarker(alias)]) };
}

// The patterns a `Host` line declares, or undefined when the line is not one.
export function hostPatterns(line: string): string[] | undefined {
  const match = /^\s*Host\s+(.*?)\s*$/i.exec(line);
  if (!match) return undefined;
  return match[1]!.split(/\s+/).filter((pattern) => pattern.length > 0);
}

// The 1-based line number of a `Host <alias>` stanza that this package did not
// write, or undefined. Lines between our own markers are ours and are skipped.
//
// `alias` is the stanza being searched for; `markerAlias` names the managed
// block, and the two are not the same thing: this deployment writes ONE block,
// marked with the profile, containing a stanza for the profile and for every
// machine.
export function foreignStanzaLine(lines: string[], alias: string, markerAlias = alias): number | undefined {
  const { begin, end } = ownedMarkers(markerAlias);
  let inside = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (begin.has(line.trim())) inside = true;
    else if (end.has(line.trim())) inside = false;
    else if (!inside && (hostPatterns(line) ?? []).includes(alias)) return i + 1;
  }
  return undefined;
}

// The 1-based line number of an option standing above the first `Host` or
// `Match` line, or undefined. Such an option is global; the block is written
// with `insertbefore: BOF`, so it would capture that option into this
// deployment's stanza, silently narrowing a global setting to one host.
export function leadingOptionLine(lines: string[]): number | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = String(lines[i]).trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^\s*(Host|Match)\s+.*/i.test(lines[i]!)) return undefined;
    return i + 1;
  }
  return undefined;
}

function configFileLines(): string[] | undefined {
  const path = configPath();
  if (!existsSync(path) || !statSync(path).isFile()) return undefined;
  return readFileSync(path, "utf8").split("\n");
}

// The standard's never-adopt rule (§5), checked for every alias this
// deployment claims.
export function adoptError(opts: Opts): string | undefined {
  const lines = configFileLines();
  if (!lines) return undefined;
  const marker = hostAlias(opts);
  for (const alias of aliases(opts)) {
    const n = foreignStanzaLine(lines, alias, marker);
    if (n === undefined) continue;
    return `refusing to manage ${configPath()}: it already declares ` +
      `\`Host ${alias}\` at line ${n}` +
      " outside this package's managed block. Remove or rename that " +
      "stanza if it is stale, or change `profile` if it belongs to " +
      "something else; this package will not overwrite it.";
  }
  return undefined;
}

export function placementError(_opts: Opts): string | undefined {
  const lines = configFileLines();
  if (!lines) return undefined;
  const n = leadingOptionLine(lines);
  if (n === undefined) return undefined;
  return `refusing to manage ${configPath()}: line ${n}` +
    " sets an option above the first `Host` line, so it applies to " +
    "every host. This package inserts its block at the top of the " +
    "file, which would capture that option into one stanza. Move " +
    "those global options below the managed block, or into an " +
    "explicit `Host *` stanza at the end of the file, and retry.";
}

export interface PreflightChecks {
  adoptError: (opts: Opts) => string | undefined;
  placementError: (opts: Opts) => string | undefined;
}

// Run the local checks. Real create only: build and dry-run must not read
// `~/.ssh/config` at all (§6). The checks are injectable so tests can cover
// the refusal without a doctored home directory.
export function preflight(
  opts: Opts,
  checks: PreflightChecks = { adoptError, placementError },
): Opts {
  const error = checks.adoptError(opts) ?? checks.placementError(opts);
  return error ? { ...opts, "red/exit": 1, "red/err": error } : opts;
}

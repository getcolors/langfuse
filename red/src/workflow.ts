import { readPars, parName } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";
import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": "vultr", "provider-dns": "cloudflare",
  "provider-backend": "local", "compute-prevent-destroy": true,
  workdir: ".colors",
};

// The compute stage's applied `params`, or undefined when no state is
// readable. The create matrix keys on this best-effort read: an unreadable
// state (a fresh clone, a missing backend) counts as absent.
//
// UNTOUCHED: ONCE's create matrix reads `ssh_key_id` with the underscore from
// this map, and a renamed key reads as a key this deployment does not own —
// the standard's never-adopt rule then refuses the deployment's own key. The
// host list is normalized separately below.
export async function stateOutput(opts: Opts): Promise<Record<string, unknown> | undefined> {
  try {
    const outputs = await tofu.outputs(
      tools.toolDir(opts, tools.infrastructureTool),
      tools.backendCredentialEnv(opts),
    );
    const params = outputs.params;
    return params && typeof params === "object" ? params as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

// Events that run against existing machines (delete, rehearse, describe)
// take their addresses from state rather than from a fresh apply.
export async function withStateHosts(opts: Opts): Promise<Opts> {
  const params = tools.normalizeParams(await stateOutput(opts));
  if (!params || params.hosts.length === 0) return opts;
  return { ...opts, "langfuse/hosts": params.hosts, "langfuse/ssh-key-id": params["ssh-key-id"] };
}

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
): Promise<Opts> {
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      (current, _environment, { event, real }) =>
        real && (event === "create" || event === "delete")
          ? validate.secretErrors(current, event)
          : [],
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? [`compute destruction is protected; set ${parName("compute-prevent-destroy")}=false to delete`]
          : [],
    ],
    // The machine key's create matrix and the Vultr preflight run before any
    // template is rendered: an unowned key on disk or at the provider stops
    // the run while stopping is still free.
    afterValidate: async (current, _environment, { event, real }) => {
      if (real && event === "delete") {
        return { ...(await withStateHosts(ssh.withMachineKey(current))), "red/exit": 0 };
      }
      if (real && (event === "rehearse" || event === "describe")) {
        const next = await withStateHosts(ssh.withMachineKey(current));
        const known = next["langfuse/hosts"] as unknown[] | undefined;
        if (!known || known.length === 0) {
          return { ...next, "red/exit": 1, "red/err": `${event}: no compute in state; run create first` };
        }
        return { ...next, "red/exit": 0 };
      }
      if (real && event === "create") {
        let next = await ssh.ensureKey(current, stateOutput);
        if (failed(next)) return next;
        next = await ssh.preflight(ssh.withMachineKey(next));
        if (!failed(next)) next = sshConfig.preflight(next);
        return failed(next) ? next : { ...next, "red/exit": 0 };
      }
      return { ...ssh.withMachineKey(current), "red/exit": 0 };
    },
  }, env);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  switch (runOpts["red/event"]) {
    case "delete": {
      const graph: Record<string, WireDecl> = {
        "langfuse/start": [startStep, "langfuse/ansible"],
        "langfuse/ansible": [tools.ansibleStep, "langfuse/ssh-config"],
        // The `~/.ssh/config` block goes before the destroy, the opposite of
        // the keypair below. A block that outlives its hosts is stale but
        // harmless; a key that predeceases them locks the operator out of
        // machines that still exist. Both orders are deliberate; see
        // standards/ssh-config.md.
        "langfuse/ssh-config": [tools.ansibleLocalStep, "langfuse/dns"],
        // DNS before the compute destroy: a record pointing at a released
        // address is worse than no record.
        "langfuse/dns": [tools.dnsStep, "langfuse/infrastructure"],
        "langfuse/infrastructure": [tools.infrastructureStep, "langfuse/ssh-cleanup"],
        "langfuse/ssh-cleanup": [ssh.cleanupStep],
      };
      return graph[step];
    }
    case "rehearse": {
      const graph: Record<string, WireDecl> = {
        "langfuse/start": [startStep, "langfuse/rehearsal"],
        "langfuse/rehearsal": [tools.rehearsalStep],
      };
      return graph[step];
    }
    case "describe": {
      const graph: Record<string, WireDecl> = {
        "langfuse/start": [startStep, "langfuse/describe"],
        "langfuse/describe": [tools.describeStep],
      };
      return graph[step];
    }
    default: {
      const graph: Record<string, WireDecl> = {
        "langfuse/start": [startStep, "langfuse/infrastructure"],
        // After compute, which is where the addresses first exist, and before
        // the stage that converges the machines — the converge and the
        // acceptance both ride the aliases this stage writes.
        "langfuse/infrastructure": [tools.infrastructureStep, "langfuse/dns"],
        // DNS before the converge: Caddy provisions its certificate over ACME
        // on first start, and the HTTP-01 challenge needs the name to already
        // resolve to the app host.
        "langfuse/dns": [tools.dnsStep, "langfuse/ssh-config"],
        "langfuse/ssh-config": [tools.ansibleLocalStep, "langfuse/ansible"],
        "langfuse/ansible": [tools.ansibleStep, "langfuse/acceptance"],
        "langfuse/acceptance": [tools.acceptanceStep],
      };
      return graph[step];
    }
  }
}

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile ?? ""}/${tool}.tfstate`,
  });
}

export const sideEffecting = [
  "langfuse/infrastructure", "langfuse/dns", "langfuse/ssh-config",
  "langfuse/ansible", "langfuse/acceptance", "langfuse/ssh-cleanup",
  "langfuse/rehearsal", "langfuse/describe",
];

function create() {
  let wf = workflow({ start: "langfuse/start", wireFn });
  wf = adviceAdd(wf, "langfuse/infrastructure", "before", "langfuse.workflow/backend",
    backendAdvice(tools.infrastructureTool));
  wf = adviceAdd(wf, "langfuse/dns", "before", "langfuse.workflow/backend",
    backendAdvice(tools.dnsTool));
  return dryRun.advise(progress.advise(wf), sideEffecting);
}

export const langfuseWorkflow = create();

import { readPars, parName } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight, type PreflightContext } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";
import { compute, computeCluster } from "package-once-red";
import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": validate.defaultComputeProvider, "provider-dns": "cloudflare",
  "provider-backend": "local", "compute-prevent-destroy": true,
  workdir: ".colors",
};

// The recorded `params` in the Compute Cluster Standard's shape.
//
// A state written before this package adopted the standard — `langfuse-vultr`'s
// is one — recorded its machines under `hosts`, with `index: null` on the four
// singletons and no `provider`. ONCE reads exactly `provider`, `ssh_key_id` and
// `nodes`, and refuses `index: null` as an id this package does not declare, so
// the translation happens here, before ONCE sees the state: `hosts` becomes
// `nodes`, every null index becomes 0 (a singleton is node 0 of its role; the
// replicas already carry their ordinal), and the provider is the only one this
// package ever offered. Roles, names and addresses are untouched, and so is
// everything else in the map — `ssh_key_id` above all, which the SSH Keypair
// Standard's create matrix reads verbatim. A `params` that already carries
// `nodes` passes through. Nothing here checks cardinality: a `hosts` list that
// does not describe every machine is ONCE's `nodeErrors` to refuse, through
// `adoptState`.
export function legacyParams(params: compute.Params): compute.Params {
  if (!("hosts" in params) || "nodes" in params) return params;
  const { hosts, ...rest } = params;
  const nodes = (Array.isArray(hosts) ? hosts as Record<string, unknown>[] : [])
    .map((h) => ({ ...h, index: h.index ?? 0 }));
  return { ...rest, provider: validate.defaultComputeProvider, nodes };
}

// The reader ONCE's `readState` takes: the recorded `params` map with the
// underscores kept (`ssh_key_id`, `vpc_ip`) and translated from the
// pre-adoption `hosts` shape by `legacyParams`, or undefined when the state is
// readable and holds no compute. An unreadable backend is whatever `red/tofu`
// throws — the SDK's `StepError` — deliberately uncaught: `readState` turns it
// into `{ error }`, and create treats that differently from delete, rehearse
// and describe. The output read is injectable so a test can put the real
// reader, translation and all, over a recorded state.
export async function stateOutput(
  opts: Opts,
  read: typeof tofu.outputs = tofu.outputs,
): Promise<compute.Params | undefined> {
  const outputs = await read(tools.toolDir(opts, tools.infrastructureTool), tools.backendCredentialEnv(opts));
  const params = outputs.params;
  return params && typeof params === "object" ? legacyParams(params as compute.Params) : undefined;
}

// The events that run against the recorded cluster and adopt it from state:
// delete, rehearse and describe. Create reads the state too, for the SSH
// Keypair Standard's create matrix and the provider switch guard, but takes
// its cluster from the fresh apply.
export const stateEvents = ["delete", "rehearse", "describe"];

// The one thing `startStep` reaches outside the process — the compute state —
// injectable so tests never shell out to tofu. The default is the real reader.
export interface StartDeps {
  reader?: compute.StateReader;
}

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
  deps: StartDeps = {},
): Promise<Opts> {
  const reader = deps.reader ?? stateOutput;
  // The state is read once, up front, on the same defaulted and overlaid opts
  // the validators see — the overlay is what carries the backend credentials —
  // and only for the events that touch a provider or the recorded cluster. The
  // validator and the after-validate share the one read.
  const overlaid = readPars({ ...defaults, ...opts }, env);
  const event = typeof overlaid["red/event"] === "string" ? overlaid["red/event"] as string : undefined;
  const context: PreflightContext = { event, real: !overlaid["red/dry-run"] };
  const readsState = compute.lifecycleEvent(context) ||
    (context.real && event !== undefined && stateEvents.includes(event));
  const state: compute.StateRead = readsState ? await computeCluster.readState(overlaid, reader) : {};
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      // Compute Provider Standard §4 before the credentials: a recorded
      // provider that differs from the selected one reports the actionable
      // error, not a missing token for the provider that was just selected.
      (current, _environment, ctx) => (compute.lifecycleEvent(ctx)
        ? computeCluster.providerValidator(validate.spec, current, state.params,
            () => validate.secretErrors(current, String(ctx.event)))
        : []),
      (current, _environment, { event: e, real }) =>
        real && e === "delete" && current["compute-prevent-destroy"]
          ? [`compute destruction is protected; set ${parName("compute-prevent-destroy")}=false to delete`]
          : [],
    ],
    // The machine key's create matrix and the Vultr preflight run before any
    // template is rendered: an unowned key on disk or at the provider stops
    // the run while stopping is still free. Delete, rehearse and describe
    // adopt the recorded cluster under `once/cluster` instead, failing closed
    // on a backend they cannot read and on a state that does not describe
    // every machine.
    afterValidate: async (current, _environment, { event: e, real }) => {
      if (real && e === "delete") {
        return computeCluster.adoptState(validate.spec, current, "delete", state);
      }
      if (real && (e === "rehearse" || e === "describe")) {
        const next = computeCluster.adoptState(validate.spec, current, e, state);
        if (!failed(next) && next["once/cluster"] == null) {
          // Readable, and nothing recorded: there is nothing to rehearse
          // against or describe.
          return { ...next, "red/exit": 1, "red/err": `${e}: no compute in state; run create first` };
        }
        return next;
      }
      if (real && e === "create") {
        let next = await ssh.ensureKey(current, async () => state.params);
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

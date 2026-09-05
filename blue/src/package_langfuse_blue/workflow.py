"""The graph, the port of io.github.getcolors.langfuse.workflow."""

from __future__ import annotations

import os

from blue import dry_run, progress, tofu
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, failed, workflow
from package_once_blue import compute as once_compute
from package_once_blue import compute_cluster as once_cluster

from . import ssh, ssh_config, tools, validate

DEFAULTS = {"provider-compute": validate.default_compute_provider, "provider-dns": "cloudflare",
            "provider-backend": "local", "compute-prevent-destroy": True,
            "workdir": ".colors"}


def legacy_params(params: dict) -> dict:
    """The recorded `params` in the Compute Cluster Standard's shape.

    A state written before this package adopted the standard —
    `langfuse-vultr`'s is one — recorded its machines under `hosts`, with
    `index: null` on the four singletons and no `provider`. ONCE reads
    exactly `provider`, `ssh_key_id` and `nodes`, and refuses `index: null`
    as an id this package does not declare, so the translation happens here,
    before ONCE sees the state: `hosts` becomes `nodes`, every null index
    becomes 0 (a singleton is node 0 of its role; the replicas already carry
    their ordinal), and the provider is the only one this package ever
    offered. Roles, names and addresses are untouched, and so is everything
    else in the map — `ssh_key_id` above all, which the SSH Keypair
    Standard's create matrix reads verbatim. A `params` that already carries
    `nodes` passes through. Nothing here checks cardinality: a `hosts` list
    that does not describe every machine is ONCE's `node_errors` to refuse,
    through `adopt_state`."""
    if "hosts" not in params or "nodes" in params:
        return params
    hosts = params.get("hosts")
    nodes = [{**h, "index": 0 if h.get("index") is None else h["index"]}
             for h in (hosts if isinstance(hosts, list) else [])]
    rest = {k: v for k, v in params.items() if k != "hosts"}
    return {**rest, "provider": validate.default_compute_provider, "nodes": nodes}


async def state_output(opts: dict) -> dict | None:
    """The reader ONCE's `read_state` takes: the recorded `params` map with
    the underscores kept (`ssh_key_id`, `vpc_ip`) and translated from the
    pre-adoption `hosts` shape by `legacy_params`, or None when the state is
    readable and holds no compute. An unreadable backend is whatever
    `blue.tofu` raises — the SDK's `StepError` — deliberately uncaught:
    `read_state` turns it into `{"error": message}`, and create treats that
    differently from delete, rehearse and describe. Looked up on this module
    at call time, so tests can replace it, or replace `tofu.outputs` beneath
    it to put the real reader, translation and all, over a recorded state."""
    outputs = await tofu.outputs(tools.tool_dir(opts, tools.infrastructure_tool),
                                 tools.backend_credential_env(opts))
    params = (outputs or {}).get("params")
    return legacy_params(params) if isinstance(params, dict) else None


# The events that run against the recorded cluster and adopt it from state:
# delete, rehearse and describe. Create reads the state too, for the SSH
# Keypair Standard's create matrix and the provider switch guard, but takes
# its cluster from the fresh apply.
STATE_EVENTS = ("delete", "rehearse", "describe")


async def start_step(original: dict, env: dict | None = None) -> dict:
    # The state is read once, up front, on the same defaulted and overlaid
    # opts the validators see — the overlay is what carries the backend
    # credentials — and only for the events that touch a provider or the
    # recorded cluster. The validator and the after-validate share the one
    # read. The read goes through this module's attribute so tests can
    # replace it.
    environment = dict(os.environ if env is None else env)
    overlaid = read_pars({**DEFAULTS, **original}, environment)
    event = overlaid.get("blue/event")
    context = {"event": event, "real": not overlaid.get("blue/dry-run")}
    reads_state = (once_compute.lifecycle_event(context)
                   or (context["real"] and event in STATE_EVENTS))
    state = (await once_cluster.read_state(overlaid, state_output)
             if reads_state else {})

    # The machine key's create matrix and the Vultr preflight run before any
    # template is rendered: an unowned key on disk or at the provider stops
    # the run while stopping is still free. Delete, rehearse and describe
    # adopt the recorded cluster under `once/cluster` instead, failing closed
    # on a backend they cannot read and on a state that does not describe
    # every machine.
    async def after(opts, _env, ctx):
        real, event = ctx["real"], ctx["event"]
        if real and event == "delete":
            return once_cluster.adopt_state(validate.spec, opts, "delete", state)
        if real and event in ("rehearse", "describe"):
            opts = once_cluster.adopt_state(validate.spec, opts, event, state)
            if not failed(opts) and opts.get("once/cluster") is None:
                # Readable, and nothing recorded: there is nothing to rehearse
                # against or describe.
                return {**opts, "blue/exit": 1,
                        "blue/err": f"{event}: no compute in state; run create first"}
            return opts
        if real and event == "create":
            async def recorded(_opts):
                return state.get("params")
            opts = await ssh.ensure_key(opts, recorded)
            if failed(opts):
                return opts
            opts = ssh.preflight(ssh.with_machine_key(opts))
            if failed(opts):
                return opts
            opts = ssh_config.preflight(opts)
            if failed(opts):
                return opts
            return {**opts, "blue/exit": 0}
        return {**ssh.with_machine_key(opts), "blue/exit": 0}

    return await preflight(
        original, defaults=DEFAULTS, overlay=read_pars, env=env,
        validators=[
            lambda _o, e, _c: validate.env_errors(e),
            lambda o, _e, _c: validate.state_errors(o),
            # Compute Provider Standard §4 before the credentials: a recorded
            # provider that differs from the selected one reports the
            # actionable error, not a missing token for the provider that was
            # just selected.
            lambda o, _e, c: (once_cluster.provider_validator(
                validate.spec, o, state.get("params"),
                lambda: validate.secret_errors(o, c["event"]))
                if once_compute.lifecycle_event(c) else []),
            lambda o, _e, c: ([f"compute destruction is protected; set "
                               f"{par_name('compute-prevent-destroy')}=false to delete"]
                              if c["real"] and c["event"] == "delete"
                              and o.get("compute-prevent-destroy") else []),
        ],
        after_validate=after)


def wire_fn(step: str, run_opts: dict):
    event = run_opts.get("blue/event")
    if event == "delete":
        return {
            "langfuse/start": (start_step, "langfuse/ansible"),
            "langfuse/ansible": (tools.ansible_step, "langfuse/ssh-config"),
            # The `~/.ssh/config` block goes before the destroy, the opposite
            # of the keypair below. A block that outlives its hosts is stale
            # but harmless; a key that predeceases them locks the operator out
            # of machines that still exist. Both orders are deliberate; see
            # standards/ssh-config.md.
            "langfuse/ssh-config": (tools.ansible_local_step, "langfuse/dns"),
            # DNS before the compute destroy: a record pointing at a released
            # address is worse than no record.
            "langfuse/dns": (tools.dns_step, "langfuse/infrastructure"),
            "langfuse/infrastructure": (tools.infrastructure_step, "langfuse/ssh-cleanup"),
            "langfuse/ssh-cleanup": (ssh.cleanup_step,),
        }.get(step)
    if event == "rehearse":
        return {
            "langfuse/start": (start_step, "langfuse/rehearsal"),
            "langfuse/rehearsal": (tools.rehearsal_step,),
        }.get(step)
    if event == "describe":
        return {
            "langfuse/start": (start_step, "langfuse/describe"),
            "langfuse/describe": (tools.describe_step,),
        }.get(step)
    return {
        "langfuse/start": (start_step, "langfuse/infrastructure"),
        # After compute, which is where the addresses first exist, and before
        # the stage that converges the machines — the converge and the
        # acceptance both ride the aliases this stage writes.
        "langfuse/infrastructure": (tools.infrastructure_step, "langfuse/dns"),
        # DNS before the converge: Caddy provisions its certificate over ACME
        # on first start, and the HTTP-01 challenge needs the name to already
        # resolve to the app host.
        "langfuse/dns": (tools.dns_step, "langfuse/ssh-config"),
        "langfuse/ssh-config": (tools.ansible_local_step, "langfuse/ansible"),
        "langfuse/ansible": (tools.ansible_step, "langfuse/acceptance"),
        "langfuse/acceptance": (tools.acceptance_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda o, tool=tool: tools.tool_dir(o, tool),
        key=lambda o, tool=tool: f"{o.get('profile') or ''}/{tool}.tfstate")


side_effecting = [
    "langfuse/infrastructure", "langfuse/dns", "langfuse/ssh-config",
    "langfuse/ansible", "langfuse/acceptance", "langfuse/ssh-cleanup",
    "langfuse/rehearsal", "langfuse/describe",
]


def create_workflow():
    wf = workflow(start="langfuse/start", wire_fn=wire_fn)
    wf = advice_add(wf, "langfuse/infrastructure", "before", "langfuse.workflow/backend",
                    backend_advice(tools.infrastructure_tool))
    wf = advice_add(wf, "langfuse/dns", "before", "langfuse.workflow/backend",
                    backend_advice(tools.dns_tool))
    return dry_run.advise(progress.advise(wf), side_effecting)


langfuse_workflow = create_workflow()

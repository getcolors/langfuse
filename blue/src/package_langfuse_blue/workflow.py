"""The graph, the port of io.github.getcolors.langfuse.workflow."""

from __future__ import annotations

from blue import dry_run, progress, tofu
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, failed, workflow

from . import ssh, ssh_config, tools, validate

DEFAULTS = {"provider-compute": "vultr", "provider-dns": "cloudflare",
            "provider-backend": "local", "compute-prevent-destroy": True,
            "workdir": ".colors"}


async def state_output(opts: dict) -> dict | None:
    """The compute stage's applied `params`, or None when no state is
    readable. The create matrix keys on this best-effort read: an unreadable
    state (a fresh clone, a missing backend) counts as absent.

    UNTOUCHED: ONCE's create matrix reads `ssh_key_id` with the underscore
    from this map, and a renamed key reads as a key this deployment does not
    own — the standard's never-adopt rule then refuses the deployment's own
    key. The host list is normalized separately below."""
    try:
        outputs = await tofu.outputs(tools.tool_dir(opts, tools.infrastructure_tool),
                                     tools.backend_credential_env(opts))
        return (outputs or {}).get("params")
    except Exception:
        return None


async def with_state_hosts(opts: dict) -> dict:
    """Events that run against existing machines (delete, rehearse, describe)
    take their addresses from state rather than from a fresh apply."""
    params = tools.normalize_params(await state_output(opts)) or {}
    if params.get("hosts"):
        return {**opts, "langfuse/hosts": params["hosts"],
                "langfuse/ssh-key-id": params.get("ssh-key-id")}
    return opts


async def start_step(original: dict, env: dict | None = None) -> dict:
    # The machine key's create matrix and the Vultr preflight run before any
    # template is rendered: an unowned key on disk or at the provider stops
    # the run while stopping is still free.
    async def after(opts, _env, context):
        real, event = context["real"], context["event"]
        if real and event == "delete":
            return {**(await with_state_hosts(ssh.with_machine_key(opts))), "blue/exit": 0}
        if real and event in ("rehearse", "describe"):
            opts = await with_state_hosts(ssh.with_machine_key(opts))
            if not opts.get("langfuse/hosts"):
                return {**opts, "blue/exit": 1,
                        "blue/err": f"{event}: no compute in state; run create first"}
            return {**opts, "blue/exit": 0}
        if real and event == "create":
            opts = await ssh.ensure_key(opts, state_output)
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
            lambda o, _e, c: (validate.secret_errors(o, c["event"])
                              if c["real"] and c["event"] in ("create", "delete") else []),
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

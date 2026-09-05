from __future__ import annotations

import pytest
from blue import tofu
from blue.workflow import StepError
from conftest import LEGACY_RAW, LEGACY_TRANSLATED, PARAMS
from package_langfuse_blue import tools, topology
from package_langfuse_blue import workflow as w
from test_validate import base, creds


def chain(event: str) -> list[str]:
    step, acc = "langfuse/start", []
    while True:
        decl = w.wire_fn(step, {"blue/event": event})
        acc.append(step)
        if len(decl) == 1:
            return acc
        step = decl[1]


def test_create_converges_in_dependency_order():
    c = chain("create")
    assert c == ["langfuse/start", "langfuse/infrastructure", "langfuse/dns",
                 "langfuse/ssh-config", "langfuse/ansible", "langfuse/acceptance"]
    # DNS before the converge: Caddy's ACME challenge needs the name to resolve.
    assert c.index("langfuse/dns") < c.index("langfuse/ansible")


def test_delete_removes_the_config_block_before_and_the_key_after_the_destroy():
    c = chain("delete")
    assert c == ["langfuse/start", "langfuse/ansible", "langfuse/ssh-config", "langfuse/dns",
                 "langfuse/infrastructure", "langfuse/ssh-cleanup"]
    assert c.index("langfuse/ssh-config") < c.index("langfuse/infrastructure")
    assert c.index("langfuse/infrastructure") < c.index("langfuse/ssh-cleanup")


def test_rehearse_and_describe_run_against_state():
    assert chain("rehearse") == ["langfuse/start", "langfuse/rehearsal"]
    assert chain("describe") == ["langfuse/start", "langfuse/describe"]


def test_every_side_effecting_step_is_dry_run_advised():
    for s in ["langfuse/infrastructure", "langfuse/dns", "langfuse/ssh-config", "langfuse/ansible",
              "langfuse/acceptance", "langfuse/ssh-cleanup", "langfuse/rehearsal", "langfuse/describe"]:
        assert s in w.side_effecting, f"{s} must be dry-run advised"
    assert w.backend_advice(tools.dns_tool) is not None


# --- the legacy state ---------------------------------------------------------


async def test_the_reader_translates_the_pre_adoption_hosts_into_nodes(monkeypatch):
    # `hosts` becomes `nodes`, a singleton's null index becomes 0, the
    # provider is the only one this package ever offered, and everything else
    # — the replica ordinals, every name and address, `ssh_key_id` — is
    # untouched.
    assert w.legacy_params(LEGACY_RAW) == LEGACY_TRANSLATED
    # A params that already carries nodes passes through.
    assert w.legacy_params(PARAMS) == PARAMS
    no_provider = {k: v for k, v in PARAMS.items() if k != "provider"}
    assert w.legacy_params(no_provider) == no_provider
    # Nothing here checks cardinality; that is ONCE's, through adopt_state.
    assert len(w.legacy_params({"hosts": LEGACY_RAW["hosts"][:5]})["nodes"]) == 5

    # The real reader runs the translation on what tofu delivers.
    async def recorded(_dir, _env):
        return {"params": LEGACY_RAW}
    monkeypatch.setattr(tofu, "outputs", recorded)
    assert await w.state_output(base) == LEGACY_TRANSLATED

    async def empty(_dir, _env):
        return {}
    monkeypatch.setattr(tofu, "outputs", empty)
    assert await w.state_output(base) is None


# --- the lifecycle against the compute state ----------------------------------

# The compute state is read once per run, through `workflow.state_output`, on
# a real create, delete, rehearse or describe. Every lifecycle test stubs it:
# None is a readable state holding no compute, a dict is a recorded `params`,
# and a raise is a backend that cannot be read.


@pytest.fixture
def state(monkeypatch):
    def install(params):
        async def stub(_opts):
            return params
        monkeypatch.setattr(w, "state_output", stub)
    return install


@pytest.fixture
def recorded(monkeypatch):
    # The real reader over a stubbed `tofu output -json`, so the legacy
    # translation is on the path.
    def install(raw):
        async def stub(_dir, _env):
            return {"params": raw}
        monkeypatch.setattr(tofu, "outputs", stub)
    return install


@pytest.fixture
def unreadable(monkeypatch):
    # The shape `blue.tofu` raises: the SDK's StepError. Only that is an
    # unreadable backend; anything else propagates as a defect.
    async def boom(_opts):
        raise StepError("tofu output failed: no backend")
    monkeypatch.setattr(w, "state_output", boom)


def deleting(**overrides) -> dict:
    return {**base, **creds, "blue/event": "delete", "compute-prevent-destroy": False, **overrides}


async def test_build_and_dry_run_never_touch_the_state(unreadable):
    # A raising state read proves nothing on these paths reaches the backend,
    # and the machine key stays the placeholder rather than the operator's home.
    for opts in [{**base, "blue/event": "build"},
                 {**base, "blue/event": "create", "blue/dry-run": True},
                 {**base, "blue/event": "delete", "blue/dry-run": True, "compute-prevent-destroy": False},
                 {**base, "blue/event": "rehearse", "blue/dry-run": True},
                 {**base, "blue/event": "describe", "blue/dry-run": True}]:
        result = await w.start_step(opts, env={})
        assert result["blue/exit"] == 0, result.get("blue/err")
        assert str(result["ssh-public-key-path"]).startswith("/home/build-placeholder")
        # A build renders the fallbacks; it adopts nothing.
        assert "once/cluster" not in result


async def test_a_real_create_requires_the_credentials(state):
    state(None)
    result = await w.start_step({**base, "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_VULTR_API_KEY" in result["blue/err"]
    assert "COLORS_PAR_CLOUDFLARE_API_TOKEN" in result["blue/err"]
    assert "COLORS_PAR_LANGFUSE_ENCRYPTION_KEY" in result["blue/err"]


async def test_a_provider_switch_is_refused_before_the_credentials(state):
    # Provider switching is a rebuild, never an apply. The validator order is
    # the thing under test: the actionable error, not a missing token for the
    # provider that was just selected.
    state({**PARAMS, "provider": "digitalocean"})
    for event in ["create", "delete"]:
        result = await w.start_step(
            {**base, "blue/event": event, "compute-prevent-destroy": False}, env={})
        assert result["blue/exit"] == 2, event
        assert ("state holds a digitalocean machine; set provider-compute back to "
                "digitalocean and delete first") in result["blue/err"]
        assert "required credential is not set" not in result["blue/err"]


async def test_legacy_state_is_accepted_on_the_default_provider(state, tmp_path, monkeypatch):
    # A `params` without `provider` is a Vultr cluster: a create checks its
    # credentials as usual, a delete adopts it.
    monkeypatch.setenv("HOME", str(tmp_path))
    legacy = {k: v for k, v in PARAMS.items() if k != "provider"}
    state(legacy)
    create = await w.start_step({**base, "blue/event": "create"}, env={})
    assert "state holds" not in create["blue/err"]
    assert "required credential is not set" in create["blue/err"]
    delete = await w.start_step(deleting(), env={})
    assert delete["blue/exit"] == 0, delete.get("blue/err")
    assert delete["once/cluster"] == legacy


async def test_a_real_delete_adopts_the_live_deployments_pre_adoption_state(
        recorded, tmp_path, monkeypatch):
    # The recorded shape of langfuse-vultr, through the real reader: six hosts
    # under `hosts`, the singletons with `index: null`. The delete addresses
    # every machine the deployment ever created.
    monkeypatch.setenv("HOME", str(tmp_path))
    recorded(LEGACY_RAW)
    result = await w.start_step(deleting(), env={})
    assert result["blue/exit"] == 0, result.get("blue/err")
    assert result["once/cluster"] == LEGACY_TRANSLATED
    hs = tools.hosts(result)
    assert [h["ip"] for h in hs] == [
        "203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4", "203.0.113.5", "203.0.113.6"]
    assert topology.host_of(hs, "app")["vpc-ip"] == "10.50.0.8"
    assert topology.host_of(hs, "clickhouse", 1)["name"] == "langfuse-vultr-clickhouse-1"
    # Rehearse and describe adopt it the same way.
    for event in ["rehearse", "describe"]:
        adopted = await w.start_step({**base, "blue/event": event}, env={})
        assert adopted["blue/exit"] == 0, adopted.get("blue/err")
        assert adopted["once/cluster"] == LEGACY_TRANSLATED
    # A hosts list that does not describe every machine is refused by ONCE,
    # not guessed.
    recorded({**LEGACY_RAW, "hosts": [h for h in LEGACY_RAW["hosts"] if h["role"] != "app"]})
    refused = await w.start_step(deleting(), env={})
    assert refused["blue/exit"] == 1
    assert refused["blue/err"] == "the compute stage did not report nodes this package declares: app-0"


async def test_an_unreadable_backend_counts_as_no_state_on_create(unreadable):
    # A fresh clone has no readable state and must still be able to create.
    result = await w.start_step({**base, "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "could not read" not in result["blue/err"]
    assert "state holds" not in result["blue/err"]
    assert "COLORS_PAR_VULTR_API_KEY" in result["blue/err"]


async def test_a_real_create_on_a_fresh_work_directory_reports_the_credentials_not_a_crash(tmp_path):
    # No state stub: the real `state_output` runs against a work directory
    # that holds no stage yet, as a fresh clone's does. The SDK's output read
    # raises its StepError there, which ONCE's `read_state` counts as an
    # unreadable state, so the create reports its credentials.
    result = await w.start_step({**base, "workdir": str(tmp_path), "blue/event": "create"}, env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_VULTR_API_KEY" in result["blue/err"]
    assert "could not read" not in result["blue/err"]


async def test_an_unreadable_backend_fails_a_real_delete_rehearse_and_describe_closed(unreadable):
    # Before adoption every one of these swallowed the read and went on: a
    # delete would have rendered the cleanup play against the documentation
    # addresses, and rehearse and describe reported "no compute in state" for
    # a backend they merely could not reach.
    result = await w.start_step(deleting(), env={})
    assert result["blue/exit"] == 1
    assert "could not read the infrastructure state for the delete cleanup" in result["blue/err"]
    assert "no backend" in result["blue/err"]
    for event in ["rehearse", "describe"]:
        r = await w.start_step({**base, "blue/event": event}, env={})
        assert r["blue/exit"] == 1, event
        assert f"could not read the infrastructure state for {event}" in r["blue/err"]
        assert "no compute in state" not in r["blue/err"]


async def test_a_real_delete_adopts_the_recorded_cluster(state, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    state(PARAMS)
    adopted = await w.start_step(deleting(), env={})
    assert adopted["blue/exit"] == 0, adopted.get("blue/err")
    # The whole recorded params, extension keys and all.
    assert adopted["once/cluster"] == PARAMS
    assert [h["ip"] for h in tools.hosts(adopted)] == [
        "1.1.1.1", "1.1.1.2", "1.1.1.3", "1.1.1.4", "1.1.1.5", "1.1.1.6"]
    # A readable state without compute adopts nothing, and the cleanup play
    # skips itself.
    state(None)
    empty = await w.start_step(deleting(), env={})
    assert empty["blue/exit"] == 0, empty.get("blue/err")
    assert "once/cluster" not in empty
    # Rehearse and describe need a recorded cluster.
    for event in ["rehearse", "describe"]:
        state(None)
        none = await w.start_step({**base, "blue/event": event}, env={})
        assert none["blue/exit"] == 1
        assert none["blue/err"] == f"{event}: no compute in state; run create first"
        state(PARAMS)
        some = await w.start_step({**base, "blue/event": event}, env={})
        assert some["blue/exit"] == 0, some.get("blue/err")
        assert some["once/cluster"] == PARAMS


async def test_a_real_delete_refuses_a_state_that_does_not_describe_every_machine(state):
    # Six machines are declared; a state that reports five is not a smaller
    # deployment to tear down but a state that cannot be trusted. ONCE's
    # message, unreworded.
    state({**PARAMS, "nodes": PARAMS["nodes"][:5]})
    partial = await w.start_step(deleting(), env={})
    assert partial["blue/exit"] == 1
    assert partial["blue/err"] == "the compute stage did not report nodes this package declares: app-0"
    # A machine without an address is refused the same way.
    state({**PARAMS, "nodes": [*PARAMS["nodes"][:3], {**PARAMS["nodes"][3], "vpc_ip": ""},
                               *PARAMS["nodes"][4:]]})
    incomplete = await w.start_step(deleting(), env={})
    assert incomplete["blue/exit"] == 1
    assert ("did not report a complete node (ip, vpc_ip, name, user, sudoer) for clickhouse-1"
            in incomplete["blue/err"])
    # A legacy index: null that was not translated is an undeclared id.
    state({**PARAMS, "nodes": [*PARAMS["nodes"][:5], {**PARAMS["nodes"][5], "index": None}]})
    untranslated = await w.start_step(deleting(), env={})
    assert untranslated["blue/exit"] == 1
    assert "did not report nodes this package declares: app-0" in untranslated["blue/err"]
    assert "reported nodes this package does not declare: app-null" in untranslated["blue/err"]

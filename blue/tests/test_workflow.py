from __future__ import annotations

from package_langfuse_blue import tools
from package_langfuse_blue import workflow as w


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


def test_normalized_params_keep_the_hosts_but_state_output_keeps_once_s_key():
    # ONCE reads `ssh_key_id` with the underscore from the state map; only the
    # host list is renamed into this package's vocabulary.
    raw = {"ssh_key_id": "k", "hosts": [{"role": "app", "index": None,
                                         "ip": "1.1.1.1", "vpc_ip": "10.0.0.1"}]}
    norm = tools.normalize_params(raw)
    assert raw["ssh_key_id"] == "k"
    assert norm["ssh-key-id"] == "k"
    assert norm["hosts"][0]["vpc-ip"] == "10.0.0.1"
    assert w.backend_advice(tools.dns_tool) is not None

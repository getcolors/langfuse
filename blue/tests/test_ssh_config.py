from __future__ import annotations

from package_langfuse_blue import ssh_config as sc
from package_langfuse_blue import topology

opts = {"profile": "langfuse-test", "provider-compute": "vultr", "vultr-vpc-subnet": "10.50.0.0/24"}


def test_the_bare_profile_plus_one_alias_per_machine():
    assert sc.aliases(opts) == [
        "langfuse-test", "langfuse-test-neon", "langfuse-test-redis",
        "langfuse-test-clickhouse-0", "langfuse-test-clickhouse-1", "langfuse-test-clickhouse-2",
        "langfuse-test-app"]
    assert sc.identity_file(opts) == "~/.ssh/langfuse-test"
    # The aliases follow the profile, not the machine label (Compute Cluster
    # Standard §6).
    renamed = {**opts, "vultr-name": "custom"}
    assert sc.machine_alias(renamed, {"role": "clickhouse", "index": 1, "name": "custom-clickhouse-1"}) \
        == "langfuse-test-clickhouse-1"
    assert sc.machine_alias(renamed, {"role": "app", "index": None, "name": "custom-app"}) == "langfuse-test-app"
    assert [sc.machine_alias(renamed, h) for h in topology.hosts(renamed)] == sc.aliases(renamed)[1:]


def test_a_foreign_stanza_for_any_alias_is_detected():
    # The marker is the profile; the stanza searched for may be a machine alias.
    lines = ["Host other", "  HostName 1.2.3.4",
             "Host langfuse-test-clickhouse-1", "  HostName 5.6.7.8"]
    assert sc.foreign_stanza_line(lines, "langfuse-test-clickhouse-1", "langfuse-test") == 3
    assert sc.foreign_stanza_line(lines, "langfuse-test-app", "langfuse-test") is None
    # Our own block is skipped, whichever alias it names.
    lines = [sc.begin_marker("langfuse-test"),
             "Host langfuse-test", "Host langfuse-test-redis",
             sc.end_marker("langfuse-test")]
    assert sc.foreign_stanza_line(lines, "langfuse-test-redis", "langfuse-test") is None


def test_a_global_option_above_the_first_host_blocks_the_insert():
    assert sc.leading_option_line(["# comment", "ForwardAgent yes", "Host x"]) == 2
    assert sc.leading_option_line(["", "# c", "Host x", "  ForwardAgent yes"]) is None

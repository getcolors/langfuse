from __future__ import annotations

from conftest import PARAMS
from package_langfuse_blue import topology as t
from package_once_blue import compute_cluster as once_cluster

opts = {"profile": "langfuse-test", "provider-compute": "vultr", "vultr-vpc-subnet": "10.50.0.0/24"}


def test_the_spec_describes_six_vultr_machines_in_four_roles():
    # The Compute Cluster Standard's spec-content test: the shape ONCE is
    # handed is data, and this is what that data must say.
    assert once_cluster.spec_errors(t.spec) == []
    # Play order, app last: it is the consumer of the other three tiers.
    assert t.spec["roles"] == [
        {"role": "neon", "count": 1, "fallback_offset": 10},
        {"role": "redis", "count": 1, "fallback_offset": 11},
        {"role": "clickhouse", "count": 3, "fallback_offset": 20},
        {"role": "app", "count": 1, "fallback_offset": 12}]
    # The bare profile alias reaches the app host.
    assert once_cluster.entry_id(t.spec) == {"role": "app", "index": 0}
    # vultr-http-sources is the package's own rule: it accepts the symbolic cloudflare.
    assert t.spec["sources"] == {"non_empty": ["ssh-sources"], "may_be_empty": []}
    assert t.spec["default"] == "vultr"
    assert list(t.spec["registry"]) == ["vultr"]
    # Every database connection crosses a VPC this package creates from vultr-vpc-subnet.
    assert t.spec["registry"]["vultr"]["network"] == {"mode": "created", "key": "vultr-vpc-subnet"}
    # A created network cuts its fallbacks from the CIDR key, not a stand-in.
    assert "fallback_subnet" not in t.spec
    assert t.spec["registry"]["vultr"]["secrets"] == ["vultr-api-key"]
    # Every key the compute template interpolates, and nothing the standards make optional.
    assert t.spec["registry"]["vultr"]["required"] == [
        "vultr-region", "vultr-os-id", "vultr-vpc-subnet",
        "vultr-plan-neon", "vultr-plan-redis", "vultr-plan-clickhouse", "vultr-plan-app",
        "vultr-ssh-sources", "vultr-http-sources"]
    assert t.ROLES == ["neon", "redis", "clickhouse", "app"]


def test_six_machines_in_play_order():
    hs = t.hosts(opts)
    assert len(hs) == 6
    assert [h["name"] for h in hs] == [
        "langfuse-test-neon", "langfuse-test-redis",
        "langfuse-test-clickhouse-0", "langfuse-test-clickhouse-1", "langfuse-test-clickhouse-2",
        "langfuse-test-app"]
    # The app host is last: it is the consumer of the other three tiers.
    assert hs[-1]["role"] == "app"
    # A singleton carries no index; a replica carries its ordinal.
    assert [h["index"] for h in hs] == [None, None, 0, 1, 2, None]


def test_fallbacks_are_the_pre_adoption_addresses():
    # ONCE's fallbacks at this package's offsets: TEST-NET-1 publicly, the VPC
    # subnet privately — the same six addresses the goldens carried before
    # adoption, because the ClickHouse cluster config and the firewall data
    # are rendered from them.
    hs = t.hosts(opts)
    assert [h["ip"] for h in hs] == [
        "192.0.2.10", "192.0.2.11", "192.0.2.20", "192.0.2.21", "192.0.2.22", "192.0.2.12"]
    assert [h["vpc-ip"] for h in hs] == [
        "10.50.0.10", "10.50.0.11", "10.50.0.20", "10.50.0.21", "10.50.0.22", "10.50.0.12"]
    assert not any("vpc_ip" in h for h in hs)
    assert all(h["user"] == "root" and h["sudoer"] == "root" for h in hs)


def test_compute_name_honours_the_override():
    assert t.compute_name(opts) == "langfuse-test"
    assert t.compute_name({**opts, "vultr-name": "custom"}) == "custom"
    assert t.compute_name({**opts, "vultr-name": "REPLACE_ME"}) == "langfuse-test"
    assert t.machine_name({**opts, "vultr-name": "custom"}, "app") == "custom-app"
    assert t.machine_name(opts, "clickhouse", 2) == "langfuse-test-clickhouse-2"


def test_hosts_on_a_real_run_come_from_state_in_the_renderers_spelling():
    # ONCE hands back every node as recorded, `vpc_ip` and index 0 and all;
    # this package's templates were written against `vpc-ip` and the
    # inventory writes an ordinal for the replicas alone, so the wrapper
    # respells the one key and blanks a singleton's index. Nothing else is
    # touched: the name is the label the template gave the instance, never
    # recomputed, and extension fields ride through.
    recorded = {**PARAMS, "nodes": [
        {**PARAMS["nodes"][0], "extra": "kept"},
        *PARAMS["nodes"][1:5],
        {**PARAMS["nodes"][5], "name": "renamed-in-console"}]}
    hs = t.hosts(opts, recorded)
    assert t.host_of(hs, "app")["vpc-ip"] == "10.50.0.7"
    assert t.host_of(hs, "clickhouse", 1)["ip"] == "1.1.1.4"
    assert [h["index"] for h in t.clickhouse_hosts(hs)] == [0, 1, 2]
    assert not any("vpc_ip" in h for h in hs)
    assert t.host_of(hs, "app")["name"] == "renamed-in-console"
    assert t.host_of(hs, "neon")["extra"] == "kept"
    assert [h["index"] for h in hs] == [None, None, 0, 1, 2, None]


def test_ports_come_from_desired_state_with_defaults():
    assert t.app_clickhouse_ports(opts) == [8123, 9000]
    assert t.clickhouse_internal_ports(opts) == [9000, 9009, 9181, 9234]
    assert t.app_clickhouse_ports({**opts, "clickhouse-http-port": 8124,
                                   "clickhouse-native-port": "9001"}) == [8124, 9001]
    assert t.redis_port(opts) == 6379

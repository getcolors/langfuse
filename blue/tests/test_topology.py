from __future__ import annotations

import re

from package_langfuse_blue import topology as t

opts = {"profile": "langfuse-test", "vultr-vpc-subnet": "10.50.0.0/24"}


def test_six_machines_in_play_order():
    hs = t.hosts(opts)
    assert len(hs) == 6
    assert [h["name"] for h in hs] == [
        "langfuse-test-neon", "langfuse-test-redis",
        "langfuse-test-clickhouse-0", "langfuse-test-clickhouse-1", "langfuse-test-clickhouse-2",
        "langfuse-test-app"]
    # The app host is last: it is the consumer of the other three tiers.
    assert hs[-1]["role"] == "app"


def test_fallbacks_are_fixed_and_inside_the_subnet():
    hs = t.hosts(opts)
    assert all(re.fullmatch(r"192\.0\.2\.\d+", h["ip"]) for h in hs)
    assert all(re.fullmatch(r"10\.50\.0\.\d+", h["vpc-ip"]) for h in hs)
    assert len({h["vpc-ip"] for h in hs}) == 6, "no two placeholders collide"


def test_compute_name_honours_the_override():
    assert t.compute_name(opts) == "langfuse-test"
    assert t.compute_name({**opts, "vultr-name": "custom"}) == "custom"
    assert t.compute_name({**opts, "vultr-name": "REPLACE_ME"}) == "langfuse-test"


def test_real_params_replace_the_fallbacks_by_role_and_index():
    params = [{"role": "neon", "index": None, "ip": "1.1.1.1", "vpc-ip": "10.50.0.2"},
              {"role": "redis", "index": None, "ip": "1.1.1.2", "vpc-ip": "10.50.0.3"},
              {"role": "clickhouse", "index": 0, "ip": "1.1.1.3", "vpc-ip": "10.50.0.4"},
              {"role": "clickhouse", "index": 1, "ip": "1.1.1.4", "vpc-ip": "10.50.0.5"},
              {"role": "clickhouse", "index": 2, "ip": "1.1.1.5", "vpc-ip": "10.50.0.6"},
              {"role": "app", "index": None, "ip": "1.1.1.6", "vpc-ip": "10.50.0.7"}]
    hs = t.hosts(opts, params)
    assert t.host_of(hs, "app")["vpc-ip"] == "10.50.0.7"
    assert t.host_of(hs, "clickhouse", 1)["ip"] == "1.1.1.4"
    assert [h["index"] for h in t.clickhouse_hosts(hs)] == [0, 1, 2]
    assert t.missing_host_error(opts, params) is None


def test_a_partial_compute_output_is_refused():
    # A two-replica cluster config forms no quorum; refuse rather than render.
    params = [{"role": "neon", "index": None, "ip": "1.1.1.1", "vpc-ip": "10.50.0.2"},
              {"role": "clickhouse", "index": 0, "ip": "1.1.1.3", "vpc-ip": "10.50.0.4"}]
    assert re.search("clickhouse-1", t.missing_host_error(opts, params))
    assert re.search("app", t.missing_host_error(opts, params))
    # An address-less host counts as missing.
    assert t.missing_host_error(opts, [{"role": "neon", "index": None, "ip": "", "vpc-ip": "10.50.0.2"}])


def test_ports_come_from_desired_state_with_defaults():
    assert t.app_clickhouse_ports(opts) == [8123, 9000]
    assert t.clickhouse_internal_ports(opts) == [9000, 9009, 9181, 9234]
    assert t.app_clickhouse_ports({**opts, "clickhouse-http-port": 8124,
                                   "clickhouse-native-port": "9001"}) == [8124, 9001]
    assert t.redis_port(opts) == 6379

from __future__ import annotations

import json
import re

from conftest import PARAMS
from package_langfuse_blue import tools, topology

opts = {"profile": "langfuse-test", "provider-compute": "vultr", "vultr-vpc-subnet": "10.50.0.0/24",
        "langfuse-host": "langfuse.example.com", "cloudflare-proxied": True}

applied = {**opts, "once/cluster": PARAMS}


def test_the_neon_bundle_renders_from_the_dependency_not_a_local_copy():
    specs = tools.neon_specs("/tmp/stage", {})
    assert len(specs) == 12
    for spec in specs:
        name = spec["template"]["name"]
        assert name.startswith("neon/tools/ansible/"), f"{name} must come from the neon dependency"
        assert "/neon/" in spec["target"]
        file = name[len("neon/tools/ansible/"):]
        assert spec["template"]["content"] == \
            (tools.NEON_ROOT / "tools" / "ansible" / file).read_text()
    # And the colliding name really does differ, so the check above is not
    # passing by accident.
    local = tools.ROOT / "tools" / "ansible" / "cleanup.yml"
    assert local.is_file()
    assert local.read_text() != (tools.NEON_ROOT / "tools" / "ansible" / "cleanup.yml").read_text()


def test_every_package_template_is_listed_once():
    assert len(tools.ANSIBLE_FILES) == len(set(tools.ANSIBLE_FILES))


def test_the_inventory_has_four_groups_and_only_host_vars():
    inv = json.loads(tools.inventory(opts, topology.hosts(opts)))
    groups = inv["all"]["children"]
    assert set(groups) == {"neon", "redis", "clickhouse", "app"}
    assert len(groups["clickhouse"]["hosts"]) == 3
    assert len(groups["app"]["hosts"]) == 1
    # Every value is a HOST var; no group carries variables.
    assert all("vars" not in g for g in groups.values())
    ch1 = groups["clickhouse"]["hosts"]["langfuse-test-clickhouse-1"]
    assert ch1["ordinal"] == 1
    assert ch1["role"] == "clickhouse"
    assert re.fullmatch(r"10\.50\.0\.\d+", ch1["vpc_ip"])
    # Singletons carry no ordinal.
    assert "ordinal" not in groups["app"]["hosts"]["langfuse-test-app"]


def test_the_adopted_cluster_reaches_the_renderers_respelled():
    # ONCE records `vpc_ip` and `ssh_key_id` with underscores — the latter is
    # the SSH Keypair Standard's contract with ONCE's create preflight and
    # must stay verbatim on the params map. The renderers read `vpc-ip`, so
    # the host wrapper respells that one key, and the inventory gets exactly
    # the bytes it got before adoption: an ordinal for the replicas alone.
    hs = tools.hosts(applied)
    groups = json.loads(tools.inventory(applied, hs))["all"]["children"]
    assert applied["once/cluster"]["ssh_key_id"] == "7692e92a"
    assert hs[0]["vpc-ip"] == "10.50.0.2"
    assert not any("vpc_ip" in h for h in hs)
    assert groups["app"]["hosts"]["langfuse-test-app"]["vpc_ip"] == "10.50.0.7"
    assert "ordinal" not in groups["app"]["hosts"]["langfuse-test-app"]
    assert groups["clickhouse"]["hosts"]["langfuse-test-clickhouse-2"]["ordinal"] == 2


def test_the_compute_stage_refuses_anything_but_the_whole_cluster():
    # The real create's infrastructure step hands its tofu outputs here. No
    # `params` output at all, or a machine set that is partial or incomplete,
    # is exit 1 with ONCE's message rather than a ClickHouse cluster config
    # against 192.0.2.20; the whole cluster lands under `once/cluster`.
    def result(p):
        return {"blue/exit": 0, "tofu/outputs": {"params": p} if p else {}}

    none = tools.resolved_cluster(opts, result(None))
    assert none["blue/exit"] == 1
    assert none["blue/err"] == ("compute produced no params output; refusing to "
                                "converge against the documentation addresses")
    # A partial cluster: two replicas form no quorum.
    partial = tools.resolved_cluster(opts, result({**PARAMS, "nodes": [
        n for n in PARAMS["nodes"] if not (n["role"] == "clickhouse" and n["index"] == 2)]}))
    assert partial["blue/exit"] == 1
    assert partial["blue/err"] == "the compute stage did not report nodes this package declares: clickhouse-2"
    incomplete = tools.resolved_cluster(opts, result({**PARAMS, "nodes": [
        *PARAMS["nodes"][:5], {**PARAMS["nodes"][5], "vpc_ip": ""}]}))
    assert incomplete["blue/exit"] == 1
    assert "did not report a complete node (ip, vpc_ip, name, user, sudoer) for app-0" in incomplete["blue/err"]
    whole = tools.resolved_cluster(opts, result(PARAMS))
    assert whole["blue/exit"] == 0
    assert whole["once/cluster"] == PARAMS


def test_the_ssh_config_block_carries_the_profile_first():
    hs = tools.ssh_config_hosts(opts, topology.hosts(opts))
    assert hs[0]["name"] == "langfuse-test"
    assert hs[0]["ip"] == topology.host_of(topology.hosts(opts), "app")["ip"]
    assert len(hs) == 7
    assert [h["name"] for h in hs] == [
        "langfuse-test", "langfuse-test-neon", "langfuse-test-redis",
        "langfuse-test-clickhouse-0", "langfuse-test-clickhouse-1", "langfuse-test-clickhouse-2",
        "langfuse-test-app"]
    assert [h["ip"] for h in hs] == [
        "192.0.2.12", "192.0.2.10", "192.0.2.11", "192.0.2.20", "192.0.2.21", "192.0.2.22", "192.0.2.12"]
    # On a real run the addresses are the recorded ones.
    assert [h["ip"] for h in tools.ssh_config_hosts(applied, tools.hosts(applied))] == [
        "1.1.1.6", "1.1.1.1", "1.1.1.2", "1.1.1.3", "1.1.1.4", "1.1.1.5", "1.1.1.6"]


async def test_a_delete_with_no_compute_in_state_stops_instead_of_converging():
    # A readable state without compute adopted nothing: there is nothing to
    # stop, and the cleanup play would only fail against the placeholder
    # addresses.
    result = await tools.ansible_step({**opts, "blue/event": "delete"})
    assert result["blue/exit"] == 0


def test_http_sources_resolve_explicit_lists_verbatim():
    resolved = tools.http_sources({"vultr-http-sources": ["1.2.3.0/24", "::/0"]})
    assert resolved["source"] == "explicit"
    assert resolved["ranges"] == ["1.2.3.0/24", "::/0"]


def test_the_cloudflare_fallback_is_never_permissive():
    assert "0.0.0.0/0" not in tools.cloudflare_ranges_fallback
    assert "::/0" not in tools.cloudflare_ranges_fallback
    assert len(tools.cloudflare_ranges_fallback) > 10


def test_the_dns_record_is_proxied_with_an_automatic_ttl():
    doc = json.loads(tools.dns_json(opts, "203.0.113.5"))
    body = doc["resource"]["cloudflare_dns_record"]["langfuse"]
    assert body["zone_id"] == "${data.cloudflare_zone.zone.id}"
    assert body["name"] == "langfuse.example.com"
    assert body["content"] == "203.0.113.5"
    assert body["ttl"] == 1
    assert body["proxied"] is True


def test_the_operator_path_ingests_one_otlp_root_span():
    # v4 ingestion is OTLP: one root span, 32-hex trace id, tagged so the
    # read-back can find it; the legacy batch endpoint rejects everything.
    t, s = tools.hex_id(16), tools.hex_id(8)
    body = json.loads(tools.otlp_body(t, s))
    span = body["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    assert re.fullmatch(r"[0-9a-f]{32}", t)
    assert re.fullmatch(r"[0-9a-f]{16}", s)
    assert span["traceId"] == t
    assert any(a["key"] == "langfuse.trace.tags" for a in span["attributes"])
    kind = next(a for a in span["attributes"] if a["key"] == "langfuse.observation.type")
    assert kind["value"]["stringValue"] == "span"


def test_observation_rows_are_counted_defensively():
    assert tools.observations_count({"out": '{"data":[{},{}]}\n200'}) == 2
    assert tools.observations_count({"out": "not json\n502"}) == 0


def test_json_numbers_render_the_way_cheshire_does():
    # Cheshire writes a double through Double.toString; green never emits one
    # today, but a tofu output or a YAML float must not silently diverge.
    assert tools._pretty(1) == "1"
    assert tools._pretty(1.0) == "1.0"
    assert tools._pretty(0.5) == "0.5"
    assert tools._pretty(12345678.0) == "1.2345678E7"
    assert tools._pretty(0.0001) == "1.0E-4"
    assert tools._pretty(True) == "true"
    assert tools._pretty([]) == "[ ]"
    assert tools._pretty({}) == "{ }"

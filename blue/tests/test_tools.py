from __future__ import annotations

import json
import re

from package_langfuse_blue import tools, topology

opts = {"profile": "langfuse-test", "vultr-vpc-subnet": "10.50.0.0/24",
        "langfuse-host": "langfuse.example.com", "cloudflare-proxied": True}


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


def test_normalize_params_speaks_kebab_case():
    p = tools.normalize_params({"ssh_key_id": "k",
                                "hosts": [{"role": "clickhouse", "index": 1.0,
                                           "ip": "1.1.1.1", "vpc_ip": "10.0.0.1"}]})
    assert p["ssh-key-id"] == "k"
    assert p["hosts"][0]["index"] == 1
    assert isinstance(p["hosts"][0]["index"], int)
    assert p["hosts"][0]["vpc-ip"] == "10.0.0.1"


def test_the_ssh_config_block_carries_the_profile_first():
    hs = tools.ssh_config_hosts(opts, topology.hosts(opts))
    assert hs[0]["name"] == "langfuse-test"
    assert hs[0]["ip"] == topology.host_of(topology.hosts(opts), "app")["ip"]
    assert len(hs) == 7


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

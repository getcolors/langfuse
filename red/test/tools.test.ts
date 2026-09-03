import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as tools from "../src/tools.ts";
import * as topology from "../src/topology.ts";

const opts = { profile: "langfuse-test", "vultr-vpc-subnet": "10.50.0.0/24",
  "langfuse-host": "langfuse.example.com", "cloudflare-proxied": true };

describe("tools", () => {
  test("the neon bundle renders from the dependency, not a local copy", () => {
    // Every storage-tier template must be the installed `package-neon-red`'s
    // bytes. Name-checking alone would not catch a second copy, because one
    // of these — `cleanup.yml` — shares a basename with a file this package
    // owns; that collision is why the bundle renders into its own directory.
    const dependency = join(
      dirname(Bun.resolveSync("package-neon-red", import.meta.dir)),
      "..", "resources", "tools", "ansible",
    );
    const specs = tools.neonSpecs("/tmp/stage", {});
    expect(specs.length).toBe(12);
    for (const spec of specs) {
      const template = spec.template as { name: string; content: string };
      expect(template.name.startsWith("neon/ansible/")).toBe(true);
      expect(spec.target).toContain("/neon/");
      const file = template.name.slice("neon/ansible/".length);
      expect(template.content).toBe(readFileSync(join(dependency, file), "utf8"));
    }
    expect(tools.ansibleTemplate("cleanup.yml").content)
      .not.toBe(readFileSync(join(dependency, "cleanup.yml"), "utf8"));
  });

  test("every package template is listed once", () => {
    expect(tools.ansibleFiles.length).toBe(new Set(tools.ansibleFiles).size);
    for (const name of tools.ansibleFiles) expect(tools.ansibleTemplate(name).content.length).toBeGreaterThan(0);
  });

  test("the inventory has four groups and only host vars", () => {
    const inv = JSON.parse(tools.inventory(opts, topology.hosts(opts)));
    const groups = inv.all.children;
    expect(new Set(Object.keys(groups))).toEqual(new Set(["neon", "redis", "clickhouse", "app"]));
    expect(Object.keys(groups.clickhouse.hosts).length).toBe(3);
    expect(Object.keys(groups.app.hosts).length).toBe(1);
    // Every value is a HOST var; no group carries variables.
    for (const group of Object.values(groups) as Array<{ vars?: unknown }>) expect(group.vars).toBeUndefined();
    const ch1 = groups.clickhouse.hosts["langfuse-test-clickhouse-1"];
    expect(ch1.ordinal).toBe(1);
    expect(ch1.role).toBe("clickhouse");
    expect(ch1.vpc_ip).toMatch(/^10\.50\.0\.\d+$/);
    // Singletons carry no ordinal.
    expect(groups.app.hosts["langfuse-test-app"].ordinal).toBeUndefined();
  });

  test("normalize params speaks kebab-case", () => {
    const p = tools.normalizeParams({ ssh_key_id: "k",
      hosts: [{ role: "clickhouse", index: 1.0, ip: "1.1.1.1", vpc_ip: "10.0.0.1" }] })!;
    expect(p["ssh-key-id"]).toBe("k");
    expect(p.hosts[0]!.index).toBe(1);
    expect(p.hosts[0]!["vpc-ip"]).toBe("10.0.0.1");
  });

  test("the ssh config block carries the profile first", () => {
    const hs = tools.sshConfigHosts(opts, topology.hosts(opts));
    expect(hs[0]!.name).toBe("langfuse-test");
    expect(hs[0]!.ip).toBe(topology.hostOf(topology.hosts(opts), "app")!.ip);
    expect(hs.length).toBe(7);
  });

  test("http sources resolve explicit lists verbatim", async () => {
    const { source, ranges } = await tools.httpSources({ "vultr-http-sources": ["1.2.3.0/24", "::/0"] });
    expect(source).toBe("explicit");
    expect(ranges).toEqual(["1.2.3.0/24", "::/0"]);
  });

  test("the cloudflare fallback is never permissive", () => {
    expect(tools.cloudflareRangesFallback).not.toContain("0.0.0.0/0");
    expect(tools.cloudflareRangesFallback).not.toContain("::/0");
    expect(tools.cloudflareRangesFallback.length).toBeGreaterThan(10);
  });

  test("the dns record is proxied with an automatic ttl", () => {
    const doc = JSON.parse(tools.dnsJson(opts, "203.0.113.5"));
    const body = doc.resource.cloudflare_dns_record.langfuse;
    expect(body.zone_id).toBe("${data.cloudflare_zone.zone.id}");
    expect(body.name).toBe("langfuse.example.com");
    expect(body.content).toBe("203.0.113.5");
    expect(body.ttl).toBe(1);
    expect(body.proxied).toBe(true);
  });

  test("the operator path ingests one otlp root span", () => {
    // v4 ingestion is OTLP: one root span, 32-hex trace id, tagged so the
    // read-back can find it; the legacy batch endpoint rejects everything.
    const t = tools.hexId(16);
    const s = tools.hexId(8);
    const b = JSON.parse(tools.otlpBody(t, s));
    const span = b.resourceSpans[0].scopeSpans[0].spans[0];
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(s).toMatch(/^[0-9a-f]{16}$/);
    expect(span.traceId).toBe(t);
    expect(span.attributes.some((a: { key: string }) => a.key === "langfuse.trace.tags")).toBe(true);
    expect(span.attributes.find((a: { key: string }) => a.key === "langfuse.observation.type").value.stringValue).toBe("span");
    // Nanosecond timestamps keep every digit.
    expect(span.startTimeUnixNano).toMatch(/^\d{19}$/);
  });

  test("observation rows are counted defensively", () => {
    expect(tools.observationsCount({ out: "{\"data\":[{},{}]}\n200" })).toBe(2);
    expect(tools.observationsCount({ out: "not json\n502" })).toBe(0);
  });
});

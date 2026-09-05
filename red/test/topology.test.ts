import { describe, expect, test } from "bun:test";
import { computeCluster } from "package-once-red";
import * as t from "../src/topology.ts";
import { params } from "./support.ts";

const opts = { profile: "langfuse-test", "provider-compute": "vultr", "vultr-vpc-subnet": "10.50.0.0/24" };

describe("topology", () => {
  test("the spec describes six Vultr machines in four roles", () => {
    // The Compute Cluster Standard's spec-content test: the shape ONCE is
    // handed is data, and this is what that data must say.
    expect(computeCluster.specErrors(t.spec)).toEqual([]);
    // Play order, app last: it is the consumer of the other three tiers.
    expect(t.spec.roles).toEqual([
      { role: "neon", count: 1, fallbackOffset: 10 },
      { role: "redis", count: 1, fallbackOffset: 11 },
      { role: "clickhouse", count: 3, fallbackOffset: 20 },
      { role: "app", count: 1, fallbackOffset: 12 },
    ]);
    // The bare profile alias reaches the app host.
    expect(computeCluster.entryId(t.spec)).toEqual({ role: "app", index: 0 });
    // vultr-http-sources is the package's own rule: it accepts the symbolic cloudflare.
    expect(t.spec.sources).toEqual({ nonEmpty: ["ssh-sources"], mayBeEmpty: [] });
    expect(t.spec.default).toBe("vultr");
    expect(Object.keys(t.spec.registry)).toEqual(["vultr"]);
    // Every database connection crosses a VPC this package creates from vultr-vpc-subnet.
    expect(t.spec.registry.vultr!.network).toEqual({ mode: "created", key: "vultr-vpc-subnet" });
    // A created network cuts its fallbacks from the CIDR key, not a stand-in.
    expect("fallbackSubnet" in t.spec).toBe(false);
    expect(t.spec.registry.vultr!.secrets).toEqual(["vultr-api-key"]);
    // Every key the compute template interpolates, and nothing the standards make optional.
    expect(t.spec.registry.vultr!.required).toEqual([
      "vultr-region", "vultr-os-id", "vultr-vpc-subnet",
      "vultr-plan-neon", "vultr-plan-redis", "vultr-plan-clickhouse", "vultr-plan-app",
      "vultr-ssh-sources", "vultr-http-sources"]);
    expect(t.roles).toEqual(["neon", "redis", "clickhouse", "app"]);
  });

  test("six machines in play order", () => {
    const hs = t.hosts(opts);
    expect(hs.length).toBe(6);
    expect(hs.map((h) => h.name)).toEqual([
      "langfuse-test-neon", "langfuse-test-redis",
      "langfuse-test-clickhouse-0", "langfuse-test-clickhouse-1", "langfuse-test-clickhouse-2",
      "langfuse-test-app",
    ]);
    // The app host is last: it is the consumer of the other three tiers.
    expect(hs.at(-1)!.role).toBe("app");
    // A singleton carries no index; a replica carries its ordinal.
    expect(hs.map((h) => h.index)).toEqual([null, null, 0, 1, 2, null]);
  });

  test("fallbacks are the pre-adoption addresses", () => {
    // ONCE's fallbacks at this package's offsets: TEST-NET-1 publicly, the VPC
    // subnet privately — the same six addresses the goldens carried before
    // adoption, because the ClickHouse cluster config and the firewall data
    // are rendered from them.
    const hs = t.hosts(opts);
    expect(hs.map((h) => h.ip)).toEqual(["192.0.2.10", "192.0.2.11", "192.0.2.20", "192.0.2.21", "192.0.2.22", "192.0.2.12"]);
    expect(hs.map((h) => h["vpc-ip"])).toEqual(["10.50.0.10", "10.50.0.11", "10.50.0.20", "10.50.0.21", "10.50.0.22", "10.50.0.12"]);
    expect(hs.some((h) => "vpc_ip" in h)).toBe(false);
    expect(hs.every((h) => h.user === "root" && h.sudoer === "root")).toBe(true);
  });

  test("compute name honours the override", () => {
    expect(t.computeName(opts)).toBe("langfuse-test");
    expect(t.computeName({ ...opts, "vultr-name": "custom" })).toBe("custom");
    expect(t.computeName({ ...opts, "vultr-name": "REPLACE_ME" })).toBe("langfuse-test");
    expect(t.machineName({ ...opts, "vultr-name": "custom" }, "app")).toBe("custom-app");
    expect(t.machineName(opts, "clickhouse", 2)).toBe("langfuse-test-clickhouse-2");
  });

  test("hosts on a real run come from state, in the renderers' spelling", () => {
    // ONCE hands back every node as recorded, `vpc_ip` and index 0 and all;
    // this package's templates were written against `vpc-ip` and the
    // inventory writes an ordinal for the replicas alone, so the wrapper
    // respells the one key and blanks a singleton's index. Nothing else is
    // touched: the name is the label the template gave the instance, never
    // recomputed, and extension fields ride through.
    const recorded: computeCluster.ClusterParams = {
      ...params,
      nodes: [
        { ...params.nodes![0]!, extra: "kept" },
        ...params.nodes!.slice(1, 5),
        { ...params.nodes![5]!, name: "renamed-in-console" },
      ],
    };
    const hs = t.hosts(opts, recorded);
    expect(t.hostOf(hs, "app")!["vpc-ip"]).toBe("10.50.0.7");
    expect(t.hostOf(hs, "clickhouse", 1)!.ip).toBe("1.1.1.4");
    expect(t.clickhouseHosts(hs).map((h) => h.index)).toEqual([0, 1, 2]);
    expect(hs.some((h) => "vpc_ip" in h)).toBe(false);
    expect(t.hostOf(hs, "app")!.name).toBe("renamed-in-console");
    expect(t.hostOf(hs, "neon")!.extra).toBe("kept");
    expect(hs.map((h) => h.index)).toEqual([null, null, 0, 1, 2, null]);
  });

  test("ports come from desired state with defaults", () => {
    expect(t.appClickhousePorts(opts)).toEqual([8123, 9000]);
    expect(t.clickhouseInternalPorts(opts)).toEqual([9000, 9009, 9181, 9234]);
    expect(t.appClickhousePorts({ ...opts, "clickhouse-http-port": 8124, "clickhouse-native-port": "9001" }))
      .toEqual([8124, 9001]);
    expect(t.redisPort(opts)).toBe(6379);
  });
});

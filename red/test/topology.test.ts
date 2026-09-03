import { describe, expect, test } from "bun:test";
import * as t from "../src/topology.ts";

const opts = { profile: "langfuse-test", "vultr-vpc-subnet": "10.50.0.0/24" };

describe("topology", () => {
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
  });

  test("fallbacks are fixed and inside the subnet", () => {
    const hs = t.hosts(opts);
    expect(hs.every((h) => /^192\.0\.2\.\d+$/.test(h.ip))).toBe(true);
    expect(hs.every((h) => /^10\.50\.0\.\d+$/.test(h["vpc-ip"]))).toBe(true);
    // No two placeholders collide.
    expect(new Set(hs.map((h) => h["vpc-ip"])).size).toBe(6);
  });

  test("compute name honours the override", () => {
    expect(t.computeName(opts)).toBe("langfuse-test");
    expect(t.computeName({ ...opts, "vultr-name": "custom" })).toBe("custom");
    expect(t.computeName({ ...opts, "vultr-name": "REPLACE_ME" })).toBe("langfuse-test");
  });

  test("real params replace the fallbacks by role and index", () => {
    const params = [
      { role: "neon", index: null, ip: "1.1.1.1", "vpc-ip": "10.50.0.2" },
      { role: "redis", index: null, ip: "1.1.1.2", "vpc-ip": "10.50.0.3" },
      { role: "clickhouse", index: 0, ip: "1.1.1.3", "vpc-ip": "10.50.0.4" },
      { role: "clickhouse", index: 1, ip: "1.1.1.4", "vpc-ip": "10.50.0.5" },
      { role: "clickhouse", index: 2, ip: "1.1.1.5", "vpc-ip": "10.50.0.6" },
      { role: "app", index: null, ip: "1.1.1.6", "vpc-ip": "10.50.0.7" },
    ];
    const hs = t.hosts(opts, params);
    expect(t.hostOf(hs, "app")!["vpc-ip"]).toBe("10.50.0.7");
    expect(t.hostOf(hs, "clickhouse", 1)!.ip).toBe("1.1.1.4");
    expect(t.clickhouseHosts(hs).map((h) => h.index)).toEqual([0, 1, 2]);
    expect(t.missingHostError(opts, params)).toBeUndefined();
  });

  test("a partial compute output is refused", () => {
    // A two-replica cluster config forms no quorum; refuse rather than render.
    const params = [
      { role: "neon", index: null, ip: "1.1.1.1", "vpc-ip": "10.50.0.2" },
      { role: "clickhouse", index: 0, ip: "1.1.1.3", "vpc-ip": "10.50.0.4" },
    ];
    expect(t.missingHostError(opts, params)).toMatch(/clickhouse-1/);
    expect(t.missingHostError(opts, params)).toMatch(/app/);
    // An address-less host counts as missing.
    expect(t.missingHostError(opts, [{ role: "neon", index: null, ip: "", "vpc-ip": "10.50.0.2" }])).toBeDefined();
  });

  test("ports come from desired state with defaults", () => {
    expect(t.appClickhousePorts(opts)).toEqual([8123, 9000]);
    expect(t.clickhouseInternalPorts(opts)).toEqual([9000, 9009, 9181, 9234]);
    expect(t.appClickhousePorts({ ...opts, "clickhouse-http-port": 8124, "clickhouse-native-port": "9001" }))
      .toEqual([8124, 9001]);
    expect(t.redisPort(opts)).toBe(6379);
  });
});

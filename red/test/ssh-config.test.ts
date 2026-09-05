import { describe, expect, test } from "bun:test";
import * as sc from "../src/ssh-config.ts";
import * as topology from "../src/topology.ts";

const opts = { profile: "langfuse-test", "provider-compute": "vultr", "vultr-vpc-subnet": "10.50.0.0/24" };

describe("ssh-config", () => {
  test("the bare profile plus one alias per machine", () => {
    expect(sc.aliases(opts)).toEqual([
      "langfuse-test", "langfuse-test-neon", "langfuse-test-redis",
      "langfuse-test-clickhouse-0", "langfuse-test-clickhouse-1", "langfuse-test-clickhouse-2",
      "langfuse-test-app",
    ]);
    expect(sc.identityFile(opts)).toBe("~/.ssh/langfuse-test");
    // The aliases follow the profile, not the machine label (Compute Cluster
    // Standard §6).
    const renamed = { ...opts, "vultr-name": "custom" };
    expect(sc.machineAlias(renamed, { role: "clickhouse", index: 1, name: "custom-clickhouse-1" } as topology.Host))
      .toBe("langfuse-test-clickhouse-1");
    expect(sc.machineAlias(renamed, { role: "app", index: null, name: "custom-app" } as topology.Host))
      .toBe("langfuse-test-app");
    expect(topology.hosts(renamed).map((h) => sc.machineAlias(renamed, h))).toEqual(sc.aliases(renamed).slice(1));
  });

  test("a foreign stanza for any alias is detected", () => {
    // The marker is the profile; the stanza searched for may be a machine alias.
    const lines = ["Host other", "  HostName 1.2.3.4",
      "Host langfuse-test-clickhouse-1", "  HostName 5.6.7.8"];
    expect(sc.foreignStanzaLine(lines, "langfuse-test-clickhouse-1", "langfuse-test")).toBe(3);
    expect(sc.foreignStanzaLine(lines, "langfuse-test-app", "langfuse-test")).toBeUndefined();
    // Our own block is skipped, whichever alias it names.
    const own = [sc.beginMarker("langfuse-test"),
      "Host langfuse-test", "Host langfuse-test-redis",
      sc.endMarker("langfuse-test")];
    expect(sc.foreignStanzaLine(own, "langfuse-test-redis", "langfuse-test")).toBeUndefined();
  });

  test("a global option above the first host blocks the insert", () => {
    expect(sc.leadingOptionLine(["# comment", "ForwardAgent yes", "Host x"])).toBe(2);
    expect(sc.leadingOptionLine(["", "# c", "Host x", "  ForwardAgent yes"])).toBeUndefined();
  });
});

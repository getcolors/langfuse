import { describe, expect, test } from "bun:test";
import * as tools from "../src/tools.ts";
import * as w from "../src/workflow.ts";

function chain(event: string): string[] {
  const acc: string[] = [];
  let step = "langfuse/start";
  for (;;) {
    const decl = w.wireFn(step, { "red/event": event });
    acc.push(step);
    const next = decl?.slice(1) ?? [];
    if (next.length === 0) return acc;
    step = String(next[0]);
  }
}

describe("workflow", () => {
  test("create converges in dependency order", () => {
    expect(chain("create")).toEqual(["langfuse/start", "langfuse/infrastructure", "langfuse/dns",
      "langfuse/ssh-config", "langfuse/ansible", "langfuse/acceptance"]);
    // DNS before the converge: Caddy's ACME challenge needs the name to resolve.
    expect(chain("create").indexOf("langfuse/dns")).toBeLessThan(chain("create").indexOf("langfuse/ansible"));
  });

  test("delete removes the config block before and the key after the destroy", () => {
    const c = chain("delete");
    expect(c).toEqual(["langfuse/start", "langfuse/ansible", "langfuse/ssh-config", "langfuse/dns",
      "langfuse/infrastructure", "langfuse/ssh-cleanup"]);
    expect(c.indexOf("langfuse/ssh-config")).toBeLessThan(c.indexOf("langfuse/infrastructure"));
    expect(c.indexOf("langfuse/infrastructure")).toBeLessThan(c.indexOf("langfuse/ssh-cleanup"));
  });

  test("rehearse and describe run against state", () => {
    expect(chain("rehearse")).toEqual(["langfuse/start", "langfuse/rehearsal"]);
    expect(chain("describe")).toEqual(["langfuse/start", "langfuse/describe"]);
  });

  test("every side-effecting step is dry-run advised", () => {
    for (const s of ["langfuse/infrastructure", "langfuse/dns", "langfuse/ssh-config", "langfuse/ansible",
      "langfuse/acceptance", "langfuse/ssh-cleanup", "langfuse/rehearsal", "langfuse/describe"]) {
      expect(w.sideEffecting).toContain(s);
    }
  });

  test("normalized params keep the hosts but state output keeps once's key", () => {
    // ONCE reads `ssh_key_id` with the underscore from the state map; only
    // the host list is renamed into this package's vocabulary.
    const raw = { ssh_key_id: "k", hosts: [{ role: "app", index: null, ip: "1.1.1.1", vpc_ip: "10.0.0.1" }] };
    const norm = tools.normalizeParams(raw)!;
    expect(raw.ssh_key_id).toBe("k");
    expect(norm["ssh-key-id"]).toBe("k");
    expect(norm.hosts[0]!["vpc-ip"]).toBe("10.0.0.1");
    // Both tofu stages carry their own backend key.
    expect(w.backendAdvice(tools.dnsTool)).toBeDefined();
    expect(tools.toolDir({ profile: "langfuse-fixture", workdir: ".colors" }, tools.dnsTool))
      .toContain("langfuse-fixture/langfuse-dns");
  });
});

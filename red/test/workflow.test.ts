import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepError, type Opts } from "red/workflow";
import { computeCluster } from "package-once-red";
import * as tools from "../src/tools.ts";
import * as topology from "../src/topology.ts";
import * as w from "../src/workflow.ts";
import { base, creds, legacyRaw, legacyTranslated, params } from "./support.ts";

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
    // Both tofu stages carry their own backend key.
    expect(w.backendAdvice(tools.dnsTool)).toBeDefined();
    expect(tools.toolDir({ profile: "langfuse-fixture", workdir: ".colors" }, tools.dnsTool))
      .toContain("langfuse-fixture/langfuse-dns");
  });

  // --- the legacy state -----------------------------------------------------

  test("the reader translates the pre-adoption hosts into nodes", async () => {
    // `hosts` becomes `nodes`, a singleton's null index becomes 0, the
    // provider is the only one this package ever offered, and everything else
    // — the replica ordinals, every name and address, `ssh_key_id` — is
    // untouched.
    expect(w.legacyParams(legacyRaw)).toEqual(legacyTranslated);
    // A params that already carries nodes passes through.
    expect(w.legacyParams(params)).toEqual(params);
    const { provider: _provider, ...noProvider } = params;
    expect(w.legacyParams(noProvider)).toEqual(noProvider);
    // Nothing here checks cardinality; that is ONCE's, through adoptState.
    expect((w.legacyParams({ hosts: (legacyRaw.hosts as unknown[]).slice(0, 5) }).nodes as unknown[]).length).toBe(5);
    // The real reader runs the translation on what tofu delivers.
    expect(await w.stateOutput(base, async () => ({ params: legacyRaw }))).toEqual(legacyTranslated);
    expect(await w.stateOutput(base, async () => ({}))).toBeUndefined();
  });

  // --- the lifecycle against the compute state ------------------------------

  // The compute state is read once per run, through the injectable reader, on
  // a real create, delete, rehearse or describe. Every lifecycle test stubs
  // it: undefined is a readable state holding no compute, a map is a recorded
  // `params`, and a throw is a backend that cannot be read.
  const start = (opts: Opts, state: computeCluster.ClusterParams | undefined) =>
    w.startStep(opts, {}, { reader: async () => state });
  // The real reader over a stubbed `tofu output -json`, so the legacy
  // translation is on the path.
  const startRecorded = (opts: Opts, raw: Record<string, unknown>) =>
    w.startStep(opts, {}, { reader: (o) => w.stateOutput(o, async () => ({ params: raw })) });
  // The shape `red/tofu` throws: the SDK's StepError. Only that is an
  // unreadable backend; anything else propagates as a defect.
  const startUnreadable = (opts: Opts) =>
    w.startStep(opts, {}, { reader: async () => { throw new StepError("tofu output failed: no backend"); } });
  const deleting: Opts = { ...base, ...creds, "red/event": "delete", "compute-prevent-destroy": false };

  test("build and dry-run never touch the state", async () => {
    // A throwing state read proves nothing on these paths reaches the backend,
    // and the machine key stays the placeholder rather than the operator's home.
    for (const opts of [{ ...base, "red/event": "build" },
                        { ...base, "red/event": "create", "red/dry-run": true },
                        { ...base, "red/event": "delete", "red/dry-run": true, "compute-prevent-destroy": false },
                        { ...base, "red/event": "rehearse", "red/dry-run": true },
                        { ...base, "red/event": "describe", "red/dry-run": true }]) {
      const result = await startUnreadable(opts);
      expect(result["red/exit"]).toBe(0);
      expect(String(result["ssh-public-key-path"])).toStartWith("/home/build-placeholder");
      // A build renders the fallbacks; it adopts nothing.
      expect(result["once/cluster"]).toBeUndefined();
    }
  });

  test("a real create requires the credentials", async () => {
    const result = await start({ ...base, "red/event": "create" }, undefined);
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
    expect(String(result["red/err"])).toContain("COLORS_PAR_CLOUDFLARE_API_TOKEN");
    expect(String(result["red/err"])).toContain("COLORS_PAR_LANGFUSE_ENCRYPTION_KEY");
  });

  test("a provider switch is refused before the credentials", async () => {
    // Provider switching is a rebuild, never an apply. The validator order is
    // the thing under test: the actionable error, not a missing token for the
    // provider that was just selected.
    for (const event of ["create", "delete"]) {
      const result = await start({ ...base, "red/event": event, "compute-prevent-destroy": false },
        { ...params, provider: "digitalocean" });
      expect(result["red/exit"]).toBe(2);
      expect(String(result["red/err"]))
        .toContain("state holds a digitalocean machine; set provider-compute back to digitalocean and delete first");
      expect(String(result["red/err"])).not.toContain("required credential is not set");
    }
  });

  test("legacy state is accepted on the default provider", async () => {
    // A `params` without `provider` is a Vultr cluster: a create checks its
    // credentials as usual, a delete adopts it.
    const { provider: _provider, ...legacy } = params;
    const create = await start({ ...base, "red/event": "create" }, legacy);
    expect(String(create["red/err"])).not.toContain("state holds");
    expect(String(create["red/err"])).toContain("required credential is not set");
    const del = await start(deleting, legacy);
    expect(del["red/exit"]).toBe(0);
    expect(del["once/cluster"]).toEqual(legacy);
  });

  test("a real delete adopts the live deployment's pre-adoption state", async () => {
    // The recorded shape of langfuse-vultr, through the real reader: six hosts
    // under `hosts`, the singletons with `index: null`. The delete addresses
    // every machine the deployment ever created.
    const result = await startRecorded(deleting, legacyRaw);
    expect(result["red/exit"]).toBe(0);
    expect(result["once/cluster"]).toEqual(legacyTranslated);
    const hs = tools.hosts(result);
    expect(hs.map((h) => h.ip)).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4", "203.0.113.5", "203.0.113.6"]);
    expect(topology.hostOf(hs, "app")!["vpc-ip"]).toBe("10.50.0.8");
    expect(topology.hostOf(hs, "clickhouse", 1)!.name).toBe("langfuse-vultr-clickhouse-1");
    // Rehearse and describe adopt it the same way.
    for (const event of ["rehearse", "describe"]) {
      const adopted = await startRecorded({ ...base, "red/event": event }, legacyRaw);
      expect(adopted["red/exit"]).toBe(0);
      expect(adopted["once/cluster"]).toEqual(legacyTranslated);
    }
    // A hosts list that does not describe every machine is refused by ONCE,
    // not guessed.
    const five = { ...legacyRaw, hosts: (legacyRaw.hosts as Record<string, unknown>[]).filter((h) => h.role !== "app") };
    const refused = await startRecorded(deleting, five);
    expect(refused["red/exit"]).toBe(1);
    expect(refused["red/err"]).toBe("the compute stage did not report nodes this package declares: app-0");
  });

  test("an unreadable backend counts as no state on create", async () => {
    // A fresh clone has no readable state and must still be able to create.
    const result = await startUnreadable({ ...base, "red/event": "create" });
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).not.toContain("could not read");
    expect(String(result["red/err"])).not.toContain("state holds");
    expect(String(result["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
  });

  test("a real create on a fresh work directory reports the credentials, not a crash", async () => {
    // No reader stub: the real `stateOutput` runs against a work directory
    // that holds no stage yet, as a fresh clone's does. The SDK's output read
    // throws its StepError there, which ONCE's `readState` counts as an
    // unreadable state, so the create reports its credentials.
    const work = mkdtempSync(join(tmpdir(), "langfuse-red-fresh"));
    try {
      const result = await w.startStep({ ...base, workdir: work, "red/event": "create" }, {});
      expect(result["red/exit"]).toBe(2);
      expect(String(result["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
      expect(String(result["red/err"])).not.toContain("could not read");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("an unreadable backend fails a real delete, rehearse and describe closed", async () => {
    // Before adoption every one of these swallowed the read and went on: a
    // delete would have rendered the cleanup play against the documentation
    // addresses, and rehearse and describe reported "no compute in state" for
    // a backend they merely could not reach.
    const result = await startUnreadable(deleting);
    expect(result["red/exit"]).toBe(1);
    expect(String(result["red/err"])).toContain("could not read the infrastructure state for the delete cleanup");
    expect(String(result["red/err"])).toContain("no backend");
    for (const event of ["rehearse", "describe"]) {
      const r = await startUnreadable({ ...base, "red/event": event });
      expect(r["red/exit"]).toBe(1);
      expect(String(r["red/err"])).toContain(`could not read the infrastructure state for ${event}`);
      expect(String(r["red/err"])).not.toContain("no compute in state");
    }
  });

  test("a real delete adopts the recorded cluster", async () => {
    const adopted = await start(deleting, params);
    expect(adopted["red/exit"]).toBe(0);
    // The whole recorded params, extension keys and all.
    expect(adopted["once/cluster"]).toEqual(params);
    expect(tools.hosts(adopted).map((h) => h.ip)).toEqual(["1.1.1.1", "1.1.1.2", "1.1.1.3", "1.1.1.4", "1.1.1.5", "1.1.1.6"]);
    // A readable state without compute adopts nothing, and the cleanup play
    // skips itself.
    const empty = await start(deleting, undefined);
    expect(empty["red/exit"]).toBe(0);
    expect("once/cluster" in empty).toBe(false);
    // Rehearse and describe need a recorded cluster.
    for (const event of ["rehearse", "describe"]) {
      const none = await start({ ...base, "red/event": event }, undefined);
      expect(none["red/exit"]).toBe(1);
      expect(none["red/err"]).toBe(`${event}: no compute in state; run create first`);
      const some = await start({ ...base, "red/event": event }, params);
      expect(some["red/exit"]).toBe(0);
      expect(some["once/cluster"]).toEqual(params);
    }
  });

  test("a real delete refuses a state that does not describe every machine", async () => {
    // Six machines are declared; a state that reports five is not a smaller
    // deployment to tear down but a state that cannot be trusted. ONCE's
    // message, unreworded.
    const partial = await start(deleting, { ...params, nodes: params.nodes!.slice(0, 5) });
    expect(partial["red/exit"]).toBe(1);
    expect(partial["red/err"]).toBe("the compute stage did not report nodes this package declares: app-0");
    // A machine without an address is refused the same way.
    const incomplete = await start(deleting, {
      ...params, nodes: params.nodes!.map((n, i) => (i === 3 ? { ...n, vpc_ip: "" } : n)),
    });
    expect(incomplete["red/exit"]).toBe(1);
    expect(String(incomplete["red/err"]))
      .toContain("did not report a complete node (ip, vpc_ip, name, user, sudoer) for clickhouse-1");
    // A legacy index: null that was not translated is an undeclared id.
    const untranslated = await start(deleting, {
      ...params, nodes: params.nodes!.map((n, i) => (i === 5 ? { ...n, index: null as unknown as number } : n)),
    });
    expect(untranslated["red/exit"]).toBe(1);
    expect(String(untranslated["red/err"])).toContain("did not report nodes this package declares: app-0");
    expect(String(untranslated["red/err"])).toContain("reported nodes this package does not declare: app-null");
  });
});

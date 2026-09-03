// The storage tier's templates, read from the SHA-pinned `package-neon-red`
// dependency rather than copied into this repository.
//
// This is red's counterpart of green's classpath resolution: green publishes
// `src/resources` from neon's deps.edn and names the templates as namespaced
// keywords, and neon's package.json publishes `red/resources` in its `files`
// list, so the same twelve Ansible templates plus the ansible-local ones are
// on disk inside the installed package. A copy of a tier this subtle drifts,
// and the drift is silent — so there is no copy in either colour.
//
// Resolved from the package entry rather than imported by subpath: neon's
// exports map admits the bare specifier "." alone, and `with { type: "text" }`
// needs a static path a bundler can see. The same technique resolves ONCE's
// unexported ssh module in once.ts.
//
// The cost is real coupling — bumping the pin in package.json can break this
// package. That is deliberate: the goldens render the merged Neon+Langfuse
// tree, so a pin bump shows up as a reviewable diff instead of a surprise on a
// host. There is no NEON_LIB_ROOT; a neon change means moving the pin.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const neonEntry = Bun.resolveSync("package-neon-red", import.meta.dir);
const neonResources = join(dirname(neonEntry), "..", "resources", "tools");

/** One template's text, by stage directory and file name. */
export function neonResource(path: string, file: string): string {
  return readFileSync(join(neonResources, path, file), "utf8");
}

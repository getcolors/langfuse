declare module "*.tf" { const content: string; export default content; }
declare module "*.yml" { const content: string; export default content; }
declare module "*.yaml" { const content: string; export default content; }
declare module "*.cfg" { const content: string; export default content; }
declare module "*.ini" { const content: string; export default content; }
declare module "*.env" { const content: string; export default content; }
declare module "*.sh" { const content: string; export default content; }
declare module "*.py" { const content: string; export default content; }
declare module "*.toml" { const content: string; export default content; }
declare module "*.json" { const content: string; export default content; }
// Bun's own types declare `*.xml` as a Document; at runtime a
// `with { type: "text" }` import is a string. The declaration here and the
// cast at the import site together restore the truth.
declare module "*.xml" { const content: string; export default content; }
declare module "*/Caddyfile" { const content: string; export default content; }
// Extensionless resources reached through the dependency graph: ONCE's red
// sources import these by path, and the compiler follows them.
declare module "*/authorized-keys" { const content: string; export default content; }
declare module "*/deploy" { const content: string; export default content; }
declare module "*/once" { const content: string; export default content; }

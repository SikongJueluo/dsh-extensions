# @dsh-extensions/config

Host-side shared loader for this repository's external YAML configuration.
Private workspace package: each consuming bundle bundles it (tsdown
`deps.alwaysBundle`), so an installed bundle never needs a second runtime
package. Not a general config framework — two real consumers define the API:
crew (watch + hot reload) and more-providers (startup read, no hot reload).

## Interface

```ts
const store = registerConfig(ctx, {
  filename: 'crew.yaml',          // default under $DSH_HOME
  configFile: config.configFile,  // optional plugin-row override
  validate: parseCrewPolicy,      // throws ConfigError on a problem
  watch: true,                    // optional; default false
  logger: log,                    // watcher setup failures
})
await store.ready                 // ConfigState<T>; never rejects
store.get()                       // T | undefined (fail-closed when invalid)
store.state()                     // { file, loaded, revision, value, error }
store.subscribe((state) => {})    // published changes only
```

`registerConfigStatusRoute(ctx, { prefix, title, recovery, store })` serves
`<prefix>/config-status` for the browser half. The payload is
`{ instances: [{ id, title, file, state, error?, revision, recovery }] }`:
every live plugin instance (agent presets eagerly activate each definition and
keep earlier generations) is aggregated behind one route, because the host
rejects a second route for the same path. The route moves to a surviving
instance when its owner unloads. It waits for the optional `webServer` service,
so non-Web profiles never mount it.

`resolveConfigFile`, `readConfigFile`, and `ConfigError` are the other pieces a
plugin or its smoke test uses directly.

## Contract

- Paths: explicit `configFile` wins (relative → process cwd, `~/` expanded);
  otherwise `dshHomePath(filename)`.
- Whole-file validation: the plugin's validator owns the schema; any throw makes
  the whole file unusable. There is no partial application and no
  last-known-good fallback.
- Watching is directory-level, debounced 80 ms, and generation-guarded. Atomic
  replacement, Nix symlink swaps, and delete/recreate all reload. Equal
  validated values (JSON fingerprint) do not bump the revision.
- The first read publishes `loaded: true`; errors are reasons (no stack), and
  `get()` is `undefined` while the file is unusable. A plugin that discovers a
  startup failure after validation can call `store.reportFailure(reason)`; the
  same status route then reports it as invalid.
- `dispose()` (registered through `ctx.effect`) stops the watcher and prevents
  any later publication.

Tests: `pnpm -C packages/config test` (real temp files, the native watcher, the
status route).

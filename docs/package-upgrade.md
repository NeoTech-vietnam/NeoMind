# Package replacement and recovery

`neomind upgrade --to TARGET --project DIRECTORY` replaces a direct local npm installation. It does not initialize projects, migrate storage, update global installations, or publish anything.

## Supported targets

Run with a supported Node version (Node 24 LTS recommended), from an initialized project after stopping its NeoMind agents, MCP servers, and native sessions:

```powershell
npx neomind upgrade --to D:/packages/neomind-0.1.0-alpha.3.1.tgz --project D:/projects/my-app
```

After the package is published to your configured npm registry:

```powershell
npx neomind upgrade --to next --project D:/projects/my-app
npx neomind upgrade --to 0.1.0-alpha.3.1 --project D:/projects/my-app
```

Targets are a version/tag for the unscoped `neomind` package or a regular local `.tgz`. URLs, Git specifications, aliases, ranges, scoped packages, global installs, workspace roots/members, linked packages, optional/peer dependencies, and non-npm projects require manual administration. Tool-specific npm `overrides` are rejected before uninstall rather than silently changing project policy. Install a normal direct `neomind` or legacy `verythinker` dependency first. Both old names can coexist only in the same dependency section.

## Replacement sequence

1. Validate the explicit npm project, managed storage, installed package identity, inactive receipts, and locks.
2. Copy a built-ins-only runner outside removable `node_modules`; back up package manifests, npm locks, configuration, and the integration ownership manifest.
3. Fetch and inspect the target before removing anything. Pack the installed old package(s) into recovery archives.
4. Recheck project manifests and inactivity, then run npm uninstall for the old package name(s).
5. Install the selected release in the original `dependencies` or `devDependencies` section, with npm lifecycle scripts disabled.
6. Verify package identity, saved dependency, lock target and available archive integrity.
7. Execute the **newly installed** CLI's conflict-aware `update` and return its report, including conflicts and warnings.

The upgrade lock serializes upgrades, but is not a universal writer gate: other clients must remain stopped. npm uninstall/install can re-resolve the broader dependency graph; inspect your manifest and lockfile diff. Lockfile generation is explicitly enabled even if project npm configuration disables it. Disabling lifecycle scripts applies to these npm operations, including other dependencies; run separately reviewed dependency setup if your project requires it.

Registry tags resolve to an exact saved version. Local archives are copied into the currently selected `.neomind/package-cache/<sha256>.tgz` (or legacy `.verythinker/package-cache/…`). The saved project-relative `file:` dependency points there, never to OS temporary staging. Preserve that archive when copying the project or rebuilding with `npm ci`; do not delete a referenced archive. If managed storage is ignored by Git, explicitly arrange distribution of the archive or use a published registry version instead.

Project records and configured policies are not reset. Integration regeneration preserves manual edits and generates conflict candidates for review; `status: upgraded` does **not** mean those conflicts are resolved. Normal installer compatibility adjustments may still occur. Historical signed receipts are not rewritten. Storage migration remains a separate explicit operation.

`neomind update` only regenerates integration files. It never upgrades the installed npm package.

## Older releases without this command

A newer checkout can administer the old installation without first replacing it. Build the newer checkout, then run its CLI with the target project's explicit path:

```powershell
node D:/DevCloud/NeoMind/dist/cli.js upgrade --to D:/packages/neomind-new.tgz --project D:/projects/my-app
```

Use Node 24 for that invocation. The checkout must have its dependencies installed and be built. This uses the new staged-runner implementation while the target project still contains the old package.

Alternatively, perform the manual equivalent from the target project, recording the original dependency section and backing up its package manifests/lockfiles first:

```powershell
npm uninstall neomind --ignore-scripts
npm install --save-dev D:/packages/neomind-new.tgz --ignore-scripts
npx neomind update
```

Use `verythinker` instead of `neomind` in the uninstall command for that legacy package; use `--save-prod` instead of `--save-dev` if it was a production dependency. Manual replacement does not provide the staged validation, recovery archives, or durable archive caching of `upgrade`; preserve the manually installed archive at its referenced path.

## Failure and recovery

Replacement is **not atomic** and has no automatic rollback. Target staging failures leave the old package installed; uninstall/install/update failures can leave a missing package or incomplete integration. A failed npm operation may already have changed manifests or `node_modules`.

The error identifies the last phase and a recovery directory. Keep that directory private: it contains project configuration and package metadata. `recovery.json` records backed-up paths, hashes, staged archives, and the error. Backups of manifests are not a complete project backup, and repacking an installed package is not guaranteed to reproduce its original registry artifact or lifecycle-script effects.

Before recovering:

1. Keep all clients stopped and inspect `recovery.json`, project manifests, lockfiles, and the installed package.
2. Choose deliberately between completing the target installation and restoring the previous state. Retain the durable archive if the current manifest references it.
3. To complete, install the reviewed target with npm in the original dependency section and run the newly installed `neomind update`. To restore, recover matching manifest/lock backups and restore dependencies from their original sources, or use the old-package archive as reviewed recovery material. Do not blindly restore a manifest without its matching dependency state.
4. Inspect all update conflicts/candidates and verify project tests before restarting clients. Do not remove locks belonging to live processes.

After success the OS recovery directory is diagnostic only and can be deleted; the managed durable archive must remain while referenced. The command never automatically deletes project records, cached archives, or failed recovery material.

# Agent Pets Plugins

English | [繁體中文](README.zh-TW.md)

The online plugin catalog for [Agent Pets](https://github.com/Ponpon55837/agent-pets). The app reads [`index.json`](index.json) only after the user turns on **Settings → Plugins → Online plugin catalog**. With the catalog off, the app makes no requests to this repository.

## How the catalog works

- `index.json` lists each plugin and its published versions.
- When a user installs or updates a plugin from the catalog, the app downloads the package, checks its `size` and `sha256` against this index, and verifies the ed25519 signature fingerprint when one is listed. Any mismatch is refused.
- The app then shows the same permission confirmation as a local install. Updates are only checked and suggested; nothing is installed without the user's confirmation.

## Submitting a plugin

1. Publish your `.agentpet-plugin` package at an `https://` URL, for example as a GitHub Release asset. Signing it with ed25519 (`signature.json`) is strongly recommended.
2. Open a pull request that adds an entry to `plugins` in `index.json`:
   - `id`, `name`, `description`, `author`, optional `homepage`
   - `publicKeyFingerprint` for signed plugins
   - `versions[]`, each with `version`, `apiVersion`, `url`, `sha256`, `size`, `publishedAt`, and `minAppVersion` when the package needs a newer app (see below)
3. Automated checks run on the pull request (see below), then a maintainer reviews the entry. Once merged, the plugin appears in the app's catalog.

### Minimum app version (`minAppVersion`)

`minAppVersion` is the lowest Agent Pets version that may install a package, as `major.minor.patch` (for example `"1.12.0"`). Agent Pets 1.12.0 and later skip versions that need a newer app. Apps before 1.12.0 do not know the field and hide every version that sets it, so leave it out when the package also works on older apps.

It is required, at `1.12.0` or later, for packages that contribute `panelThemes`, which older apps cannot install. It is never added to versions that are already published: like every field of a published version it cannot change, and adding it would hide those versions from users on 1.11.x.

### Panel themes

A package can contribute up to 8 panel themes through `contributes.panelThemes` (colours, fonts and backgrounds for light and dark mode). The rules are in the app's [panel theme docs](https://github.com/Ponpon55837/agent-pets/blob/main/docs/plugins/panel-themes.md). For the package:

- Fonts are `.woff2` files of at most 1 MiB that start with `wOF2`. Every packaged `.woff2` must be named by a theme's `fonts[].src`.
- Background images are static PNG or WebP files of at most 8 MiB, 64–4096 px per side and 8,388,608 px in total, with EXIF orientation 1.
- A package with skins, theme images or fonts may be up to 25 MiB. Any other package, including one whose themes only set colours, is limited to 5 MiB.

To publish a new version, open a pull request that adds it to your plugin's `versions` list. If you rotate your signing key, users who already installed the plugin are asked to confirm the new key, so explain the change in the pull request.

See the Agent Pets [plugin developer docs](https://github.com/Ponpon55837/agent-pets/tree/main/docs/plugins) for the package format, signing, permissions, and limits.

## Automated checks

Every pull request runs [`scripts/validate-catalog.mjs`](scripts/validate-catalog.mjs) through GitHub Actions. It applies the same rules the app uses, and fails on problems the app would silently skip:

- `index.json` format, duplicate plugin ids, and duplicate versions.
- Each new or changed package's `size` and `sha256`, archive paths, file types and size limits, and that `plugin.json` matches the catalog entry.
- `plugin.json`, including every panel theme's grammar, colours and contrast, is checked by the app's own validator, copied byte for byte under [`scripts/vendor/agent-pets/`](scripts/vendor/agent-pets/) at the app commit pinned in its `vendor.json`. Theme fonts, theme images and `minAppVersion` are checked as described above.
- The ed25519 signature and `publicKeyFingerprint`. Removing a listed fingerprint fails; changing one is flagged for review.
- Published versions and files under `packages/` cannot change. Versions are matched by semver precedence, so `1.0.0+rebuild` cannot replace `1.0.0`. Deleting a package that `index.json` still lists fails, and `index.json` and packages must be regular files, not symlinks.

The report is posted as a comment on the pull request. It lists the permissions and contributions each new version requests, the consent items it adds compared with the previous version (hosts, permissions, themes, fonts), and code patterns that need a closer look, such as `innerHTML`, `eval`, or a bare `fetch`. A passing check does not replace review: a maintainer still reads the plugin source and decides whether to merge. A contributor pull request that also changes files outside the catalog ran its own copy of the workflows, so its comment only points to the run.

A separate `scope` check only allows contributor pull requests to change `index.json` and `packages/*.agentpet-plugin`. Changes to workflows, scripts or dependencies come from the maintainer. Pull requests always run the base branch's validator and tests; pushes to a branch of this repository run that branch's own.

To run it locally (Node.js 22.18 or later): `pnpm install`, then `pnpm validate`. `pnpm test` runs the validator's tests.

When the app's validator changes, the maintainer re-pins the copy with `node scripts/sync-app-rules.mjs --app <agent-pets checkout> --commit <commit>`. `node scripts/sync-app-rules.mjs --app <agent-pets checkout>` reports drift from the pinned commit; without `--app` it checks the recorded hashes, which `pnpm test` also does.

## Reporting a plugin

The **Report issue** button on a plugin's page in the app opens a new issue here, with only the plugin id and version in the title. Use it for bugs, broken downloads, or security concerns about a listed plugin.

Do not paste secrets, tokens, or personal data into issues.

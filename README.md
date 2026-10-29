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
   - `versions[]`, each with `version`, `apiVersion`, `url`, `sha256`, `size`, and `publishedAt`
3. Automated checks run on the pull request (see below), then a maintainer reviews the entry. Once merged, the plugin appears in the app's catalog.

To publish a new version, open a pull request that adds it to your plugin's `versions` list. If you rotate your signing key, users who already installed the plugin are asked to confirm the new key, so explain the change in the pull request.

See the Agent Pets [plugin developer docs](https://github.com/Ponpon55837/agent-pets/tree/main/docs/plugins) for the package format, signing, permissions, and limits.

## Automated checks

Every pull request runs [`scripts/validate-catalog.mjs`](scripts/validate-catalog.mjs) through GitHub Actions. It applies the same rules the app uses, and fails on problems the app would silently skip:

- `index.json` format, duplicate plugin ids, and duplicate versions.
- Each new or changed package's `size` and `sha256`, archive paths, file types and size limits, and that `plugin.json` matches the catalog entry.
- The ed25519 signature and `publicKeyFingerprint`. Removing a listed fingerprint fails; changing one is flagged for review.
- Published versions and files under `packages/` cannot change.

The run summary lists the permissions each new version requests, new hosts compared with the previous version, and code patterns that need a closer look, such as `innerHTML`, `eval`, or a bare `fetch`. A passing check does not replace review: a maintainer still reads the plugin source and decides whether to merge.

To run it locally: `pnpm install`, then `pnpm validate`.

## Reporting a plugin

The **Report issue** button on a plugin's page in the app opens a new issue here, with only the plugin id and version in the title. Use it for bugs, broken downloads, or security concerns about a listed plugin.

Do not paste secrets, tokens, or personal data into issues.

# Agent Pets Plugins

[Agent Pets](https://github.com/Ponpon55837/agent-pets) 的線上插件目錄。App 會在使用者開啟 **設定 → 插件 → 線上插件目錄** 後讀取本 repo 的 [`index.json`](index.json)。

The online plugin catalog for [Agent Pets](https://github.com/Ponpon55837/agent-pets). The app reads [`index.json`](index.json) only after the user turns on **Settings → Plugins → Online plugin catalog**.

## 上架插件 / Submitting a plugin

1. 把 `.agentpet-plugin` 套件發布在 GitHub Release（或本 repo），網址必須是 `https://`。建議用 ed25519 簽章（`signature.json`）。
2. 對本 repo 發 PR，在 `index.json` 的 `plugins` 加入一筆，包含 `id`、`name`、`description`、`author`、`versions[]`（`version`、`apiVersion`、`url`、`sha256`、`size`、`publishedAt`），有簽章時加上 `publicKeyFingerprint`。
3. 維護者審核後合併即上架。App 會在安裝前比對 `sha256`、`size` 與簽章指紋，不符就拒絕安裝。

格式、簽章與限制請見 Agent Pets 的[插件開發文件](https://github.com/Ponpon55837/agent-pets/tree/main/docs/plugins)。

1. Publish the `.agentpet-plugin` package over `https://` (for example as a GitHub Release asset). Signing with ed25519 (`signature.json`) is recommended.
2. Open a PR adding an entry to `plugins` in `index.json` with `id`, `name`, `description`, `author`, and `versions[]` (`version`, `apiVersion`, `url`, `sha256`, `size`, `publishedAt`), plus `publicKeyFingerprint` for signed plugins.
3. Once merged, the plugin is listed. The app checks `sha256`, `size`, and the signing fingerprint before installing and refuses mismatches.

See the Agent Pets [plugin developer docs](https://github.com/Ponpon55837/agent-pets/tree/main/docs/plugins) for the format, signing, and limits.

## 回報問題 / Reporting a plugin

App 裡插件頁的「回報問題」按鈕會開啟本 repo 的新 issue，標題只帶插件 id 與版本。請勿在 issue 中貼上密鑰、token 或個人資料。

The **Report issue** button in the app opens a new issue here with only the plugin id and version in the title. Do not paste secrets, tokens, or personal data into issues.

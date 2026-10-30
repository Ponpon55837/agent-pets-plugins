# Agent Pets Plugins

[English](README.md) | 繁體中文

[Agent Pets](https://github.com/Ponpon55837/agent-pets) 的線上插件目錄。使用者在 **設定 → 插件 → 線上插件目錄** 開啟後，App 才會讀取本 repo 的 [`index.json`](index.json)；未開啟時不會對本 repo 發出任何請求。

## 目錄如何運作

- `index.json` 列出每個插件與它發布的版本。
- 使用者從目錄安裝或更新時，App 會下載套件，比對本目錄記載的 `size` 與 `sha256`；有列出簽章指紋時也會驗證 ed25519 簽章。任何不符都會拒絕安裝。
- 接著顯示與本機安裝相同的權限確認。更新只會檢查與提示，使用者沒確認就不會安裝。

## 上架插件

1. 把 `.agentpet-plugin` 套件發布在 `https://` 網址，例如 GitHub Release 的附件。強烈建議用 ed25519 簽章（`signature.json`）。
2. 發 PR，在 `index.json` 的 `plugins` 加入一筆：
   - `id`、`name`、`description`、`author`，`homepage` 選填
   - 有簽章時加上 `publicKeyFingerprint`
   - `versions[]`，每個版本包含 `version`、`apiVersion`、`url`、`sha256`、`size`、`publishedAt`
3. PR 會先跑自動檢查（見下方），再由維護者審核後合併，插件就會出現在 App 的目錄中。

發布新版本時，發 PR 把新版本加進該插件的 `versions`。如果更換簽章金鑰，已安裝的使用者會被要求確認新金鑰，請在 PR 中說明原因。

套件格式、簽章、權限與限制請見 Agent Pets 的[插件開發文件](https://github.com/Ponpon55837/agent-pets/tree/main/docs/plugins)。

## 自動檢查

每個 PR 都會透過 GitHub Actions 執行 [`scripts/validate-catalog.mjs`](scripts/validate-catalog.mjs)。規則與 App 相同，而且 App 會靜默略過的問題在這裡會直接失敗：

- `index.json` 格式、重複的插件 id 與重複的版本。
- 每個新增或變更套件的 `size` 與 `sha256`、壓縮檔路徑、檔案類型與大小上限，以及 `plugin.json` 是否與目錄項目一致。
- ed25519 簽章與 `publicKeyFingerprint`。移除已列出的指紋會失敗；更換指紋會標示出來請維護者確認。
- 已發布的版本與 `packages/` 下的檔案不可變更。

檢查報告會貼在 PR 留言中，列出每個新版本要求的權限、和前一版相比新增的主機，以及需要特別注意的程式寫法，例如 `innerHTML`、`eval` 或裸 `fetch`。檢查通過不代表免審：維護者仍會閱讀插件原始碼，再決定是否合併。

另一項 `scope` 檢查只允許投稿者的 PR 修改 `index.json` 與 `packages/*.agentpet-plugin`；workflow、腳本與相依套件的變更一律由維護者處理。

本機執行：`pnpm install` 後執行 `pnpm validate`。

## 回報插件問題

App 中插件頁的「回報問題」按鈕會在本 repo 開新 issue，標題只帶插件 id 與版本。可用來回報錯誤、下載失效或目錄中插件的安全疑慮。

請勿在 issue 中貼上密鑰、token 或個人資料。

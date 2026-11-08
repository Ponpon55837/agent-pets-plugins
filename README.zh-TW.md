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
   - `versions[]`，每個版本包含 `version`、`apiVersion`、`url`、`sha256`、`size`、`publishedAt`；套件需要較新版 App 時再加上 `minAppVersion`（見下方）
3. PR 會先跑自動檢查（見下方），再由維護者審核後合併，插件就會出現在 App 的目錄中。

### 最低 App 版本（`minAppVersion`）

`minAppVersion` 是可以安裝該套件的最低 Agent Pets 版本，格式為 `major.minor.patch`（例如 `"1.12.0"`）。Agent Pets 1.12.0 以上會略過需要更新版 App 的版本；1.12.0 以前的 App 不認得這個欄位，會隱藏所有設定了它的版本，所以套件在舊版 App 也能用時請不要設定。

含 `panelThemes` 的套件必須設定，且至少為 `1.12.0`，因為舊版 App 無法安裝這類套件。已發布的版本不會補上這個欄位：已發布版本的欄位都不可修改，而且補上後 1.11.x 的使用者就看不到這些版本。

### 面板主題

套件可以透過 `contributes.panelThemes` 提供最多 8 個面板主題（淺色與深色模式的配色、字型與背景）。規則見 App 的[面板主題文件](https://github.com/Ponpon55837/agent-pets/blob/main/docs/plugins/panel-themes.zh-TW.md)。套件方面：

- 字型為 `.woff2`，每個最多 1 MiB，且開頭必須是 `wOF2`。套件內每個 `.woff2` 都必須由主題的 `fonts[].src` 引用。
- 背景圖為靜態 PNG 或 WebP，最多 8 MiB、每邊 64–4096 px、總計 8,388,608 px，EXIF 方向為 1。
- 含 skins、主題圖片或字型的套件最大 25 MiB；其他套件（包含主題只設定配色的套件）上限為 5 MiB。

發布新版本時，發 PR 把新版本加進該插件的 `versions`。如果更換簽章金鑰，已安裝的使用者會被要求確認新金鑰，請在 PR 中說明原因。

套件格式、簽章、權限與限制請見 Agent Pets 的[插件開發文件](https://github.com/Ponpon55837/agent-pets/tree/main/docs/plugins)。

## 自動檢查

每個 PR 都會透過 GitHub Actions 執行 [`scripts/validate-catalog.mjs`](scripts/validate-catalog.mjs)。規則與 App 相同，而且 App 會靜默略過的問題在這裡會直接失敗：

- `index.json` 格式、重複的插件 id 與重複的版本。
- 每個新增或變更套件的 `size` 與 `sha256`、壓縮檔路徑、檔案類型與大小上限，以及 `plugin.json` 是否與目錄項目一致。
- `plugin.json`（包含每個面板主題的文法、顏色與對比）由 App 自己的驗證器檢查。驗證器逐位元組複製在 [`scripts/vendor/agent-pets/`](scripts/vendor/agent-pets/)，對應 `vendor.json` 記錄的 App commit。主題字型、主題圖片與 `minAppVersion` 依上方規則檢查。
- ed25519 簽章與 `publicKeyFingerprint`。移除已列出的指紋會失敗；更換指紋會標示出來請維護者確認。
- 已發布的版本與 `packages/` 下的檔案不可變更。版本依 semver 優先順序比對，所以 `1.0.0+rebuild` 不能取代 `1.0.0`。刪除 `index.json` 仍列出的套件會失敗；`index.json` 與套件必須是一般檔案，不可為符號連結。

檢查報告會貼在 PR 留言中，列出每個新版本要求的權限與貢獻、和前一版相比新增的授權項目（主機、權限、主題、字型），以及需要特別注意的程式寫法，例如 `innerHTML`、`eval` 或裸 `fetch`。檢查通過不代表免審：維護者仍會閱讀插件原始碼，再決定是否合併。投稿者的 PR 若也修改了目錄以外的檔案，執行的是它自己那份 workflow，因此留言只會指向執行紀錄。

另一項 `scope` 檢查只允許投稿者的 PR 修改 `index.json` 與 `packages/*.agentpet-plugin`；workflow、腳本與相依套件的變更一律由維護者處理。PR 一律使用基底分支的驗證器與測試；推送到本 repo 分支時則執行該分支自己的版本。

本機執行（Node.js 22.18 以上）：`pnpm install` 後執行 `pnpm validate`。`pnpm test` 會執行驗證器的測試。

App 的驗證器有變更時，維護者用 `node scripts/sync-app-rules.mjs --app <agent-pets checkout> --commit <commit>` 重新釘選。`node scripts/sync-app-rules.mjs --app <agent-pets checkout>` 會回報與釘選 commit 的差異；不加 `--app` 時只比對記錄的雜湊，`pnpm test` 也會做這項檢查。

## 回報插件問題

App 中插件頁的「回報問題」按鈕會在本 repo 開新 issue，標題只帶插件 id 與版本。可用來回報錯誤、下載失效或目錄中插件的安全疑慮。

請勿在 issue 中貼上密鑰、token 或個人資料。

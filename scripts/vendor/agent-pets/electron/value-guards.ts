// 主程序共用的執行期型別守衛。IPC、檔案與網路輸入在進入業務邏輯前都先經過這些檢查。
// （plugin-panel-themes.ts 刻意保留自己的副本：目錄驗證器原封不動地內嵌那組純函式檔案，
// 不能多一個相依。）

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

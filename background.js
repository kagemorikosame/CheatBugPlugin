// background.js — ChaosMode バックグラウンドスクリプト
// (現在は最小構成。将来的なタブ状態管理の拡張用)
"use strict";

browser.runtime.onInstalled.addListener(() => {
  console.log("[ChaosMode] インストール完了");
});

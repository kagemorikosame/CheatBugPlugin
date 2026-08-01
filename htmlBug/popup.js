// popup.js — ChaosMode ポップアップ制御

"use strict";

const levelSlider = document.getElementById("chaos-level");
const levelValue = document.getElementById("level-value");
const glitchWordsInput = document.getElementById("glitch-words");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const btnStart = document.getElementById("btn-start");
const btnReset = document.getElementById("btn-reset");

const optCss = document.getElementById("opt-css");
const optText = document.getElementById("opt-text");
const optShuffle = document.getElementById("opt-shuffle");
const optBlur = document.getElementById("opt-blur");
const optImgSwap = document.getElementById("opt-imgswap");
const optJsChaos = document.getElementById("opt-jschaos");
const optAudioChaos = document.getElementById("opt-audiochaos");

const STORAGE_KEY = "chaosSettings";

// ---- スライダー表示更新 -------------------------------------------

levelSlider.addEventListener("input", () => {
  levelValue.textContent = levelSlider.value;
});

// ---- ステータス表示更新 ------------------------------------------

function setStatus(applied) {
  if (applied) {
    statusDot.classList.add("running");
    statusText.textContent = "適用済み";
  } else {
    statusDot.classList.remove("running");
    statusText.textContent = "未適用";
  }
}

// ---- 設定の保存・復元 ----------------------------------------------
// content.js はタブごとにオンデマンド注入され、ページがリロードされると
// 実行コンテキストごと破棄されて既定値（レベル3等）に戻ってしまう。
// そのため設定値は拡張機能の storage.local に保存し、ポップアップを
// 開いたときにそこから復元することで、リロード後も前回の値を維持する。

function collectSettings() {
  return {
    chaosLevel: parseInt(levelSlider.value, 10),
    enableCss: optCss.checked,
    enableText: optText.checked,
    enableShuffle: optShuffle.checked,
    enableBlur: optBlur.checked,
    enableImgSwap: optImgSwap.checked,
    enableJsChaos: optJsChaos.checked,
    enableAudioChaos: optAudioChaos.checked,
    glitchWords: glitchWordsInput.value
      .split("\n")
      .map((w) => w.trim())
      .filter((w) => w.length > 0),
  };
}

function applySettingsToUI(settings) {
  if (!settings) return;
  if (typeof settings.chaosLevel === "number") {
    levelSlider.value = settings.chaosLevel;
    levelValue.textContent = settings.chaosLevel;
  }
  if (typeof settings.enableCss === "boolean")
    optCss.checked = settings.enableCss;
  if (typeof settings.enableText === "boolean")
    optText.checked = settings.enableText;
  if (typeof settings.enableShuffle === "boolean")
    optShuffle.checked = settings.enableShuffle;
  if (typeof settings.enableBlur === "boolean")
    optBlur.checked = settings.enableBlur;
  if (typeof settings.enableImgSwap === "boolean")
    optImgSwap.checked = settings.enableImgSwap;
  if (typeof settings.enableJsChaos === "boolean")
    optJsChaos.checked = settings.enableJsChaos;
  if (typeof settings.enableAudioChaos === "boolean")
    optAudioChaos.checked = settings.enableAudioChaos;
  if (Array.isArray(settings.glitchWords) && settings.glitchWords.length > 0) {
    glitchWordsInput.value = settings.glitchWords.join("\n");
  }
}

async function saveSettings() {
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: collectSettings() });
  } catch (_) {
    /* storage が使えない環境では無視 */
  }
}

// 各コントロールを変更した時点で即座に保存（発動ボタンを押さなくても残る）
levelSlider.addEventListener("change", saveSettings);
for (const opt of [
  optCss,
  optText,
  optShuffle,
  optBlur,
  optImgSwap,
  optJsChaos,
  optAudioChaos,
]) {
  opt.addEventListener("change", saveSettings);
}
glitchWordsInput.addEventListener("change", saveSettings);

// ---- アクティブタブ取得 ------------------------------------------

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// ---- content.js を動的に注入（まだ注入されていない場合） ---------

async function ensureContentScript(tabId) {
  try {
    // content.js が既に動いているか確認
    const resp = await browser.tabs.sendMessage(tabId, { action: "getStatus" });
    return resp; // 既に注入済み
  } catch (_) {
    // 注入されていないので実行
    await browser.tabs.executeScript(tabId, { file: "content.js" });
    // 少し待ってから再試行
    await new Promise((r) => setTimeout(r, 100));
    return browser.tabs.sendMessage(tabId, { action: "getStatus" });
  }
}

// ---- ポップアップ開いたときの設定復元・ステータス同期 ------------

(async () => {
  // 1. まず保存済みの設定を復元（ページがリロードされていても前回値を維持）
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    applySettingsToUI(stored?.[STORAGE_KEY]);
  } catch (_) {
    /* storage が使えない環境では既定値のまま */
  }

  // 2. content script が既にこのタブで稼働中なら、その実際の状態で上書き
  try {
    const tab = await getActiveTab();
    const resp = await ensureContentScript(tab.id);
    setStatus(resp?.isApplied ?? false);
    if (resp?.isApplied) {
      applySettingsToUI(resp);
    }
  } catch (_) {
    setStatus(false);
  }
})();

// ---- ボタンイベント -----------------------------------------------

btnStart.addEventListener("click", async () => {
  const tab = await getActiveTab();
  await ensureContentScript(tab.id);
  const settings = collectSettings();
  await saveSettings();
  await browser.tabs.sendMessage(tab.id, {
    action: "start",
    level: settings.chaosLevel,
    words: settings.glitchWords,
    css: settings.enableCss,
    text: settings.enableText,
    shuffle: settings.enableShuffle,
    blur: settings.enableBlur,
    imgSwap: settings.enableImgSwap,
    jsChaos: settings.enableJsChaos,
    audioChaos: settings.enableAudioChaos,
  });
  setStatus(true);
});

btnReset.addEventListener("click", async () => {
  const tab = await getActiveTab();
  try {
    await browser.tabs.sendMessage(tab.id, { action: "reset" });
  } catch (_) {
    /* 未注入なら無視 */
  }
  setStatus(false);
  window.close();
});

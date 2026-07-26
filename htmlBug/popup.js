// popup.js — ChaosMode ポップアップ制御

"use strict";

const levelSlider = document.getElementById("chaos-level");
const levelValue = document.getElementById("level-value");
const glitchWordsInput = document.getElementById("glitch-words");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const btnStart = document.getElementById("btn-start");
const btnReset = document.getElementById("btn-reset");

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

// ---- ポップアップ開いたときのステータス同期 ----------------------

(async () => {
  try {
    const tab = await getActiveTab();
    const resp = await ensureContentScript(tab.id);
    setStatus(resp?.isApplied ?? false);
    if (resp?.chaosLevel) {
      levelSlider.value = resp.chaosLevel;
      levelValue.textContent = resp.chaosLevel;
    }
    // 前回のチェックボックス状態を復元
    if (typeof resp?.enableCss === "boolean")
      document.getElementById("opt-css").checked = resp.enableCss;
    if (typeof resp?.enableText === "boolean")
      document.getElementById("opt-text").checked = resp.enableText;
    if (typeof resp?.enableShuffle === "boolean")
      document.getElementById("opt-shuffle").checked = resp.enableShuffle;
    if (typeof resp?.enableBlur === "boolean")
      document.getElementById("opt-blur").checked = resp.enableBlur;
    if (typeof resp?.enableImgSwap === "boolean")
      document.getElementById("opt-imgswap").checked = resp.enableImgSwap;
    if (typeof resp?.enableJsChaos === "boolean")
      document.getElementById("opt-jschaos").checked = resp.enableJsChaos;
    if (typeof resp?.enableAudioChaos === "boolean")
      document.getElementById("opt-audiochaos").checked =
        resp.enableAudioChaos;
    // 前回のグリッチワードを復元
    if (Array.isArray(resp?.glitchWords) && resp.glitchWords.length > 0) {
      glitchWordsInput.value = resp.glitchWords.join("\n");
    }
  } catch (_) {
    setStatus(false);
  }
})();

// ---- ボタンイベント -----------------------------------------------

btnStart.addEventListener("click", async () => {
  const tab = await getActiveTab();
  await ensureContentScript(tab.id);
  // グリッチワード: 改行で区切って空行やスペースのみの行を除去
  const words = glitchWordsInput.value
    .split("\n")
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  await browser.tabs.sendMessage(tab.id, {
    action: "start",
    level: parseInt(levelSlider.value, 10),
    words,
    css: document.getElementById("opt-css").checked,
    text: document.getElementById("opt-text").checked,
    shuffle: document.getElementById("opt-shuffle").checked,
    blur: document.getElementById("opt-blur").checked,
    imgSwap: document.getElementById("opt-imgswap").checked,
    jsChaos: document.getElementById("opt-jschaos").checked,
    audioChaos: document.getElementById("opt-audiochaos").checked,
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

// ============================================================
//  NumFuzz - popup.js
// ============================================================

"use strict";

const toggleEnable    = document.getElementById("toggle-enable");
const toggleWasm      = document.getElementById("toggle-wasm");
const sliderLevel     = document.getElementById("slider-level");
const sliderProb      = document.getElementById("slider-prob");
const valLevel        = document.getElementById("val-level");
const valProb         = document.getElementById("val-prob");
const statusDot       = document.getElementById("status-dot");
const statusText      = document.getElementById("status-text");
const fuzzInfo        = document.getElementById("fuzz-info");
const levelDesc       = document.getElementById("level-desc");
const currentOriginEl = document.getElementById("current-origin");
const siteModeEl      = document.getElementById("site-mode");
const siteBadge       = document.getElementById("site-badge");
const toggleRandom    = document.getElementById("toggle-random");
const rulesInfo       = document.getElementById("rules-info");
const openEditorBtn   = document.getElementById("open-editor");

let currentOrigin = null;
let currentTabId  = null;
let rulesCount    = 0;

const LEVEL_DESCS = [
  "Lv1 — ±10%　わずかなズレ",
  "Lv2 — ×0.7〜1.5　明確なズレ",
  "Lv3 — ×0.5〜2.0　半分〜2倍（推奨）",
  "Lv4 — ×0.2〜5.0　大幅な変動",
  "Lv5 — ×0.01〜10　ほぼランダム",
];

// ---- UI 更新 -------------------------------------------------------

function updateLevelDesc(lv) {
  levelDesc.textContent = LEVEL_DESCS[lv - 1] || "";
}

/**
 * グローバル設定とサイト別設定を受け取り、実効状態を表示する
 */
function updateStatus(settings) {
  const sensitive = currentOrigin && isSensitiveSite(currentOrigin);
  const effective = !sensitive && isEnabledFor(settings, currentOrigin || "");
  if (effective) {
    statusDot.classList.add("active");
    statusText.textContent = settings.numFuzzRandom
      ? "有効（次のリロードから適用）"
      : rulesCount ? "有効（ルールのみ）" : "有効（検出のみ）";
  } else {
    statusDot.classList.remove("active");
    statusText.textContent = sensitive ? "無効（保護対象サイト）" : "無効";
  }
}

function updateLastMult(mult, url) {
  if (typeof mult === "number") {
    fuzzInfo.textContent = "前回 ×" + mult.toFixed(4);
    fuzzInfo.title = url || "";
  } else {
    fuzzInfo.textContent = "—";
  }
}

/**
 * サイトバッジ（グローバル/カスタム有効/カスタム無効）を更新する
 */
function updateSiteBadge(settings) {
  const sites = settings.numFuzzSites;
  if (!currentOrigin || !(currentOrigin in sites)) {
    const g = settings.numFuzzEnabled;
    siteBadge.textContent = "グローバル設定を使用中（" + (g ? "有効" : "無効") + "）";
    siteBadge.className = "";
  } else if (sites[currentOrigin]) {
    siteBadge.textContent = "このサイト: カスタム有効";
    siteBadge.className = "on";
  } else {
    siteBadge.textContent = "このサイト: カスタム無効";
    siteBadge.className = "off";
  }
}

// ---- 初期化（タブURL取得 → ストレージ読み込み） --------------------

function updateRulesInfo(settings) {
  const list = (currentOrigin && settings.numFuzzRules[currentOrigin]) || [];
  rulesCount = list.filter((r) => r.enabled).length;
  rulesInfo.textContent = list.length
    ? `このサイトのルール: ${list.length}件（有効 ${rulesCount}件）`
    : "このサイトのルール: なし";
}

browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
  currentTabId  = tabs[0] ? tabs[0].id : null;
  currentOrigin = tabs[0] && tabs[0].url ? originKey(tabs[0].url) : "";
  currentOriginEl.textContent = currentOrigin || "取得できませんでした";
  if (!currentOrigin) {
    siteModeEl.disabled = true;
    openEditorBtn.disabled = true;
  }

  return browser.storage.local.get(
    Object.assign({}, DEFAULT_SETTINGS, { numFuzzLastMult: null, numFuzzLastUrl: "" }),
  );
}).then((s) => {
  toggleEnable.checked = s.numFuzzEnabled;
  toggleWasm.checked   = s.numFuzzWasm;
  toggleRandom.checked = s.numFuzzRandom;
  sliderLevel.value    = s.numFuzzLevel;
  sliderProb.value     = Math.round(s.numFuzzProb * 100);
  valLevel.textContent = s.numFuzzLevel;
  valProb.textContent  = Math.round(s.numFuzzProb * 100) + "%";
  updateLevelDesc(s.numFuzzLevel);

  // サイト別設定をセレクトに反映（未設定サイトはグローバルに従う）
  if (currentOrigin && currentOrigin in s.numFuzzSites) {
    siteModeEl.value = s.numFuzzSites[currentOrigin] ? "on" : "off";
  } else {
    siteModeEl.value = "global";
  }

  updateRulesInfo(s);
  updateSiteBadge(s);
  updateStatus(s);
  updateLastMult(s.numFuzzLastMult, s.numFuzzLastUrl);
}).catch((e) => {
  currentOriginEl.textContent = "エラー: " + e.message;
});

// ---- 設定保存 -------------------------------------------------------

function saveSettings() {
  browser.storage.local.get({ numFuzzSites: {} }).then((s) => {
    const sites = Object.assign({}, s.numFuzzSites);

    // サイト別オーバーライドの更新
    if (currentOrigin) {
      if (siteModeEl.value === "global") {
        delete sites[currentOrigin];
      } else {
        sites[currentOrigin] = (siteModeEl.value === "on");
      }
    }

    const next = {
      numFuzzEnabled: toggleEnable.checked,
      numFuzzWasm:    toggleWasm.checked,
      numFuzzRandom:  toggleRandom.checked,
      numFuzzLevel:   Number(sliderLevel.value),
      numFuzzProb:    Number(sliderProb.value) / 100,
      numFuzzSites:   sites,
    };
    return browser.storage.local.set(next).then(() => next);
  }).then((next) => {
    updateSiteBadge(next);
    updateStatus(next);
  });
}

// ---- イベント -------------------------------------------------------

toggleEnable.addEventListener("change", saveSettings);
toggleWasm.addEventListener("change", saveSettings);
toggleRandom.addEventListener("change", saveSettings);
siteModeEl.addEventListener("change", saveSettings);

openEditorBtn.addEventListener("click", () => {
  const url = browser.runtime.getURL("editor.html") +
    "?tab=" + encodeURIComponent(currentTabId) + "&origin=" + encodeURIComponent(currentOrigin);
  browser.tabs.create({ url }).then(() => window.close());
});

// ドラッグ中は表示だけ更新し、確定時に保存する
sliderLevel.addEventListener("input", () => {
  valLevel.textContent = sliderLevel.value;
  updateLevelDesc(Number(sliderLevel.value));
});
sliderLevel.addEventListener("change", saveSettings);

sliderProb.addEventListener("input", () => {
  valProb.textContent = sliderProb.value + "%";
});
sliderProb.addEventListener("change", saveSettings);

// 拡張機能の再読み込み漏れに気付けるよう、実際に動いているバージョンを表示する
document.getElementById("footer").textContent = "NumFuzz v" + browser.runtime.getManifest().version;

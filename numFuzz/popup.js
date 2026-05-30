// ============================================================
//  NumFuzz - popup.js
// ============================================================

"use strict";

const toggleEnable    = document.getElementById("toggle-enable");
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

let currentOrigin = null;

const LEVEL_DESCS = [
  "Lv1 — ±10%　わずかなズレ",
  "Lv2 — ×0.7〜1.5　明確なズレ",
  "Lv3 — ×0.5〜2.0　半分〜2倍（推奨）",
  "Lv4 — ×0.2〜5.0　大幅な変動",
  "Lv5 — ×0.01〜10　ほぼランダム",
];

const RANGES = [
  [0.9,  1.1 ],
  [0.7,  1.5 ],
  [0.5,  2.0 ],
  [0.2,  5.0 ],
  [0.01, 10.0],
];

function genNextMult(level) {
  const [rMin, rMax] = RANGES[Math.min(level, 5) - 1];
  return rMin + Math.random() * (rMax - rMin);
}

// ---- UI 更新 -------------------------------------------------------

function updateLevelDesc(lv) {
  levelDesc.textContent = LEVEL_DESCS[lv - 1] || "";
}

/**
 * グローバル設定とサイト別設定を受け取り、実効状態を表示する
 */
function updateStatus(globalEnabled, sites, mult, url) {
  const effective = getEffectiveEnabled(globalEnabled, sites);
  if (effective) {
    statusDot.classList.add("active");
    statusText.textContent = "有効（次のリロードから適用）";
  } else {
    statusDot.classList.remove("active");
    statusText.textContent = "無効";
  }
  if (mult) {
    fuzzInfo.textContent = "前回 ×" + mult.toFixed(4);
    fuzzInfo.title = url || "";
  } else {
    fuzzInfo.textContent = "—";
  }
}

/**
 * サイト別オーバーライドを考慮した実効 enabled 値を返す
 */
function getEffectiveEnabled(globalEnabled, sites) {
  if (currentOrigin && currentOrigin in sites) {
    return sites[currentOrigin];
  }
  return globalEnabled;
}

/**
 * サイトバッジ（グローバル/カスタム有効/カスタム無効）を更新する
 */
function updateSiteBadge(sites) {
  if (!currentOrigin || !(currentOrigin in sites)) {
    siteBadge.textContent = "グローバル設定を使用中";
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

browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
  if (tabs[0] && tabs[0].url) {
    try {
      const u = new URL(tabs[0].url);
      // file: の場合 origin が "null" になるので hostname を使う
      currentOrigin = (u.origin && u.origin !== "null") ? u.origin : u.protocol + "//" + u.hostname;
      currentOriginEl.textContent = currentOrigin;
    } catch (_) {
      currentOriginEl.textContent = "取得できませんでした";
    }
  } else {
    currentOriginEl.textContent = "取得できませんでした";
  }

  return browser.storage.local.get({
    numFuzzEnabled:  false,
    numFuzzLevel:    3,
    numFuzzProb:     0.5,
    numFuzzSites:    {},
    numFuzzLastMult: null,
    numFuzzLastUrl:  "",
  });
}).then((s) => {
  toggleEnable.checked = s.numFuzzEnabled;
  sliderLevel.value    = s.numFuzzLevel;
  sliderProb.value     = Math.round(s.numFuzzProb * 100);
  valLevel.textContent = s.numFuzzLevel;
  valProb.textContent  = Math.round(s.numFuzzProb * 100) + "%";
  updateLevelDesc(s.numFuzzLevel);

  // サイト別設定をセレクトに反映
  if (currentOrigin && currentOrigin in s.numFuzzSites) {
    siteModeEl.value = s.numFuzzSites[currentOrigin] ? "on" : "off";
  } else {
    siteModeEl.value = "global";
  }

  updateSiteBadge(s.numFuzzSites);
  updateStatus(s.numFuzzEnabled, s.numFuzzSites, s.numFuzzLastMult, s.numFuzzLastUrl);
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

    return browser.storage.local.set({
      numFuzzEnabled:  toggleEnable.checked,
      numFuzzLevel:    Number(sliderLevel.value),
      numFuzzProb:     Number(sliderProb.value) / 100,
      numFuzzSites:    sites,
      numFuzzNextMult: genNextMult(Number(sliderLevel.value)), // 次回ロード用乗数を事前生成
    }).then(() => sites);
  }).then((sites) => {
    updateSiteBadge(sites);
    updateStatus(toggleEnable.checked, sites, null, "");
  });
}

// ---- イベント -------------------------------------------------------

toggleEnable.addEventListener("change", saveSettings);
siteModeEl.addEventListener("change", saveSettings);

sliderLevel.addEventListener("input", () => {
  valLevel.textContent = sliderLevel.value;
  updateLevelDesc(Number(sliderLevel.value));
  saveSettings();
});

sliderProb.addEventListener("input", () => {
  valProb.textContent = sliderProb.value + "%";
  saveSettings();
});

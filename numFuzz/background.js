// ============================================================
//  NumFuzz - background.js
//
//  filterResponseData でネットワークレベルの傍受を実装
//  <script src="..."> タグ経由の JS も含め全スクリプトを書き換え可能
//
//  ★ content.js の fetch/XHR フックでは届かなかった
//    <script src> タグをここで補完する
// ============================================================

"use strict";

const RANGES = [
  [0.9, 1.1], // level 1: ±10%
  [0.7, 1.5], // level 2
  [0.5, 2.0], // level 3: 半分〜2倍
  [0.2, 5.0], // level 4
  [0.01, 10.0], // level 5: 激烈
];

// ページロード単位で乗数を統一するためのタブ別キャッシュ
const _tabState = new Map(); // tabId -> { mult, prob }

// ----------------------------------------------------------------
//  設定キャッシュ（起動時・変更時に更新）
//  onBeforeRequest 内で同期的に参照し、無効サイトはフィルタ自体を作らない
//
//  ★ SRI 問題の根本原因：従来は無効サイトでも filterResponseData を生成して
//    TextDecoder → TextEncoder でバイト列を冊情報を通して書き戻していたため、
//    reCAPTCHA 等 SRI 付きスクリプトのハッシュ不一致 → Google CAPTCHA 発生
// ----------------------------------------------------------------
let _settingsCache = {
  numFuzzEnabled: false,
  numFuzzSites: {},
  numFuzzLevel: 3,
  numFuzzProb: 0.5,
};

function refreshSettingsCache() {
  browser.storage.local
    .get({
      numFuzzEnabled: false,
      numFuzzSites: {},
      numFuzzLevel: 3,
      numFuzzProb: 0.5,
    })
    .then((s) => {
      _settingsCache = s;
    })
    .catch(() => {});
}

refreshSettingsCache(); // 起動時に読み込み
browser.storage.onChanged.addListener(refreshSettingsCache); // ポップアップで変更時に自動更新

function isEnabledForOrigin(origin) {
  const siteOv = _settingsCache.numFuzzSites[origin];
  return siteOv !== undefined ? siteOv : _settingsCache.numFuzzEnabled;
}

// タブがローディング開始 or 削除されたらキャッシュをクリア
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") _tabState.delete(tabId);
});
browser.tabs.onRemoved.addListener((tabId) => _tabState.delete(tabId));

// ----------------------------------------------------------------
//  Cocos Creator エンジン本体のみスキップ
//  main.*.js や chunk.*.js はゲームスクリプトなので Fuzz 対象にする
// ----------------------------------------------------------------
function isEngineFile(url) {
  return /cocos2d|jsb-adapter|physics-builtin|physics-cannon|ammo\.wasm|phaser/.test(
    url.toLowerCase(),
  );
}

// SRI ハッシュが付くサードパーティ CDN はスキップ
// (内容を書き換えると integrity チェック失敗でゲームが止まる)
const THIRD_PARTY_CDN_RE =
  /\b(cloudflareinsights|google-analytics|googletagmanager|googlesyndication|doubleclick|facebook\.net|fbcdn\.net|clarity\.ms|hotjar|newrelic|datadoghq|segment\.io|mixpanel|amplitude|intercom|zendesk|sentry\.io|bugsnag|rollbar|logrocket)\b/i;

function isThirdPartyCdn(url) {
  return THIRD_PARTY_CDN_RE.test(url);
}

// 検索エンジン・認証・決済など、bot検出やreCAPTCHAを使うセンシティブなオリジンはスキップ
// グローバル有効でもこれらのサイトは絶対に書き換えない
const SENSITIVE_ORIGIN_RE =
  /\b(google|googleapis|gstatic|recaptcha|youtube|ytimg|bing|yahoo|duckduckgo|yandex|baidu|naver|ecosia|brave\.com|paypal|stripe|amazon|apple|icloud|microsoft|live\.com|outlook|github|gitlab|twitter|x\.com|facebook|instagram|linkedin|reddit|wikipedia)\b/i;

function isSensitiveSite(origin) {
  return SENSITIVE_ORIGIN_RE.test(origin);
}

// JS ソースの数値リテラルを書き換える
function fuzzJs(src, mult, prob) {
  let count = 0;
  const out = src.replace(
    /(?<![A-Za-z0-9_$.\[])(0x[0-9A-Fa-f]+|\d+\.\d+|\d+\.?|\.\d+)(?![A-Za-z0-9_$\]:])/g,
    (t) => {
      if (t[0] === "0" && (t[1] === "x" || t[1] === "X")) return t;
      const n = parseFloat(t);
      if (
        !isFinite(n) ||
        (t.indexOf(".") < 0 && Math.abs(n) <= 10) || // 小整数（-10〜10）はスキップ
        Math.random() > prob
      )
        return t;
      count++;
      const r = n * mult;
      return t.includes(".") ? r.toFixed(6) : String(Math.round(r));
    },
  );
  return { out, count };
}

// JSON オブジェクトの数値を再帰的に書き換える
function fuzzObj(o, d, mult) {
  if (d <= 0 || o === null || o === undefined) return;
  if (Array.isArray(o)) {
    for (const v of o) fuzzObj(v, d - 1, mult);
    return;
  }
  if (typeof o !== "object") return;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === "number" && isFinite(v) && v !== 0 && v !== 1 && v !== -1)
      o[k] = v * mult;
    else fuzzObj(v, d - 1, mult);
  }
}

// ----------------------------------------------------------------
//  タブの乗数を取得（なければ生成して _tabState に保存）
//  storage から level/prob を読んで初期化する
// ----------------------------------------------------------------
function ensureTabState(tabId, s) {
  if (!_tabState.has(tabId)) {
    const [rMin, rMax] = RANGES[Math.min(s.numFuzzLevel, 5) - 1];
    const mult = rMin + Math.random() * (rMax - rMin);
    _tabState.set(tabId, { mult, prob: Number(s.numFuzzProb) });
    console.log(
      `[NumFuzz BG] タブ${tabId} 乗数生成: ${mult.toFixed(6)} prob:${s.numFuzzProb}`,
    );
  }
  return _tabState.get(tabId);
}

// ================================================================
//  メインのネットワーク傍受リスナー
//  types: ["script"] → <script src="..."> タグを傍受できる
//  types: ["xmlhttprequest"] → fetch()/XHR を傍受できる
// ================================================================
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url, tabId } = details;
    if (tabId < 0) return {};

    // URLパスに .js/.json が含まれるか確認（version hash がパス末尾に来るURLも考慮）
    const isJs   = /\.js(?:\/|$|\?)/.test(url) || /\.js$/.test(url.split("/").pop().split("?")[0]);
    const isJson = /\.json(?:\/|$|\?)/.test(url) || /\.json$/.test(url.split("/").pop().split("?")[0]);
    if (!isJs && !isJson) return {};

    if (isEngineFile(url)) return {};
    if (isThirdPartyCdn(url)) return {}; // SRI付きサードパーティCDNは絶対スキップ

    // ページオリジン（documentUrl）を取得してチェックの基準にする
    // → ゲームページが有効かどうかを判定するため、リソースURLではなくページURLを使う
    let pageOrigin = "";
    try {
      const docUrl = details.documentUrl || details.originUrl;
      if (docUrl) pageOrigin = new URL(docUrl).origin;
    } catch (_) {}

    let reqOrigin = "";
    try { reqOrigin = new URL(url).origin; } catch (_) {}

    // センシティブサイト（検索エンジン・認証・決済等）はグローバル有効でも絶対スキップ
    if (isSensitiveSite(pageOrigin) || isSensitiveSite(reqOrigin)) {
      return {};
    }

    // クロスオリジンスクリプトはスキップ（明示的にnumFuzzSitesで有効化された場合のみ許可）
    // → ゲームページが有効でもCDN上のサードパーティスクリプトは書き換えない
    if (pageOrigin && reqOrigin && reqOrigin !== pageOrigin) {
      const explicitlyEnabled = _settingsCache.numFuzzSites[reqOrigin];
      if (explicitlyEnabled !== true) {
        return {};
      }
    }

    // ★ キャッシュで同期チェック：無効サイトはフィルタを一切作らない
    const checkOrigin = pageOrigin || reqOrigin;
    if (!isEnabledForOrigin(checkOrigin)) {
      return {};
    }

    const fname = url.split("/").pop().split("?")[0].toLowerCase();
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const dec = new TextDecoder("utf-8");
    const enc = new TextEncoder();
    const chunks = [];

    filter.ondata = (e) => chunks.push(e.data);
    filter.onerror = () => {
      try { filter.disconnect(); } catch (_) {}
    };

    filter.onstop = () => {
      let raw = "";
      for (const chunk of chunks) raw += dec.decode(chunk, { stream: true });
      raw += dec.decode();

      browser.storage.local
        .get({
          numFuzzEnabled: false,
          numFuzzSites: {},
          numFuzzLevel: 3,
          numFuzzProb: 0.5,
        })
        .then((s) => {
          // onBeforeRequest 通過後に設定が変わった場合の二重確認
          const siteOv = s.numFuzzSites[checkOrigin];
          const enabled = siteOv !== undefined ? siteOv : s.numFuzzEnabled;

          if (!enabled) {
            filter.write(enc.encode(raw));
            filter.disconnect();
            return;
          }

          const { mult, prob } = ensureTabState(tabId, s);

          try {
            let result;
            if (isJs) {
              const { out, count } = fuzzJs(raw, mult, prob);
              console.log(
                `[NumFuzz BG] ✅ JS  ${fname}: ${count}箇所変更 (mult=${mult.toFixed(4)})`,
              );
              result = out;
            } else {
              const o = JSON.parse(raw);
              fuzzObj(o, 6, mult);
              console.log(
                `[NumFuzz BG] ✅ JSON ${fname}: 変更完了 (mult=${mult.toFixed(4)})`,
              );
              result = JSON.stringify(o);
            }
            filter.write(enc.encode(result));
          } catch (e) {
            console.warn(`[NumFuzz BG] ❌ 書き換えエラー ${fname}:`, e.message);
            filter.write(enc.encode(raw));
          }
          filter.disconnect();
        })
        .catch((e) => {
          console.warn("[NumFuzz BG] storage エラー:", e);
          filter.write(enc.encode(raw));
          filter.disconnect();
        });
    };

    return {};
  },
  { urls: ["<all_urls>"], types: ["script", "xmlhttprequest"] },
  ["blocking"],
);

// ----------------------------------------------------------------
//  content.js からのメッセージ受信
//  getTabMult: content.js が eval/JSON.parse フック用に乗数を要求
// ----------------------------------------------------------------
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === "numFuzzReady") {
    browser.storage.local
      .set({
        numFuzzLastMult: msg.mult,
        numFuzzLastUrl: sender.url || "",
      })
      .catch(() => {});
  }

  if (msg.action === "getTabMult") {
    const tabId = sender.tab ? sender.tab.id : -1;
    if (_tabState.has(tabId)) {
      return Promise.resolve(_tabState.get(tabId).mult);
    }
    // まだスクリプトリクエストが来ていない場合はここで生成
    return browser.storage.local
      .get({
        numFuzzEnabled: false,
        numFuzzSites: {},
        numFuzzLevel: 3,
        numFuzzProb: 0.5,
      })
      .then((s) => {
        const origin = sender.url ? new URL(sender.url).origin : "";
        const siteOv = s.numFuzzSites[origin];
        const enabled = siteOv !== undefined ? siteOv : s.numFuzzEnabled;
        if (!enabled) return null;
        return ensureTabState(tabId, s).mult;
      });
  }
});

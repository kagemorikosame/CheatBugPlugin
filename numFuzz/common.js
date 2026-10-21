// ============================================================
//  NumFuzz - common.js
//  background.js / popup.js で共有する定数・判定関数
// ============================================================

"use strict";

const RANGES = [
  [0.9, 1.1], // level 1: ±10%
  [0.7, 1.5], // level 2
  [0.5, 2.0], // level 3: 半分〜2倍
  [0.2, 5.0], // level 4
  [0.01, 10.0], // level 5: 激烈
];

const DEFAULT_SETTINGS = {
  numFuzzEnabled: false,
  numFuzzSites: {},
  numFuzzLevel: 3,
  numFuzzProb: 0.5,
  numFuzzWasm: true,
  numFuzzRandom: true, // false ならランダム書き換えをせず、置き換えルールのみ適用
  numFuzzRules: {}, // origin -> [{ id, enabled, type: "value"|"key", from, to, wasmInt }]
};

// ----------------------------------------------------------------
//  置き換えルール
//  type "value": 元の値 from（数値）に一致したら to にする
//  type "key"  : JSON / JS のキー名 from（文字列）の値を to にする
//  type "wasm" : Unity(IL2CPP) の C# メソッド method 内の index 番目の定数を to にする
//                （元の値 from と一致する場合のみ。valType は表示用）
//  wasmInt     : value ルールを WASM（ゲームの C# コード内）の整数定数にも適用する
//  ※ WASM はどのルールでも、名前の分かるゲームの C# メソッド内しか書き換えない
// ----------------------------------------------------------------

// 保存されているルールのうち有効で正しいものを、検索しやすい形にして返す
function compileRules(settings, origin) {
  const list = (settings.numFuzzRules && settings.numFuzzRules[origin]) || [];
  const value = new Map(); // from(number) -> rule
  const key = new Map(); // from(string) -> rule
  const wasm = new Map(); // "Type.Method#index" -> rule
  for (const r of list) {
    if (!r || !r.enabled) continue;
    const to = Number(r.to);
    if (r.to === "" || r.to === null || !isFinite(to)) continue;
    if (r.type === "wasm") {
      if (r.method && Number.isInteger(r.index)) {
        wasm.set(r.method + "#" + r.index, { to, from: Number(r.from) });
      }
    } else if (r.type === "key") {
      const k = String(r.from || "").trim();
      if (k) key.set(k, { to, wasmInt: false });
    } else {
      const from = Number(r.from);
      if (r.from === "" || r.from === null || !isFinite(from)) continue;
      value.set(from, { to, wasmInt: !!r.wasmInt });
    }
  }
  return { value, key, wasm, size: value.size + key.size + wasm.size };
}

// 検索エンジン・認証・決済など、bot検出やreCAPTCHAを使うセンシティブなオリジンはスキップ
// グローバル有効でもこれらのサイトは絶対に書き換えない
const SENSITIVE_ORIGIN_RE =
  /\b(google|googleapis|gstatic|recaptcha|youtube|ytimg|bing|yahoo|duckduckgo|yandex|baidu|naver|ecosia|brave\.com|paypal|stripe|amazon|apple|icloud|microsoft|live\.com|outlook|github|gitlab|twitter|x\.com|facebook|instagram|linkedin|reddit|wikipedia)\b/i;

function isSensitiveSite(origin) {
  return SENSITIVE_ORIGIN_RE.test(origin);
}

// サイト設定のキー。file: などは origin が "null" になるので protocol + hostname を使う
function originKey(url) {
  try {
    const u = new URL(url);
    return u.origin && u.origin !== "null" ? u.origin : u.protocol + "//" + u.hostname;
  } catch (_) {
    return "";
  }
}

function isEnabledFor(settings, origin) {
  const siteOv = settings.numFuzzSites[origin];
  return siteOv !== undefined ? siteOv : settings.numFuzzEnabled;
}

function genMult(level) {
  const lv = Math.min(Math.max(Number(level) || 3, 1), 5);
  const [rMin, rMax] = RANGES[lv - 1];
  return rMin + Math.random() * (rMax - rMin);
}

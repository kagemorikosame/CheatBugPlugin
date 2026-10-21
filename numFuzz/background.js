// ============================================================
//  NumFuzz - background.js
//
//  filterResponseData でネットワークレベルの傍受を実装
//  <script src="..."> / fetch() / XHR で読まれる JS・JSON・WASM を書き換える
//  （ランダム書き換え + サイトごとの置き換えルール + 検出値の記録）
//  （数値の書き換えはここだけで行う。ページ側でのフックは二重適用になるため持たない）
// ============================================================

"use strict";

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
let _settingsCache = Object.assign({}, DEFAULT_SETTINGS);

function refreshSettingsCache() {
  browser.storage.local
    .get(DEFAULT_SETTINGS)
    .then((s) => {
      _settingsCache = s;
    })
    .catch(() => {});
}

refreshSettingsCache(); // 起動時に読み込み
browser.storage.onChanged.addListener(refreshSettingsCache); // ポップアップで変更時に自動更新

// タブのトップレベル URL（itch.io 等、ゲームが別オリジンの iframe 内で動く場合の判定用）
const _tabTopUrl = new Map(); // tabId -> url

// 検出値（書き換え前の値）。ルール編集ページから検索する
const _tabScan = new Map(); // tabId -> scan

function newScan() {
  return {
    files: [], // { name, kind, count }
    json: [], // { file, path, key, value }
    js: new Map(), // value -> { count, keys: Map<key, count> }
    wasm: [], // Unity C# メソッドごとの定数: { method, consts: [{ i, t, v }] }
  };
}

function getScan(tabId) {
  if (!_tabScan.has(tabId)) _tabScan.set(tabId, newScan());
  return _tabScan.get(tabId);
}

// ----------------------------------------------------------------
//  Unity(IL2CPP) の C# メタデータ（unityMeta.js の要約）
//  .data の読み込みで取得し、同じタブの .wasm の書き換えで使う。
//  Unity は .data を IndexedDB にキャッシュするため、2回目以降は 304 で本体が来ない。
//  その場合に備えて要約を storage にも保存しておく（URL ごと）。
// ----------------------------------------------------------------
const _tabMeta = new Map(); // tabId -> { promise, resolve }
const META_CACHE_KEY = "numFuzzMetaCache";
const META_WAIT_MS = 120000;

function expectMeta(tabId) {
  if (!_tabMeta.has(tabId)) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    _tabMeta.set(tabId, { promise, resolve });
  }
  return _tabMeta.get(tabId);
}

function clearMeta(tabId) {
  const m = _tabMeta.get(tabId);
  if (m) m.resolve(null); // 待っている wasm を解放する
  _tabMeta.delete(tabId);
}

// Unity は .wasm と .data をほぼ同時に（.wasm が先のこともある）読み込み始める。
// .wasm の受信完了時点で .data がまだ始まっていなければ少しだけ待ち、
// それでも来なければ Unity 以外とみなして null
const META_APPEAR_MS = 5000;

function waitMeta(tabId) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const poll = () => {
      const m = _tabMeta.get(tabId);
      if (m) {
        Promise.race([m.promise, new Promise((r) => setTimeout(() => r(null), META_WAIT_MS))]).then(resolve);
      } else if (Date.now() - t0 >= META_APPEAR_MS) {
        resolve(null);
      } else {
        setTimeout(poll, 100);
      }
    };
    poll();
  });
}

function metaCacheKey(url) {
  return url.split("?")[0];
}

function loadCachedMeta(url) {
  return browser.storage.local.get({ [META_CACHE_KEY]: {} })
    .then((s) => {
      const cached = s[META_CACHE_KEY][metaCacheKey(url)];
      return cached && cached.schema === META_SCHEMA ? cached : null; // 古い形式は使わない
    })
    .catch(() => null);
}

function saveCachedMeta(url, meta) {
  return browser.storage.local.get({ [META_CACHE_KEY]: {} }).then((s) => {
    const cache = s[META_CACHE_KEY];
    delete cache[metaCacheKey(url)];
    cache[metaCacheKey(url)] = meta;
    const keys = Object.keys(cache);
    for (const k of keys.slice(0, Math.max(0, keys.length - 3))) delete cache[k]; // 直近3件だけ残す（1件数百KB）
    return browser.storage.local.set({ [META_CACHE_KEY]: cache });
  }).catch(() => {});
}

function concatChunks(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    bytes.set(new Uint8Array(chunk), off);
    off += chunk.byteLength;
  }
  return bytes;
}

// Content-Encoding なしで gzip のまま届いた場合（Unity の解凍フォールバック）は展開を試みる
function maybeGunzip(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || typeof DecompressionStream !== "function") {
    return Promise.resolve(bytes);
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer().then((buf) => new Uint8Array(buf)).catch(() => bytes);
}

// .data の本体からメタデータを得る。本体がない（304 等）・読めない場合はキャッシュ → 再取得の順に試す
function resolveMetaFromData(url, bytes) {
  return maybeGunzip(bytes).then((data) => {
    const meta = data.length ? metaFromUnityData(data) : null;
    if (meta) {
      saveCachedMeta(url, meta);
      return meta;
    }
    return loadCachedMeta(url).then((cached) => {
      if (cached || data.length) return cached;
      // キャッシュもない 304 の場合は自分で取り直す（tabId=-1 なので書き換え対象にならない）
      return fetch(url, { cache: "no-store" })
        .then((r) => r.arrayBuffer())
        .then((buf) => maybeGunzip(new Uint8Array(buf)))
        .then((d) => {
          const m = metaFromUnityData(d);
          if (m) saveCachedMeta(url, m);
          return m;
        })
        .catch(() => null);
    });
  });
}

// トップレベルのナビゲーション開始 or タブ削除でキャッシュをクリア
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    _tabState.delete(details.tabId);
    _tabScan.delete(details.tabId);
    clearMeta(details.tabId);
    _tabLiveFrame.delete(details.tabId);
    _tabLiveInfo.delete(details.tabId);
    _tabTopUrl.set(details.tabId, details.url);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
);
browser.tabs.onRemoved.addListener((tabId) => {
  _tabState.delete(tabId);
  _tabScan.delete(tabId);
  clearMeta(tabId);
  _tabLiveFrame.delete(tabId);
  _tabLiveInfo.delete(tabId);
  _tabTopUrl.delete(tabId);
});

function getTopUrl(details) {
  if (_tabTopUrl.has(details.tabId)) return _tabTopUrl.get(details.tabId);
  const anc = details.frameAncestors;
  if (anc && anc.length) return anc[anc.length - 1].url;
  return details.documentUrl || details.originUrl || "";
}

// ----------------------------------------------------------------
//  エンジン本体のみスキップ
//  Cocos: main.*.js や chunk.*.js はゲームスクリプトなので Fuzz 対象にする
//  Unity: loader.js / framework.js は Emscripten のグルーコード（ゲームの値は wasm 側）
// ----------------------------------------------------------------
function isEngineFile(url) {
  return /cocos2d|jsb-adapter|physics-builtin|physics-cannon|ammo\.wasm|phaser|\.loader\.js|\.framework\.js|unityloader/.test(
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

// 数値 1 個のランダム書き換え（JS・JSON 共通ルール）
//  - 小整数（-10〜10）はスキップ（ループ・インデックス・フラグ等を壊さないため）
//  - 整数は整数のまま、小数は小数のまま
function fuzzNum(n, isInt, mult) {
  const r = n * mult;
  return isInt ? Math.round(r) : r;
}

// 負の値は直前の演算子とくっつかないよう括弧で囲む（x-100 → x-(-3)）
function jsNum(v) {
  return v < 0 ? "(" + v + ")" : String(v);
}

const JS_NUM_RE = /(?<![A-Za-z0-9_$.\[])(0x[0-9A-Fa-f]+|\d+\.\d+|\d+\.?|\.\d+)(?![A-Za-z0-9_$\]:])/g;
// 直前が `key:` / `key =` / `"key":` ならキー名とみなす（負号付きも可）
const JS_KEY_RE = /([A-Za-z_$][\w$]*)["']?\s*[:=]\s*(?:-\s*)?$/;
// 直前の `-` が単項マイナスかどうか（二項演算の引き算は負の値として扱わない）
const JS_NEG_RE = /(?:^|[(\[{,=:?!&|+*\/%<>;~^]|\breturn)\s*-\s*$/;

function countUp(map, key, limit) {
  const c = map.get(key);
  if (c !== undefined) map.set(key, c + 1);
  else if (map.size < limit) map.set(key, 1);
}

// JS ソースの数値リテラルを書き換える
//  ctx: { mult, prob, random, rules, scan }
function fuzzJs(src, ctx) {
  const { mult, prob, random, rules, scan } = ctx;
  const needCtx = rules.size > 0 || !!scan;
  let count = 0;
  const out = src.replace(JS_NUM_RE, (t, _g, off) => {
    const isHex = t[0] === "0" && (t[1] === "x" || t[1] === "X");
    const n = isHex ? parseInt(t, 16) : parseFloat(t);
    if (!isFinite(n)) return t;

    let key = null, neg = false;
    if (needCtx) {
      const before = src.slice(Math.max(0, off - 80), off);
      const km = JS_KEY_RE.exec(before);
      if (km) key = km[1];
      neg = JS_NEG_RE.test(before);
    }
    const sv = neg ? -n : n;

    if (scan) {
      let e = scan.js.get(sv);
      if (!e && scan.js.size < 50000) scan.js.set(sv, (e = { count: 0, keys: new Map() }));
      if (e) {
        e.count++;
        if (key) countUp(e.keys, key, 20);
      }
    }

    const rule = (key && rules.key.get(key)) || rules.value.get(sv);
    if (rule) {
      count++;
      // 負号は元のソースに残るので、-X = to となる X を出力する
      return neg ? jsNum(-rule.to) : jsNum(rule.to);
    }

    const isInt = t.indexOf(".") < 0;
    if (!random || isHex || (isInt && Math.abs(n) <= 10) || Math.random() > prob) return t;
    count++;
    const r = fuzzNum(n, isInt, mult);
    return isInt ? String(r) : r.toFixed(6);
  });
  return { out, count };
}

// JSON オブジェクトの数値を再帰的に書き換える
//  ランダム書き換えは深さ6まで。ルールはそれより深くても適用する
//  "__xxx__" キー（Cocos の __id__ / __type__ 等の参照情報）はキー名ルール以外では触らない
function fuzzObj(o, ctx, file, path, depth) {
  if (depth > 32 || o === null || typeof o !== "object") return 0;
  const { mult, prob, random, rules, scan } = ctx;
  let count = 0;
  const isArr = Array.isArray(o);
  const keys = isArr ? o.keys() : Object.keys(o);
  for (const k of keys) {
    const v = o[k];
    const p = isArr ? path + "[" + k + "]" : path ? path + "." + k : String(k);
    if (typeof v !== "number") {
      count += fuzzObj(v, ctx, file, p, depth + 1);
      continue;
    }
    if (!isFinite(v)) continue;
    const keyName = isArr ? null : k;
    if (scan && scan.json.length < 5000) scan.json.push({ file, path: p, key: keyName, value: v });

    const keyRule = keyName !== null ? rules.key.get(keyName) : undefined;
    if (keyRule) {
      o[k] = keyRule.to;
      count++;
      continue;
    }
    if (keyName !== null && /^__.*__$/.test(keyName)) continue;
    const valueRule = rules.value.get(v);
    if (valueRule) {
      o[k] = valueRule.to;
      count++;
      continue;
    }

    const isInt = Number.isInteger(v);
    if (!random || depth >= 6 || (isInt && Math.abs(v) <= 10) || Math.random() > prob) continue;
    o[k] = fuzzNum(v, isInt, mult);
    count++;
  }
  return count;
}

// ----------------------------------------------------------------
//  タブの乗数を取得（なければ生成して _tabState に保存）
//  ポップアップ表示用に最後の乗数も保存する
// ----------------------------------------------------------------
function ensureTabState(tabId, pageUrl) {
  if (!_tabState.has(tabId)) {
    const mult = genMult(_settingsCache.numFuzzLevel);
    const prob = Number(_settingsCache.numFuzzProb);
    _tabState.set(tabId, { mult, prob });
    console.log(`[NumFuzz BG] タブ${tabId} 乗数生成: ${mult.toFixed(6)} prob:${prob}`);
    browser.storage.local
      .set({ numFuzzLastMult: mult, numFuzzLastUrl: pageUrl || "" })
      .catch(() => {});
  }
  return _tabState.get(tabId);
}

// ================================================================
//  メインのネットワーク傍受リスナー
//  types: ["script"] → <script src="..."> タグを傍受できる
//  types: ["xmlhttprequest"] → fetch()/XHR を傍受できる（Unity の .wasm もここ）
// ================================================================
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url, tabId } = details;
    if (tabId < 0) return {};

    // URLパスに .js/.json が含まれるか確認（version hash がパス末尾に来るURLも考慮）
    const fname = url.split("/").pop().split("?")[0].toLowerCase();
    const isJs   = /\.js(?:\/|$|\?)/.test(url) || /\.js$/.test(fname);
    const isJson = /\.json(?:\/|$|\?)/.test(url) || /\.json$/.test(fname);
    // Unity は .wasm.br / .wasm.gz などの名前で配信する（実体はマジックナンバーで判定）
    const isWasm = /\.wasm(?:\.br|\.gz)?$/.test(fname);
    // Unity の .data（C# のメタデータを読むだけ。中身は書き換えない）
    const isData = /\.data(?:\.br|\.gz)?$/.test(fname);
    if (!isJs && !isJson && !isWasm && !isData) return {};
    if ((isWasm || isData) && !_settingsCache.numFuzzWasm) return {};

    if (isEngineFile(url)) return {};
    if (isThirdPartyCdn(url)) return {}; // SRI付きサードパーティCDNは絶対スキップ

    // ページオリジン（documentUrl）: クロスオリジン判定の基準
    // トップオリジン（タブのURL）: 有効/無効判定の基準
    // → itch.io のようにゲームが別オリジンの iframe で動いても、ポップアップで開いている
    //   タブのサイト設定がそのまま効く
    const docUrl = details.documentUrl || details.originUrl || "";
    const pageOrigin = docUrl ? originKey(docUrl) : "";
    const reqOrigin = originKey(url);
    const topUrl = getTopUrl(details);
    const topOrigin = topUrl ? originKey(topUrl) : "";

    // センシティブサイト（検索エンジン・認証・決済等）はグローバル有効でも絶対スキップ
    if (isSensitiveSite(pageOrigin) || isSensitiveSite(reqOrigin) || isSensitiveSite(topOrigin)) {
      return {};
    }

    // クロスオリジンスクリプトはスキップ（明示的にnumFuzzSitesで有効化された場合のみ許可）
    // → ゲームページが有効でもCDN上のサードパーティスクリプトは書き換えない
    if (pageOrigin && reqOrigin && reqOrigin !== pageOrigin) {
      if (_settingsCache.numFuzzSites[reqOrigin] !== true) {
        return {};
      }
    }

    // ★ キャッシュで同期チェック：無効サイトはフィルタを一切作らない
    //   （ランダム OFF・ルールなしでも、有効サイトでは検出値の記録のためフィルタを作る）
    const checkOrigin = topOrigin || pageOrigin || reqOrigin;
    if (!isEnabledFor(_settingsCache, checkOrigin)) {
      return {};
    }

    const filter = browser.webRequest.filterResponseData(details.requestId);
    const chunks = [];

    // .data は読み取り専用: 受け取ったそばから素通しし、コピーからメタデータを読む
    if (isData) {
      const meta = expectMeta(tabId);
      filter.ondata = (e) => {
        chunks.push(e.data);
        filter.write(e.data);
      };
      filter.onerror = () => {
        meta.resolve(null);
        try { filter.disconnect(); } catch (_) {}
      };
      filter.onstop = () => {
        filter.disconnect();
        resolveMetaFromData(url, concatChunks(chunks)).catch((e) => {
          console.warn(`[NumFuzz BG] ❌ ${fname}: メタデータの解析エラー`, e.message);
          return null;
        }).then((m) => {
          console.log(m
            ? `[NumFuzz BG] 📖 ${fname}: C# メタデータ v${m.version} を読み込み（ゲームのメソッド ${m.images.filter((i) => i.methods).reduce((a, i) => a + i.methods.length, 0)}個）`
            : `[NumFuzz BG] 📖 ${fname}: C# メタデータなし（IL2CPP 以外 / 未対応バージョン）`);
          meta.resolve(m);
        });
      };
      return {};
    }

    filter.ondata = (e) => chunks.push(e.data);
    filter.onerror = () => {
      try { filter.disconnect(); } catch (_) {}
    };

    filter.onstop = async () => {
      const passThrough = () => {
        for (const chunk of chunks) filter.write(chunk); // 元のバイト列をそのまま返す
        filter.disconnect();
      };

      // onBeforeRequest 通過後に設定が変わった場合の二重確認
      if (!isEnabledFor(_settingsCache, checkOrigin)) {
        passThrough();
        return;
      }

      const { mult, prob } = ensureTabState(tabId, topUrl || docUrl || url);
      const rules = compileRules(_settingsCache, checkOrigin);
      const random = _settingsCache.numFuzzRandom;
      const scan = getScan(tabId);
      const tag = `(mult=${mult.toFixed(4)}${random ? "" : " ランダムOFF"}, ルール${rules.size}件)`;

      try {
        if (isWasm) {
          const bytes = concatChunks(chunks);
          // Content-Encoding なしで圧縮されたまま届いた場合（Unity の解凍フォールバック）は触らない
          if (!isWasmBinary(bytes)) {
            console.log(`[NumFuzz BG] ⏭ WASM ${fname}: 圧縮済み/非wasmのためスキップ`);
            passThrough();
            return;
          }
          // 名前の分かるゲームの C# コードだけを書き換えるため、メタデータが必須
          const meta = await waitMeta(tabId);
          const t0 = performance.now();
          const res = fuzzWasm(bytes, {
            meta, mult, prob, random, valueRules: rules.value, wasmRules: rules.wasm, scan: scan.wasm,
          });
          if (res.reason) {
            console.log(`[NumFuzz BG] ⏭ WASM ${fname}: ${res.reason}（エンジン保護のため書き換えません）`);
            scan.files.push({ name: fname, kind: "wasm", count: 0, note: res.reason });
            passThrough();
            return;
          }
          const outBytes = res.bytes;
          // コードセクションを組み直した場合は念のため検証し、壊れていれば元に戻す
          if (outBytes !== bytes && !WebAssembly.validate(outBytes)) {
            console.warn(`[NumFuzz BG] ❌ WASM ${fname}: 組み直し後の検証に失敗したため元のまま返します`);
            passThrough();
            return;
          }
          scan.files.push({ name: fname, kind: "wasm", count: res.count });
          // 実行中の変数一覧（ページ側で読み書きするための型・フィールド情報）
          scan.live = {
            types: res.live, heapStart: res.heapStart, version: meta.version,
            metaSize: meta.metaSize, stringsHeaderPos: meta.stringsHeaderPos, stringsOff: meta.stringsOff,
          };
          console.log(
            `[NumFuzz BG] ✅ WASM ${fname}: ${res.count}箇所変更（対象: ゲームの C# メソッド ${res.games}個） ${tag} ${Math.round(performance.now() - t0)}ms`,
          );
          filter.write(outBytes);
          filter.disconnect();
          return;
        }

        const dec = new TextDecoder("utf-8");
        let raw = "";
        for (const chunk of chunks) raw += dec.decode(chunk, { stream: true });
        raw += dec.decode();

        const ctx = { mult, prob, random, rules, scan };
        let result, count;
        if (isJs) {
          ({ out: result, count } = fuzzJs(raw, ctx));
        } else {
          const o = JSON.parse(raw);
          count = fuzzObj(o, ctx, fname, "", 0);
          result = JSON.stringify(o);
        }
        scan.files.push({ name: fname, kind: isJs ? "js" : "json", count });
        console.log(`[NumFuzz BG] ✅ ${isJs ? "JS  " : "JSON"} ${fname}: ${count}箇所変更 ${tag}`);
        filter.write(new TextEncoder().encode(result));
        filter.disconnect();
      } catch (e) {
        console.warn(`[NumFuzz BG] ❌ 書き換えエラー ${fname}:`, e.message);
        passThrough();
      }
    };

    return {};
  },
  { urls: ["<all_urls>"], types: ["script", "xmlhttprequest"] },
  ["blocking"],
);

// ----------------------------------------------------------------
//  ルール編集ページからの検出値検索
//  { action: "searchScan", tabId, kind: "json"|"js"|"wasm", query, limit, namedOnly }
// ----------------------------------------------------------------
function searchScan(msg) {
  const scan = _tabScan.get(msg.tabId);
  if (!scan) return { files: [], total: 0, items: [], counts: { json: 0, js: 0, wasm: 0, wasmAll: 0 } };
  const limit = msg.limit || 300;
  const q = String(msg.query || "").trim();
  const qNum = q !== "" && isFinite(Number(q)) ? Number(q) : null;
  const qLower = q.toLowerCase();

  const matchValue = (v, shown) =>
    qNum !== null && (v === qNum || shown === qNum || String(shown).startsWith(q));
  // 完全一致を先頭に、あとは出現数の多い順
  const byRelevance = (a, b) =>
    (qNum !== null ? (b.value === qNum) - (a.value === qNum) : 0) || b.count - a.count;

  let items = [];
  if (msg.kind === "json") {
    items = scan.json.filter((e) =>
      !q || matchValue(e.value, e.value) ||
      (qNum === null && (e.path.toLowerCase().includes(qLower) || e.file.includes(qLower))));
  } else if (msg.kind === "js") {
    for (const [value, e] of scan.js) {
      const keys = [...e.keys].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
      if (q && !matchValue(value, value) &&
          !(qNum === null && keys.some((k) => k.toLowerCase().includes(qLower)))) continue;
      items.push({ value, count: e.count, keys: keys.slice(0, 5) });
    }
    items.sort(byRelevance);
  } else if (msg.kind === "wasm") {
    // メソッド名・意味（変数名）で一致したらその定数、値で一致したらその定数だけ
    // namedOnly（既定）: 意味の分かる数値（おすすめ）のみ
    // ただし値で検索したときは、同じ値の場所をすべて見せる（おすすめを先に並べる）
    const namedOnly = msg.namedOnly !== false && qNum === null;
    for (const m of scan.wasm) {
      const nameHit = qNum === null && m.method.toLowerCase().includes(qLower);
      for (const c of m.consts) {
        if (namedOnly && !c.named) continue;
        const shown = c.t === "f32" ? Number(c.v.toPrecision(7)) : c.v;
        // "this.money" は "PlayerStatus.money" でも検索できるようにする
        const named = c.label ? c.label.replace(/^this\./, m.method.slice(0, m.method.indexOf(".")) + ".") : "";
        const labelHit = qNum === null && !!c.label &&
          (c.label.toLowerCase().includes(qLower) || named.toLowerCase().includes(qLower));
        if (q && !nameHit && !labelHit && !matchValue(c.v, shown)) continue;
        items.push({ method: m.method, index: c.i, valType: c.t, value: c.v, label: c.label, named: c.named, flag: c.flag });
      }
    }
    if (qNum !== null) items.sort((a, b) => (b.named ? 1 : 0) - (a.named ? 1 : 0));
  }
  const counts = {
    json: scan.json.length,
    js: scan.js.size,
    wasm: scan.wasm.reduce((a, m) => a + m.consts.filter((c) => c.named).length, 0),
    wasmAll: scan.wasm.reduce((a, m) => a + m.consts.length, 0),
  };
  return { files: scan.files, total: items.length, items: items.slice(0, limit), counts };
}

// ----------------------------------------------------------------
//  実行中の変数（Unity の C# フィールド）の読み書き
//  content.js がゲームの wasm メモリを取得したフレームへ、編集ページからの依頼を転送する
// ----------------------------------------------------------------
const _tabLiveFrame = new Map(); // tabId -> wasm メモリを取得したフレームの frameId
// 原因の切り分け用: フックが動いているフレーム（liveHello）と、注入に失敗したときのエラー
const _tabLiveInfo = new Map(); // tabId -> { frames: Map<frameId, url>, injectError: string | null }

function liveInfo(tabId) {
  if (!_tabLiveInfo.has(tabId)) _tabLiveInfo.set(tabId, { frames: new Map(), injectError: null });
  return _tabLiveInfo.get(tabId);
}

// 有効なサイト（タブのトップレベルで判定）でだけ実行中の変数の機能を使う
function liveEnabledFor(tabId, frameId, url) {
  const topUrl = frameId === 0 ? url : _tabTopUrl.get(tabId);
  const top = topUrl ? originKey(topUrl) : "";
  return !!top && !isSensitiveSite(top) && !!_settingsCache.numFuzzWasm && isEnabledFor(_settingsCache, top);
}

// content.js は manifest の content_scripts でも読み込まれるが、それが動かない環境の予備として
// 有効なサイトのフレームにはコード文字列でも注入する（content.js 側で二重には動かない）。
// iframe は onCommitted の時点ではまだ注入できないことがある（Missing host permission）ため、
// onDOMContentLoaded でも試す。Unity が wasm をインスタンス化するのは数 MB のダウンロード後なので間に合う
const _contentCode = fetch(browser.runtime.getURL("content.js")).then((r) => r.text()).catch(() => null);

function injectContent(details) {
  const { tabId, frameId, url } = details;
  if (tabId < 0 || !/^https?:/.test(url) || !liveEnabledFor(tabId, frameId, url)) return;
  _contentCode.then((code) => {
    if (!code) return;
    browser.tabs.executeScript(tabId, { frameId, code: "window.__nfLiveForce = true;\n" + code, runAt: "document_start" })
      .catch((e) => {
        // onCommitted で失敗して onDOMContentLoaded で成功することがあるので、記録だけしておく
        liveInfo(tabId).injectError = `${new URL(url).host}: ${e.message}`;
      });
  });
}
browser.webNavigation.onCommitted.addListener(injectContent);
browser.webNavigation.onDOMContentLoaded.addListener(injectContent);

// メモリを取得できていないときに、どこで止まっているかを説明する
function liveNotReadyReason(tabId) {
  const info = _tabLiveInfo.get(tabId);
  const frames = info ? [...info.frames.values()] : [];
  if (!_tabTopUrl.has(tabId)) {
    return "対象のタブの読み込みを確認できていません。ゲームのページを再読み込みしてから、ポップアップの「ルール・検出値を編集…」を開き直してください。";
  }
  if (!frames.length) {
    return "ゲームのページにフックを入れられていません" + (info && info.injectError ? `（${info.injectError}）` : "") +
      "。NumFuzz と「Unity の C# コードも書き換える」が有効か確認し、ゲームのページを再読み込みしてください。";
  }
  return `フックは動いています（${frames.map((u) => new URL(u).host).join(", ")}）が、ゲームの wasm メモリをまだ取得できていません。` +
    "ゲームの読み込みが終わるまで待ってください（自動で再試行します）。ゲームが先に起動していた場合は、ゲームのページを再読み込みしてください。";
}

function liveCall(tabId, req) {
  const frameId = _tabLiveFrame.get(tabId);
  if (frameId === undefined) return Promise.resolve({ error: liveNotReadyReason(tabId), notReady: true });
  return browser.tabs.sendMessage(tabId, { action: "liveCall", req }, { frameId })
    .catch((e) => ({ error: "ゲームのページと通信できません: " + e.message }));
}

function handleLive(msg) {
  const scan = _tabScan.get(msg.tabId);
  const live = scan && scan.live;
  if (msg.action === "liveScan") {
    if (!live || !live.types.length) {
      return Promise.resolve({ error: "変数の情報がありません（Unity(IL2CPP) のゲームを NumFuzz 有効で読み込んでください）" });
    }
    return liveCall(msg.tabId, Object.assign({ op: "scan" }, live)).then((res) => Object.assign({ types: live.types }, res));
  }
  if (msg.action === "liveRead") return liveCall(msg.tabId, { op: "read", items: msg.items });
  if (msg.action === "liveWrite") return liveCall(msg.tabId, { op: "write", addr: msg.addr, kind: msg.kind, value: msg.value });
  if (msg.action === "liveFreeze") {
    return liveCall(msg.tabId, { op: "freeze", key: msg.key, addr: msg.addr, kind: msg.kind, value: msg.value });
  }
  return null;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return undefined;
  // content.js（manifest から読み込まれた場合）: このフレームのタブのサイトで有効か
  if (msg.action === "liveEnabled") {
    return Promise.resolve(!!sender.tab && liveEnabledFor(sender.tab.id, sender.frameId, sender.url || ""));
  }
  if (msg.action === "liveHello") {
    if (sender.tab) liveInfo(sender.tab.id).frames.set(sender.frameId, msg.url || sender.url || "");
    return undefined;
  }
  if (msg.action === "liveReady") {
    if (sender.tab) _tabLiveFrame.set(sender.tab.id, sender.frameId);
    return undefined;
  }
  const live = handleLive(msg);
  if (live) return live;
  if (msg.action === "searchScan") return Promise.resolve(searchScan(msg));
  return undefined;
});

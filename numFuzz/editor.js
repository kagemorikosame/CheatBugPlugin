// ============================================================
//  NumFuzz - editor.js
//  サイトごとの置き換えルール編集 + 検出値の検索
//  editor.html?tab=<tabId>&origin=<origin> で開く（ポップアップから）
// ============================================================

"use strict";

const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tab"));
const origin = params.get("origin") || "";

const rulesBody = document.getElementById("rules-body");
const rulesEmpty = document.getElementById("rules-empty");
const saveState = document.getElementById("save-state");
const queryEl = document.getElementById("query");
const scanHead = document.getElementById("scan-head");
const scanBody = document.getElementById("scan-body");
const scanEmpty = document.getElementById("scan-empty");
const scanTotal = document.getElementById("scan-total");
const scanFiles = document.getElementById("scan-files");
const wasmOptions = document.getElementById("wasm-options");
const namedOnlyEl = document.getElementById("named-only");

let rules = [];
let kind = "json";

document.getElementById("origin").textContent = origin || "サイトを取得できませんでした";
document.title = "NumFuzz ルール編集 - " + origin;

function el(tag, props, children) {
  const e = document.createElement(tag);
  Object.assign(e, props || {});
  for (const c of children || []) e.append(c);
  return e;
}

function isNumText(s) {
  return String(s).trim() !== "" && isFinite(Number(s));
}

// ---- ルール ---------------------------------------------------------

let saveTimer = null;
function scheduleSave() {
  saveState.textContent = "保存中…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

function save() {
  // 意味の推定を入れる前に作った C# ルールは label がないので、検出値から補って表示する
function fillRuleLabels() {
  const missing = rules.filter((r) => r.type === "wasm" && !r.label);
  if (!missing.length) return;
  browser.runtime.sendMessage({ action: "searchScan", tabId, kind: "wasm", query: "", namedOnly: false, limit: 100000 })
    .then((res) => {
      let changed = false;
      for (const r of missing) {
        const it = res.items.find((x) => x.method === r.method && x.index === r.index && String(x.value) === String(r.from));
        if (it && it.label) { r.label = it.label; changed = true; }
      }
      if (changed) renderRules();
    })
    .catch(() => {});
}

browser.storage.local.get({ numFuzzRules: {} }).then((s) => {
    const all = Object.assign({}, s.numFuzzRules);
    if (rules.length) all[origin] = rules;
    else delete all[origin];
    return browser.storage.local.set({ numFuzzRules: all });
  }).then(() => {
    saveState.textContent = "保存しました（リロードで反映）";
  }).catch((e) => {
    saveState.textContent = "保存エラー: " + e.message;
  });
}

function addRule(rule) {
  rules.push(Object.assign({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    enabled: true,
    type: "value",
    from: "",
    to: "",
    wasmInt: false,
  }, rule));
  renderRules();
  scheduleSave();
  // 検出値から追加した場合は「新しい値」、空のルールなら「元の値」にフォーカス
  const last = rulesBody.lastElementChild;
  if (last) {
    const inputs = last.querySelectorAll("input[type=text]");
    const input = rule && rule.from !== undefined ? inputs[inputs.length - 1] : inputs[0];
    if (input) input.focus();
  }
}

// 推定ラベルに値を埋め込む（"this.money = ●" / "Foo(▶no, cost)" → "Foo(▶no=2, cost)"）
function fillLabel(label, shown) {
  return label.includes("●") ? label.replace("●", shown) : label.replace(/▶([^,)]+)/, "▶$1=" + shown);
}

// 推定ラベルから「値が入る変数・使われる場所」の名前を作る
//   PlayerStatus.Start #6 / "this.money = PlayerPrefs.GetInt(…)"  → PlayerStatus.money
//   <AddGamanGaugeAnim>d__88.MoveNext / "this.i = ●"            → AddGamanGaugeAnim() のローカル変数 i
//   "WaitForSeconds..ctor(▶seconds)"                            → new WaitForSeconds() の seconds
function targetName(method, label) {
  if (!label) return null;
  const cls = method.slice(0, method.indexOf("."));
  const co = /^<(.+)>d__\d+$/.exec(cls); // コルーチン（IEnumerator のメソッド）
  const api = (name) => name.replace(/^(.+)\.\.ctor$/, "new $1()").replace(/〔.*$/, "");
  let m = /^this\.([^\s=]+) /.exec(label);
  // this.chooseManager.leftCost → chooseManager.leftCost（ゲームのログと同じ書き方）
  if (m && m[1].includes(".")) return m[1];
  if (m) return co ? co[1] + "() のローカル変数 " + m[1] : cls + "." + m[1];
  m = /^引数 (\S+) /.exec(label);
  if (m) return method.replace(/#\d+$/, "") + "() の引数 " + m[1];
  m = /^ローカル変数（≒ (.+?)）/.exec(label);
  if (m) return m[1].startsWith("this.") ? cls + m[1].slice(4) : m[1] + " の結果";
  m = /^([^(]+)\(.*▶([^,)=]+)/.exec(label);
  if (m) return api(m[1]) + " の " + m[2];
  m = /^(\S+) [<>=!+\-*\/%]+ ●$/.exec(label);
  if (m) return m[1];
  return null;
}

function formatValue(t, v) {
  return t === "f32" ? String(Number(Number(v).toPrecision(7))) : String(v);
}

function renderRules() {
  rulesBody.textContent = "";
  rulesEmpty.style.display = rules.length ? "none" : "";

  for (const r of rules) {
    const isCs = r.type === "wasm";
    const enabled = el("input", { type: "checkbox", checked: r.enabled });
    const type = el("select", { disabled: isCs }, isCs
      ? [el("option", { value: "wasm", textContent: "C#" })]
      : [
        el("option", { value: "value", textContent: "値" }),
        el("option", { value: "key", textContent: "キー" }),
      ]);
    type.value = r.type;
    // C# ルールの対象（メソッド＋位置）は検出値から決まるので編集不可
    const from = isCs
      ? el("div", {}, [
        el("div", { textContent: targetName(r.method, r.label) || `${r.method} #${r.index}` }),
        el("div", {
          className: "muted",
          textContent: (r.label ? fillLabel(r.label, formatValue(r.valType, r.from)) + " — " : "") +
            `${r.method} #${r.index}（${r.valType === "i32" ? "整数" : "小数"}・元の値 ${formatValue(r.valType, r.from)}）`,
        }),
      ])
      : el("input", {
        type: "text",
        value: r.from,
        placeholder: r.type === "key" ? "例: hp" : "例: 100",
      });
    const to = el("input", { type: "text", value: r.to, placeholder: "例: 9999" });
    const wasmInt = el("input", { type: "checkbox", checked: r.wasmInt, disabled: r.type !== "value" });
    const del = el("button", { className: "danger", textContent: "削除" });

    const validate = () => {
      if (!isCs) {
        from.classList.toggle("invalid", r.type === "key" ? !String(r.from).trim() : !isNumText(r.from));
      }
      // C# の整数定数には整数しか入れられない
      to.classList.toggle("invalid", !isNumText(r.to) || (isCs && r.valType === "i32" && !Number.isInteger(Number(r.to))));
    };
    validate();

    enabled.addEventListener("change", () => { r.enabled = enabled.checked; scheduleSave(); });
    type.addEventListener("change", () => { r.type = type.value; renderRules(); scheduleSave(); });
    if (!isCs) from.addEventListener("input", () => { r.from = from.value.trim(); validate(); scheduleSave(); });
    to.addEventListener("input", () => { r.to = to.value.trim(); validate(); scheduleSave(); });
    wasmInt.addEventListener("change", () => { r.wasmInt = wasmInt.checked; scheduleSave(); });
    del.addEventListener("click", () => {
      rules = rules.filter((x) => x !== r);
      renderRules();
      scheduleSave();
    });

    rulesBody.append(el("tr", {}, [
      el("td", {}, [enabled]),
      el("td", { style: "width:90px" }, [type]),
      el("td", {}, [from]),
      el("td", {}, [to]),
      el("td", {}, [wasmInt]),
      el("td", {}, [del]),
    ]));
  }
}

document.getElementById("add-value").addEventListener("click", () => addRule({ type: "value" }));
document.getElementById("add-key").addEventListener("click", () => addRule({ type: "key" }));

// ---- 検出値 ---------------------------------------------------------

const HEADS = {
  json: ["値", "キー / パス", "ファイル", ""],
  js: ["値", "出現数", "キー名（推定）", ""],
  wasm: ["対象（変数・引数）", "意味（推定）", "C# メソッド", "型", "元の値", ""],
};

function addButton(label, rule) {
  const b = el("button", { textContent: label });
  b.addEventListener("click", () => addRule(rule));
  return b;
}

const KIND_LABELS = { json: "JSON", js: "JS", wasm: "C# (Unity)" };

function renderScan(res) {
  scanFiles.textContent = res.files.length
    ? "読み込まれたファイル: " + res.files.map((f) =>
      `${f.name}（${f.kind}・${f.note ? "未変更: " + f.note : f.count + "箇所変更"}）`).join("、")
    : "";
  for (const b of document.querySelectorAll("#kind-tabs button")) {
    b.textContent = `${KIND_LABELS[b.dataset.kind]} (${res.counts[b.dataset.kind]})`;
  }

  scanHead.textContent = "";
  scanHead.append(el("tr", {}, HEADS[kind].map((h) => el("th", { textContent: h }))));
  scanBody.textContent = "";
  scanTotal.textContent = res.total ? `${res.total}件` + (res.total > res.items.length ? `（上位${res.items.length}件を表示）` : "") : "";

  if (!res.items.length) {
    scanEmpty.textContent = kind === "wasm" && !queryEl.value.trim()
      ? "C# メソッドの定数はありません（Unity(IL2CPP) のゲームでないか、C# のメタデータを読み取れませんでした）。"
      : res.files.length
      ? "該当する値はありません。"
      : "まだ検出値がありません。このサイトで NumFuzz を有効にして、ページを再読み込みしてください。";
    return;
  }
  scanEmpty.textContent = "";

  for (const it of res.items) {
    let cells;
    if (kind === "json") {
      const btns = [addButton("＋値", { type: "value", from: String(it.value), to: String(it.value) })];
      if (it.key) btns.push(" ", addButton("＋キー", { type: "key", from: it.key, to: String(it.value) }));
      cells = [
        el("td", { className: "num", textContent: String(it.value) }),
        el("td", { className: "muted", textContent: it.path }),
        el("td", { className: "muted", textContent: it.file }),
        el("td", {}, btns),
      ];
    } else if (kind === "js") {
      const btns = [addButton("＋値", { type: "value", from: String(it.value), to: String(it.value) })];
      if (it.keys.length) {
        btns.push(" ", addButton("＋キー", { type: "key", from: it.keys[0], to: String(it.value) }));
      }
      cells = [
        el("td", { className: "num", textContent: String(it.value) }),
        el("td", { className: "num", textContent: String(it.count) }),
        el("td", {}, it.keys.map((k) => el("span", { className: "key-chip", textContent: k }))),
        el("td", {}, btns),
      ];
    } else {
      const shown = formatValue(it.valType, it.value);
      const rule = {
        type: "wasm", method: it.method, index: it.index, valType: it.valType, label: it.label || "",
        from: String(it.value), to: shown,
      };
      cells = [
        el("td", it.label ? { textContent: targetName(it.method, it.label) || "（不明）" }
          : { className: "muted", textContent: "（不明・変更注意）" }),
        el("td", { className: "muted", textContent: it.label ? fillLabel(it.label, shown) : "" }),
        el("td", { className: "muted", textContent: `${it.method} #${it.index}` }),
        el("td", { className: "muted nowrap", textContent: (it.valType === "i32" ? "整数" : "小数") + (it.flag ? "（ON/OFF）" : "") }),
        el("td", { className: "num", textContent: shown }),
        el("td", {}, [addButton("＋", rule)]),
      ];
    }
    scanBody.append(el("tr", {}, cells));
  }
}

// タブを手で選ぶまでは、検出値のある種類（Unity なら C#）を自動で選ぶ
let autoKind = true;
let lastSignature = "";

function selectKind(k) {
  kind = k;
  for (const x of document.querySelectorAll("#kind-tabs button")) x.classList.toggle("active", x.dataset.kind === k);
}

function refreshScan() {
  wasmOptions.style.display = kind === "wasm" ? "" : "none";
  return browser.runtime.sendMessage({ action: "searchScan", tabId, kind, query: queryEl.value, namedOnly: namedOnlyEl.checked })
    .then((res) => {
      lastSignature = JSON.stringify([res.files, res.counts]);
      if (autoKind && !res.counts[kind]) {
        const best = Object.keys(KIND_LABELS).sort((a, b) => res.counts[b] - res.counts[a])[0];
        if (res.counts[best] && best !== kind) {
          selectKind(best);
          return refreshScan();
        }
      }
      renderScan(res);
      fillRuleLabels();
    })
    .catch((e) => { scanEmpty.textContent = "検出値を取得できませんでした: " + e.message; });
}

// ゲームの読み込み（Unity は数十秒かかる）が進んで検出値が増えたら自動で表示を更新する
function pollScan() {
  browser.runtime.sendMessage({ action: "searchScan", tabId, kind, query: "", limit: 1 })
    .then((res) => {
      if (JSON.stringify([res.files, res.counts]) !== lastSignature) refreshScan();
    })
    .catch(() => {});
}
setInterval(pollScan, 2000);

let queryTimer = null;
queryEl.addEventListener("input", () => {
  clearTimeout(queryTimer);
  queryTimer = setTimeout(refreshScan, 200);
});

for (const b of document.querySelectorAll("#kind-tabs button")) {
  b.addEventListener("click", () => {
    autoKind = false;
    selectKind(b.dataset.kind);
    refreshScan();
  });
}

document.getElementById("refresh").addEventListener("click", refreshScan);
namedOnlyEl.addEventListener("change", refreshScan);
document.getElementById("reload").addEventListener("click", () => {
  scanEmpty.textContent = "再読み込み中…（ゲームの読み込みが終わると自動で表示されます）";
  // 再読み込みでメモリ上の位置が変わるので、実行中の変数の一覧は読み込み直してもらう
  liveRows = [];
  liveGroups = [];
  liveBody.textContent = "";
  liveStatus.textContent = "ゲームの再読み込み後に「変数を読み込む」を押してください。";
  browser.tabs.reload(tabId).catch((e) => {
    scanEmpty.textContent = "再読み込みできませんでした（タブが閉じられた可能性があります）: " + e.message;
  });
});

// ---- 初期化 ---------------------------------------------------------

browser.storage.local.get({ numFuzzRules: {} }).then((s) => {
  rules = (s.numFuzzRules[origin] || []).map((r) => Object.assign({}, r));
  renderRules();
  fillRuleLabels();
});
refreshScan();

// ---- 実行中の変数（Unity） -------------------------------------------
//  ゲームのメモリ上のインスタンスを探し、フィールドの値を読み書きする

const liveHead = document.getElementById("live-head");
const liveBody = document.getElementById("live-body");
const liveStatus = document.getElementById("live-status");
const liveQuery = document.getElementById("live-query");
const liveAuto = document.getElementById("live-auto");

let liveRows = []; // { addr, kind, valueEl, tr, name }
let liveGroups = []; // { tr, rows }

const isFloatKind = (k) => k === 0x0c || k === 0x0d;
const kindText = (k) => (k === 0x02 ? "ON/OFF（1/0）" : isFloatKind(k) ? "小数" : "整数");
const formatLive = (k, v) => (v === null || v === undefined ? "?" : isFloatKind(k) ? String(Number(v.toPrecision(7))) : String(v));

function validLiveValue(kind, text) {
  if (!isNumText(text)) return null;
  const v = Number(text);
  if (kind === 0x02) return v === 0 || v === 1 ? v : null;
  if (!isFloatKind(kind) && !Number.isInteger(v)) return null;
  return v;
}

// ゲーム側の変数名を、メモリ上で実際にそのオブジェクトを指しているフィールドから決める
//   GameManager.playerStatus がこのオブジェクトを指していれば "playerStatus"
//   どこからも指されていなければ型名（同じ名前が複数あれば [1] [2] を付ける）
function liveNames(res, types) {
  const byAddr = new Map(res.instances.map((i) => [i.addr, i]));
  const refsTo = new Map(); // addr -> [{ owner, field }]
  for (const inst of res.instances) {
    const t = types.get(inst.ti);
    (t.refFields || []).forEach((rf, k) => {
      const target = byAddr.get(inst.refVals ? inst.refVals[k] : 0);
      if (!target || target.ti !== rf.ti || target === inst) return;
      if (!refsTo.has(target.addr)) refsTo.set(target.addr, []);
      refsTo.get(target.addr).push({ owner: t.name, field: rf.name });
    });
  }
  const names = new Map();
  for (const inst of res.instances) {
    const refs = refsTo.get(inst.addr) || [];
    // いちばん多く使われているフィールド名を変数名にする
    const count = new Map();
    for (const r of refs) count.set(r.field, (count.get(r.field) || 0) + 1);
    const best = [...count].sort((a, b) => b[1] - a[1])[0];
    names.set(inst.addr, {
      name: best ? best[0] : types.get(inst.ti).name,
      refs: refs.map((r) => r.owner + "." + r.field),
    });
  }
  // 同じ名前が複数あれば番号を付ける
  const total = new Map();
  for (const v of names.values()) total.set(v.name, (total.get(v.name) || 0) + 1);
  const seen = new Map();
  for (const inst of res.instances) {
    const v = names.get(inst.addr);
    if (total.get(v.name) > 1) {
      const n = (seen.get(v.name) || 0) + 1;
      seen.set(v.name, n);
      v.name = `${v.name}[${n}]`;
    }
  }
  return names;
}

function renderLive(res) {
  const types = new Map(res.types.map((t) => [t.ti, t]));
  const names = liveNames(res, types);

  liveRows = [];
  liveGroups = [];
  liveBody.textContent = "";
  liveHead.textContent = "";
  liveHead.append(el("tr", {}, ["変数", "型", "現在の値", "新しい値", "", "固定"].map((h) => el("th", { textContent: h }))));

  const insts = res.instances.slice().sort((a, b) => types.get(a.ti).name.localeCompare(types.get(b.ti).name));
  for (const inst of insts) {
    const t = types.get(inst.ti);
    const nm = names.get(inst.addr);
    const v = nm.name;
    const head = el("tr", {}, [el("td", {
      colSpan: 6,
      className: "muted",
      textContent: `▼ ${v}（${t.name}${nm.refs.length ? " ／ 参照元: " + nm.refs.join(", ") : " ／ 参照元なし"}）`,
    })]);
    liveBody.append(head);
    const group = { tr: head, rows: [] };
    liveGroups.push(group);

    t.fields.forEach((f, i) => {
      const addr = inst.addr + f.off;
      const name = `${v}.${f.name}`;
      const getterText = f.getters.map((g) => `${v}.${g}`).join(" / ");
      const valueEl = el("td", { className: "num", textContent: formatLive(f.kind, inst.values[i]) });
      const input = el("input", { type: "text", placeholder: "新しい値" });
      const btn = el("button", { textContent: "書き込む" });
      const freeze = el("input", { type: "checkbox" });
      const key = `${inst.addr}:${f.off}`;

      const send = (value) => browser.runtime.sendMessage({ action: "liveWrite", tabId, addr, kind: f.kind, value })
        .then((r) => {
          if (r && r.error) liveStatus.textContent = r.error;
          else valueEl.textContent = formatLive(f.kind, r.value);
        });
      const setFreeze = (value) => browser.runtime.sendMessage({ action: "liveFreeze", tabId, key, addr, kind: f.kind, value });

      input.addEventListener("input", () => {
        input.classList.toggle("invalid", input.value.trim() !== "" && validLiveValue(f.kind, input.value.trim()) === null);
      });
      const apply = () => {
        const value = validLiveValue(f.kind, input.value.trim());
        if (value === null) { input.classList.add("invalid"); return; }
        send(value);
        if (freeze.checked) setFreeze(value);
      };
      btn.addEventListener("click", apply);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
      freeze.addEventListener("change", () => {
        if (!freeze.checked) { setFreeze(null); return; }
        // 新しい値が入っていればその値、なければ今の値で固定する
        let value = validLiveValue(f.kind, input.value.trim());
        if (value === null) value = validLiveValue(f.kind, valueEl.textContent);
        if (value === null) { freeze.checked = false; return; }
        send(value);
        setFreeze(value);
      });

      const tr = el("tr", {}, [
        el("td", {}, [
          el("div", { textContent: name }),
          getterText ? el("div", { className: "muted", textContent: "= " + getterText }) : "",
        ]),
        el("td", { className: "muted nowrap", textContent: kindText(f.kind) }),
        valueEl,
        el("td", {}, [input]),
        el("td", {}, [btn]),
        el("td", {}, [freeze]),
      ]);
      liveBody.append(tr);
      const row = { addr, kind: f.kind, valueEl, tr, text: (name + " " + getterText + " " + t.name).toLowerCase() };
      liveRows.push(row);
      group.rows.push(row);
    });
  }
  liveStatus.textContent = res.instances.length
    ? `${res.instances.length}個のオブジェクトの変数を読み込みました。`
    : res.error || "変数が見つかりませんでした（ゲームの画面が表示されてから試してください）。";
  applyLiveFilter();
}

function applyLiveFilter() {
  const q = liveQuery.value.trim().toLowerCase();
  for (const g of liveGroups) {
    let any = false;
    for (const r of g.rows) {
      const show = !q || r.text.includes(q);
      r.tr.style.display = show ? "" : "none";
      any = any || show;
    }
    g.tr.style.display = any ? "" : "none";
  }
}

// ゲームの読み込み中（wasm メモリをまだ取得していない）なら、取得できるまで自動で再試行する
let liveRetryTimer = null;
let liveRetryCount = 0;
const LIVE_RETRY_MS = 3000;
const LIVE_RETRY_MAX = 40; // 約 2 分

function scanLive(isRetry) {
  clearTimeout(liveRetryTimer);
  if (!isRetry) liveRetryCount = 0;
  liveStatus.textContent = "ゲームのメモリから変数を探しています…";
  return browser.runtime.sendMessage({ action: "liveScan", tabId })
    .then((res) => {
      if (!res || !res.instances) {
        const msg = (res && res.error) || "変数を読み込めませんでした。";
        if (res && res.notReady && liveRetryCount < LIVE_RETRY_MAX) {
          liveRetryCount++;
          liveStatus.textContent = msg + `（再試行 ${liveRetryCount}/${LIVE_RETRY_MAX}）`;
          liveRetryTimer = setTimeout(() => scanLive(true), LIVE_RETRY_MS);
        } else {
          liveStatus.textContent = msg;
        }
        return;
      }
      renderLive(res);
    })
    .catch((e) => { liveStatus.textContent = "変数を読み込めませんでした: " + e.message; });
}

function refreshLiveValues() {
  if (!liveAuto.checked || !liveRows.length || document.hidden) return;
  browser.runtime.sendMessage({ action: "liveRead", tabId, items: liveRows.map((r) => ({ addr: r.addr, kind: r.kind })) })
    .then((res) => {
      if (!res || !res.values) return;
      res.values.forEach((v, i) => { liveRows[i].valueEl.textContent = formatLive(liveRows[i].kind, v); });
    })
    .catch(() => {});
}

document.getElementById("live-scan").addEventListener("click", () => scanLive(false));
liveQuery.addEventListener("input", applyLiveFilter);
setInterval(refreshLiveValues, 1000);

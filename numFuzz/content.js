// ============================================================
//  NumFuzz - content.js  (document_start / 全フレーム)
//
//  実行中の変数（Unity の C# フィールド）を読み書きするための仲介役。
//  有効なサイトのフレームでだけ、ページに wasm のメモリを取得するフックを入れる。
//  読み込まれ方は 2 通り（どちらか先に動いたほうだけが働く）:
//    - manifest の content_scripts（document_start）: background に有効なサイトか確かめてから入れる
//    - background.js からの注入（webNavigation）: 有効なサイトにだけ注入されるので、すぐ入れる
//      （__nfLiveForce が付く。manifest 側が読み込めない環境の予備）
//  数値の書き換え（ランダム・ルール）は background.js が通信の段階で行うので、ここでは何もしない。
//
//  editor.js ⇄ background.js ⇄ content.js ⇄（CustomEvent）⇄ ページ内の pageMain
// ============================================================

"use strict";

(function () {
  if (window.__nfLiveContent) return;
  window.__nfLiveContent = true;

  const pending = new Map();
  let seq = 0;

  // ページからの応答・準備完了の通知
  document.addEventListener("nf-live-res", (e) => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch (_) { return; }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg.res);
    }
  });
  document.addEventListener("nf-live-ready", () => {
    browser.runtime.sendMessage({ action: "liveReady" }).catch(() => {});
  });

  function call(req) {
    return new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      document.dispatchEvent(new CustomEvent("nf-live-req", { detail: JSON.stringify(Object.assign({ id }, req)) }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ error: "ページから応答がありません" });
        }
      }, 15000);
    });
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === "liveCall") return call(msg.req);
    return undefined;
  });

  let started = false;
  function start() {
    if (started) return;
    started = true;
    const el = document.createElement("script");
    el.textContent = "(" + pageMain.toString() + ")();";
    (document.head || document.documentElement).appendChild(el);
    el.remove();
    // このフレームでフックが動いていることを background に知らせる（原因の切り分け用）
    browser.runtime.sendMessage({ action: "liveHello", url: location.href }).catch(() => {});
  }
  if (window.__nfLiveForce) start();
  else browser.runtime.sendMessage({ action: "liveEnabled" }).then((ok) => { if (ok) start(); }).catch(() => {});

  // ----------------------------------------------------------------
  //  ページ内で動くコード（文字列化して注入するので外側の変数は参照しない）
  // ----------------------------------------------------------------
  function pageMain() {
    if (window.__nfLive) return;
    window.__nfLive = true;

    let memory = null;
    const freezes = new Map(); // key -> { addr, kind, value }
    const WA = WebAssembly;

    // wasm のインスタンス化をフックしてメモリを取得する（Unity は exports.memory を公開している）
    const grab = (r) => {
      try {
        const inst = r && (r.instance || r);
        const mem = inst && inst.exports && inst.exports.memory;
        if (mem instanceof WA.Memory) capture(mem);
      } catch (_) { /* 取得できなくてもゲームには影響させない */ }
      return r;
    };
    // フックより先にゲームが起動していた場合の予備: メモリの buffer が参照された（メモリが拡張された等）
    // ときに取得する。複数あれば大きいほう（ゲーム本体）を使う
    // フックした getter を通さずに大きさを調べる（capture の中から getter を呼ぶと再帰するため）
    const bufferGetter = (Object.getOwnPropertyDescriptor(WA.Memory.prototype, "buffer") || {}).get;
    const sizeOf = (mem) => (bufferGetter ? bufferGetter.call(mem) : mem.buffer).byteLength;
    const capture = (mem) => {
      try {
        if (!(mem instanceof WA.Memory) || mem === memory) return;
        if (memory && sizeOf(memory) >= sizeOf(mem)) return;
        const first = !memory;
        memory = mem;
        if (first) document.dispatchEvent(new CustomEvent("nf-live-ready"));
      } catch (_) { /* ゲームには影響させない */ }
    };
    try {
      const proto = WA.Memory.prototype;
      const bufDesc = Object.getOwnPropertyDescriptor(proto, "buffer");
      if (bufDesc && bufDesc.get) {
        const origGet = bufDesc.get;
        Object.defineProperty(proto, "buffer", {
          configurable: true, enumerable: bufDesc.enumerable,
          get: function () { const b = origGet.call(this); if (memory !== this) capture(this); return b; },
        });
      }
      const origGrow = proto.grow;
      proto.grow = function () { capture(this); return origGrow.apply(this, arguments); };
    } catch (_) { /* 取得できなくてもゲームには影響させない */ }

    // さらに予備: Unity は描画のたびに HEAPU8 / HEAPF32 などから subarray を切り出すので、
    // その元の ArrayBuffer（= wasm メモリ）を取得する。wasm メモリは 64KiB（ページ）の倍数で大きいので、
    // .data のダウンロード等の別のバッファとは区別できる。複数あれば大きいほうを使う
    let lateBuffer = null;
    const PAGE = 65536, MIN_HEAP = 16 * 1024 * 1024;
    try {
      const TA = Object.getPrototypeOf(Uint8Array.prototype);
      const origSubarray = TA.subarray;
      TA.subarray = function () {
        if (!memory) {
          const b = this.buffer;
          // 使えなくなった（拡張で切り離された）バッファより大きいか同じなら新しいほうに替える
          if (b !== lateBuffer && b instanceof ArrayBuffer && b.byteLength >= MIN_HEAP && b.byteLength % PAGE === 0 &&
              (!lateBuffer || lateBuffer.byteLength === 0 || b.byteLength >= lateBuffer.byteLength)) {
            const first = !lateBuffer;
            lateBuffer = b;
            if (first) document.dispatchEvent(new CustomEvent("nf-live-ready"));
          }
        }
        return origSubarray.apply(this, arguments);
      };
    } catch (_) { /* 取得できなくてもゲームには影響させない */ }

    // 今の wasm メモリのバッファ（メモリが拡張されると古いバッファは使えなくなるので毎回取り直す）
    function currentBuffer() {
      if (memory) return bufferGetter ? bufferGetter.call(memory) : memory.buffer;
      return lateBuffer && lateBuffer.byteLength ? lateBuffer : null;
    }

    const origInstantiate = WA.instantiate;
    WA.instantiate = function () { return origInstantiate.apply(this, arguments).then(grab); };
    if (typeof WA.instantiateStreaming === "function") {
      const origStreaming = WA.instantiateStreaming;
      WA.instantiateStreaming = function () { return origStreaming.apply(this, arguments).then(grab); };
    }

    // kind は IL2CPP_TYPE_*（0x02 bool, 0x08 int, 0x0c float …）。bool は 0/1 で扱う
    function read(dv, addr, kind) {
      switch (kind) {
        case 0x02: return dv.getUint8(addr) ? 1 : 0;
        case 0x03: case 0x07: return dv.getUint16(addr, true);
        case 0x04: return dv.getInt8(addr);
        case 0x05: return dv.getUint8(addr);
        case 0x06: return dv.getInt16(addr, true);
        case 0x08: case 0x11: return dv.getInt32(addr, true);
        case 0x09: return dv.getUint32(addr, true);
        case 0x0a: return Number(dv.getBigInt64(addr, true));
        case 0x0b: return Number(dv.getBigUint64(addr, true));
        case 0x0c: return dv.getFloat32(addr, true);
        case 0x0d: return dv.getFloat64(addr, true);
        default: return null;
      }
    }
    function write(dv, addr, kind, v) {
      switch (kind) {
        case 0x02: dv.setUint8(addr, v ? 1 : 0); break;
        case 0x03: case 0x07: dv.setUint16(addr, v, true); break;
        case 0x04: dv.setInt8(addr, v); break;
        case 0x05: dv.setUint8(addr, v); break;
        case 0x06: dv.setInt16(addr, v, true); break;
        case 0x08: case 0x11: dv.setInt32(addr, v, true); break;
        case 0x09: dv.setUint32(addr, v, true); break;
        case 0x0a: dv.setBigInt64(addr, BigInt(Math.trunc(v)), true); break;
        case 0x0b: dv.setBigUint64(addr, BigInt(Math.trunc(v)), true); break;
        case 0x0c: dv.setFloat32(addr, v, true); break;
        case 0x0d: dv.setFloat64(addr, v, true); break;
        default: throw new Error("unsupported kind " + kind);
      }
    }

    // 実行中のインスタンスを探す
    //  1. メモリ上のメタデータ本体（global-metadata.dat）を見つける
    //  2. 型名の文字列を指す Il2CppClass（name は +8、namespaze は +12）を見つける
    //  3. 先頭が Il2CppClass* のオブジェクトをインスタンス候補とし、中身の妥当性で絞り込む
    function scan(req) {
      const buf = currentBuffer();
      const u32 = new Uint32Array(buf);
      const dv = new DataView(buf);
      const len = u32.length;
      const size = buf.byteLength;
      const start = Math.max(1, req.heapStart >>> 2);

      let base = -1;
      const sp = req.stringsHeaderPos >>> 2;
      for (let i = start; i < len - sp; i++) {
        if (u32[i] === 0xfab11baf && u32[i + 1] === req.version && u32[i + sp] === req.stringsOff) { base = i * 4; break; }
      }
      if (base < 0) return { error: "メモリ上に C# のメタデータが見つかりません（ゲームの読み込みが終わってから試してください）" };
      const metaEnd = base + req.metaSize;
      const inMeta = (v) => v >= base && v < metaEnd;

      const byName = new Map();
      for (const t of req.types) byName.set(base + req.stringsOff + t.nameIndex, t);
      const klassOf = new Map();
      for (let i = start; i < len; i++) {
        const v = u32[i];
        if (v < base || v >= metaEnd) continue;
        const t = byName.get(v);
        if (!t) continue;
        const k = i * 4 - 8;
        if (k > 0 && inMeta(u32[(k + 12) >>> 2]) && u32[k >>> 2] !== 0) klassOf.set(k, t);
      }
      if (!klassOf.size) return { error: "クラス情報が見つかりません", instances: [] };

      const klasses = [...klassOf.keys()];
      const kMin = Math.min(...klasses), kMax = Math.max(...klasses);
      const looksLikeObject = (p) => {
        if (p === 0) return true;
        if (p < req.heapStart || p + 12 > size || (p & 3)) return false;
        const k = u32[p >>> 2];
        if (k < req.heapStart || k + 16 > size || (k & 3)) return false;
        return inMeta(u32[(k + 8) >>> 2]);
      };
      const perType = new Map();
      const instances = [];
      for (let i = start; i < len; i++) {
        const v = u32[i];
        if (v < kMin || v > kMax) continue;
        const t = klassOf.get(v);
        if (!t) continue;
        const a = i * 4;
        if (klasses.some((k) => a >= k && a < k + 512)) continue; // Il2CppClass 自身の中
        if (u32[(a + 4) >>> 2] !== 0) continue; // monitor（lock 用）は通常 0
        if (t.unityObject) {
          // m_CachedPtr: ネイティブ側のオブジェクトを指す。0 は破棄済み
          const native = u32[(a + 8) >>> 2];
          if (native === 0 || native >= size || (native & 3)) continue;
        }
        if (!t.refOffs.every((off) => looksLikeObject(u32[(a + off) >>> 2]))) continue;
        if (!t.fields.every((f) => f.kind !== 0x02 || dv.getUint8(a + f.off) <= 1)) continue;
        const n = (perType.get(t.ti) || 0) + 1;
        if (n > 8) continue;
        perType.set(t.ti, n);
        instances.push({
          ti: t.ti, addr: a,
          values: t.fields.map((f) => read(dv, a + f.off, f.kind)),
          refVals: (t.refFields || []).map((rf) => u32[(a + rf.off) >>> 2]),
        });
      }
      return { instances };
    }

    function handle(req) {
      const buf = currentBuffer();
      if (!buf) return { error: "ゲームの wasm メモリをまだ取得していません（ゲームを起動してから試してください）" };
      const dv = new DataView(buf);
      switch (req.op) {
        case "scan": return scan(req);
        case "read": return { values: req.items.map((it) => read(dv, it.addr, it.kind)) };
        case "write":
          write(dv, req.addr, req.kind, req.value);
          return { ok: true, value: read(dv, req.addr, req.kind) };
        case "freeze":
          if (req.value === null) freezes.delete(req.key);
          else freezes.set(req.key, { addr: req.addr, kind: req.kind, value: req.value });
          return { ok: true };
        default: return { error: "unknown op" };
      }
    }

    // 固定した変数を書き戻し続ける
    setInterval(() => {
      const buf = currentBuffer();
      if (!buf || !freezes.size) return;
      const dv = new DataView(buf);
      for (const f of freezes.values()) {
        try { write(dv, f.addr, f.kind, f.value); } catch (_) { /* 範囲外になった等は無視 */ }
      }
    }, 100);

    document.addEventListener("nf-live-req", (e) => {
      let req, res;
      try {
        req = JSON.parse(e.detail);
        res = handle(req);
      } catch (err) {
        res = { error: String(err && err.message || err) };
      }
      document.dispatchEvent(new CustomEvent("nf-live-res", { detail: JSON.stringify({ id: req && req.id, res }) }));
    });
  }
})();

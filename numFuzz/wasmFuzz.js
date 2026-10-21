// ============================================================
//  NumFuzz - wasmFuzz.js
//
//  Unity WebGL（IL2CPP）の wasm のうち、名前の分かるゲームの C# メソッド
//  （Assembly-CSharp）に対応する関数の定数だけを書き換える。
//  エンジン・標準ライブラリ・パッケージのコードは一切触らない。
//
//  ゲーム関数の特定:
//    global-metadata.dat（unityMeta.js）のアセンブリ名とメソッド数を手がかりに、
//    wasm のデータセグメントから各アセンブリの Il2CppCodeGenModule
//    { moduleName, methodPointerCount, methodPointers } を探し、
//    methodPointers（関数テーブルの添字）→ elem セクション → 関数番号 と辿る。
//    次の関数は保護のため対象外にする:
//      - エンジン側のメソッドと同一関数にまとめられているもの（同一コード畳み込み）
//      - ゲーム以外の関数から直接 call されているもの
//
//  定数の意味（変数名）の推定:
//    - this.field = 定数          … local.get 0; const; store offset=N
//                                    （N はメタデータの型情報から計算したフィールドのオフセット）
//    - API(…, 定数, …)            … const の後に引数だけを積んで call（呼び出し先の引数名）
//                                    直前に読み込んだ文字列リテラル（PlayerPrefs のキー等）も表示
//    - this.field と比較・演算     … local.get 0; load offset=N; const; 比較/算術
//    - 関数の戻り値と比較          … call F; const; 比較（if (Random.value < 0.05f)）
//    - 引数と比較・演算            … local.get N（N = 引数の位置）; const; 比較/算術
//    - ローカル変数と比較          … local.get N; const; 比較。直前の local.set/tee の値の出どころ
//                                    （関数の戻り値・this のフィールド）が分かれば添える
//    意味が分かった定数を「名前付き（おすすめ）」として扱う。
//
//  書き換え対象の定数（ゲーム関数内のみ）:
//    - f32.const / f64.const : すべて（ランダムは isFuzzableFloat を満たすもののみ）
//    - i32.const             : 名前付きのもの、または値として使われているもの（代入・比較・演算）
//        アドレス範囲の値やオフセット加算（+20 等）、フラグの store8 などは除外
// ============================================================

"use strict";

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

function isWasmBinary(bytes) {
  return bytes.length >= 8 && WASM_MAGIC.every((v, i) => bytes[i] === v);
}

// エンジンが依存しやすい定数（相対誤差で比較）。ランダム書き換えで除外する
const PROTECTED_CONSTS = [
  Math.PI, Math.PI * 2, Math.PI / 2, Math.PI / 4, 1 / Math.PI, 1 / (Math.PI * 2),
  Math.PI / 180, 180 / Math.PI, Math.E, Math.LN2, Math.LN10, Math.LOG2E, Math.LOG10E,
  Math.SQRT2, Math.SQRT1_2, 255, 255.5, 127, 127.5, 65535,
];

function isFuzzableFloat(v) {
  if (!isFinite(v)) return false;
  const a = Math.abs(v);
  if (a < 1e-3 || a >= 1e5) return false; // 0・イプシロン・INT_MAX/FLT_MAX 等の上限値
  if (a === 2 ** Math.round(Math.log2(a))) return false; // 0.5, 1, 2, 0.25, 256 ...
  for (const c of PROTECTED_CONSTS) {
    if (Math.abs(a - c) <= c * 1e-6) return false;
  }
  return true;
}

// i32.const の直後の命令がこれらなら「値」として使われているとみなす
//  store(値側) / local.set / local.tee / local.get / i32.const / 比較 / 減算・乗除算・剰余
function isValueUse(next) {
  return next === 0x36 || next === 0x21 || next === 0x22 || next === 0x20 || next === 0x41 ||
    (next >= 0x46 && next <= 0x4f) || (next >= 0x6b && next <= 0x70);
}
// アドレス範囲の値でも、比較・算術の相手ならアドレスではない
function isArithUse(next) {
  return (next >= 0x46 && next <= 0x4f) || (next >= 0x6b && next <= 0x70);
}

const STORE_OPS = new Set([0x36, 0x37, 0x38, 0x39]); // i32/i64/f32/f64.store
const COMPARE_OPS = new Set([0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
  0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66]);
const LOAD_OPS = new Set([0x28, 0x29, 0x2a, 0x2b]); // i32/i64/f32/f64.load
const OP_SYMBOLS = {
  0x46: "==", 0x47: "!=", 0x48: "<", 0x49: "<", 0x4a: ">", 0x4b: ">", 0x4c: "<=", 0x4d: "<=", 0x4e: ">=", 0x4f: ">=",
  0x5b: "==", 0x5c: "!=", 0x5d: "<", 0x5e: ">", 0x5f: "<=", 0x60: ">=",
  0x61: "==", 0x62: "!=", 0x63: "<", 0x64: ">", 0x65: "<=", 0x66: ">=",
  0x6a: "+", 0x6b: "-", 0x6c: "*", 0x6d: "/", 0x6e: "/", 0x6f: "%", 0x70: "%",
  0x92: "+", 0x93: "-", 0x94: "*", 0x95: "/", 0xa0: "+", 0xa1: "-", 0xa2: "*", 0xa3: "/",
};

function encodeULeb(v) {
  const out = [];
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 128;
    out.push(b);
  } while (v > 0);
  return out;
}

// 符号付き LEB128。minLen に満たない場合は冗長バイトで埋める（wasm では有効なエンコード）
function encodeSLeb32(v, minLen) {
  const out = [];
  v |= 0;
  for (;;) {
    const b = v & 127;
    v >>= 7;
    const done = (v === 0 && !(b & 64)) || (v === -1 && (b & 64));
    if (done && out.length + 1 >= minLen) {
      out.push(b);
      return out;
    }
    out.push(b | 128);
  }
}

// ----------------------------------------------------------------
//  モジュール構造の読み取り（型・import・関数・elem・data・global・code）
// ----------------------------------------------------------------
function readWasmLayout(bytes) {
  let p = 8;
  function u() {
    let r = 0, s = 0, x;
    do { x = bytes[p++]; r += (x & 127) * 2 ** s; s += 7; } while (x & 128);
    return r;
  }
  function sleb() {
    let r = 0, s = 0, x;
    do { x = bytes[p++]; if (s < 32) r |= (x & 127) << s; s += 7; } while (x & 128);
    if (s < 32 && (x & 64)) r |= -1 << s;
    return r;
  }
  function valtype() {
    const t = bytes[p++];
    if (t === 0x63 || t === 0x64) sleb(); // (ref null? ht)
  }
  // 定数式（i32.const N end）のみ対応
  function constExpr() {
    if (bytes[p++] !== 0x41) throw new Error("unsupported const expr");
    const v = sleb();
    if (bytes[p++] !== 0x0b) throw new Error("unsupported const expr");
    return v;
  }

  const L = {
    nImports: 0, elem: [], segs: [], stack0: 0, codeIdPos: -1, codeStart: -1, codeEnd: -1,
    typeParams: [], importTypes: [], funcTypes: [],
  };
  while (p < bytes.length) {
    const idPos = p;
    const id = bytes[p++];
    const size = u();
    const st = p;
    if (id === 1) {
      const n = u();
      for (let i = 0; i < n; i++) {
        if (bytes[p++] !== 0x60) throw new Error("unsupported type");
        const np = u();
        for (let j = 0; j < np; j++) valtype();
        const nr = u();
        for (let j = 0; j < nr; j++) valtype();
        L.typeParams.push(np);
      }
    } else if (id === 2) {
      const n = u();
      for (let i = 0; i < n; i++) {
        const modLen = u(); p += modLen;
        const fieldLen = u(); p += fieldLen;
        const kind = bytes[p++];
        if (kind === 0) { L.importTypes.push(u()); L.nImports++; }
        else if (kind === 1) { p++; const f = u(); u(); if (f & 1) u(); }
        else if (kind === 2) { const f = u(); u(); if (f & 1) u(); }
        else if (kind === 3) p += 2;
        else if (kind === 4) { p++; u(); }
      }
    } else if (id === 3) {
      const n = u();
      for (let i = 0; i < n; i++) L.funcTypes.push(u());
    } else if (id === 6) {
      const n = u();
      for (let i = 0; i < n; i++) {
        const type = bytes[p++];
        const mut = bytes[p++];
        if (bytes[p] === 0x41) {
          p++;
          const v = sleb();
          p++;
          // 最初の可変 i32 グローバル = __stack_pointer（静的領域の終端）
          if (type === 0x7f && mut === 1 && !L.stack0) L.stack0 = v;
        } else {
          while (bytes[p++] !== 0x0b);
        }
      }
    } else if (id === 9) {
      const n = u();
      for (let i = 0; i < n; i++) {
        const flags = u();
        if (flags !== 0 && flags !== 2) throw new Error("unsupported elem segment");
        if (flags === 2) { u(); }
        const off = constExpr();
        if (flags === 2) p++; // elemkind
        const c = u();
        for (let j = 0; j < c; j++) L.elem[off + j] = u();
      }
    } else if (id === 10) {
      L.codeIdPos = idPos; L.codeStart = st; L.codeEnd = st + size;
    } else if (id === 11) {
      const n = u();
      for (let i = 0; i < n; i++) {
        const flags = u();
        if (flags === 1) throw new Error("passive data segment"); // pthread ビルド等は未対応
        if (flags === 2) u();
        const addr = constExpr();
        const len = u();
        L.segs.push({ addr, off: p, len });
        p += len;
      }
    }
    p = st + size;
  }
  L.segs.sort((a, b) => a.addr - b.addr);
  if (!L.stack0) {
    const last = L.segs[L.segs.length - 1];
    L.stack0 = last ? last.addr + last.len : 0;
  }
  return L;
}

// 関数（import を含む絶対番号）の引数の数
function funcParamCount(L, absIdx) {
  const t = absIdx < L.nImports ? L.importTypes[absIdx] : L.funcTypes[absIdx - L.nImports];
  return t === undefined ? -1 : L.typeParams[t];
}

// メモリアドレス → ファイル内オフセット（データセグメント内のみ）
function addrToOffset(L, addr) {
  let lo = 0, hi = L.segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = L.segs[mid];
    if (addr < s.addr) hi = mid - 1;
    else if (addr >= s.addr + s.len) lo = mid + 1;
    else return s.off + (addr - s.addr);
  }
  return -1;
}

// 初期メモリの u32 を読む。データセグメントは 0 の並びで分割されているため、
// セグメント外（＝0）や境界をまたぐ値もバイト単位で組み立てる
function memU32(L, bytes, addr) {
  const o = addrToOffset(L, addr);
  if (o >= 0 && addrToOffset(L, addr + 3) === o + 3) {
    return (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  }
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const bo = addrToOffset(L, addr + i);
    if (bo >= 0) v |= bytes[bo] << (8 * i);
  }
  return v >>> 0;
}

function offsetToAddr(L, off) {
  for (const s of L.segs) if (off >= s.off && off < s.off + s.len) return s.addr + (off - s.off);
  return -1;
}

function findBytes(hay, needle, from, to) {
  const first = needle[0];
  for (let i = hay.indexOf(first, from); i >= 0 && i <= to - needle.length; i = hay.indexOf(first, i + 1)) {
    let ok = true;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

function dataRange(L) {
  const last = L.segs[L.segs.length - 1];
  return [L.segs[0].off, last.off + last.len];
}

// アセンブリの Il2CppCodeGenModule を探し、methodPointers 配列のアドレスを返す
function findCodeGenModule(bytes, L, name, count) {
  const [dataFrom, dataTo] = dataRange(L);
  const needle = new TextEncoder().encode(name + "\0");
  for (let fo = findBytes(bytes, needle, dataFrom, dataTo); fo >= 0; fo = findBytes(bytes, needle, fo + 1, dataTo)) {
    const nameAddr = offsetToAddr(L, fo);
    if (nameAddr < 0) continue;
    const pat = [nameAddr & 255, (nameAddr >>> 8) & 255, (nameAddr >>> 16) & 255, (nameAddr >>> 24) & 255];
    for (let q = findBytes(bytes, pat, dataFrom, dataTo); q >= 0; q = findBytes(bytes, pat, q + 1, dataTo)) {
      const qa = offsetToAddr(L, q);
      if (qa < 0 || memU32(L, bytes, qa + 4) !== count) continue;
      const mpAddr = memU32(L, bytes, qa + 8);
      if (addrToOffset(L, mpAddr) >= 0) return mpAddr;
    }
  }
  return -1;
}

// ----------------------------------------------------------------
//  関数とメソッドの対応付け
//  戻り値: {
//    game:  Map<コード内関数番号, ラベル>      書き換え対象のゲーム関数
//    info:  Map<コード内関数番号, method>     ゲームのメソッド情報（共有関数も含む。呼び出し先の名前用）
//    api:   Map<コード内関数番号, method>     エンジン側 API のメソッド情報（引数名の表示用）
//  }
// ----------------------------------------------------------------
function mapGameFunctions(bytes, L, meta) {
  if (!L.segs.length) return null;

  const owners = new Map(); // func -> { game: Set<label>, engine: bool }
  const info = new Map();
  const api = new Map();
  const toFunc = (ti) => {
    if (!ti) return -1;
    const fi = L.elem[ti];
    return fi === undefined ? -1 : fi - L.nImports;
  };
  const owner = (fi) => {
    if (!owners.has(fi)) owners.set(fi, { game: new Set(), engine: false });
    return owners.get(fi);
  };

  let gameModules = 0;
  for (const img of meta.images) {
    if (!img.methodCount) continue;
    const mpAddr = findCodeGenModule(bytes, L, img.name, img.methodCount);
    if (mpAddr < 0) {
      if (img.methods) return null; // ゲーム側が見つからなければ何もしない
      continue; // エンジン側が見つからない場合は、直接 call の検査で保護する
    }
    const ptr = (rid) => toFunc(memU32(L, bytes, mpAddr + (rid - 1) * 4));
    if (img.methods) {
      gameModules++;
      // 同じ名前（オーバーロード）は #2, #3 で区別する
      const seen = new Map();
      for (const me of img.methods) {
        const n = (seen.get(me.name) || 0) + 1;
        seen.set(me.name, n);
        const label = n > 1 ? `${me.name}#${n}` : me.name;
        const fi = ptr(me.rid);
        if (fi < 0) continue;
        owner(fi).game.add(label);
        if (!info.has(fi)) info.set(fi, me);
      }
    } else {
      for (let rid = 1; rid <= img.methodCount; rid++) {
        const fi = ptr(rid);
        if (fi >= 0) owner(fi).engine = true;
      }
      for (const me of img.api || []) {
        const fi = ptr(me.rid);
        if (fi < 0) continue;
        if (!api.has(fi)) api.set(fi, []);
        api.get(fi).push(me);
      }
    }
  }
  if (!gameModules) return null;

  // 同一コードにまとめられた API は、よく使うもの（API_TYPES の順）を先に表示する
  const rank = new Map([...API_TYPES].map((t, i) => [t, i]));
  const rankOf = (me) => {
    const r = rank.get(me.name.slice(0, me.name.indexOf("."))); // "WaitForSeconds..ctor" → "WaitForSeconds"
    return r === undefined ? 999 : r;
  };
  for (const list of api.values()) list.sort((a, b) => rankOf(a) - rankOf(b));

  const game = new Map();
  for (const [fi, o] of owners) {
    if (o.game.size && !o.engine) game.set(fi, [...o.game].join(" / "));
  }
  return { game, info, api };
}

// ----------------------------------------------------------------
//  フィールドのオフセット（ゲームの型のみ）
//  wasm のデータにある Il2CppMetadataRegistration から
//    types（Il2CppType* の配列）と typeDefinitionsSizes（型ごとのサイズ）を取り出し、
//  メタデータのフィールドの並び・型から IL2CPP と同じ規則でオフセットを計算する。
//  計算結果が実際のインスタンスサイズと合わない型はラベルを付けない（誤表示を防ぐ）。
//  戻り値: {
//    layouts: Map<型定義番号, Map<オフセット, { name, kind }>>,
//    kindOf:  (Il2CppType の番号) => 型の種類（IL2CPP_TYPE_*）| null
//  }
// ----------------------------------------------------------------
function resolveFieldLayouts(bytes, L, meta) {
  const layouts = new Map();
  const res = { layouts, kindOf: () => null };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const N = meta.typeDefCount;
  if (!N) return res;

  // { …, typesCount, types, methodSpecsCount, methodSpecs, fieldOffsetsCount(=N), fieldOffsets, typeDefinitionsSizesCount(=N), typeDefinitionsSizes, … }
  const [from, to] = dataRange(L);
  let typesAddr = -1, sizesAddr = -1;
  for (let q = from + 16; q < to - 16; q++) {
    if (dv.getUint32(q, true) !== N || dv.getUint32(q + 8, true) !== N) continue;
    const qa = offsetToAddr(L, q);
    if (qa < 0) continue;
    const t = memU32(L, bytes, qa - 12);
    const s = memU32(L, bytes, qa + 12);
    if (addrToOffset(L, t) >= 0 && addrToOffset(L, s) >= 0) { typesAddr = t; sizesAddr = s; break; }
  }
  if (typesAddr < 0) return res;

  const typeAt = (i) => {
    const ptr = memU32(L, bytes, typesAddr + i * 4);
    if (addrToOffset(L, ptr) < 0) return null;
    const bits = memU32(L, bytes, ptr + 4);
    return { data: memU32(L, bytes, ptr), attrs: bits & 0xffff, kind: (bits >>> 16) & 0xff, valuetype: bits >>> 31 };
  };
  res.kindOf = (i) => {
    const t = typeAt(i);
    return t ? t.kind : null;
  };
  // クラス型（IL2CPP_TYPE_CLASS）なら型定義番号、それ以外は null
  res.classOf = (i) => {
    const t = typeAt(i);
    return t && t.kind === 0x12 ? t.data : null;
  };
  const instanceSize = (ti) => {
    if (ti < 0 || ti >= N) return -1;
    const ptr = memU32(L, bytes, sizesAddr + ti * 4);
    return addrToOffset(L, ptr) < 0 ? -1 : memU32(L, bytes, ptr);
  };
  // [size, align]。分からない型は null
  const sizeOf = (t) => {
    switch (t.kind) {
      case 0x02: case 0x04: case 0x05: return [1, 1];
      case 0x03: case 0x06: case 0x07: return [2, 2];
      case 0x08: case 0x09: case 0x0c: return [4, 4];
      case 0x0a: case 0x0b: case 0x0d: return [8, 8];
      case 0x0e: case 0x0f: case 0x12: case 0x14: case 0x18: case 0x19: case 0x1b: case 0x1c: case 0x1d: return [4, 4];
      case 0x11: {
        const s = instanceSize(t.data) - 8;
        return s > 0 ? [s, Math.min(s, 4)] : null;
      }
      case 0x15: return t.valuetype ? null : [4, 4];
      default: return null;
    }
  };

  // UnityEngine.Object 系（MonoBehaviour 等）を継承しているゲームの型
  const unityBases = new Set(meta.unityObjectTypes || []);
  const gameTypes = new Map();
  for (const img of meta.images) for (const ty of img.types || []) gameTypes.set(ty.ti, ty);
  res.typeNames = new Map([...gameTypes].map(([ti, ty]) => [ti, ty.name]));
  const parentDef = (ty) => {
    const pt = ty.parent >= 0 ? typeAt(ty.parent) : null;
    return pt && pt.kind === 0x12 ? pt.data : -1;
  };
  res.unityObject = new Set();
  for (const ty of gameTypes.values()) {
    for (let cur = ty, guard = 0; cur && guard < 16; guard++) {
      const pd = parentDef(cur);
      if (unityBases.has(pd)) { res.unityObject.add(ty.ti); break; }
      cur = gameTypes.get(pd);
    }
  }

  for (const img of meta.images) {
    for (const ty of img.types || []) {
      let off = 8; // オブジェクトヘッダー（klass + monitor）
      if (ty.parent >= 0) {
        const pt = typeAt(ty.parent);
        if (!pt) continue;
        if (pt.kind === 0x1c) off = 8; // System.Object（コルーチン等）
        else if (pt.kind === 0x12) off = instanceSize(pt.data);
        else continue; // ジェネリックの親クラス等はサイズが分からない
        if (off < 0) continue;
      }
      const map = new Map();
      let ok = true;
      for (const f of ty.fields) {
        const t = typeAt(f.type);
        if (!t) { ok = false; break; }
        if (t.attrs & 0x50) continue; // static / const は インスタンスに含まれない
        const sa = sizeOf(t);
        if (!sa) { ok = false; break; }
        off = Math.ceil(off / sa[1]) * sa[1];
        map.set(off, { name: f.name, kind: t.kind, size: sa[0], data: t.data });
        off += sa[0];
      }
      const inst = instanceSize(ty.ti);
      if (ok && inst >= off && inst - off < 8) layouts.set(ty.ti, map);
    }
  }
  return res;
}

// 型の種類 → 値の分類
//   "num":  数値（おすすめ）  "flag": bool（変更はできるがおすすめしない）
//   "ref":  参照・ポインタ（変更不可）  null: 不明
function valueClass(kind) {
  if (kind === null || kind === undefined) return null;
  if (kind === 0x02) return "flag";
  if (kind >= 0x03 && kind <= 0x0d) return "num";
  if (kind === 0x11) return "num"; // 列挙型など（値型）
  return "ref";
}

// コンパイラが作るフィールド名を C# の名前に戻す
//   <i>5__2（コルーチンのローカル変数）→ i / <>3__no（コルーチンの引数）→ no
//   <hp>k__BackingField（自動プロパティ）→ hp
function prettyField(name) {
  const m = /^<(.+)>(?:5__\d+|k__BackingField)$/.exec(name) || /^<>3__(.+)$/.exec(name);
  return m ? m[1] : name;
}

// フィールドの経路を表示用の文字列にする（["this", "chooseManager", "leftCost"] → "this.chooseManager.leftCost"）
function pathText(names) {
  return names.map(prettyField).join(".");
}

const CONVERT_OPS = (op) => op >= 0xa7 && op <= 0xbf; // wrap / trunc / convert / demote / promote / reinterpret

// メタデータの使用箇所トークン（型情報）を解読する（new X() の X）
function typeInfoAt(bytes, L, addr) {
  if (addrToOffset(L, addr) < 0) return null;
  const token = memU32(L, bytes, addr);
  if (!(token & 1) || (token >>> 29) !== 1) return null; // kIl2CppMetadataUsageTypeInfo
  return (token & 0x1fffffff) >>> 1;
}

// メタデータの使用箇所トークン（文字列リテラル）を解読する
function literalAt(bytes, L, meta, addr) {
  if (addrToOffset(L, addr) < 0) return null;
  const token = memU32(L, bytes, addr);
  if (!(token & 1) || (token >>> 29) !== 5) return null; // kIl2CppMetadataUsageStringLiteral
  const s = meta.literals ? meta.literals[(token & 0x1fffffff) >>> 1] : undefined;
  return s === undefined ? null : s;
}

/**
 * bytes: Uint8Array（f32/f64 はその場で書き換える）
 * opts : {
 *   meta,                       // unityMeta.js の要約（なければ何もしない）
 *   mult, prob, random,         // ランダム書き換え（ゲーム関数の小数のみ）
 *   valueRules: Map<number, {to, wasmInt}>,
 *   wasmRules:  Map<"label#index", {to, from}>,
 *   scan: Array | null,         // 検出値 [{ method, consts: [{ i, t, v, label, named }] }] を追加する
 * }
 * 戻り値: { bytes, count, games, reason? }
 */
function fuzzWasm(bytes, opts) {
  const { meta, mult, prob, random, valueRules, wasmRules, scan } = opts;
  if (!meta) return { bytes, count: 0, games: 0, reason: "C# のメタデータがないため対象外" };

  let L, mapped, layouts;
  try {
    L = readWasmLayout(bytes);
    mapped = mapGameFunctions(bytes, L, meta);
    layouts = mapped ? resolveFieldLayouts(bytes, L, meta) : null;
  } catch (e) {
    return { bytes, count: 0, games: 0, reason: "wasm の構造を解析できません: " + e.message };
  }
  if (!mapped || !mapped.game.size || L.codeStart < 0) {
    return { bytes, count: 0, games: 0, reason: "ゲームの C# メソッドを特定できません" };
  }
  const { game, info, api } = mapped;

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ptrLo = 1024, ptrHi = L.stack0;
  let p = L.codeStart;

  function u() {
    let r = 0, s = 0, x;
    do { x = bytes[p++]; r += (x & 127) * 2 ** s; s += 7; } while (x & 128);
    return r;
  }
  function sleb() {
    let r = 0, s = 0, x;
    do { x = bytes[p++]; if (s < 32) r |= (x & 127) << s; s += 7; } while (x & 128);
    if (s < 32 && (x & 64)) r |= -1 << s;
    return r;
  }
  function sk() { while (bytes[p++] & 128); }

  const { layouts: fieldLayouts, kindOf, classOf } = layouts;
  const typeNames = layouts.typeNames || new Map();

  // 値の出どころを経路として解決する
  //   h: 直近の命令の履歴、end: 対象の値（オブジェクトまたはフィールド値）を積んだ命令の位置
  //   起点: this（local 0）/ 引数 / new したオブジェクトや別のフィールドを入れたローカル変数
  //   戻り値: { names: ["this", "playerStatus", "money"], ti: オブジェクトなら型定義番号, fd: 最後に読んだフィールド }
  //   srcOf(N): ローカル変数 N に代入された由来の候補（古い順）。分岐で使い回されたローカル変数は
  //   命令の並び順だけでは区別できないため、新しい順に試してフィールドの位置が合うものを採用する
  function rootsOf(e, me, srcOf) {
    if (!e || (e.op !== 0x20 && e.op !== 0x22)) return [];
    const N = e.a;
    if (me && !me.static && N === 0) return [{ names: ["this"], ti: me.type }];
    const pi = me ? (me.static ? N : N - 1) : -1;
    if (me && pi >= 0 && pi < me.params.length) {
      const ti = classOf(me.ptypes[pi]);
      return ti !== null ? [{ names: [me.params[pi]], ti }] : [];
    }
    const roots = [];
    for (const src of (srcOf(N) || []).slice().reverse()) {
      if (!src) continue;
      if (src.path && src.path.ti !== null && src.path.ti !== undefined) roots.push({ names: src.path.names, ti: src.path.ti });
      else if (src.newType !== undefined && src.newType !== null) {
        roots.push({ names: ["new " + (typeNames.get(src.newType) || "?") + "()"], ti: src.newType });
      }
    }
    return roots;
  }
  function walkFields(root, offs) {
    let names = root.names.slice();
    let ti = root.ti;
    let fd = null;
    for (const off of offs) {
      if (fd) {
        if (fd.kind !== 0x12) return null;
        ti = fd.data;
      }
      const lay = fieldLayouts.get(ti);
      fd = lay ? lay.get(off) : null;
      if (!fd) return null;
      // コルーチンの <>4__this は外側のクラスそのもの（GameManager.yourMoney のように表示）
      if (fd.name === "<>4__this") names = [typeNames.get(fd.data) || "this"];
      else names.push(fd.name);
    }
    return { names, ti: fd ? (fd.kind === 0x12 ? fd.data : null) : ti, fd };
  }
  // storeOff を指定すると、得られたオブジェクトにそのオフセットのフィールドがある候補だけを採用する
  function resolvePath(h, end, me, srcOf, storeOff) {
    let j = end;
    const offs = [];
    while (j >= 0 && h[j].op >= 0x28 && h[j].op <= 0x35) { offs.unshift(h[j].a); j--; }
    if (j < 0) return null;
    for (const root of rootsOf(h[j], me, srcOf)) {
      const r = walkFields(root, offs);
      if (!r) continue;
      if (storeOff !== undefined) {
        const lay = r.ti !== null && (!r.fd || r.fd.kind === 0x12) ? fieldLayouts.get(r.ti) : null;
        if (!lay || !lay.get(storeOff)) continue;
      }
      return r;
    }
    return null;
  }
  const MAX_SRCS = 4;
  function pushSrc(map, N, src) {
    const list = (map.get(N) || []).slice();
    list.push(src);
    if (list.length > MAX_SRCS) list.shift();
    map.set(N, list);
  }

  const nFuncs = u();
  const funcsStart = p;
  const consts = new Map(); // func -> [const record]
  // 引数なしのインスタンスメソッド Get〇〇 / get_〇〇（ゲッター候補）
  const getterCands = new Set();
  for (const [fi, me] of info) {
    if (!me.static && me.params.length === 0 && /\.(Get[A-Z]\w*|get_\w+)$/.test(me.name)) getterCands.add(fi);
  }
  const getters = []; // { type, off, name }
  const calledFromOutside = new Set();

  for (let f = 0; f < nFuncs; f++) {
    const size = u();
    const end = p + size;
    const isGame = game.has(f);
    const list = isGame ? [] : null;

    // ゲーム関数のみ: 直前の命令の履歴・call までの引数列・文字列リテラル
    const hist = []; // 直近の命令 { op, a }（a = ローカル番号 / メモリオフセット / 定数値）
    let pendingNext = null; // 直後の命令を記録待ちの定数
    let pendingAfterCall = null; // call の直後の命令を記録待ちの定数
    let run = []; // 直近の「値を積むだけの命令」の並びに含まれる定数 { c, pos }
    let runPushes = 0;
    let lastLit = null; // { s, at }
    const localSrc = new Map(); // ローカル変数 → 代入された値の出どころ { call, newType } | { path }
    let lastNew = null; // { type, at }: 直前に読み込んだ型情報（new X() の X）
    const meF = isGame ? info.get(f) : null;
    // ゲッター（GetClearCount() 等）: this から読むフィールドを記録する（エンジンと共有の関数も対象）
    const getter = getterCands.has(f) ? { offs: new Set(), n: 0 } : null;
    let prevGetterOp = -1, prevGetterA = null;
    let n = 0; // 命令番号

    try {
      const nLocals = u();
      for (let i = 0; i < nLocals; i++) {
        sk();
        const t = bytes[p++];
        if (t === 0x63 || t === 0x64) sk();
      }
      while (p < end) {
        const op = bytes[p++];
        let a = null;
        let rec = null;
        if (op === 0x43) { if (list) rec = { off: p, len: 4, t: "f32", v: dv.getFloat32(p, true) }; p += 4; }
        else if (op === 0x44) { if (list) rec = { off: p, len: 8, t: "f64", v: dv.getFloat64(p, true) }; p += 8; }
        else if (op === 0x41) {
          const st = p;
          a = sleb();
          if (list) rec = { off: st, len: p - st, t: "i32", v: a };
        }
        else if (op === 0x42) sk();
        else if (op === 0x10) { a = u(); const c = a - L.nImports; if (!isGame && game.has(c)) calledFromOutside.add(c); }
        else if (op === 0x02 || op === 0x03 || op === 0x04 || op === 0x06) {
          const t = bytes[p];
          if (t === 0x40 || (t >= 0x6f && t <= 0x7f)) p++; else sk();
        }
        else if ((op >= 0x20 && op <= 0x24)) a = u();
        else if (op === 0x0c || op === 0x0d || op === 0x12 ||
                 op === 0x07 || op === 0x08 || op === 0x09 || op === 0x18 ||
                 op === 0x25 || op === 0x26 || op === 0xd2 || op === 0x3f || op === 0x40) sk();
        else if (op === 0x0e) { const c = u(); for (let i = 0; i <= c; i++) sk(); }
        else if (op === 0x11 || op === 0x13) { sk(); sk(); }
        else if (op === 0x1c) { const k = u(); p += k; }
        else if (op >= 0x28 && op <= 0x3e) { sk(); a = u(); }
        else if (op === 0xd0) p++;
        else if (op === 0xfc) {
          const s = u();
          if (s === 8 || s === 10 || s === 12 || s === 14) { sk(); sk(); }
          else if (s > 7) sk();
        }
        else if (op === 0xfd) {
          const s = u();
          if (s <= 11 || s === 92 || s === 93) { sk(); sk(); }
          else if (s === 12 || s === 13) p += 16;
          else if (s >= 21 && s <= 34) p++;
          else if (s >= 84 && s <= 91) { sk(); sk(); p++; }
        }
        else if (op === 0xfe) { const s = u(); if (s === 3) p++; else { sk(); sk(); } }
        else if ((op >= 0x45 && op <= 0xc4) || op === 0x00 || op === 0x01 || op === 0x05 ||
                 op === 0x0b || op === 0x0f || op === 0x19 || op === 0x1a || op === 0x1b ||
                 op === 0xd1) { /* 即値なし */ }
        else throw new Error("unknown opcode 0x" + op.toString(16));

        if (getter) {
          getter.n++;
          if (op >= 0x28 && op <= 0x35 && prevGetterOp === 0x20 && prevGetterA === 0) getter.offs.add(a);
          prevGetterOp = op; prevGetterA = a;
        }
        if (!list) continue;
        n++;

        if (pendingNext) { pendingNext.next = op; pendingNext.nextA = a; pendingNext = null; }
        if (pendingAfterCall) {
          for (const c of pendingAfterCall) { c.afterCall = op; c.afterCallA = a; }
          pendingAfterCall = null;
        }

        if (rec) {
          rec.prev = hist[hist.length - 1];
          rec.hist = hist.slice();
          if (lastLit && n - lastLit.at <= 8) rec.lit = lastLit.s;
          // 履歴に出てくるローカル変数の出どころ（この時点の値）
          rec.srcs = new Map();
          for (const e of rec.hist) if (e.op === 0x20 || e.op === 0x22) rec.srcs.set(e.a, localSrc.get(e.a));
          list.push(rec);
          pendingNext = rec;
          run.push({ c: rec, pos: runPushes });
          runPushes++;
        } else if (op === 0x20 || op === 0x23 || op === 0x42) {
          runPushes++;
        } else if (op === 0x10) {
          for (const r of run) { r.c.callee = a; r.c.after = runPushes - r.pos - 1; }
          pendingAfterCall = run.map((r) => r.c);
          run = []; runPushes = 0;
        } else {
          run = []; runPushes = 0;
        }

        // i32.const ADDR; i32.load → 文字列リテラルの読み込み
        if (op === 0x28 && a === 0) {
          const prev = hist[hist.length - 1];
          if (prev && prev.op === 0x41) {
            const s = literalAt(bytes, L, meta, prev.a);
            if (s !== null) lastLit = { s, at: n };
            const ty = typeInfoAt(bytes, L, prev.a);
            if (ty !== null) lastNew = { type: classOf(ty), at: n };
          }
        }

        // local.set / local.tee: 代入された値の出どころを覚える
        //   関数の戻り値（new X() なら型も）/ フィールドの経路（this.chooseManager.leftCost 等）
        if (op === 0x21 || op === 0x22) {
          const h1 = hist[hist.length - 1];
          let src = null;
          // (float)this.MaxBoukouLimit のような型変換は読み飛ばす
          const e = h1 && CONVERT_OPS(h1.op) ? hist.length - 2 : hist.length - 1;
          const he = hist[e];
          if (he && he.op === 0x10) {
            src = { call: he.a, newType: lastNew && n - lastNew.at <= 8 ? lastNew.type : undefined };
          } else if (he && ((he.op >= 0x28 && he.op <= 0x35) || he.op === 0x20 || he.op === 0x22)) {
            const path = resolvePath(hist, e, meF, (N) => localSrc.get(N));
            if (path) src = { path };
          }
          pushSrc(localSrc, a, src);
        }

        hist.push({ op, a });
        if (hist.length > 8) hist.shift();
      }
    } catch (_) {
      p = -1; // 解析できない関数は一切触らない
    }

    if (list && p === end && bytes[end - 1] === 0x0b) consts.set(f, list);
    // 短い関数で this のフィールドを 1 つだけ読んでいればゲッターとみなす
    if (getter && p === end && getter.n <= 16 && getter.offs.size === 1) {
      const me = info.get(f);
      getters.push({ type: me.type, off: [...getter.offs][0], name: me.name.slice(me.name.indexOf(".") + 1) + "()" });
    }
    p = end;
  }

  // 定数の意味（ラベル）と分類を推定する
  //  戻り値: null（不明）| { block: true }（変更不可）| { label, cls: "num" | "flag" | "local" | null }
  //  cls "local" は出どころの分からないローカル変数（ループ回数などの可能性があるのでおすすめしない）
  // 呼び出し先の表示名（get_xxx はプロパティとして表示）
  const calleeName = (abs) => {
    const ci = abs - L.nImports;
    const cands = api.get(ci) || (info.has(ci) ? [info.get(ci)] : null);
    if (!cands) return null;
    const m = /^(.*)\.get_(\w+)$/.exec(cands[0].name);
    return m ? m[1] + "." + m[2] : cands[0].name + "()";
  };
  const isInternal = (name) => name.startsWith("<>"); // <>1__state / <>2__current 等
  function describe(c, me) {
    const h = c.hist || [];
    const last = h.length - 1;
    const srcOf = (N) => (c.srcs ? c.srcs.get(N) : undefined);
    const fields = me && !me.static ? fieldLayouts.get(me.type) : null;

    // 1. フィールドへの代入: <オブジェクト> 定数 store offset=N
    //    this.money = 10 / this.playerStatus.money = 10 / GameManager.yourMoney = 10（コルーチン内）
    if (STORE_OPS.has(c.next) && last >= 0) {
      const obj = resolvePath(h, last, me, srcOf, c.nextA);
      if (obj && obj.ti !== null && (!obj.fd || obj.fd.kind === 0x12)) {
        const lay = fieldLayouts.get(obj.ti);
        const fd = lay && lay.get(c.nextA);
        if (fd) {
          const cls = valueClass(fd.kind);
          // コンパイラが作る内部状態（コルーチンの <>1__state 等）や参照型は変更させない
          if (isInternal(fd.name) || cls === "ref") return { block: true };
          return { label: pathText([...obj.names, fd.name]) + " = ●", cls };
        }
      }
    }
    // 2. API(…, 定数, …)
    if (c.callee !== undefined) {
      const ci = c.callee - L.nImports;
      const cands = api.get(ci) || (info.has(ci) ? [info.get(ci)] : null);
      const pc = funcParamCount(L, c.callee);
      const callee = cands && cands[0];
      if (callee && pc > 0) {
        const argIdx = pc - 1 - c.after;
        const idx = callee.static ? argIdx : argIdx - 1;
        if (idx >= 0 && idx < callee.params.length) {
          const cls = valueClass(kindOf(callee.ptypes[idx]));
          // null 比較・オブジェクト引数、コルーチン生成時の状態（<>1__state）は変えさせない
          if (cls === "ref" || isInternal(callee.params[idx])) return { block: true };
          const args = callee.params.map((pn, i) => {
            if (i === idx) return "▶" + pn;
            if (i === idx - 1 && c.lit !== undefined) return JSON.stringify(c.lit);
            return pn;
          });
          let label = callee.name + "(" + args.join(", ") + ")";
          if (STORE_OPS.has(c.afterCall) && fields) {
            const fd = fields.get(c.afterCallA);
            if (fd && !isInternal(fd.name)) label = "this." + prettyField(fd.name) + " = " + label;
          }
          // 同じ処理にまとめられた別の API（例: WaitForSeconds..ctor と Rect.set_width）
          if (cands.length > 1) {
            label += "〔同一処理: " + cands.slice(1, 3).map((x) => x.name).join(", ") + (cands.length > 3 ? " ほか" : "") + "〕";
          }
          return { label, cls };
        }
      }
    }
    // 3. 比較・演算: <値> [型変換] 定数 比較/算術
    if (!OP_SYMBOLS[c.next] || last < 0) return null;
    const sym = OP_SYMBOLS[c.next];
    const isCompare = COMPARE_OPS.has(c.next);
    // 戻り値・ローカル変数は型が分からないため、整数はオブジェクト（ポインタ）の可能性を除く:
    //   加減算はアドレス計算（ptr + 20）、0 との比較は null チェックのことがある
    const maybePointer = c.t === "i32" && (!isCompare || c.v === 0);
    let e = last;
    if (CONVERT_OPS(h[e].op)) e--; // (float)this.MaxBoukouLimit * 0.05f
    if (e < 0) return null;
    const pe = h[e];

    // フィールドの値と比較・演算: this.money + 1 / this.chooseManager.leftCost <= 0
    if (pe.op >= 0x28 && pe.op <= 0x35) {
      const v = resolvePath(h, e, me, srcOf);
      if (!v || !v.fd) return null;
      if (isInternal(v.fd.name)) return { block: true };
      const cls = valueClass(v.fd.kind);
      const loopVar = /^<.+>5__\d+$/.test(v.fd.name); // コルーチンのループ変数の加減算は扱わない
      if ((cls === "num" || cls === "flag") && (isCompare || !loopVar)) return { label: pathText(v.names) + " " + sym + " ●", cls };
      return null;
    }
    // 関数の戻り値と比較・演算: if (Random.value < 0.05f)
    if (pe.op === 0x10) {
      if (maybePointer) return null;
      const name = calleeName(pe.a);
      return name ? { label: name + " " + sym + " ●", cls: "num" } : null;
    }
    // 引数・ローカル変数と比較: if (amount > 100) / if (count >= 3)
    if (me && (pe.op === 0x20 || pe.op === 0x22)) {
      const N = pe.a;
      if (!me.static && N === 0) return null; // this
      const pi = me.static ? N : N - 1;
      if (pi >= 0 && pi < me.params.length) {
        const cls = valueClass(kindOf(me.ptypes[pi]));
        if (cls === "num" || cls === "flag") return { label: "引数 " + me.params[pi] + " " + sym + " ●", cls };
        return null;
      }
      // 値の由来は直近の代入だけを使う（オブジェクトと違ってフィールドの位置で確かめられないため）
      const srcList = srcOf(N) || [];
      const latest = srcList[srcList.length - 1] || null;
      // 由来がフィールドの値なら、そのフィールドと同じように扱う（var limit = this.MaxBoukouLimit; limit * 0.05f）
      const fieldSrc = latest && latest.path && latest.path.fd ? latest : null;
      if (fieldSrc) {
        const fd = fieldSrc.path.fd;
        // コルーチンの状態（<>1__state）による分岐は変えるとコルーチンが壊れる
        if (isInternal(fd.name)) return { block: true };
        const cls = valueClass(fd.kind);
        const loopVar = /^<.+>5__\d+$/.test(fd.name);
        if ((cls === "num" || cls === "flag") && (isCompare || !loopVar)) {
          return { label: pathText(fieldSrc.path.names) + " " + sym + " ●", cls };
        }
        return null;
      }
      if (!isCompare || maybePointer) return null; // ローカル変数の加減算（ループのカウンタ等）・null チェックは扱わない
      const callSrc = latest && latest.call !== undefined ? latest : null;
      if (callSrc) {
        const name = calleeName(callSrc.call);
        if (name) return { label: "ローカル変数（≒ " + name + "） " + sym + " ●", cls: "num" };
      }
      return { label: "ローカル変数 " + sym + " ●", cls: "local" };
    }
    return null;
  }

  // 書き換え可能な定数を決めて適用する
  let count = 0, games = 0;
  const grow = []; // 長さが伸びる i32 置き換え: [off, oldLen, newBytes]
  const funcs = [...consts.keys()].sort((a, b) => a - b);
  for (const f of funcs) {
    if (calledFromOutside.has(f)) continue;
    const label = game.get(f);
    const me = info.get(f);
    const editable = [];
    for (const c of consts.get(f)) {
      const d = describe(c, me);
      if (d && d.block) continue;
      if (d) {
        c.label = d.label;
        c.cls = d.cls;
      } else if (c.t === "i32") {
        if (!isValueUse(c.next)) continue;
        if (c.prev && c.prev.op === 0x23) continue; // global.get sp; i32.const N; i32.sub = スタック確保
        if (c.v < 0 && c.next === 0x6b) continue; // ptr - (-N) = ポインタ加算
        if (c.v >= ptrLo && c.v < ptrHi && !isArithUse(c.next)) continue; // アドレス
      }
      editable.push(c);
    }
    if (!editable.length) continue;
    games++;
    if (scan) {
      scan.push({
        method: label,
        // f32 は 9 桁あれば元の値に戻せる（ルールの from に使う）。表示は編集ページ側で丸める
        // named: 意味の分かる数値（おすすめ）。flag は bool（ON/OFF）
        consts: editable.map((c, i) => ({
          i, t: c.t, v: c.t === "f32" ? Number(c.v.toPrecision(9)) : c.v,
          label: c.label || null, named: c.cls === "num" || (!!c.label && !c.cls), flag: c.cls === "flag",
        })),
      });
    }

    editable.forEach((c, i) => {
      // 1. メソッド＋位置を指定したルール（元の値が一致する場合のみ）
      let to;
      const wr = wasmRules.get(label + "#" + i);
      if (wr && (c.t === "f32" ? Math.fround(wr.from) === c.v : wr.from === c.v)) to = wr.to;
      // 2. 値ルール（小数は常に、整数は wasmInt 指定時のみ）
      if (to === undefined) {
        const vr = valueRules.get(c.t === "f32" ? Number(c.v.toPrecision(7)) : c.v);
        if (vr && (c.t !== "i32" || vr.wasmInt)) to = vr.to;
      }
      // 3. ランダム（小数のみ）
      if (to === undefined && random && c.t !== "i32" && isFuzzableFloat(c.v) && Math.random() <= prob) {
        to = c.v * mult;
      }
      if (to === undefined) return;

      if (c.t === "f32") dv.setFloat32(c.off, to, true);
      else if (c.t === "f64") dv.setFloat64(c.off, to, true);
      else {
        const enc = encodeSLeb32(Math.trunc(to), c.len);
        if (enc.length === c.len) bytes.set(enc, c.off);
        else grow.push([c.off, c.len, enc]);
      }
      count++;
    });
  }

  grow.sort((a, b) => a[0] - b[0]);
  const out = grow.length ? rebuildCode(bytes, L.codeIdPos, L.codeEnd, nFuncs, funcsStart, grow) : bytes;
  return { bytes: out, count, games, live: buildLiveTypes(meta, layouts, getters), heapStart: L.stack0 };
}

// ----------------------------------------------------------------
//  実行中の変数一覧（ページ側の liveVars で読み書きする）
//  ゲームの型ごとに、数値・bool のインスタンスフィールドと、
//  そのフィールドを返すゲッター名・その型を参照しているフィールド名（GameManager.playerStatus 等）
// ----------------------------------------------------------------
function buildLiveTypes(meta, layoutRes, getters) {
  const { layouts } = layoutRes;
  const live = new Map();
  const refs = new Map(); // ti -> ["GameManager.playerStatus", …]
  for (const img of meta.images) {
    for (const ty of img.types || []) {
      const lay = layouts.get(ty.ti);
      if (!lay) continue;
      for (const fd of lay.values()) {
        if (fd.kind === 0x12 && !fd.name.startsWith("<")) {
          if (!refs.has(fd.data)) refs.set(fd.data, []);
          refs.get(fd.data).push(`${ty.name}.${fd.name}`);
        }
      }
      if (/^</.test(ty.name)) continue; // コンパイラが作る型（コルーチン等）
      const fields = [];
      const refOffs = [];
      const refFields = []; // 他のゲームオブジェクトを指すフィールド（実行中の名前付けに使う）
      for (const [off, fd] of lay) {
        if (fd.name.startsWith("<")) continue;
        const cls = valueClass(fd.kind);
        if (cls === "ref") {
          // インスタンスの妥当性確認に使う参照（クラス・文字列のみ。配列やジェネリックは
          // クラス名がメタデータ外に作られるので確認に使えない）
          if (fd.kind === 0x12 || fd.kind === 0x0e) refOffs.push(off);
          if (fd.kind === 0x12) refFields.push({ off, name: fd.name, ti: fd.data });
          continue;
        }
        if (fd.kind === 0x11 && fd.size !== 4) continue; // Vector3 等の構造体は対象外（列挙型のみ）
        fields.push({ name: fd.name, off, kind: fd.kind, size: fd.size, getters: [] });
      }
      if (!fields.length) continue;
      live.set(ty.ti, {
        ti: ty.ti, name: ty.name, nameIndex: ty.nameIndex,
        unityObject: layoutRes.unityObject ? layoutRes.unityObject.has(ty.ti) : false,
        fields, refOffs, refFields, refs: [],
      });
    }
  }
  for (const g of getters) {
    const t = live.get(g.type);
    const fd = t && t.fields.find((x) => x.off === g.off);
    if (fd && !fd.getters.includes(g.name)) fd.getters.push(g.name);
  }
  for (const [ti, list] of refs) if (live.has(ti)) live.get(ti).refs = list;
  return [...live.values()];
}

// 長さが変わる置き換えを適用してコードセクションを組み直す
function rebuildCode(bytes, codeIdPos, codeEnd, nFuncs, funcsStart, grow) {
  const parts = [];
  let gi = 0;
  let p = funcsStart;

  function u() {
    let r = 0, s = 0, x;
    do { x = bytes[p++]; r += (x & 127) * 2 ** s; s += 7; } while (x & 128);
    return r;
  }

  const head = Uint8Array.from(encodeULeb(nFuncs));
  parts.push(head);
  let sectionSize = head.length;

  for (let f = 0; f < nFuncs; f++) {
    const sizeStart = p;
    const size = u();
    const bodyStart = p;
    const end = bodyStart + size;
    if (gi >= grow.length || grow[gi][0] >= end) {
      parts.push(bytes.subarray(sizeStart, end));
      sectionSize += end - sizeStart;
    } else {
      const segs = [];
      let cur = bodyStart, bodyLen = 0;
      while (gi < grow.length && grow[gi][0] < end) {
        const [off, len, enc] = grow[gi++];
        segs.push(bytes.subarray(cur, off), Uint8Array.from(enc));
        bodyLen += off - cur + enc.length;
        cur = off + len;
      }
      segs.push(bytes.subarray(cur, end));
      bodyLen += end - cur;
      const sz = Uint8Array.from(encodeULeb(bodyLen));
      parts.push(sz, ...segs);
      sectionSize += sz.length + bodyLen;
    }
    p = end;
  }

  const before = bytes.subarray(0, codeIdPos + 1);
  const secSize = Uint8Array.from(encodeULeb(sectionSize));
  const after = bytes.subarray(codeEnd);
  const out = new Uint8Array(before.length + secSize.length + sectionSize + after.length);
  let o = 0;
  for (const part of [before, secSize, ...parts, after]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

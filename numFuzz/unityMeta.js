// ============================================================
//  NumFuzz - unityMeta.js
//
//  Unity WebGL（IL2CPP）の .data から global-metadata.dat を取り出し、
//  C# のアセンブリ・型・フィールド・メソッド・引数の名前と文字列リテラルを読み出す。
//  wasmFuzz.js はこれを使って
//    - どの wasm 関数がゲームの C# メソッドか
//    - 各定数がどのフィールド・どの API の引数として使われているか（変数名の推定）
//  を求め、名前の分かるゲームコードの定数だけを書き換える。
// ============================================================

"use strict";

const UNITY_WEBDATA_MAGIC = "UnityWebData1.0\0";
const METADATA_PATH = "Il2CppData/Metadata/global-metadata.dat";
// 要約の形式。変えたら上げる（古い形式の storage キャッシュを使わないため）
const META_SCHEMA = 4;

function isUnityWebData(bytes) {
  if (bytes.length < 20) return false;
  for (let i = 0; i < UNITY_WEBDATA_MAGIC.length; i++) {
    if (bytes[i] !== UNITY_WEBDATA_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

// UnityWebData1.0 の中から指定パスのファイルを取り出す
function extractUnityWebDataFile(bytes, path) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const headerSize = dv.getUint32(16, true);
  let p = 20;
  while (p < headerSize) {
    const off = dv.getUint32(p, true);
    const size = dv.getUint32(p + 4, true);
    const nameLen = dv.getUint32(p + 8, true);
    const name = dec.decode(bytes.subarray(p + 12, p + 12 + nameLen));
    p += 12 + nameLen;
    if (name === path) return bytes.subarray(off, off + size);
  }
  return null;
}

// ゲーム本体として扱うアセンブリ（それ以外はエンジン・標準ライブラリ・パッケージとして保護）
function isGameAssembly(name) {
  return /^Assembly-CSharp(-firstpass)?\.dll$/.test(name);
}

// 引数名を表示するエンジン側の型（ゲームから呼ばれる代表的な API）
const API_TYPES = new Set([
  "PlayerPrefs", "Random", "Mathf", "Time", "WaitForSeconds", "WaitForSecondsRealtime",
  "MonoBehaviour", "Object", "GameObject", "Component", "Transform",
  "Vector2", "Vector3", "Vector4", "Vector2Int", "Vector3Int", "Color", "Color32", "Quaternion", "Rect",
  "Rigidbody", "Rigidbody2D", "AudioSource", "Animator", "Animation", "SpriteRenderer", "Camera",
  "Screen", "Application", "Physics", "Physics2D", "Input", "Debug",
  "Image", "Slider", "Text", "TMP_Text", "TextMeshProUGUI", "CanvasGroup", "Graphic",
  "String", "Int32", "Single", "Math", "Convert", "List`1", "Array",
  "DOTween", "ShortcutExtensions", "TweenSettingsExtensions", "DOTweenModuleUI", "DOTweenModuleSprite",
]);

// UnityEngine 名前空間の UnityEngine.Object 系の基底クラス
const UNITY_OBJECT_TYPES = new Set(["Object", "Component", "Behaviour", "MonoBehaviour", "ScriptableObject"]);

// 文字列リテラルは長いものを切り詰めて保存する（表示用）
const LITERAL_MAX = 60;

// ----------------------------------------------------------------
//  レイアウト定義（バージョンごとのレコードサイズ・フィールド位置）
// ----------------------------------------------------------------
function metadataLayout(dv, version) {
  if (version >= 38) {
    // ヘッダーは (offset, size, count) の 3 つ組。インデックスは 2 バイト幅（実測 v39）
    const sec = (k) => ({ off: dv.getUint32(8 + k * 12, true), size: dv.getUint32(12 + k * 12, true), count: dv.getUint32(16 + k * 12, true) });
    const L = {
      literals: sec(0), literalData: sec(1), strings: sec(2), methods: sec(5), params: sec(10), fields: sec(11),
      types: sec(19), images: sec(20), stringsHeaderPos: 8 + 2 * 12,
      literalSize: 4, literalOffsetsOnly: true,
      methodSize: 30, mToken: 18, mFlags: 22, mParamStart: 12, mParamCount: 28,
      paramSize: 10, pType: 8, pTypeW: 2,
      fieldSize: 10, fType: 4, fTypeW: 2,
      typeSize: 76, tParent: 12, tParentW: 2, tFieldStart: 20, tMethodStart: 24, tMethodCount: 52, tFieldCount: 56,
      imageSize: 36, imageTypeStart: 8, imageTypeCount: 10, imageIdxW: 2,
    };
    if (L.methods.size !== L.methods.count * L.methodSize ||
        L.types.size !== L.types.count * L.typeSize ||
        L.images.size !== L.images.count * L.imageSize ||
        L.fields.size !== L.fields.count * L.fieldSize ||
        L.params.size !== L.params.count * L.paramSize) return null;
    return L;
  }
  if (version === 29 || version === 31) {
    // ヘッダーは (offset, size) の 2 つ組。インデックスは 4 バイト固定（未検証: 実物での確認なし）
    const sec = (k) => ({ off: dv.getUint32(8 + k * 8, true), size: dv.getUint32(12 + k * 8, true) });
    const v31 = version === 31;
    const L = {
      literals: sec(0), literalData: sec(1), strings: sec(2), methods: sec(5), params: sec(10), fields: sec(11),
      types: sec(19), images: sec(20), stringsHeaderPos: 8 + 2 * 8,
      literalSize: 8, literalOffsetsOnly: false,
      methodSize: v31 ? 36 : 32, mToken: v31 ? 24 : 20, mFlags: v31 ? 28 : 24,
      mParamStart: v31 ? 16 : 12, mParamCount: v31 ? 34 : 30,
      paramSize: 12, pType: 8, pTypeW: 4,
      fieldSize: 12, fType: 4, fTypeW: 4,
      typeSize: 88, tParent: 16, tParentW: 4, tFieldStart: 32, tMethodStart: 36, tMethodCount: 64, tFieldCount: 68,
      imageSize: 40, imageTypeStart: 8, imageTypeCount: 12, imageIdxW: 4,
    };
    for (const k of ["literals", "methods", "params", "fields", "types", "images"]) {
      const size = { literals: L.literalSize, methods: L.methodSize, params: L.paramSize, fields: L.fieldSize, types: L.typeSize, images: L.imageSize }[k];
      L[k].count = L[k].size / size;
    }
    return L;
  }
  return null;
}

// ----------------------------------------------------------------
//  global-metadata.dat の解析
//  戻り値（要約。storage にキャッシュするので必要なものだけ）:
//  {
//    version, typeDefCount,
//    literals: [string],                      // 文字列リテラル（切り詰め）
//    images: [{
//      name, methodCount,
//      methods?: [{ name, rid, type, static, params, ptypes }],  // ゲームアセンブリ: 全メソッド
//      types?:   [{ ti, name, nameIndex, parent, fields: [{ name, type }] }],  // ゲームアセンブリの型
//      api?:     [{ name, rid, static, params, ptypes }], // エンジン側: API_TYPES のメソッドのみ
//    }],
//  }
//  ※ type / parent / fields[].type / ptypes は Il2CppType の番号（wasm 側の types 配列で解決する）
// ----------------------------------------------------------------
function parseIl2CppMetadata(m) {
  const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
  if (dv.getUint32(0, true) !== 0xfab11baf) return null;
  const version = dv.getInt32(4, true);
  const L = metadataLayout(dv, version);
  if (!L) return null;

  const dec = new TextDecoder();
  const str = (o) => {
    const s = L.strings.off + o;
    let e = s;
    while (e < m.length && m[e] !== 0) e++;
    return dec.decode(m.subarray(s, e));
  };
  const rd = (off, w) => (w === 2 ? dv.getUint16(off, true) : dv.getUint32(off, true));
  const NONE = (w) => (w === 2 ? 0xffff : 0xffffffff);

  // 引数の名前と型（Il2CppType の番号）
  const readParams = (mb) => {
    const start = dv.getUint32(mb + L.mParamStart, true);
    const count = dv.getUint16(mb + L.mParamCount, true);
    const names = [], types = [];
    if (start === 0xffffffff) return { names, types };
    for (let j = start; j < start + count; j++) {
      const pb = L.params.off + j * L.paramSize;
      names.push(str(dv.getUint32(pb, true)));
      types.push(rd(pb + L.pType, L.pTypeW));
    }
    return { names, types };
  };
  const readMethod = (k, typeName, ti) => {
    const mb = L.methods.off + k * L.methodSize;
    const ps = readParams(mb);
    return {
      name: typeName + "." + str(dv.getUint32(mb, true)),
      rid: dv.getUint32(mb + L.mToken, true) & 0xffffff,
      type: ti,
      static: !!(dv.getUint16(mb + L.mFlags, true) & 0x10),
      params: ps.names,
      ptypes: ps.types,
    };
  };

  const images = [];
  const unityObjectTypes = []; // UnityEngine.Object 系の基底クラス（実行中の変数一覧で破棄済みオブジェクトを除くため）
  for (let i = 0; i < L.images.count; i++) {
    const b = L.images.off + i * L.imageSize;
    const name = str(dv.getUint32(b, true));
    const typeStart = rd(b + L.imageTypeStart, L.imageIdxW);
    const typeCount = rd(b + L.imageTypeCount, L.imageIdxW);
    const game = isGameAssembly(name);
    const img = { name, methodCount: 0 };
    if (game) { img.methods = []; img.types = []; } else { img.api = []; }

    for (let t = typeStart; t < typeStart + typeCount; t++) {
      const tb = L.types.off + t * L.typeSize;
      if (tb + L.typeSize > m.length) return null;
      const nameIndex = dv.getUint32(tb, true);
      const typeName = str(nameIndex);
      if (!game && UNITY_OBJECT_TYPES.has(typeName) && str(dv.getUint32(tb + 4, true)) === "UnityEngine") unityObjectTypes.push(t);
      const mStart = dv.getUint32(tb + L.tMethodStart, true);
      const mCount = dv.getUint16(tb + L.tMethodCount, true);
      const hasMethods = mStart !== 0xffffffff && mCount > 0;
      if (hasMethods) img.methodCount += mCount;

      if (game) {
        const fStart = dv.getUint32(tb + L.tFieldStart, true);
        const fCount = dv.getUint16(tb + L.tFieldCount, true);
        const fields = [];
        for (let j = fStart; j < fStart + fCount && fStart !== 0xffffffff; j++) {
          const fb = L.fields.off + j * L.fieldSize;
          fields.push({ name: str(dv.getUint32(fb, true)), type: rd(fb + L.fType, L.fTypeW) });
        }
        const parent = rd(tb + L.tParent, L.tParentW);
        img.types.push({ ti: t, name: typeName, nameIndex, parent: parent === NONE(L.tParentW) ? -1 : parent, fields });
        if (hasMethods) for (let k = mStart; k < mStart + mCount; k++) img.methods.push(readMethod(k, typeName, t));
      } else if (hasMethods && API_TYPES.has(typeName)) {
        for (let k = mStart; k < mStart + mCount; k++) {
          const me = readMethod(k, typeName, t);
          delete me.type;
          img.api.push(me);
        }
      }
    }
    images.push(img);
  }
  if (!images.some((img) => img.methods)) return null;

  // 文字列リテラル
  const literals = [];
  const litCount = L.literals.count;
  for (let i = 0; i < litCount; i++) {
    let s, e;
    if (L.literalOffsetsOnly) {
      // v39: 開始オフセットの累積配列（終端は次の要素）
      s = dv.getUint32(L.literals.off + i * 4, true);
      e = i + 1 < litCount ? dv.getUint32(L.literals.off + (i + 1) * 4, true) : L.literalData.size;
    } else {
      // v29/31: { length, dataIndex }
      const len = dv.getUint32(L.literals.off + i * 8, true);
      s = dv.getUint32(L.literals.off + i * 8 + 4, true);
      e = s + len;
    }
    const text = dec.decode(m.subarray(L.literalData.off + s, L.literalData.off + Math.min(e, s + LITERAL_MAX * 4)));
    literals.push(text.length > LITERAL_MAX ? text.slice(0, LITERAL_MAX) + "…" : text);
  }

  return {
    schema: META_SCHEMA, version, typeDefCount: L.types.count, literals, images, unityObjectTypes,
    // 実行中のメモリ上でメタデータ本体を見つけるための情報（ヘッダー内の文字列セクション位置と値）
    metaSize: m.length, stringsHeaderPos: L.stringsHeaderPos, stringsOff: L.strings.off,
  };
}

// .data（UnityWebData）からメタデータ要約を作る。Unity/IL2CPP でなければ null
function metaFromUnityData(bytes) {
  if (!isUnityWebData(bytes)) return null;
  const meta = extractUnityWebDataFile(bytes, METADATA_PATH);
  return meta ? parseIl2CppMetadata(meta) : null;
}

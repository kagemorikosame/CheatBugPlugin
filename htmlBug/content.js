// ============================================================
//  ChaosMode - content.js
//  WebページのCSS / HTML をランダムに書き換えてカオスにする
// ============================================================

(function () {
  "use strict";

  // ---- ユーティリティ ------------------------------------------------

  const rand = (min, max) => Math.random() * (max - min) + min;
  const randInt = (min, max) => Math.floor(rand(min, max + 1));
  const pick = (arr) => arr[randInt(0, arr.length - 1)];
  const randColor = () =>
    `hsl(${randInt(0, 360)},${randInt(40, 100)}%,${randInt(20, 60)}%)`;

  // ---- カオスレベル設定 (popup.js から変更可) ----------------------
  let chaosLevel = 3; // 1〜5
  let enableCss = true; // CSS書き換え
  let enableText = true; // テキストグリッチ
  let enableShuffle = false; // 要素シャッフル（デフォルト無効）
  let enableBlur = false; // ブラー処理（デフォルト無効）
  let enableImgSwap = true; // 画像差し替え（デフォルト有効）
  let enableJsChaos = false; // JS定数バグ（デフォルト無効）
  let enableAudioChaos = true; // 音声ピッチ・速度ランダム化（デフォルト有効）

  // ---- 音声ピッチ・速度ランダム化設定 --------------------------------
  // 再生速度（ピッチも連動して変化）の変動範囲（<audio>/<video> 要素・
  // Web Audio API 共通、バグレベルが上がるほど極端になる）
  const audioRateRangesByLevel = [
    [0.85, 1.2], // level 1: 穏やか
    [0.7, 1.5], // level 2
    [0.5, 2.0], // level 3
    [0.3, 2.8], // level 4
    [0.15, 4.0], // level 5: 激烈
  ];
  // Web Audio API の detune（セント単位、100=半音1つ分）変動幅
  // playbackRate とは独立してピッチだけを揺らす
  const webAudioDetuneRangeByLevel = [150, 350, 600, 1000, 1800];

  function currentAudioRateRange() {
    return audioRateRangesByLevel[Math.min(Math.max(chaosLevel, 1), 5) - 1];
  }
  function currentWebAudioDetuneRange() {
    return webAudioDetuneRangeByLevel[
      Math.min(Math.max(chaosLevel, 1), 5) - 1
    ];
  }

  // ---- 外部画像差し替え設定 ----------------------------------------
  // 各画像が外部画像に差し替わる確率（0.0〜1.0）
  const externalImgChance = 0.25;
  // 外部画像のベースURL（末尾に ?_=ユニーク値 を付与してキャッシュを回避）
  const externalImgBase = "https://picsum.photos/640/480";

  // ---- CSS カオス処理 -----------------------------------------------

  const cssChaosRules = [
    // 色系
    (el) => {
      el.style.color = randColor();
    },
    (el) => {
      el.style.backgroundColor = randColor();
    },
    (el) => {
      el.style.borderColor = randColor();
    },
    (el) => {
      el.style.outline = `${randInt(1, 8)}px solid ${randColor()}`;
    },

    // サイズ系
    (el) => {
      el.style.fontSize = `${rand(0.3, 4)}em`;
    },
    (el) => {
      el.style.width = `${randInt(10, 300)}%`;
    },
    (el) => {
      el.style.height = `${randInt(10, 500)}px`;
    },
    (el) => {
      el.style.padding = `${randInt(0, 60)}px`;
    },
    (el) => {
      el.style.margin = `${randInt(-30, 80)}px`;
    },
    (el) => {
      el.style.borderWidth = `${randInt(0, 20)}px`;
    },
    (el) => {
      el.style.borderStyle = pick([
        "solid",
        "dashed",
        "dotted",
        "double",
        "groove",
        "ridge",
      ]);
    },
    (el) => {
      el.style.letterSpacing = `${rand(-2, 10)}px`;
    },
    (el) => {
      el.style.lineHeight = `${rand(0.5, 4)}`;
    },

    // 変形系
    (el) => {
      const rotate = rand(-180, 180);
      const scaleX = rand(0.1, 3);
      const scaleY = rand(0.1, 3);
      const skewX = rand(-45, 45);
      const skewY = rand(-45, 45);
      el.style.transform = `rotate(${rotate}deg) scale(${scaleX},${scaleY}) skew(${skewX}deg,${skewY}deg)`;
    },
    (el) => {
      el.style.transformOrigin = `${randInt(0, 100)}% ${randInt(0, 100)}%`;
    },

    // 配置系
    (el) => {
      if (Math.random() < 0.3) {
        el.style.position = pick(["fixed", "absolute", "relative", "sticky"]);
        el.style.top = `${randInt(-200, 100)}vh`;
        el.style.left = `${randInt(-100, 200)}vw`;
        el.style.zIndex = `${randInt(-10, 9999)}`;
      }
    },

    // 透明度 / 表示
    (el) => {
      el.style.opacity = `${rand(0.3, 1)}`;
    },
    (el) => {
      el.style.visibility = Math.random() < 0.1 ? "hidden" : "visible";
    },
    (el) => {
      el.style.overflow = pick(["visible", "hidden", "scroll", "auto"]);
    },

    // フィルター系
    (el) => {
      const blurPx = enableBlur ? rand(0, 8) : 0;
      const bright = rand(0.5, 1.5);
      const contrast = rand(0.5, 2.0);
      const hue = randInt(0, 360);
      const saturate = rand(0, 3);
      el.style.filter = `blur(${blurPx}px) brightness(${bright}) contrast(${contrast}) hue-rotate(${hue}deg) saturate(${saturate})`;
    },
    (el) => {
      el.style.mixBlendMode = pick([
        "normal",
        "multiply",
        "screen",
        "overlay",
        "difference",
        "exclusion",
        "hue",
        "saturation",
        "color",
        "luminosity",
      ]);
    },
  ];

  // ---- HTML 構造カオス処理 ------------------------------------------

  /**
   * 子要素をランダムにシャッフル
   */
  function shuffleChildren(parent) {
    const children = [...parent.children];
    if (children.length < 2) return;
    for (let i = children.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      parent.insertBefore(children[j], children[i]);
    }
  }

  // グリッチ時に混入するカスタムワード一覧
  let glitchWords = [];

  // ---- 数字グリッチ -----------------------------------------------

  /**
   * ページ全体のテキストノードを走査し、数字をランダムに書き換える
   * 対象: 整数(512)、小数(4.35)、カンマ区切り(94,800)
   * SCRIPT/STYLE タグ内と .chaos-spawned 内はスキップ
   */
  function glitchNumbers() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
    );
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      const tag = parent.tagName;
      if (
        tag === "SCRIPT" ||
        tag === "STYLE" ||
        tag === "NOSCRIPT" ||
        tag === "TEXTAREA"
      )
        continue;
      if (parent.closest(".chaos-spawned")) continue;
      if (!/\d/.test(node.textContent)) continue;
      textNodes.push(node);
    }

    for (const tn of textNodes) {
      tn.textContent = tn.textContent.replace(
        // カンマ区切り整数 / 小数 / 整数 にマッチ
        /\d[\d,]*(?:\.\d+)?/g,
        (match) => {
          const num = parseFloat(match.replace(/,/g, ""));
          if (!isFinite(num)) return match;
          const newNum = num * rand(0.05, 20.0);
          if (match.includes(".")) {
            // 小数: 元の小数桁数を維持
            const decimals = match.split(".")[1].length;
            return newNum.toFixed(decimals);
          }
          const rounded = Math.round(newNum);
          if (match.includes(",")) {
            // カンマ区切り: 3桁ごとにカンマを挿入
            return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
          }
          return String(rounded);
        },
      );
    }
  }

  // ---- 画像差し替え -----------------------------------------------

  /**
   * ページ上の画像を差し替える
   * - 一定確率で外部画像に差し替え
   * - 残りはページ内の画像URLをシャッフルして入れ替え
   */
  function swapImages() {
    const imgs = [...document.querySelectorAll("img")].filter(
      (el) => !el.closest(".chaos-spawned") && el.src,
    );
    if (imgs.length === 0) return;

    const shufflePool = [];

    let externalCounter = 0;
    for (const img of imgs) {
      if (Math.random() < externalImgChance) {
        // 外部画像に差し替え（?_= でキャッシュを回避し、画像ごとに異なる写真を取得）
        img.removeAttribute("srcset");
        img.removeAttribute("sizes");
        img.src = `${externalImgBase}?_=${Date.now()}_${externalCounter++}`;
      } else {
        shufflePool.push(img);
      }
    }

    // 残りの画像をURLシャッフルで入れ替え
    if (shufflePool.length < 2) return;

    const srcs = shufflePool.map((img) => img.src);
    const shuffled = [...srcs];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = randInt(0, i - 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // 全要素が偶然元と同じURLになった場合は先頭2枚を強制スワップ
    const allSame = shuffled.every((s, i) => s === srcs[i]);
    if (allSame) {
      [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
    }

    for (let i = 0; i < shufflePool.length; i++) {
      shufflePool[i].removeAttribute("srcset");
      shufflePool[i].removeAttribute("sizes");
      shufflePool[i].src = shuffled[i];
    }
  }

  // ---- 音声ピッチ・速度カオス ---------------------------------------

  /**
   * 音声/動画要素にランダムな再生速度を設定
   * preservesPitch を無効化することで、速度変化にピッチも連動させる
   */
  function glitchAudioElement(el) {
    if (!enableAudioChaos) return;
    const [rMin, rMax] = currentAudioRateRange();
    try {
      el.playbackRate = rand(rMin, rMax);
      el.preservesPitch = false;
      el.mozPreservesPitch = false;
      el.webkitPreservesPitch = false;
    } catch (_) {
      /* 無視 */
    }
  }

  /**
   * Web Audio API (AudioBufferSourceNode) 経由の再生をフックし、
   * playbackRate（速度）と detune（ピッチ）をランダム化する。
   * ゲームなどは <audio> タグを使わず AudioContext.createBufferSource()
   * で直接デコード・再生することが多く、その場合は上記の
   * glitchAudioElement では一切効果がないため、こちらが必要になる。
   * ページの JS 実行コンテキストに注入し、AudioBufferSourceNode.prototype.start
   * を上書きすることで、生成方法（createBufferSource / new コンストラクタ）
   * によらず start() 呼び出し直前に値を設定する。
   */
  function startWebAudioChaos() {
    const [rMin, rMax] = currentAudioRateRange();
    const detuneMax = currentWebAudioDetuneRange();
    injectPageScript(`
(function(){"use strict";
// バグレベルはボタンを押すたびに変わりうるため、レンジは毎回グローバルに書き込み直す
// (start の上書き自体は一度きり、レンジ参照はそこから常に最新値を読む)
window.__chaosModeAudioRange={rMin:${rMin},rMax:${rMax},detuneMax:${detuneMax}};
if(window.__chaosModeAudioActive)return;
window.__chaosModeAudioActive=true;
if(typeof AudioBufferSourceNode==='undefined')return;
var proto=AudioBufferSourceNode.prototype;
var _origStart=proto.start;
proto.start=function(){
  try{
    var r=window.__chaosModeAudioRange||{rMin:0.85,rMax:1.2,detuneMax:150};
    if(this.playbackRate)this.playbackRate.value=r.rMin+Math.random()*(r.rMax-r.rMin);
    if(this.detune)this.detune.value=(Math.random()*2-1)*r.detuneMax;
  }catch(e){}
  return _origStart.apply(this,arguments);
};
console.log('[ChaosMode] 音声カオス(WebAudio)起動');
})();
`);
  }

  let audioChaosStarted = false;

  /**
   * 音声カオス起動
   *   1. 既存の audio / video 要素にランダムなピッチ・速度を適用
   *   2. 再生開始のたびに再ランダム化（play イベントをキャプチャで捕捉）
   *   3. 動的に追加される audio / video 要素も MutationObserver で検知
   *   4. Web Audio API (AudioBufferSourceNode) をフックしてピッチ・速度を変化
   */
  function startAudioChaos() {
    document.querySelectorAll("audio,video").forEach(glitchAudioElement);
    startWebAudioChaos();

    if (audioChaosStarted) return;
    audioChaosStarted = true;

    document.addEventListener(
      "play",
      (e) => {
        if (e.target instanceof HTMLMediaElement) glitchAudioElement(e.target);
      },
      true,
    );

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches?.("audio,video")) glitchAudioElement(node);
          node.querySelectorAll?.("audio,video").forEach(glitchAudioElement);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * テキストノードをランダムにグリッチ化
   * - 文字レベルでグリッチ記号に置換
   * - glitchWords があればランダムな位置にワードを挿入
   */
  function glitchText(el) {
    const glitchChars = "█▓▒░@#$%&!?~^*+=-";
    for (const node of el.childNodes) {
      if (
        node.nodeType === Node.TEXT_NODE &&
        node.textContent.trim().length > 0
      ) {
        // ① 数字の連続部分をランダムな数字に置換（桁数も±変化）
        const numGlitched = node.textContent.replace(/\d+/g, (digits) => {
          const newLen = Math.max(1, digits.length + randInt(-1, 3));
          return (
            String(randInt(1, 9)) +
            Array.from({ length: newLen - 1 }, () =>
              String(randInt(0, 9)),
            ).join("")
          );
        });

        // ② 数字以外の文字をグリッチ記号にランダム置換（数字部分は保護）
        let chars = numGlitched
          .split("")
          .map((c) =>
            /\d/.test(c)
              ? c
              : Math.random() < 0.5
                ? pick(glitchChars.split(""))
                : c,
          );

        // ③ カスタムワードをランダムな位置に挿入（登録があれば約 40 %の確率）
        if (glitchWords.length > 0 && Math.random() < 0.4) {
          const pos = randInt(0, chars.length);
          const word = pick(glitchWords);
          chars.splice(pos, 0, ...word.split(""));
        }

        node.textContent = chars.join("");
      }
    }
  }

  // ---- JS定数カオスフォグ -----------------------------------------

  /**
   * ページのグローバルコンテキストにスクリプトを注入する
   * （content script のサンドボックスを回避してページの window に直接アクセス）
   */
  function injectPageScript(code) {
    const script = document.createElement("script");
    script.textContent = code;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  /**
   * JS定数カオスフォグ起動
   *   1. fetch 傍受: .js ファイルロード時に数値リテラルをランダム書き換え
   *   2. window 上のグローバル数値変数を 300ms ごとにランダム変更
   * カオスレベルに応じて乗算倍率範囲と変異確率を変える
   */
  function startJsChaosFuzz() {
    const multiplierRanges = [
      [0.8, 1.2], // level 1: ±20%
      [0.5, 2.0], // level 2: 半分〜2倍
      [0.2, 3.0], // level 3
      [0.1, 5.0], // level 4
      [0.01, 10.0], // level 5: 激烈
    ];
    const [rMin, rMax] = multiplierRanges[Math.min(chaosLevel, 5) - 1];
    const mutProb = (chaosLevel * 0.02).toFixed(3);

    injectPageScript(`
(function(){"use strict";
if(window.__chaosModeJsActive)return;
window.__chaosModeJsActive=true;
var _rMin=${rMin},_rMax=${rMax},MUTPROB=${mutProb};
function fuzzMult(){return _rMin+Math.random()*(_rMax-_rMin);}
function fuzzNum(n){if(!isFinite(n)||n===0)return n;return n*fuzzMult();}

// ==============================================
// 1. JS ソース数値リテラル書き換え
// ==============================================
function fuzzJsSource(src){
  return src.replace(
    /(?<![A-Za-z0-9_$.])(0x[0-9A-Fa-f]+|\\d+\\.\\d+|\\d+\\.?|\\.\\d+)(?![A-Za-z0-9_$])/g,
    function(m){
      if(m[0]==='0'&&(m[1]==='x'||m[1]==='X'))return m;
      var n=parseFloat(m);
      if(!isFinite(n)||n===0||n===1||n===-1)return m;
      var r=n*fuzzMult();
      return m.indexOf('.')>=0?r.toFixed(6):String(Math.round(r));
    }
  );
}

// JSON オブジェクトの数値を再帰的に変異
function fuzzJsonObj(obj,depth){
  if(depth<=0||obj===null||obj===undefined)return;
  if(Array.isArray(obj)){for(var i=0;i<obj.length;i++)fuzzJsonObj(obj[i],depth-1);return;}
  if(typeof obj!=='object')return;
  var keys=Object.keys(obj);
  for(var i=0;i<keys.length;i++){
    var k=keys[i],v=obj[k];
    if(typeof v==='number'&&isFinite(v)&&v!==0&&v!==1&&v!==-1)obj[k]=fuzzNum(v);
    else fuzzJsonObj(v,depth-1);
  }
}

// ==============================================
// 2. fetch 傍受 (.js / .json 両対応)
// ==============================================
// エンジン本体・フレームワークファイルはスキップ (fuzzing するとエンジン内部が壊れる)
function isEngineFile(url){
  return /cocos2d|physics\.js|jsb-adapter|chunk\.|vendor\.|runtime\.|settings\.[a-z0-9]+\.js|main\.[a-z0-9]+\.js/.test(url.toLowerCase());
}
var _origFetch=window.fetch;
if(typeof _origFetch==='function'){
  window.fetch=function(input,init){
    var url=typeof input==='string'?input:(input&&input.url?String(input.url):'');
    return _origFetch.call(this,input,init).then(function(resp){
      var fname=url.split('/').pop().split('?')[0].toLowerCase();
      if(/\\.js$/.test(fname)&&!isEngineFile(url)){
        return resp.text().then(function(text){
          try{return new Response(fuzzJsSource(text),{status:resp.status,statusText:resp.statusText,headers:resp.headers});}
          catch(e){return new Response(text,{status:resp.status,statusText:resp.statusText,headers:resp.headers});}
        });
      }
      if(/\\.json$/.test(fname)){
        return resp.text().then(function(text){
          try{var o=JSON.parse(text);fuzzJsonObj(o,4);return new Response(JSON.stringify(o),{status:resp.status,statusText:resp.statusText,headers:resp.headers});}
          catch(e){return new Response(text,{status:resp.status,statusText:resp.statusText,headers:resp.headers});}
        });
      }
      return resp;
    });
  };
}

// ==============================================
// 3. XHR 傍受 (responseText ゲッターを上書き)
//    Cocos Creator は XHR でアセットをロードする
// ==============================================
(function(){
  var P=XMLHttpRequest.prototype;
  var _origOpen=P.open;
  P.open=function(m,url){this.__chaosUrl=String(url);return _origOpen.apply(this,arguments);};
  var _rtDesc=Object.getOwnPropertyDescriptor(P,'responseText');
  if(_rtDesc&&_rtDesc.get){
    Object.defineProperty(P,'responseText',{
      get:function(){
        var raw=_rtDesc.get.call(this);
        if(this.readyState!==4||!this.__chaosUrl||typeof raw!=='string'||raw.length===0)return raw;
        if(!this.__chaosFuzzed){
          var fname=this.__chaosUrl.split('/').pop().split('?')[0].toLowerCase();
          if(/\\.js$/.test(fname)&&!isEngineFile(this.__chaosUrl))this.__chaosCached=fuzzJsSource(raw);
          else if(/\\.json$/.test(fname)){
            try{var o=JSON.parse(raw);fuzzJsonObj(o,4);this.__chaosCached=JSON.stringify(o);}
            catch(e){this.__chaosCached=raw;}
          }else this.__chaosCached=raw;
          this.__chaosFuzzed=true;
        }
        return this.__chaosCached;
      },configurable:true
    });
  }
})();

// ==============================================
// 4. eval 傍受 (動的コード生成をキャッチ)
// ==============================================
var _origEval=window.eval;
window.eval=function(code){
  if(typeof code==='string')try{code=fuzzJsSource(code);}catch(e){}
  return _origEval.call(this,code);
};

// ==============================================
// 5. JSON.parse 傍受 (設定・レベルデータをキャッチ)
// ==============================================
var _origJsonParse=JSON.parse;
JSON.parse=function(text){
  var r=_origJsonParse.apply(this,arguments);
  if(r!==null&&typeof r==='object')try{fuzzJsonObj(r,3);}catch(e){}
  return r;
};

// ==============================================
// 6. グローバル変数 + 2階層オブジェクトの定期変異
// ==============================================
var _skip={length:1,outerWidth:1,outerHeight:1,innerWidth:1,innerHeight:1,
  screenX:1,screenY:1,pageXOffset:1,pageYOffset:1,scrollX:1,scrollY:1,
  devicePixelRatio:1,NaN:1,Infinity:1};

function mutateObj(obj,depth){
  if(depth<=0||!obj||typeof obj!=='object')return;
  if(obj===window||obj===document||obj instanceof Node||obj instanceof Function)return;
  // CC 内部オブジェクト (_assembler/_childrenCount/_components 等を持つ) はスキップ
  // これらを書き換えると CC エンジンが null._assembler 等でクラッシュする
  if(typeof obj._assembler!=='undefined'||
    typeof obj._childrenCount!=='undefined'||
    typeof obj._components!=='undefined'||
    typeof obj.__classname__==='string')return;
  var keys;try{keys=Object.keys(obj);}catch(e){return;}
  for(var i=0;i<keys.length;i++){
    var k=keys[i];
    try{
      var v=obj[k];
      if(typeof v==='number'&&isFinite(v)&&v!==0&&v!==1&&Math.random()<MUTPROB)obj[k]=fuzzNum(v);
      else if(depth>1)mutateObj(v,depth-1);
    }catch(e){}
  }
}

function mutateGlobals(){
  var keys;try{keys=Object.getOwnPropertyNames(window);}catch(e){return;}
  for(var i=0;i<keys.length;i++){
    var key=keys[i];
    if(_skip[key])continue;
    if(!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key))continue;
    try{
      var val=window[key];
      if(typeof val==='number'&&isFinite(val)&&val!==0&&val!==1&&Math.random()<MUTPROB){
        var desc=Object.getOwnPropertyDescriptor(window,key);
        if(desc&&desc.writable!==false&&!desc.get)window[key]=fuzzNum(val);
      }else mutateObj(val,2);
    }catch(e){}
  }
}

// ==============================================
// 7. Cocos Creator シーングラフ走査
//    全コンポーネントの数値プロパティを直接変異
// ==============================================
var _ccMutCount=0;
// CC コンポーネント専用変異: '_' 始まりの内部プロパティはスキップ
// (_type/_fillType/_assembler 等の Enum・内部参照を書き換えると CC エンジンがクラッシュする)
function mutateCcComp(comp){
  if(!comp||typeof comp!=='object')return;
  var keys;try{keys=Object.keys(comp);}catch(e){return;}
  for(var i=0;i<keys.length;i++){
    var k=keys[i];
    if(k.charCodeAt(0)===95)continue;  // '_' (charCode 95) = CC 内部プロパティのためスキップ
    try{
      var v=comp[k];
      if(typeof v==='number'&&isFinite(v)&&v!==0&&v!==1&&Math.random()<MUTPROB)comp[k]=fuzzNum(v);
    }catch(e){}
  }
}
function mutateCcNode(node,depth){
  if(!node||depth<=0||_ccMutCount>500)return;
  _ccMutCount++;
  var comps=node._components||[];
  for(var i=0;i<comps.length;i++)mutateCcComp(comps[i]);
  var children=node._children||node.children||[];
  for(var j=0;j<children.length;j++)mutateCcNode(children[j],depth-1);
}
function mutateCcScene(){
  if(!window.cc||!cc.director)return;
  _ccMutCount=0;
  try{
    var scene=cc.director._scene;
    if(!scene&&typeof cc.director.getScene==='function')scene=cc.director.getScene();
    if(scene)mutateCcNode(scene,5);
  }catch(e){}
}

window.__chaosModeJsInterval=setInterval(function(){
  mutateGlobals();
  mutateCcScene();
},300);
console.log('[ChaosMode] JSカオスフォグ起動 range:'+_rMin+'-'+_rMax);
})();
`);
  }

  // ---- メイン カオス適用 -------------------------------------------

  function applyChaosTick() {
    // レベルに応じて対象要素数を決定
    const totalElements = document.querySelectorAll("*").length;
    const maxTargets = Math.min(
      Math.floor(totalElements * (chaosLevel / 5) * 0.3),
      200,
    );

    const allElements = [
      ...document.querySelectorAll(
        "div,p,span,h1,h2,h3,h4,h5,h6,a,button,img,section,article,header,footer,nav,ul,li,table,tr,td,th,input,label",
      ),
    ].filter((el) => !el.closest(".chaos-spawned") && el !== document.body);

    // シャッフルして先頭 maxTargets 個を対象にする
    const targets = allElements
      .sort(() => Math.random() - 0.5)
      .slice(0, maxTargets);

    for (const el of targets) {
      // CSS カオスをランダムな件数適用
      if (enableCss) {
        const ruleCount = randInt(
          1,
          Math.min(chaosLevel + 1, cssChaosRules.length),
        );
        const rules = [...cssChaosRules]
          .sort(() => Math.random() - 0.5)
          .slice(0, ruleCount);
        for (const rule of rules) {
          try {
            rule(el);
          } catch (_) {
            /* 無視 */
          }
        }
      }

      // テキストグリッチ（レベル3以上）
      if (enableText && chaosLevel >= 3 && Math.random() < 0.2) {
        glitchText(el);
      }

      // 子要素シャッフル（レベル3以上）
      if (enableShuffle && chaosLevel >= 3 && Math.random() < 0.7) {
        shuffleChildren(el);
      }
    }

    // 数字グリッチ（ページ全体のテキストノードを対象）
    if (enableText) {
      glitchNumbers();
    }

    // 画像差し替え
    if (enableImgSwap) {
      swapImages();
    }
  }

  // ---- 状態管理 -------------------------------------------------------

  let isApplied = false;

  // 1回だけカオスを適用する（ボタンを押すたびに重ね掛け可能）
  function startChaos(level) {
    chaosLevel = Math.max(1, Math.min(5, level ?? chaosLevel));
    applyChaosTick();
    if (enableJsChaos) startJsChaosFuzz();
    if (enableAudioChaos) startAudioChaos();
    isApplied = true;
  }

  function resetPage() {
    isApplied = false;
    window.location.reload();
  }

  // ---- popup.js / background.js からのメッセージ受信 ---------------

  browser.runtime.onMessage.addListener((msg) => {
    switch (msg.action) {
      case "start":
        if (Array.isArray(msg.words))
          glitchWords = msg.words.filter((w) => w.length > 0);
        if (typeof msg.css === "boolean") enableCss = msg.css;
        if (typeof msg.text === "boolean") enableText = msg.text;
        if (typeof msg.shuffle === "boolean") enableShuffle = msg.shuffle;
        if (typeof msg.blur === "boolean") enableBlur = msg.blur;
        if (typeof msg.imgSwap === "boolean") enableImgSwap = msg.imgSwap;
        if (typeof msg.jsChaos === "boolean") enableJsChaos = msg.jsChaos;
        if (typeof msg.audioChaos === "boolean")
          enableAudioChaos = msg.audioChaos;
        startChaos(msg.level);
        return Promise.resolve({ status: "applied" });
      case "reset":
        resetPage();
        return Promise.resolve({ status: "reset" });
      case "getStatus":
        return Promise.resolve({
          isApplied,
          chaosLevel,
          enableCss,
          enableText,
          enableShuffle,
          enableBlur,
          enableImgSwap,
          enableJsChaos,
          enableAudioChaos,
          glitchWords,
        });
      default:
        return Promise.resolve({ status: "unknown" });
    }
  });
})();

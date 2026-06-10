// ============================================================
//  NumFuzz - content.js  (document_start で実行)
//
//  ネットワークレベルの傍受は background.js の filterResponseData が担当。
//  ここでは background.js が対応できない以下のみフックする：
//    - eval()       ← 動的に生成・実行されるコード
//    - JSON.parse() ← ゲームが動的に読み込む設定データ
//
//  乗数は background.js の _tabState に合わせるため
//  getTabMult メッセージで取得する。
// ============================================================

// センシティブサイト判定（検索エンジン・認証・決済等はグローバル有効でも介入しない）
const _SENSITIVE_RE = /\b(google|googleapis|gstatic|recaptcha|youtube|ytimg|bing|yahoo|duckduckgo|yandex|baidu|naver|ecosia|paypal|stripe|amazon|apple|icloud|microsoft|live\.com|outlook|github|gitlab|twitter|x\.com|facebook|instagram|linkedin|reddit|wikipedia)\b/i;
function _isSensitive(origin) { return _SENSITIVE_RE.test(origin); }

(function () {
  "use strict";

  browser.storage.local.get({
    numFuzzEnabled: false,
    numFuzzSites:   {},
  }).then((s) => {
    const origin  = location.origin;
    const siteOv  = s.numFuzzSites[origin];
    const enabled = siteOv !== undefined ? siteOv : s.numFuzzEnabled;

    if (!enabled || _isSensitive(origin)) {
      console.log("[NumFuzz] 無効 (origin: " + origin + ")");
      return;
    }

    // background.js から同一タブの乗数を取得
    return browser.runtime.sendMessage({ action: "getTabMult" }).then((mult) => {
      if (mult === null || mult === undefined) {
        console.log("[NumFuzz] 乗数取得失敗 - eval/JSON.parse フックをスキップ");
        return;
      }
      injectEvalHooks(mult);
      browser.runtime.sendMessage({ action: "numFuzzReady", mult }).catch(() => {});
    });
  }).catch((e) => console.error("[NumFuzz] エラー:", e));

  // ----------------------------------------------------------------
  //  eval / JSON.parse フックをページコンテキストに注入
  // ----------------------------------------------------------------
  function injectEvalHooks(mult) {
    const el = document.createElement("script");
    el.textContent = `(function(){"use strict";
if(window.__numFuzzEvalHooked)return;
window.__numFuzzEvalHooked=true;
var MULT=${mult};
var _evalN=0,_jpN=0;

console.log('%c[NumFuzz] eval/JSON.parse フック設置 mult='+MULT.toFixed(6),'color:#f9d423;font-weight:bold');

function fuzzSrc(src){
  return src.replace(
    /(?<![A-Za-z0-9_$.\\[])(0x[0-9A-Fa-f]+|\\d+\\.\\d+|\\d+\\.?|\\.\\d+)(?![A-Za-z0-9_$\\]:])/g,
    function(t){
      if(t[0]==='0'&&(t[1]==='x'||t[1]==='X'))return t;
      var n=parseFloat(t);
      if(!isFinite(n)||(t.indexOf('.')<0&&Math.abs(n)<=10))return t;
      var r=n*MULT;
      return t.indexOf('.')>=0?r.toFixed(6):String(Math.round(r));
    }
  );
}
function fuzzObj(o,d){
  if(d<=0||o===null||o===undefined)return;
  if(Array.isArray(o)){for(var i=0;i<o.length;i++)fuzzObj(o[i],d-1);return;}
  if(typeof o!=='object')return;
  for(var k of Object.keys(o)){
    var v=o[k];
    if(typeof v==='number'&&isFinite(v)&&v!==0&&v!==1&&v!==-1)o[k]=v*MULT;
    else fuzzObj(v,d-1);
  }
}

// eval フック
var _origEval=window.eval;
window.eval=function(code){
  if(typeof code==='string'&&code.length>0){
    _evalN++;
    console.log('[NumFuzz] eval #'+_evalN+' 傍受 ('+code.length+'文字)');
    try{code=fuzzSrc(code);}catch(e){console.warn('[NumFuzz] eval書き換えエラー:',e);}
  }
  return _origEval.call(this,code);
};

// JSON.parse フック
var _origJsonParse=JSON.parse;
JSON.parse=function(text){
  var r=_origJsonParse.apply(this,arguments);
  if(r!==null&&typeof r==='object'){
    _jpN++;
    try{fuzzObj(r,5);}catch(e){console.warn('[NumFuzz] JSON.parse書き換えエラー:',e);}
    // ログは多すぎるのでまとめて出力
    if(_jpN<=10||_jpN%50===0)console.log('[NumFuzz] JSON.parse #'+_jpN+' 傍受');
  }
  return r;
};

console.log('[NumFuzz] eval/JSON.parse フック完了');
})();`;
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  }
})();

//  ✅ 傍受可能: ゲームが動的に fetch() / XHR で読む JS・JSON
//              eval() で実行する動的コード / JSON.parse() の戻り値
//  ❌ 傍受不可: HTML の <script src="..."> タグで読む JS
//              (ブラウザのHTMLパーサーが直接読むため JS フックが届かない)
//
//  ★ タイミング問題の対策 ★
//  storage.get() は非同期のため「次回ロード用の乗数」を事前に
//  ストレージに保存しておき、今回のロードでは保存済み乗数を即使用する。
//  ポップアップで設定変更時に次回乗数を新規生成して保存する。
// ============================================================

(function () {
  "use strict";

  const RANGES = [
    [0.9,  1.1 ],
    [0.7,  1.5 ],
    [0.5,  2.0 ],
    [0.2,  5.0 ],
    [0.01, 10.0],
  ];

  function buildHookScript(mult, prob) {
    return `(function(){
"use strict";
if(window.__numFuzzInstalled)return;
window.__numFuzzInstalled=true;

var MULT=${mult};
var PROB=${prob};
var _interceptCount={fetch:0,xhr:0,eval:0,jsonParse:0};

console.log('%c[NumFuzz] ===== 起動 =====','color:#f9d423;font-weight:bold');
console.log('[NumFuzz] 乗数(MULT):', MULT.toFixed(6));
console.log('[NumFuzz] 確率(PROB):', PROB);
console.log('[NumFuzz] ⚠ <script src> タグ経由のJSは傍受できません');

var _pageOrigin=window.location.origin;
function isEngineFile(url){
  return /cocos2d|physics\\.js|jsb-adapter|chunk\\.|vendor\\.|runtime\\.|phaser/.test(url.toLowerCase());
}
function isCrossOrigin(url){
  try{return new URL(url).origin!==_pageOrigin;}catch(e){return false;}
}

var _fuzzedTotal=0;
function fuzzSrc(src, label){
  var before=_fuzzedTotal;
  var out=src.replace(
    /(?<![A-Za-z0-9_$.\\[])(0x[0-9A-Fa-f]+|\\d+\\.\\d+|\\d+\\.?|\\.\\d+)(?![A-Za-z0-9_$\\]:])/g,
    function(t){
      if(t[0]==='0'&&(t[1]==='x'||t[1]==='X'))return t;
      var n=parseFloat(t);
      if(!isFinite(n)||(t.indexOf('.')<0&&Math.abs(n)<=10)||Math.random()>PROB)return t;
      _fuzzedTotal++;
      var r=n*MULT;
      return t.indexOf('.')>=0?r.toFixed(6):String(Math.round(r));
    }
  );
  var changed=_fuzzedTotal-before;
  console.log('[NumFuzz] JS書き換え '+label+' → '+changed+'箇所変更 (合計:'+_fuzzedTotal+')');
  return out;
}

function fuzzObj(o,d,label){
  var before=_fuzzedTotal;
  _fuzzObjInner(o,d);
  var changed=_fuzzedTotal-before;
  if(changed>0)console.log('[NumFuzz] JSON書き換え '+label+' → '+changed+'箇所変更 (合計:'+_fuzzedTotal+')');
  else console.log('[NumFuzz] JSON パス '+label+' → 変更なし');
}
function _fuzzObjInner(o,d){
  if(d<=0||o===null||o===undefined)return;
  if(Array.isArray(o)){for(var i=0;i<o.length;i++)_fuzzObjInner(o[i],d-1);return;}
  if(typeof o!=='object')return;
  var ks=Object.keys(o);
  for(var i=0;i<ks.length;i++){
    var v=o[ks[i]];
    if(typeof v==='number'&&isFinite(v)&&v!==0&&v!==1&&v!==-1){
      o[ks[i]]=v*MULT; _fuzzedTotal++;
    }else _fuzzObjInner(v,d-1);
  }
}

// ---- fetch フック --------------------------------------------------
var _origFetch=window.fetch;
if(typeof _origFetch==='function'){
  window.fetch=function(input,init){
    var url=typeof input==='string'?input:(input&&input.url?String(input.url):'');
    var fname=url.split('/').pop().split('?')[0].toLowerCase();
    return _origFetch.call(this,input,init).then(function(resp){
      var isJs=/\\.js$/.test(fname);
      var isJson=/\\.json$/.test(fname);
      if(!isJs&&!isJson){return resp;}
      if(isCrossOrigin(url)){return resp;} // クロスオリジンはスキップ
      if(isJs&&isEngineFile(url)){return resp;}
      _interceptCount.fetch++;
      console.log('[NumFuzz] fetch 傍受 #'+_interceptCount.fetch+': '+fname+' ('+url.slice(0,80)+')');
      if(isJs){
        return resp.text().then(function(text){
          try{
            var fuzzed=fuzzSrc(text,fname);
            return new Response(fuzzed,{status:resp.status,statusText:resp.statusText,headers:resp.headers});
          }catch(e){
            console.warn('[NumFuzz] fetch JS書き換えエラー:',e);
            return new Response(text,{status:resp.status,statusText:resp.statusText,headers:resp.headers});
          }
        });
      }
      if(isJson){
        return resp.text().then(function(text){
          try{
            var o=JSON.parse(text);
            fuzzObj(o,6,fname);
            return new Response(JSON.stringify(o),{status:resp.status,statusText:resp.statusText,headers:resp.headers});
          }catch(e){
            console.warn('[NumFuzz] fetch JSON書き換えエラー:',e);
            return new Response(text,{status:resp.status,statusText:resp.statusText,headers:resp.headers});
          }
        });
      }
      return resp;
    });
  };
  console.log('[NumFuzz] fetch フック設置 ✅');
}else{
  console.warn('[NumFuzz] fetch フック設置 ❌ (window.fetch が存在しません)');
}

// ---- XHR フック ----------------------------------------------------
(function(){
  var P=XMLHttpRequest.prototype;
  var _origOpen=P.open;
  P.open=function(m,url){this.__nfUrl=String(url);return _origOpen.apply(this,arguments);};
  var _rtDesc=Object.getOwnPropertyDescriptor(P,'responseText');
  if(_rtDesc&&_rtDesc.get){
    Object.defineProperty(P,'responseText',{
      get:function(){
        var raw=_rtDesc.get.call(this);
        if(this.readyState!==4||!this.__nfUrl||typeof raw!=='string'||!raw)return raw;
        if(!this.__nfDone){
          var fname=this.__nfUrl.split('/').pop().split('?')[0].toLowerCase();
          var isJs=/\\.js$/.test(fname);
          var isJson=/\\.json$/.test(fname);
          if(!isCrossOrigin(this.__nfUrl)&&((isJs&&!isEngineFile(this.__nfUrl))||isJson)){
            _interceptCount.xhr++;
            console.log('[NumFuzz] XHR 傍受 #'+_interceptCount.xhr+': '+fname+' ('+this.__nfUrl.slice(0,80)+')');
            if(isJs){
              try{this.__nfVal=fuzzSrc(raw,fname);}
              catch(e){console.warn('[NumFuzz] XHR JS書き換えエラー:',e);this.__nfVal=raw;}
            }else{
              try{var o=JSON.parse(raw);fuzzObj(o,6,fname);this.__nfVal=JSON.stringify(o);}
              catch(e){console.warn('[NumFuzz] XHR JSON書き換えエラー:',e);this.__nfVal=raw;}
            }
          }else{
            if(isJs)console.log('[NumFuzz] XHR スキップ(エンジンファイル): '+fname);
            this.__nfVal=raw;
          }
          this.__nfDone=true;
        }
        return this.__nfVal;
      },configurable:true
    });
    console.log('[NumFuzz] XHR フック設置 ✅');
  }else{
    console.warn('[NumFuzz] XHR フック設置 ❌ (responseText descriptor が取得できません)');
  }
})();

// ---- eval フック ---------------------------------------------------
var _origEval=window.eval;
window.eval=function(code){
  if(typeof code==='string'&&code.length>0){
    _interceptCount.eval++;
    console.log('[NumFuzz] eval 傍受 #'+_interceptCount.eval+' ('+code.length+'文字)');
    try{code=fuzzSrc(code,'eval#'+_interceptCount.eval);}catch(e){console.warn('[NumFuzz] eval書き換えエラー:',e);}
  }
  return _origEval.call(this,code);
};
console.log('[NumFuzz] eval フック設置 ✅');

// ---- JSON.parse フック ---------------------------------------------
var _origJsonParse=JSON.parse;
JSON.parse=function(text){
  var r=_origJsonParse.apply(this,arguments);
  if(r!==null&&typeof r==='object'){
    _interceptCount.jsonParse++;
    try{fuzzObj(r,5,'JSON.parse#'+_interceptCount.jsonParse);}
    catch(e){console.warn('[NumFuzz] JSON.parse書き換えエラー:',e);}
  }
  return r;
};
console.log('[NumFuzz] JSON.parse フック設置 ✅');

console.log('[NumFuzz] 全フック設置完了。動的にfetch/XHRでロードされるファイルを傍受します');
})();`;
  }

  // ================================================================
  //  ストレージから「今回ロード用に事前生成された乗数」を読み込む
  //  → 非同期だが、乗数は前回のポップアップ操作時に生成済みなので
  //    Phase 1 = フック設置（同期）と同時に乗数も即注入できる
  // ================================================================

  browser.storage.local.get({
    numFuzzEnabled:  false,
    numFuzzLevel:    3,
    numFuzzProb:     0.5,
    numFuzzSites:    {},
    numFuzzNextMult: null,   // ポップアップで事前生成した乗数
  }).then((s) => {
    const origin = location.origin;
    const siteOverride = s.numFuzzSites[origin];
    const enabled = siteOverride !== undefined ? siteOverride : s.numFuzzEnabled;

    if (!enabled || _isSensitive(origin)) {
      console.log("[NumFuzz] 無効 (origin: " + origin + ")");
      return;
    }

    // 事前生成乗数があればそれを使う。なければここで生成（初回・移行期）
    let mult = s.numFuzzNextMult;
    if (mult === null || mult === undefined) {
      const [rMin, rMax] = RANGES[Math.min(s.numFuzzLevel, 5) - 1];
      mult = rMin + Math.random() * (rMax - rMin);
      console.log("[NumFuzz] 事前乗数なし → 即時生成: " + mult.toFixed(6));
    } else {
      console.log("[NumFuzz] 事前生成乗数を使用: " + mult.toFixed(6));
    }

    const prob = Number(s.numFuzzProb);

    // 今回の乗数でフック+乗数注入スクリプトを同期的に設置
    const el = document.createElement("script");
    el.textContent = buildHookScript(mult, prob);
    (document.head || document.documentElement).appendChild(el);
    el.remove();

    // 次回ロード用の乗数を新規生成してストレージに保存
    const [rMin, rMax] = RANGES[Math.min(s.numFuzzLevel, 5) - 1];
    const nextMult = rMin + Math.random() * (rMax - rMin);
    browser.storage.local.set({
      numFuzzNextMult:  nextMult,
      numFuzzLastMult:  mult,
      numFuzzLastUrl:   location.href,
    }).then(() => {
      console.log("[NumFuzz] 次回ロード用乗数を保存: " + nextMult.toFixed(6));
    }).catch(() => {});

    // バックグラウンドに通知
    browser.runtime.sendMessage({
      action: "numFuzzReady",
      mult,
      prob,
    }).catch(() => {});

  }).catch((e) => {
    console.error("[NumFuzz] ストレージ読み込みエラー:", e);
  });
})();

//    Phase 1 (同期): document_start で即座にフックを設置
//    Phase 2 (非同期): ストレージから設定を読み込んで乗数を注入
//  → フック設置が常にJSファイル読み込みより先に完了する
// ============================================================

(function () {
  "use strict";

  // ================================================================
  //  Phase 1: フックを【同期的に】即座に設置する
  //  window.__numFuzzMult === null の間はすべてパススルー
  //  設定が読み込まれ次第 __numFuzzMult に乗数がセットされる
  // ================================================================

  const HOOK_SCRIPT = `(function(){
"use strict";
if(window.__numFuzzInstalled)return;
window.__numFuzzInstalled=true;
window.__numFuzzMult=null;
window.__numFuzzProb=1.0;
window.__numFuzzCount=0;

function isEngineFile(url){
  return /cocos2d|physics\\.js|jsb-adapter|chunk\\.|vendor\\.|runtime\\.|phaser/.test(url.toLowerCase());
}
function isCrossOrigin(url){
  try{return new URL(url).origin!==window.location.origin;}catch(e){return false;}
}
function fuzzSrc(src){
  var m=window.__numFuzzMult,p=window.__numFuzzProb;
  if(m===null)return src;
  return src.replace(
    /(?<![A-Za-z0-9_$.\\[])(0x[0-9A-Fa-f]+|\\d+\\.\\d+|\\d+\\.?|\\.\\d+)(?![A-Za-z0-9_$\\]:])/g,
    function(t){
      if(t[0]==='0'&&(t[1]==='x'||t[1]==='X'))return t;
      var n=parseFloat(t);
      if(!isFinite(n)||(t.indexOf('.')<0&&Math.abs(n)<=10)||Math.random()>p)return t;
      window.__numFuzzCount++;
      var r=n*m;
      return t.indexOf('.')>=0?r.toFixed(6):String(Math.round(r));
    }
  );
}
function fuzzObj(o,d){
  var m=window.__numFuzzMult;
  if(m===null||d<=0||o===null||o===undefined)return;
  if(Array.isArray(o)){for(var i=0;i<o.length;i++)fuzzObj(o[i],d-1);return;}
  if(typeof o!=='object')return;
  var ks=Object.keys(o);
  for(var i=0;i<ks.length;i++){
    var v=o[ks[i]];
    if(typeof v==='number'&&isFinite(v)&&v!==0&&v!==1&&v!==-1){
      o[ks[i]]=v*m; window.__numFuzzCount++;
    }else fuzzObj(v,d-1);
  }
}

// fetch フック
var _origFetch=window.fetch;
if(typeof _origFetch==='function'){
  window.fetch=function(input,init){
    var url=typeof input==='string'?input:(input&&input.url?String(input.url):'');
    return _origFetch.call(this,input,init).then(function(resp){
      if(window.__numFuzzMult===null)return resp;
      if(isCrossOrigin(url))return resp; // クロスオリジンはスキップ
      var fname=url.split('/').pop().split('?')[0].toLowerCase();
      if(/\\.js$/.test(fname)&&!isEngineFile(url)){
        return resp.text().then(function(text){
          try{return new Response(fuzzSrc(text),{status:resp.status,statusText:resp.statusText,headers:resp.headers});}
          catch(e){return new Response(text,{status:resp.status,statusText:resp.statusText,headers:resp.headers});}
        });
      }
      if(/\\.json$/.test(fname)){
        return resp.text().then(function(text){
          try{var o=JSON.parse(text);fuzzObj(o,6);return new Response(JSON.stringify(o),{status:resp.status,statusText:resp.statusText,headers:resp.headers});}
          catch(e){return new Response(text,{status:resp.status,statusText:resp.statusText,headers:resp.headers});}
        });
      }
      return resp;
    });
  };
}

// XHR フック
(function(){
  var P=XMLHttpRequest.prototype;
  var _origOpen=P.open;
  P.open=function(m,url){this.__nfUrl=String(url);return _origOpen.apply(this,arguments);};
  var _rtDesc=Object.getOwnPropertyDescriptor(P,'responseText');
  if(_rtDesc&&_rtDesc.get){
    Object.defineProperty(P,'responseText',{
      get:function(){
        var raw=_rtDesc.get.call(this);
        if(this.readyState!==4||!this.__nfUrl||typeof raw!=='string'||!raw)return raw;
        if(!this.__nfDone){
          if(window.__numFuzzMult!==null&&!isCrossOrigin(this.__nfUrl)){
            var fname=this.__nfUrl.split('/').pop().split('?')[0].toLowerCase();
            if(/\\.js$/.test(fname)&&!isEngineFile(this.__nfUrl))
              this.__nfVal=fuzzSrc(raw);
            else if(/\\.json$/.test(fname)){
              try{var o=JSON.parse(raw);fuzzObj(o,6);this.__nfVal=JSON.stringify(o);}
              catch(e){this.__nfVal=raw;}
            }else this.__nfVal=raw;
          }else this.__nfVal=raw;
          this.__nfDone=true;
        }
        return this.__nfVal;
      },configurable:true
    });
  }
})();

// eval フック
var _origEval=window.eval;
window.eval=function(code){
  if(window.__numFuzzMult!==null&&typeof code==='string')try{code=fuzzSrc(code);}catch(e){}
  return _origEval.call(this,code);
};

// JSON.parse フック
var _origJsonParse=JSON.parse;
JSON.parse=function(text){
  var r=_origJsonParse.apply(this,arguments);
  if(window.__numFuzzMult!==null&&r!==null&&typeof r==='object')try{fuzzObj(r,5);}catch(e){}
  return r;
};

console.log('[NumFuzz] フック設置完了 (設定読み込み待機中)');
})();`;

  // Phase 1 を同期的に注入
  const hookEl = document.createElement("script");
  hookEl.textContent = HOOK_SCRIPT;
  (document.head || document.documentElement).appendChild(hookEl);
  hookEl.remove();

  // ================================================================
  //  Phase 2: ストレージから設定を読み込み乗数を注入する（非同期）
  //  フックはすでに設置済みなので、この完了を待たずにJSが
  //  読み込まれても問題ない。乗数がセットされた瞬間から有効になる。
  // ================================================================

  const RANGES = [
    [0.9,  1.1 ],  // level 1: ±10%
    [0.7,  1.5 ],  // level 2
    [0.5,  2.0 ],  // level 3: 半分〜2倍
    [0.2,  5.0 ],  // level 4
    [0.01, 10.0],  // level 5: 激烈
  ];

  browser.storage.local.get({
    numFuzzEnabled: false,
    numFuzzLevel:   3,
    numFuzzProb:    0.5,
    numFuzzSites:   {},
  }).then((s) => {
    const origin = location.origin;
    const siteOverride = s.numFuzzSites[origin];
    const enabled = siteOverride !== undefined ? siteOverride : s.numFuzzEnabled;
    if (!enabled || _isSensitive(origin)) {
      console.log("[NumFuzz] 無効 (origin: " + origin + ")");
      return;
    }

    const [rMin, rMax] = RANGES[Math.min(s.numFuzzLevel, 5) - 1];
    const mult = rMin + Math.random() * (rMax - rMin);
    const prob = Number(s.numFuzzProb);

    // 乗数を page context に注入して有効化
    const cfgEl = document.createElement("script");
    cfgEl.textContent =
      `window.__numFuzzMult=${mult};` +
      `window.__numFuzzProb=${prob};` +
      `console.log('[NumFuzz] 有効化 mult='+${mult.toFixed(6)}.toFixed(4)+' prob='+${prob});`;
    (document.head || document.documentElement).appendChild(cfgEl);
    cfgEl.remove();

    // バックグラウンドに通知
    browser.runtime.sendMessage({
      action: "numFuzzReady",
      mult,
      prob,
    }).catch(() => {});
  }).catch((e) => {
    console.error("[NumFuzz] ストレージ読み込みエラー:", e);
  });
})();

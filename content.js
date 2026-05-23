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
  let enableImgSwap = true; // 画像差る替え（デフォルト有効）

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

  // ---- 画像差る替え -----------------------------------------------

  /**
   * ランダムな彩色図形で構成したSVGをdata URIとして返す
   */
  function randomSvgDataUri(w, h) {
    const bg = randColor();
    const shapes = [];
    const count = randInt(3, 8);
    for (let i = 0; i < count; i++) {
      const fill = randColor();
      const opacity = rand(0.5, 1).toFixed(2);
      const type = pick(["rect", "circle", "ellipse", "polygon"]);
      if (type === "rect") {
        shapes.push(
          `<rect x="${randInt(0, w)}" y="${randInt(0, h)}" width="${randInt(10, w)}" height="${randInt(10, h)}" fill="${fill}" opacity="${opacity}"/>`,
        );
      } else if (type === "circle") {
        const r = randInt(5, Math.max(10, Math.floor(Math.min(w, h) / 2)));
        shapes.push(
          `<circle cx="${randInt(0, w)}" cy="${randInt(0, h)}" r="${r}" fill="${fill}" opacity="${opacity}"/>`,
        );
      } else if (type === "ellipse") {
        shapes.push(
          `<ellipse cx="${randInt(0, w)}" cy="${randInt(0, h)}" rx="${randInt(5, Math.max(6, Math.floor(w / 2)))}" ry="${randInt(5, Math.max(6, Math.floor(h / 2)))}" fill="${fill}" opacity="${opacity}"/>`,
        );
      } else {
        const pts = Array.from(
          { length: randInt(4, 6) },
          () => `${randInt(0, w)},${randInt(0, h)}`,
        ).join(" ");
        shapes.push(
          `<polygon points="${pts}" fill="${fill}" opacity="${opacity}"/>`,
        );
      }
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<rect width="${w}" height="${h}" fill="${bg}"/>` +
      shapes.join("") +
      `</svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  /**
   * ページ上の画像をランダムSVGで差る替える
   */
  function swapImages() {
    const imgs = [...document.querySelectorAll("img")].filter(
      (el) => !el.closest(".chaos-spawned"),
    );
    for (const img of imgs) {
      const w = Math.max(img.naturalWidth || img.offsetWidth || 200, 10);
      const h = Math.max(img.naturalHeight || img.offsetHeight || 150, 10);
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      img.src = randomSvgDataUri(w, h);
    }
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

    // 画像差る替え
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
          glitchWords,
        });
      default:
        return Promise.resolve({ status: "unknown" });
    }
  });
})();

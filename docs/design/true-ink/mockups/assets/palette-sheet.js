/* The palette comparison sheet builds its own specimens.
 *
 * Five bands rendered from one template, so the ONLY difference between them is
 * the `data-palette` attribute on the wrapper. Hand-writing five copies of this
 * markup would guarantee they drifted, and a comparison whose specimens differ
 * in anything but the thing being compared is not a comparison.
 *
 * The contrast figures under each band are read out of the resolved custom
 * properties of that band and computed here, in the browser — so a number cannot
 * disagree with the colour sitting two centimetres above it.
 */
(function () {
  "use strict";

  var DIRS = [
    { id: "", ru: "Тушь", en: "True Ink", tag: "принята 24.08",
      note: "Сцена почти чёрная (L 0.108), высота делается <b>исключительно светлотой</b>: шаг от сцены до приподнятой поверхности — 0.097, вдвое больше, чем у остальных четырёх, потому что на почти-чёрном это единственное, что доступно. Тень там объявлять бессмысленно — под #040405 остаётся четыре единицы, и никакой чёрный их не использует. Поэтому <code>--sh-1</code> сведена к контактной, а край платит светлой волосяной линией сверху. Акцент здесь совпадает с чернилами, и это аргумент, а не экономия: на чёрной сцене самое яркое из доступного — белое, поэтому главная кнопка читается как переключённый тумблер." },
    { id: "ember", ru: "Уголь", en: "Slate & Ember", tag: null,
      note: "Тёплый графит, hue 70 — то, что было до 24 августа. Аргумент был такой: любая дефолтная тёмная тема отдаёт в синий, поэтому тёплое серое — самый дешёвый способ не выглядеть шаблоном. На практике тёплое серое многие читают не как тёплое, а как <b>коричневое</b>, и рядом с зелёным «работает» это даёт землистость, которой никто не просил." },
    { id: "graphite", ru: "Графит", en: "Graphite", tag: null,
      note: "Нейтральный холодный графит, хрома 0.004 — почти ноль. Хром <b>исчезает</b>: единственное цветное на экране — вывод программы и состояние сессии. Это ответ Zed и Xcode, и он безошибочен: невидимый интерфейс невозможно упрекнуть в дурном вкусе. Ровно поэтому же он ничего и не говорит." },
    { id: "steel", ru: "Сталь", en: "Blue Steel", tag: null,
      note: "Холодный синеватый графит и <b>настоящий синий акцент</b> — единственное направление, где у приложения есть свой цвет. Синий не занят ни одним из четырёх сигналов, так что правило «оттенок принадлежит состоянию» не нарушено. Риск честный: это же решение принимает каждая вторая SaaS-панель." },
    { id: "petrol", ru: "Глубина", en: "Deep Petrol", tag: null,
      note: "Тёмное, которое действительно читается как <b>цвет</b>, а не как «не белое»: hue 208, хрома 0.016 — втрое больше, чем у графита. Ни один дефолт этим не занят. Ближе к прибору, чем к редактору." },
  ];


  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  function mini() {
    return '<div class="mini">'
      + '<div class="bar">'
      + '<div class="traffic" aria-hidden="true"><i></i><i></i><i></i></div>'
      + '<nav class="tabs" aria-hidden="true">'
      + '<span class="tab" aria-current="page"><i data-ic="terminal"></i>Terminals</span>'
      + '<span class="tab"><i data-ic="list"></i>Board</span>'
      + '<span class="tabs-ink" style="--x: 46px; --w: 92"></span></nav>'
      + '<span class="bar-spacer"></span>'
      + '<span class="crumb"><span class="dot" style="background: var(--st-working)"></span><span>relay</span>'
      + '<span class="crumb-sep">/</span><span class="crumb-login">acme-dev</span></span>'
      + '<span class="btn--icon"><i data-ic="search"></i></span>'
      + "</div>"
      + '<div class="mini-stage">'
      + '<div class="mini-side">'
      + '<div class="row rail is-working is-selected"><span class="dot" style="background: var(--st-working)"></span>'
      + '<span class="row-main"><span class="row-title">relay</span><span class="row-sub">acme-dev · 12</span></span></div>'
      + '<div class="row rail is-waiting"><span class="dot" style="background: var(--st-waiting)"></span>'
      + '<span class="row-main"><span class="row-title">harbor</span><span class="row-sub">acme-release · 14</span></span></div>'
      + '<div class="row rail is-error"><span class="row-main"><span class="row-title">#128 таймер</span></span>'
      + '<span class="chip-state is-error">error</span></div>'
      + "</div>"
      + '<div class="mini-deck"><div class="tile rail rail--full is-working is-active">'
      + '<div class="tile-head"><span class="tile-name">Retry the refund webhook</span>'
      + '<span class="chip chip--mono"><i data-ic="git-branch"></i>main</span>'
      + '<span class="tile-tokens">↑<b>48.3k</b> ↓6.1k</span>'
      + '<span class="chip-state is-working">working</span>'
      + '<span class="btn--icon"><i data-ic="expand"></i></span></div>'
      + '<div class="tile-body"><div class="term">'
      + '<span class="term-warn">●</span> <span class="term-ink">Bash(cargo test -p webhooks)</span>\n'
      + '  <span class="term-dim">running 12 tests</span>\n'
      + '  <span class="term-ok">ok. 12 passed; 0 failed</span>\n\n'
      + '<span class="term-warn">✳</span> Resetting the backoff on restart\n'
      + '  <span class="term-dim">(21s · ↑2.1k tokens)</span>\n'
      + '<span class="term-cursor"></span></div></div>'
      + "</div></div></div></div>";
  }

  function probe() {
    return '<div class="probe">'
      + '<div class="probe-box"><span class="probe-lab">Состояния</span><div class="probe-row">'
      + '<span class="chip-state is-working">working</span><span class="chip-state is-waiting">needs input</span>'
      + '<span class="chip-state is-error">error</span><span class="chip-state is-ended">ended</span>'
      + '<span class="chip-state is-idle">idle</span></div></div>'
      + '<div class="probe-box"><span class="probe-lab">Действия</span><div class="probe-row">'
      + '<button class="btn btn--primary"><i data-ic="plus"></i> New session</button>'
      + '<button class="btn btn--ghost">Merge</button>'
      + '<button class="btn btn--outline">On GitHub</button>'
      + '<button class="btn btn--quiet">Cancel</button></div></div>'
      + '<div class="probe-box"><span class="probe-lab">Карточка и дифф</span>'
      + '<div class="probe-row" style="margin-bottom: var(--sp-2)"><article class="card rail is-working" style="flex:1">'
      + '<span class="card-title">Retry the refund webhook on a 410</span>'
      + '<span class="meta"><span class="chip"><i data-ic="alert"></i>bug</span>'
      + '<span class="chip" style="color: var(--st-working)"><i data-ic="terminal"></i>in progress</span></span></article></div>'
      + '<div class="dv-file">'
      + '<div class="dv-line"><span class="dv-old">12</span><span class="dv-new">12</span><span class="dv-mark"> </span><span class="dv-text">  try {</span></div>'
      + '<div class="dv-line dv-line--del"><span class="dv-old">13</span><span class="dv-new"></span><span class="dv-mark">−</span><span class="dv-text">    return true;</span></div>'
      + '<div class="dv-line dv-line--add"><span class="dv-old"></span><span class="dv-new">13</span><span class="dv-mark">+</span><span class="dv-text">    return u.protocol === "https:";</span></div>'
      + "</div></div></div>";
  }

  /* ---- Measurement, in the browser ------------------------------------- */
  function parse(v) {
    v = v.trim();
    if (v[0] === "#") {
      var h = v.slice(1);
      if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
    }
    var n = v.slice(v.indexOf("(") + 1, v.lastIndexOf(")")).split(",").map(parseFloat);
    return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
  }
  function over(f, b) { return [0, 1, 2].map(function (i) { return f[3] * f[i] + (1 - f[3]) * b[i]; }).concat(1); }
  function lum(c) {
    var r = [0, 1, 2].map(function (i) {
      var s = c[i] / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2];
  }
  function ratio(el, ink, stack) {
    var cs = getComputedStyle(el);
    var g = parse(cs.getPropertyValue(stack[stack.length - 1]));
    for (var i = stack.length - 2; i >= 0; i--) g = over(parse(cs.getPropertyValue(stack[i])), g);
    var f = parse(cs.getPropertyValue(ink));
    if (f[3] < 1) f = over(f, g);
    var a = lum(f), b = lum(g);
    var hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  var PAIRS = [
    ["чернила на острове", "--fg", ["--bg-island"]],
    ["тихая ступень", "--fg-dim", ["--bg-island"]],
    ["главное действие", "--accent-ink", ["--accent"]],
    ["«ждёт» на выделенном ряду", "--st-waiting", ["--chip-waiting", "--sel", "--bg-island"]],
    ["терминал, обычный текст", "--term-mid", ["--term-bg"]],
  ];

  function numbers(band) {
    var host = band.querySelector(".numbers");
    host.innerHTML = PAIRS.map(function (p) {
      var r = ratio(band, p[1], p[2]);
      var low = r < 4.5;
      return '<div class="number' + (low ? " number--low" : "") + '"><b>' + r.toFixed(2) + "</b><span>" + p[0] + "</span></div>";
    }).join("");
  }

  var host = document.getElementById("bands");
  host.innerHTML = DIRS.map(function (d, i) {
    return '<section class="band"' + (d.id ? ' data-palette="' + d.id + '"' : "") + ' data-od-id="band-' + (d.id || "ember") + '">'
      + '<div class="band-head"><span class="band-num">' + String(i + 1).padStart(2, "0") + "</span>"
      + '<h2 class="band-name">' + d.ru + "</h2>"
      + '<span class="band-en">' + esc(d.en) + "</span>"
      + (d.tag ? '<span class="band-tag">' + d.tag + "</span>" : "")
      + "</div>"
      + '<p class="band-note">' + d.note + "</p>"
      + '<div class="band-grid">' + mini() + probe() + "</div>"
      + '<div class="numbers"></div>'
      + '<div class="band-acts">'
      + '<button class="btn btn--outline" data-try="' + (d.id || "ember") + '"><i data-ic="terminal"></i> Открыть деку в этом направлении</button>'
      + '<button class="btn btn--quiet" data-try="' + (d.id || "ember") + '" data-goto="board.html"><i data-ic="list"></i> И доску</button>'
      + "</div></section>";
  }).join("");

  function measureAll() { Array.prototype.forEach.call(document.querySelectorAll(".band"), numbers); }

  /* The figures are re-read after a theme switch, because half of them change. */
  new MutationObserver(function () { window.setTimeout(measureAll, 300); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-try]");
    if (!b) return;
    try { localStorage.setItem("cowork.deck.v2.palette", b.getAttribute("data-try")); } catch (err) { /* private window */ }
    window.location.href = b.getAttribute("data-goto") || "terminals-deck.html";
  });

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureAll);
  measureAll();
})();

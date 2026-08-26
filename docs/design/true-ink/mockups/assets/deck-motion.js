/* cowork-deck — "Slate & Ember II": the motion and interaction layer.
 *
 * Six primitives, declared once here and used by every screen. The rule they all
 * obey: if a thing changes POSITION or SIZE, it gets there by moving, so a person
 * can follow it. Nothing in this file animates a colour except where the CSS
 * already declares a transition, and nothing animates a box-shadow — doing that
 * on a waiting session once pegged WindowServer for as long as the session
 * waited, which is until somebody acts.
 *
 * No framework, matching the app: cowork-deck's frontend is vanilla TypeScript.
 */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  var LS = "cowork.deck.v2.";

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(LS + key);
      localStorage.setItem(LS + key, value);
    } catch (e) { /* a private window is not an error worth reporting */ }
    return null;
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ==========================================================================
     1 · The appearance switch
     ------------------------------------------------------------------------
     Colour is not normally transitioned — a hover whose ground fades for 300ms
     feels broken — so the transition is armed for exactly one switch by a class
     and then taken away again.
     ====================================================================== */
  function applyTheme(theme, animate) {
    var root = document.documentElement;
    if (animate && !reduced.matches) {
      root.classList.add("theming");
      window.setTimeout(function () { root.classList.remove("theming"); }, 260);
    }
    if (theme === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
    store("theme", theme);
    $$("[data-theme-toggle]").forEach(function (btn) {
      var next = theme === "light" ? "dark" : "light";
      /* The control shows the theme it will GIVE you, and says so in words a
         screen reader can use — an icon-only toggle whose label never changes is
         the commonest way this control lies. */
      btn.setAttribute("aria-label", next === "light" ? "Switch to the light appearance" : "Switch to the dark appearance");
      btn.setAttribute("title", btn.getAttribute("aria-label"));
      var use = btn.querySelector("use");
      if (use) use.setAttribute("href", next === "light" ? "#i-sun" : "#i-moon");
    });
    // The tab ink is measured in pixels, and a theme switch can change a font's
    // metrics, so it is re-measured after the swap rather than left behind.
    window.requestAnimationFrame(placeInk);
  }

  /* ==========================================================================
     2 · The tab ink
     ------------------------------------------------------------------------
     A 2px bar that SLIDES from the tab you left to the tab you are on. It is
     what makes four labels read as one control with a position, rather than as
     four things one of which is lit. Driven by transform, so it composites.
     ====================================================================== */
  function placeInk() {
    $$(".tabs").forEach(function (tabs) {
      var ink = $(".tabs-ink", tabs);
      var active = $('.tab[aria-current="page"]', tabs) || $(".tab.is-active", tabs);
      if (!ink) return;
      if (!active) { ink.style.setProperty("--w", 0); return; }
      var a = active.getBoundingClientRect();
      var b = tabs.getBoundingClientRect();
      ink.style.setProperty("--x", Math.round(a.left - b.left) + "px");
      ink.style.setProperty("--w", Math.max(0, Math.round(a.width)));
    });
  }

  /* ==========================================================================
     3 · The staggered entrance
     ------------------------------------------------------------------------
     `--i` is the child's index, CLAMPED: a fortieth row arriving two seconds
     late is not choreography, it is lag. The cap is the system's --dur-4 budget
     divided by the stagger step, so a list of any length lands inside it.
     ====================================================================== */
  var STAGGER_CAP = 12;
  function stagger(root, one) {
    var boxes = one ? [one] : $$("[data-enter]", root);
    boxes.forEach(function (box) {
      var kids = $$(":scope > *", box).filter(function (el) { return !el.hidden; });
      kids.forEach(function (el, i) {
        el.style.setProperty("--i", Math.min(i, STAGGER_CAP));
        el.classList.add("enter");
        /* The class comes OFF when the animation ends, and that is a correctness
           fix rather than tidiness: `animation-fill-mode: both` keeps the last
           keyframe in force for as long as the class is there, and an animation
           origin outranks an inline style — so a `transform: none` left behind
           here would silently swallow every FLIP transform on this element for
           the rest of the session. */
        el.addEventListener("animationend", function done(e) {
          if (e.target !== el) return;
          el.classList.remove("enter");
          el.style.removeProperty("--i");
          el.removeEventListener("animationend", done);
        });
      });
    });
  }

  /* ==========================================================================
     4 · FLIP
     ------------------------------------------------------------------------
     Measure, mutate, invert, play. Everything on this screen that changes place
     — a card moving column, a tile zooming, a filtered list closing its gaps —
     goes through this one function, which is why they all move alike.
     ====================================================================== */
  function flip(nodes, mutate) {
    if (reduced.matches) { mutate(); return; }
    var first = nodes.map(function (n) { return n.getBoundingClientRect(); });
    mutate();
    nodes.forEach(function (n, i) {
      var last = n.getBoundingClientRect();
      var dx = first[i].left - last.left;
      var dy = first[i].top - last.top;
      /* Scale as well as position, and that is what makes a zoom a MORPH rather
         than a slide: a tile that grows to fill the stage has to be seen growing,
         or the gesture is a cut with a translation stapled to it. Guarded at 2px
         so an ordinary reflow — a card changing column, a filtered row closing a
         gap — stays a pure translate and never resamples its own text. */
      var sx = last.width > 2 ? first[i].width / last.width : 1;
      var sy = last.height > 2 ? first[i].height / last.height : 1;
      var scaled = Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01;
      if (!dx && !dy && !scaled) return;
      n.classList.remove("flipping");
      n.style.transformOrigin = "0 0";
      n.style.transform = "translate3d(" + dx + "px," + dy + "px,0)" + (scaled ? " scale(" + sx + "," + sy + ")" : "");
      // Two frames: one to let the untransitioned transform land, one to play it.
      window.requestAnimationFrame(function () {
        n.classList.add("flipping");
        n.style.transform = "";
        n.addEventListener("transitionend", function done() {
          n.classList.remove("flipping");
          n.style.removeProperty("transform-origin");
          n.removeEventListener("transitionend", done);
        });
      });
    });
  }

  /* ==========================================================================
     5 · Height, animated from a measurement
     ------------------------------------------------------------------------
     Never a `max-height` guess: too small clips the content, too large makes a
     two-line body take the whole duration to arrive.
     ====================================================================== */
  function slideOpen(box) {
    box.hidden = false;
    var h = box.scrollHeight;
    box.style.height = "0px";
    box.classList.add("is-animating");
    window.requestAnimationFrame(function () { box.style.height = h + "px"; });
    box.addEventListener("transitionend", function done(e) {
      if (e.target !== box) return;
      box.classList.remove("is-animating");
      box.style.height = "";
      box.removeEventListener("transitionend", done);
    });
  }
  function slideShut(box, hideAfter) {
    box.style.height = box.scrollHeight + "px";
    box.classList.add("is-animating");
    window.requestAnimationFrame(function () { box.style.height = "0px"; });
    box.addEventListener("transitionend", function done(e) {
      if (e.target !== box) return;
      box.classList.remove("is-animating");
      box.style.height = "";
      if (hideAfter) box.hidden = true;
      box.removeEventListener("transitionend", done);
    });
  }

  /* ==========================================================================
     6 · The rail sweep — the only animation that plays on an EVENT
     ====================================================================== */
  function markChanged(el) {
    if (!el) return;
    el.classList.remove("just-changed");
    void el.offsetWidth;
    el.classList.add("just-changed");
    window.setTimeout(function () { el.classList.remove("just-changed"); }, 700);
  }

  /* --- Toasts: the one thing that reports a completed action -------------- */
  function toast(text, icon) {
    var host = $(".toasts");
    if (!host) {
      host = document.createElement("div");
      host.className = "toasts";
      /* Announced, but not as an alert: finishing a move is news, not an
         emergency, and `alert` interrupts whatever is being read. */
      host.setAttribute("role", "status");
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    var el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-' + (icon || "check") + '"/></svg><span></span>';
    el.querySelector("span").textContent = text;
    host.appendChild(el);
    window.setTimeout(function () {
      el.classList.add("is-leaving");
      window.setTimeout(function () { el.remove(); }, 240);
    }, 2600);
  }

  /* ==========================================================================
     Overlays — dialogs and the palette
     ------------------------------------------------------------------------
     Esc closes, focus goes in and comes back out to where it was, and the exit
     is the entrance played backwards rather than a disappearance.
     ====================================================================== */
  var lastFocus = null;
  function openOverlay(id) {
    var ov = document.getElementById(id);
    if (!ov) return;
    lastFocus = document.activeElement;
    $$(".overlay").forEach(function (o) { if (o !== ov) o.hidden = true; });
    ov.hidden = false;
    ov.classList.remove("is-closing");
    var focusable = $("[data-autofocus]", ov) || $("input, button, textarea, select, [tabindex]", ov);
    if (focusable) focusable.focus();
    document.documentElement.style.setProperty("overflow", "hidden");
  }
  function closeOverlay(ov) {
    ov = ov || $$(".overlay").filter(function (o) { return !o.hidden; })[0];
    if (!ov) return;
    if (reduced.matches) { ov.hidden = true; }
    else {
      ov.classList.add("is-closing");
      window.setTimeout(function () { ov.hidden = true; ov.classList.remove("is-closing"); }, 220);
    }
    document.documentElement.style.removeProperty("overflow");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  /* --- The command palette ---------------------------------------------- */
  function paletteFilter(pal, term) {
    term = term.trim().toLowerCase();
    var shown = 0;
    $$(".palette-item", pal).forEach(function (item) {
      var hit = !term || item.textContent.toLowerCase().indexOf(term) > -1;
      item.hidden = !hit;
      item.setAttribute("aria-selected", "false");
      if (hit) shown++;
    });
    $$(".palette-group", pal).forEach(function (g) {
      var next = g.nextElementSibling, any = false;
      while (next && !next.classList.contains("palette-group")) {
        if (next.classList.contains("palette-item") && !next.hidden) any = true;
        next = next.nextElementSibling;
      }
      g.hidden = !any;
    });
    var none = $(".palette-empty", pal);
    if (none) none.hidden = shown > 0;
    var first = $$(".palette-item", pal).filter(function (i) { return !i.hidden; })[0];
    if (first) first.setAttribute("aria-selected", "true");
  }
  function paletteMove(pal, delta) {
    var items = $$(".palette-item", pal).filter(function (i) { return !i.hidden; });
    if (!items.length) return;
    var at = items.findIndex(function (i) { return i.getAttribute("aria-selected") === "true"; });
    var next = Math.max(0, Math.min(items.length - 1, (at < 0 ? 0 : at) + delta));
    items.forEach(function (i) { i.setAttribute("aria-selected", "false"); });
    items[next].setAttribute("aria-selected", "true");
    /* `scrollIntoView` is off limits here — it breaks the embedded preview — so
       the list is scrolled by arithmetic against its own box. */
    var list = $(".palette-list", pal);
    var r = items[next].getBoundingClientRect(), lr = list.getBoundingClientRect();
    if (r.top < lr.top) list.scrollTop -= (lr.top - r.top) + 8;
    else if (r.bottom > lr.bottom) list.scrollTop += (r.bottom - lr.bottom) + 8;
  }

  /* ==========================================================================
     Wiring
     ====================================================================== */
  /* A palette chosen on the comparison sheet, applied here. There is deliberately
     no control for it inside the product screens: a theme switch is a real app
     setting, but "which candidate palette am I looking at" is a question only the
     design document gets to ask. The sheet opts out with `data-no-palette`,
     because its whole job is showing five of them at once. */
  function applyPalette() {
    if (document.body.hasAttribute("data-no-palette")) return;
    /* BASE is what `deck-ui.css` ships. A stored value naming it means "no
       override", not "an override that happens to match": switching back to the
       shipped palette must REMOVE the attribute, or the document keeps one the
       candidate file no longer declares and every token falls through to
       whatever the cascade found last. */
    var BASE = "ink";
    var p = store("palette");
    if (p && p !== BASE) document.documentElement.setAttribute("data-palette", p);
    else document.documentElement.removeAttribute("data-palette");
  }

  function boot() {
    applyPalette();
    applyTheme(store("theme") === "light" ? "light" : "dark", false);
    stagger(document);
    window.requestAnimationFrame(placeInk);
    window.addEventListener("resize", placeInk);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeInk);

    var here = document.body.getAttribute("data-screen");
    if (here) store("screen", here);

    document.addEventListener("click", function (e) {
      var t = e.target;

      var toggle = t.closest && t.closest("[data-theme-toggle]");
      if (toggle) {
        applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light", true);
        return;
      }

      var opener = t.closest && t.closest("[data-open-overlay]");
      if (opener) { e.preventDefault(); openOverlay(opener.getAttribute("data-open-overlay")); return; }

      var closer = t.closest && t.closest("[data-close-overlay]");
      if (closer) { e.preventDefault(); closeOverlay(closer.closest(".overlay")); return; }

      // A click on the scrim itself, never on the box standing in it.
      if (t.classList && t.classList.contains("overlay")) { closeOverlay(t); return; }

      var group = t.closest && t.closest(".group-head");
      if (group) {
        var body = document.getElementById(group.getAttribute("aria-controls"));
        var open = group.getAttribute("aria-expanded") === "true";
        group.setAttribute("aria-expanded", open ? "false" : "true");
        if (body) { if (open) slideShut(body, true); else slideOpen(body); }
        return;
      }

      var prHead = t.closest && t.closest(".pr-head");
      if (prHead && !(t.closest && t.closest(".pr-acts"))) {
        var row = prHead.closest(".pr-row");
        var wrap = $(".pr-detail-wrap", row);
        var isOpen = row.classList.contains("is-open");
        row.classList.toggle("is-open", !isOpen);
        prHead.setAttribute("aria-expanded", isOpen ? "false" : "true");
        if (wrap) { if (isOpen) slideShut(wrap, false); else slideOpen(wrap); }
        return;
      }

      var f = t.closest && t.closest(".filter");
      if (f && f.hasAttribute("data-filter")) { e.preventDefault(); applyFilter(f); return; }

      var pi = t.closest && t.closest(".palette-item");
      if (pi) { closeOverlay(pi.closest(".overlay")); toast(pi.getAttribute("data-does") || pi.textContent.trim(), pi.getAttribute("data-icon") || "check"); return; }

      var says = t.closest && t.closest("[data-toast]");
      if (says) { toast(says.getAttribute("data-toast"), says.getAttribute("data-toast-icon") || "check"); return; }
    });

    document.addEventListener("keydown", function (e) {
      var pal = document.getElementById("palette");
      var openOv = $$(".overlay").filter(function (o) { return !o.hidden; })[0];

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (openOv === pal) closeOverlay(pal); else openOverlay("palette");
        return;
      }
      if (e.key === "Escape" && openOv) { e.preventDefault(); closeOverlay(openOv); return; }
      if (openOv === pal && pal) {
        if (e.key === "ArrowDown") { e.preventDefault(); paletteMove(pal, 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); paletteMove(pal, -1); }
        else if (e.key === "Enter") {
          var sel = $('.palette-item[aria-selected="true"]', pal);
          if (sel) { e.preventDefault(); sel.click(); }
        }
      }
    });

    var search = $("#palette .palette-search input");
    if (search) search.addEventListener("input", function () { paletteFilter(document.getElementById("palette"), search.value); });

    if (typeof window.deckScreen === "function") window.deckScreen({
      flip: flip, toast: toast, markChanged: markChanged, stagger: stagger,
      slideOpen: slideOpen, slideShut: slideShut, placeInk: placeInk,
      reduced: reduced, store: store, $: $, $$: $$
    });
  }

  /* --- Filters: pressing one re-flows the list, and the rows MOVE -------- */
  function applyFilter(btn) {
    var scope = document.getElementById(btn.getAttribute("data-scope") || "");
    if (!scope) return;
    var group = btn.getAttribute("data-group");
    var want = btn.getAttribute("data-filter");
    if (group) {
      /* Pressing the chip that is already on turns it OFF and falls back to
         everything. On a label filter there is no "all" chip, so this is the
         only way to clear one — and a filter that cannot be cleared is a filter
         that silently hides rows for the rest of the session. The "*" chip is
         exempt: un-pressing it would leave the group with nothing lit and the
         same result, which reads as broken. */
      var off = want !== "*" && btn.getAttribute("aria-pressed") === "true";
      $$('.filter[data-group="' + group + '"]').forEach(function (o) { o.setAttribute("aria-pressed", "false"); });
      if (off) {
        var all = $$('.filter[data-group="' + group + '"]').filter(function (o) { return o.getAttribute("data-filter") === "*"; })[0];
        if (all) all.setAttribute("aria-pressed", "true");
        want = "*";
      } else {
        btn.setAttribute("aria-pressed", "true");
      }
    } else {
      btn.setAttribute("aria-pressed", btn.getAttribute("aria-pressed") === "true" ? "false" : "true");
    }
    var rows = $$("[data-tags]", scope);
    var staying = rows.filter(function (r) { return want === "*" || r.getAttribute("data-tags").split(" ").indexOf(want) > -1; });
    flip(staying, function () {
      rows.forEach(function (r) { r.hidden = staying.indexOf(r) < 0; });
    });
    var n = $("[data-filter-count]");
    if (n) n.textContent = staying.length;
  }

  window.deckUI = { flip: flip, stagger: stagger, toast: toast, markChanged: markChanged, slideOpen: slideOpen, slideShut: slideShut, openOverlay: openOverlay, closeOverlay: closeOverlay, placeInk: placeInk };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

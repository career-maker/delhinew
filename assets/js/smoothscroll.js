/*!
 * SmoothScroll.js: approved master implementation
 * Website Engineering System, Doc 17 section 8.
 *
 * Version: 1.0.0 (approved by the owner 2026-11-06)
 * Original implementation. No dependencies. Not a wrapper around Lenis, Locomotive or any other library.
 *
 * WHAT IT DOES
 *   Mouse-wheel notches ease over 400 ms along a "pulse" curve. Fast repeated notches accelerate.
 *   Everything else stays native: trackpads, touch, keyboard, scrollbar drag, pinch/ctrl-zoom,
 *   horizontal scrolling, nested scrollable elements, dialogs/drawers, locked pages, reduced motion.
 *
 * LOADING (Doc 17 section 8)
 *   <script>window.SmoothScrollOptions = { ... };</script>   // optional, BEFORE the script
 *   <script src="assets/js/smoothscroll.js" defer></script>   // once, before the site's main script
 *
 * CONFIGURATION: window.SmoothScrollOptions (read once at init; unknown keys are ignored)
 *   animationTime      400    ms one wheel notch takes to complete.
 *   stepSize           100    CSS px scrolled per notch (zoom-independent: it is a CSS px value).
 *   accelerationDelta  50     ms. A notch arriving sooner than this after the previous one accelerates.
 *   accelerationMax    3      Largest acceleration multiplier. 1 turns acceleration off.
 *   pulseAlgorithm     true   true: pulse easing curve. false: linear.
 *   pulseScale         4      Steepness of the pulse curve (higher = sharper start).
 *   anchorSupport      true   Smooth-scroll same-page #links using the same curve.
 *   anchorDuration     null   ms for anchor scrolls (null: animationTime).
 *   respectReducedMotion true Stay inactive while prefers-reduced-motion: reduce is set.
 *   trackpadHoldMs     1500   ms after trackpad-like input during which wheel events stay native.
 *   ignoreSelector     see DEFAULTS. Wheel events starting inside a matching element stay native.
 *                      Add data-smoothscroll="off" to any element to opt it out.
 *   debug              false  console.info diagnostics.
 *
 * PUBLIC API: window.SmoothScroll
 *   .version, .active (boolean), .options (resolved copy)
 *   .init()      start (no-op when already running)
 *   .destroy()   stop, remove every listener, cancel animation
 *   .scrollTo(yCssPx, durationMs?)   smooth scroll the page (ignored while reduced motion is on)
 *
 * HOW IT WORKS
 *   - A queue of tweens. Each notch adds one tween {delta, start, last, duration}. Every animation frame
 *     each tween contributes pulse(t / duration) * delta minus what it already contributed, so
 *     overlapping notches blend and fast spinning accelerates.
 *   - Scrolling is written with scrollTo({behavior: "instant"}), so a site rule such as
 *     html { scroll-behavior: smooth } cannot add a second layer of smoothing.
 *   - If the page position differs from where this script last put it (keyboard, scrollbar drag,
 *     find-in-page, another script) the animation is cancelled and native behaviour wins.
 *   - Direction change cancels the queue (immediate reversal, no fighting).
 *   - The wheel listener is non-passive only so it can preventDefault; it returns early, without
 *     preventDefault, for everything listed under "stays native".
 *
 * KNOWN LIMITATIONS (read before relying on it)
 *   1. Browsers do not say whether a wheel event came from a mouse or a trackpad. Detection is a
 *      conservative heuristic: an event is treated as a MOUSE notch only when it is a line-mode
 *      event, or a whole-number pixel-mode event of about one notch (deltaY x devicePixelRatio >= 90;
 *      the legacy wheelDeltaY is deliberately NOT used), and the deltas do not vary between
 *      consecutive events (<60 ms apart). Anything unclear is treated as a trackpad and
 *      left native. Consequences: some mice (notably high-resolution or free-spinning wheels and
 *      macOS mice that report small pixel deltas) are treated as trackpads and scroll natively;
 *      a trackpad whose deltas happen to look like mouse notches can be smoothed until its varying
 *      deltas are seen (first event(s) only). A mouse set to fewer than 3 lines per notch (<90 device px)
 *      is also left native.
 *   2. Firefox and Safari report wheel data differently from Chromium. Verify on real devices.
 *   3. Keyboard scrolling is native by design (it cancels any running animation); it is not smoothed.
 *   4. Wheel events inside cross-origin iframes are never delivered to this page.
 *   5. Zoom: stepSize is in CSS px, so one notch moves the same CSS distance at every zoom level.
 *      Ctrl/Cmd + wheel (zoom gesture) is never intercepted.
 *   6. Scrolling of the document only. Element-level smoothing is out of scope.
 *
 * CHANGELOG
 *   1.0.0  Approved as the canonical master. Behaviour identical to the tested 0.1.0-draft.
 *   0.1.0-draft  Initial implementation.
 *
 * CHECKSUM: see smoothscroll.js.sha256 next to this file (SHA-256 of the exact bytes of this file).
 */
(function (window, document) {
  'use strict';

  if (!window || !document) return;
  if (window.SmoothScroll && window.SmoothScroll.__loaded) {
    if (window.console && window.SmoothScroll.options && window.SmoothScroll.options.debug) {
      console.info('[SmoothScroll] second load ignored');
    }
    return; // never initialise twice
  }

  var VERSION = '1.0.0';

  var DEFAULTS = {
    animationTime: 400,
    stepSize: 100,
    accelerationDelta: 50,
    accelerationMax: 3,
    pulseAlgorithm: true,
    pulseScale: 4,
    anchorSupport: true,
    anchorDuration: null,
    respectReducedMotion: true,
    trackpadHoldMs: 1500,
    ignoreSelector: '[data-smoothscroll="off"], textarea, select, input[type="range"], ' +
      '[role="dialog"], [aria-modal="true"], dialog[open], [role="listbox"], [role="menu"]',
    debug: false
  };

  var opts = {};
  var queue = [];            // active tweens
  var raf = 0;
  var expected = 0;          // page position after this script's last write
  var lastWheelTime = 0;
  var lastDir = 0;
  var lastDeltaY = 0;
  var lastDeltaTime = 0;
  var trackpadUntil = 0;
  var running = false;
  var reducedMq = null;
  var normalize = 1;

  function log() {
    if (opts.debug && window.console) console.info.apply(console, ['[SmoothScroll]'].concat([].slice.call(arguments)));
  }

  function readOptions() {
    var user = window.SmoothScrollOptions || {};
    var out = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
        var v = user[k];
        out[k] = (v === undefined || v === null || (typeof v !== typeof DEFAULTS[k] && DEFAULTS[k] !== null)) ? DEFAULTS[k] : v;
      }
    }
    if (!(out.animationTime > 0)) out.animationTime = DEFAULTS.animationTime;
    if (!(out.stepSize > 0)) out.stepSize = DEFAULTS.stepSize;
    if (!(out.accelerationMax >= 1)) out.accelerationMax = 1;
    if (!(out.pulseScale > 0)) out.pulseScale = DEFAULTS.pulseScale;
    return out;
  }

  /* ---------- easing ---------- */
  function pulseRaw(x) {
    x = x * opts.pulseScale;
    if (x < 1) return x - (1 - Math.exp(-x));
    var start = Math.exp(-1);
    x -= 1;
    return start + (1 - Math.exp(-x)) * (1 - start);
  }
  function ease(p) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    return opts.pulseAlgorithm ? pulseRaw(p) * normalize : p;
  }

  /* ---------- page geometry ---------- */
  function now() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }
  function pageY() {
    return window.pageYOffset || document.documentElement.scrollTop || 0;
  }
  function maxScroll() {
    var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    return Math.max(0, h - document.documentElement.clientHeight);
  }
  function writeY(y) {
    try {
      window.scrollTo({ top: y, left: window.pageXOffset || 0, behavior: 'instant' });
    } catch (e) {
      window.scrollTo(window.pageXOffset || 0, y);
    }
    expected = pageY();
  }
  // true when something has locked page scrolling (drawer / modal pattern)
  function pageLocked() {
    var html = document.documentElement, body = document.body;
    function bad(el) {
      if (!el) return false;
      var cs = window.getComputedStyle(el);
      return cs.overflowY === 'hidden' || cs.overflowY === 'clip' || (el === body && cs.position === 'fixed');
    }
    return bad(html) || bad(body);
  }

  /* ---------- tween loop ---------- */
  function cancel() {
    queue.length = 0;
    if (raf) { window.cancelAnimationFrame(raf); raf = 0; }
  }

  function frame(t) {
    raf = 0;
    if (!queue.length) return;
    var y = pageY();
    if (Math.abs(y - expected) > 2) { log('external scroll, cancelled'); cancel(); return; }

    var sum = 0;
    for (var i = queue.length - 1; i >= 0; i--) {
      var q = queue[i];
      var el = Math.min(Math.max(t - q.start, 0), q.duration);
      var done = Math.round(q.delta * ease(el / q.duration));
      sum += done - q.last;
      q.last = done;
      if (el >= q.duration) queue.splice(i, 1);
    }
    if (sum) writeY(Math.min(Math.max(y + sum, 0), maxScroll()));
    if (queue.length) raf = window.requestAnimationFrame(frame);
  }

  function push(delta, duration) {
    queue.push({ delta: delta, start: now(), last: 0, duration: duration });
    if (!raf) {
      expected = pageY();
      raf = window.requestAnimationFrame(frame);
    }
  }

  /* ---------- wheel ---------- */
  // First scrollable ancestor that can still move in this direction, or an opt-out element.
  // Returns null when the page itself should scroll.
  function nativeOwner(el, dir) {
    var sel = opts.ignoreSelector;
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      if (sel) {
        try { if (el.matches && el.matches(sel)) return el; } catch (e) { sel = ''; }
      }
      var cs = window.getComputedStyle(el), oy = cs.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1) {
        if (dir > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // Conservative: true only for clear mouse-wheel notches.
  function looksLikeMouse(e, t) {
    var dy = e.deltaY, mouse;
    if (e.deltaMode === 1 || e.deltaMode === 2) {
      mouse = true; // line / page mode
    } else {
      // pixel mode: a notch is ~100 device px (deltaY * devicePixelRatio stays ~100 at any browser zoom);
      // small pixel deltas are what trackpads and macOS mice send, so they stay native
      var devPx = Math.abs(dy) * (window.devicePixelRatio || 1);
      mouse = devPx >= 90 && Math.abs(dy - Math.round(dy)) < 0.01;
    }
    // trackpads and inertia emit streams of changing magnitudes; mouse notches are identical
    if (t - lastDeltaTime < 60 && lastDeltaY !== 0 && Math.abs(dy) !== Math.abs(lastDeltaY)) {
      trackpadUntil = t + opts.trackpadHoldMs;
    }
    lastDeltaY = dy;
    lastDeltaTime = t;
    return mouse && t >= trackpadUntil;
  }

  function onWheel(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) { return; }
    var dy = e.deltaY, dx = e.deltaX;
    if (!dy || Math.abs(dx) > Math.abs(dy)) return;

    var t = now();
    if (!looksLikeMouse(e, t)) { cancel(); return; }

    var dir = dy > 0 ? 1 : -1;
    if (nativeOwner(e.target, dir)) { cancel(); return; }
    if (pageLocked()) { cancel(); return; }

    var y = raf ? expected : pageY();
    var pending = 0;
    for (var i = 0; i < queue.length; i++) pending += queue[i].delta - queue[i].last;
    var max = maxScroll();
    var projected = y + pending;
    if ((dir > 0 && projected >= max - 0.5) || (dir < 0 && projected <= 0.5)) {
      // already at the end: let the browser handle it (scroll chaining, overscroll, pull to refresh)
      if (!queue.length) return;
      e.preventDefault();
      return;
    }

    if (dir !== lastDir) cancel();
    lastDir = dir;

    var notches = e.deltaMode === 1 ? Math.max(1, Math.round(Math.abs(dy) / 3)) :
      e.deltaMode === 2 ? 5 : Math.max(1, Math.min(5, Math.round(Math.abs(dy) * (window.devicePixelRatio || 1) / 100)));
    var factor = 1;
    var elapsed = t - lastWheelTime;
    if (opts.accelerationMax > 1 && elapsed < opts.accelerationDelta && elapsed > 0) {
      factor = Math.min((1 + opts.accelerationDelta / elapsed) / 2, opts.accelerationMax);
    }
    lastWheelTime = t;

    var delta = dir * notches * opts.stepSize * factor;
    var room = dir > 0 ? max - projected : projected; // never queue past the ends
    if (Math.abs(delta) > room) delta = dir * room;

    e.preventDefault();
    push(delta, opts.animationTime);
  }

  /* ---------- anchors ---------- */
  function cssPx(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  function onClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.target && a.target !== '_self' || a.hasAttribute('download')) return;
    if (a.closest('[data-smoothscroll="off"]')) return;
    var u;
    try { u = new URL(a.href, window.location.href); } catch (err) { return; }
    if (u.origin !== window.location.origin || u.pathname !== window.location.pathname ||
        u.search !== window.location.search || !u.hash || u.hash === '#') return;
    var id;
    try { id = decodeURIComponent(u.hash.slice(1)); } catch (err2) { id = u.hash.slice(1); }
    var target = document.getElementById(id) || document.querySelector('[name="' + id.replace(/"/g, '\\"') + '"]');
    if (!target || pageLocked()) return;

    e.preventDefault();
    var padTop = cssPx(window.getComputedStyle(document.documentElement).scrollPaddingTop);
    var margin = cssPx(window.getComputedStyle(target).scrollMarginTop);
    var dest = Math.min(Math.max(target.getBoundingClientRect().top + pageY() - padTop - margin, 0), maxScroll());
    glide(dest, opts.anchorDuration || opts.animationTime);

    if (window.location.hash !== u.hash && window.history && history.pushState) history.pushState(null, '', u.hash);
    if (!target.hasAttribute('tabindex') && !/^(a|button|input|select|textarea)$/i.test(target.tagName)) {
      target.setAttribute('tabindex', '-1');
    }
    try { target.focus({ preventScroll: true }); } catch (err3) { /* ignore */ }
  }

  function glide(y, duration) {
    cancel();
    var delta = Math.round(y - pageY());
    if (delta) { lastDir = delta > 0 ? 1 : -1; push(delta, duration); }
  }

  /* ---------- cancel on anything that is not the wheel ---------- */
  function onNativeInput() { cancel(); }
  function onKey(e) {
    if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| |Spacebar)$/.test(e.key)) cancel();
  }
  function onVisibility() { if (document.hidden) cancel(); }

  /* ---------- lifecycle ---------- */
  var listeners = [];
  function on(target, type, fn, o) {
    target.addEventListener(type, fn, o);
    listeners.push([target, type, fn, o]);
  }

  function start() {
    if (running) return;
    running = true;
    on(window, 'wheel', onWheel, { passive: false });
    on(window, 'keydown', onKey, true);
    on(window, 'mousedown', onNativeInput, true);   // scrollbar drag, text selection
    on(window, 'touchstart', onNativeInput, { passive: true, capture: true });
    on(window, 'pagehide', onNativeInput);
    on(document, 'visibilitychange', onVisibility);
    if (opts.anchorSupport) on(document, 'click', onClick);
    API.active = true;
    log('started');
  }

  function stop() {
    cancel();
    while (listeners.length) {
      var l = listeners.pop();
      l[0].removeEventListener(l[1], l[2], l[3]);
    }
    running = false;
    API.active = false;
    log('stopped');
  }

  function reducedMotion() {
    return !!(opts.respectReducedMotion && reducedMq && reducedMq.matches);
  }
  function onReducedChange() { if (reducedMotion()) stop(); else if (!API.__destroyed) start(); }

  function init() {
    if (running) return;
    API.__destroyed = false;
    try {
      opts = readOptions();
      API.options = opts;
      var n = pulseRaw(1);
      normalize = n > 0 ? 1 / n : 1;
      if (!('onwheel' in window) || !window.requestAnimationFrame) { log('unsupported browser, staying native'); return; }
      reducedMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      if (reducedMq) {
        if (reducedMq.addEventListener) reducedMq.addEventListener('change', onReducedChange);
        else if (reducedMq.addListener) reducedMq.addListener(onReducedChange);
      }
      if (!reducedMotion()) start();
    } catch (err) {
      stop();
      if (window.console) console.warn('[SmoothScroll] init failed, native scrolling kept', err);
    }
  }

  function destroy() {
    API.__destroyed = true;
    stop();
    if (reducedMq) {
      if (reducedMq.removeEventListener) reducedMq.removeEventListener('change', onReducedChange);
      else if (reducedMq.removeListener) reducedMq.removeListener(onReducedChange);
      reducedMq = null;
    }
  }

  var API = {
    __loaded: true,
    __destroyed: false,
    version: VERSION,
    active: false,
    options: DEFAULTS,
    init: init,
    destroy: destroy,
    scrollTo: function (y, duration) {
      if (reducedMotion() || !running) { window.scrollTo(0, y); return; }
      glide(Math.min(Math.max(+y || 0, 0), maxScroll()), duration > 0 ? duration : opts.animationTime);
    }
  };
  window.SmoothScroll = API;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window, document);

(function () {
  'use strict';

  var THEME_KEY = 'zyphora-theme';
  var MODES = ['light', 'dark', 'system'];

  function readMode() {
    try {
      var stored = localStorage.getItem(THEME_KEY);
      return MODES.indexOf(stored) === -1 ? 'system' : stored;
    } catch (e) {
      return 'system';
    }
  }

  function writeMode(mode) {
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* ignore */ }
  }

  function resolve(mode) {
    if (mode === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return mode;
  }

  function applyMode(mode) {
    var resolved = resolve(mode);
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-mode', mode);
  }

  function updateButton(button, mode) {
    var isDark = resolve(mode) === 'dark';
    button.setAttribute('aria-checked', isDark ? 'true' : 'false');
    var label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }

  function initThemeToggle() {
    var button = document.querySelector('.theme-toggle');
    if (!button) return;

    var mode = readMode();
    applyMode(mode);
    updateButton(button, mode);

    button.addEventListener('click', function () {
      // Flip relative to what's currently rendered, so a 'system' user on a dark OS
      // toggling once lands on 'light' (matching what they see), not 'dark'.
      mode = resolve(mode) === 'dark' ? 'light' : 'dark';
      writeMode(mode);
      applyMode(mode);
      updateButton(button, mode);
    });

    var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    var onSystemChange = function () {
      if (mode === 'system') {
        applyMode(mode);
        updateButton(button, mode);
      }
    };
    if (darkQuery.addEventListener) {
      darkQuery.addEventListener('change', onSystemChange);
    } else if (darkQuery.addListener) {
      darkQuery.addListener(onSystemChange);
    }
  }

  function initNavToggle() {
    var toggle = document.querySelector('.nav-toggle');
    var nav = document.getElementById('primary-nav');
    if (!toggle || !nav) return;

    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
      document.body.classList.toggle('nav-open', open);
    };

    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') === 'true';
      setOpen(!open);
    });

    nav.addEventListener('click', function (event) {
      if (event.target instanceof HTMLAnchorElement) setOpen(false);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setOpen(false);
    });

    var desktopQuery = window.matchMedia('(min-width: 720px)');
    desktopQuery.addEventListener('change', function () {
      if (desktopQuery.matches) setOpen(false);
    });
  }

  function init() {
    initThemeToggle();
    initNavToggle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
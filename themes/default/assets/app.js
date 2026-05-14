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

  function initPostTabs() {
    var tablist = document.querySelector('.post-tabs[role="tablist"]');
    var track = document.querySelector('.post-tabs-track');
    if (!tablist || !track) return;

    var tabs = Array.prototype.slice.call(tablist.querySelectorAll('button[role="tab"]'));
    if (tabs.length === 0) return;

    var panels = {};
    Array.prototype.forEach.call(track.querySelectorAll('[role="tabpanel"]'), function (panel) {
      panels[panel.getAttribute('data-category')] = panel;
    });

    function activate(category, focusTab) {
      track.setAttribute('data-active', category);
      tabs.forEach(function (tab) {
        var isActive = tab.getAttribute('data-category') === category;
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tab.setAttribute('tabindex', isActive ? '0' : '-1');
        tab.classList.toggle('is-active', isActive);
        if (isActive && focusTab) tab.focus();
      });
      Object.keys(panels).forEach(function (key) {
        if (key === category) {
          panels[key].removeAttribute('aria-hidden');
        } else {
          panels[key].setAttribute('aria-hidden', 'true');
        }
      });
    }

    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () {
        activate(tab.getAttribute('data-category'), false);
      });
      tab.addEventListener('keydown', function (event) {
        var nextIndex = null;
        switch (event.key) {
          case 'ArrowLeft':
            nextIndex = (index - 1 + tabs.length) % tabs.length;
            break;
          case 'ArrowRight':
            nextIndex = (index + 1) % tabs.length;
            break;
          case 'Home':
            nextIndex = 0;
            break;
          case 'End':
            nextIndex = tabs.length - 1;
            break;
          default:
            return;
        }
        event.preventDefault();
        activate(tabs[nextIndex].getAttribute('data-category'), true);
      });
    });
  }

  function initSiteSearch() {
    var form = document.querySelector('.site-search');
    if (!form) return;
    var toggle = form.querySelector('.site-search-toggle');
    var input = form.querySelector('.site-search-input');
    if (!toggle || !input) return;

    // Treat an already-filled value (e.g. landed on /search?q=foo) as "open",
    // so the user sees their query without having to click the icon.
    var startOpen = input.value.trim().length > 0;

    function setOpen(open) {
      form.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Search' : 'Open search');
      input.setAttribute('tabindex', open ? '0' : '-1');
      if (open) {
        // Wait one frame so the width transition can run before focus snaps in.
        requestAnimationFrame(function () { input.focus(); });
      } else {
        // Clear text on close so the next open starts fresh, unless the user
        // explicitly navigated here with a query.
        if (document.activeElement === input) input.blur();
      }
    }

    setOpen(startOpen);

    toggle.addEventListener('click', function (event) {
      // While closed the icon is purely a toggle; while open we let the
      // button act as the form's submit so a click runs the search.
      var open = form.classList.contains('is-open');
      if (!open) {
        event.preventDefault();
        setOpen(true);
        return;
      }
      // Open with empty input: collapse instead of submitting nothing.
      if (input.value.trim().length === 0) {
        event.preventDefault();
        setOpen(false);
      }
    });

    // Esc collapses; click outside collapses (but not when the click landed
    // inside the form, otherwise the toggle/input would close on their own clicks).
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && form.classList.contains('is-open')) {
        setOpen(false);
        toggle.focus();
      }
    });
    document.addEventListener('click', function (event) {
      if (!form.classList.contains('is-open')) return;
      if (form.contains(event.target)) return;
      if (input.value.trim().length > 0) return; // keep open while there's a query
      setOpen(false);
    });
  }

  function init() {
    initThemeToggle();
    initNavToggle();
    initPostTabs();
    initSiteSearch();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
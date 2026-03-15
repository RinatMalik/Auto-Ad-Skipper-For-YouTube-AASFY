// content.js
//
// This script runs on YouTube pages and is responsible for:
// 1) reading extension settings,
// 2) detecting when an ad is currently showing,
// 3) finding the most likely "Skip" control,
// 4) attempting a robust click sequence,
// 5) retrying when YouTube delays enablement of the skip button.
(() => {
  // Build serial to help confirm the loaded extension version in logs/UI.
  const BUILD_SERIAL = 'AASFY-PR-2026-03-15-06';

  // Storage keys used across popup + content script.
  const STORAGE_KEYS = {
    activationState: 'activationState',
    debugMode: 'debugMode',
    customSkipIdentifiers: 'customSkipIdentifiers'
  };

  // Default settings used when a key does not yet exist in storage.
  const DEFAULTS = {
    activationState: 'active',
    debugMode: false,
    customSkipIdentifiers: []
  };

  // Known skip-button selectors that YouTube has used historically.
  const DEFAULT_SELECTORS = [
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button',
    '.ytp-ad-skip-button-container',
    'button[aria-label*="Skip" i]'
  ];

  const AD_UI_CONTAINERS = ['#movie_player.ad-showing', '.video-ads.ytp-ad-module', '.ytp-ad-player-overlay', '.ytp-ad-module'];

  // Multi-language keywords and common phrases used in skip controls.
  const DEFAULT_TEXT_PATTERNS = ['skip', 'skip ad', 'skip ads', 'saltar', 'überspringen', 'ignorer', '跳过'];

  // Timing controls to avoid over-clicking and to support short retries.
  const CLICK_DEBOUNCE_MS = 1200;
  const RETRY_AFTER_CLICK_MS = 650;
  const HUMANIZED_CLICK_DELAY_MIN_MS = 120;
  const HUMANIZED_CLICK_DELAY_MAX_MS = 260;
  const GRID_SWEEP_STEP_PX = 100;

  // Runtime state cache.
  const state = {
    active: DEFAULTS.activationState === 'active',
    debugMode: DEFAULTS.debugMode,
    customSkipIdentifiers: [],
    intervalId: null,
    observer: null,
    observerQueued: false,
    pendingClickTimeoutId: null,
    pendingClickTarget: null,
    lastClickTimestamp: 0
  };

  // Debug logger (active only when debugMode is enabled from popup).
  const debugLog = (...parts) => {
    if (!state.debugMode) {
      return;
    }

    console.log('[AASFY DEBUG]', ...parts);
  };

  // Normalizes custom selector/text entries provided by the user.
  const sanitizeCustomIdentifiers = (value) => {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
      .slice(0, 25);
  };

  // True only when an element is visually and geometrically visible.
  const isElementVisible = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.pointerEvents !== 'none' &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  // True only when an element appears actionable (disabled states only).
  const isElementEnabled = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const isDisabledByAttr = element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
    const hasDisabledClass = (element.className || '').toString().toLowerCase().includes('disabled');

    return !isDisabledByAttr && !hasDisabledClass;
  };

  // Finds nearest clickable ancestor because text spans are often nested.
  const getClickableElement = (element) => {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    return element.closest('button, [role="button"]') || element;
  };

  // Helper to safely check visibility of any CSS selector.
  const isSelectorVisible = (selector) => {
    try {
      return [...document.querySelectorAll(selector)].some((element) => isElementVisible(element));
    } catch (error) {
      debugLog('Selector visibility check failed:', selector, error?.message || error);
      return false;
    }
  };

  // Skip controls should count only when they are in known ad UI containers.
  const isSelectorVisibleInAdUi = (selector) => {
    try {
      return [...document.querySelectorAll(selector)].some((element) => isElementVisible(element) && isInsideAdUi(element));
    } catch (error) {
      debugLog('Ad-UI selector visibility check failed:', selector, error?.message || error);
      return false;
    }
  };

  // Reads multiple ad-related UI indicators to reduce false positives.
  const getAdSignals = () => {
    const moviePlayerAdShowing = Boolean(document.querySelector('#movie_player.ad-showing'));
    const adModuleVisible = isSelectorVisible('.video-ads.ytp-ad-module');
    const adOverlayVisible = isSelectorVisible('.ytp-ad-player-overlay');
    const adPreviewVisible = isSelectorVisible('.ytp-ad-preview-container');
    const adBadgeVisible = isSelectorVisible('.ytp-ad-text, .ytp-ad-simple-ad-badge');
    const skipControlVisible = DEFAULT_SELECTORS.some((selector) => isSelectorVisibleInAdUi(selector));
    const adContainerVisible = AD_UI_CONTAINERS.some((selector) => isSelectorVisible(selector));

    return {
      moviePlayerAdShowing,
      adModuleVisible,
      adOverlayVisible,
      adPreviewVisible,
      adBadgeVisible,
      skipControlVisible,
      adContainerVisible
    };
  };

  // Final ad-likelihood decision used to gate skip attempts.
  const isAdLikelyShowing = (signals = getAdSignals()) => {
    // Use strong positive signals first; avoid false positives from generic overlays alone.
    return Boolean(
      signals.moviePlayerAdShowing ||
        signals.adModuleVisible ||
        signals.adOverlayVisible ||
        signals.adPreviewVisible ||
        signals.adBadgeVisible ||
        (signals.skipControlVisible && signals.adContainerVisible)
    );
  };

  // Ensures candidate controls are part of known ad-related UI zones.
  const isInsideAdUi = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.closest('.ytp-ad-skip-button-container, .video-ads, .ytp-ad-player-overlay, .ytp-ad-module')) {
      return true;
    }

    const adShowingPlayer = document.querySelector('#movie_player.ad-showing');
    return Boolean(adShowingPlayer && adShowingPlayer.contains(element));
  };

  // Collects searchable text from visible label sources.
  const getElementText = (element) => {
    const rawText = [
      element.textContent || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || ''
    ].join(' ');

    return rawText.trim().toLowerCase();
  };

  // Selector-based candidate discovery.
  const collectSelectorCandidates = (selectors) => {
    const candidates = [];

    selectors.forEach((selector) => {
      try {
        const nodes = document.querySelectorAll(selector);
        nodes.forEach((node) => candidates.push({ element: node, source: 'selector' }));
      } catch (error) {
        debugLog('Invalid selector ignored:', selector, error?.message || error);
      }
    });

    return candidates;
  };

  // Text/semantic candidate discovery for evolving YouTube markup.
  const collectSemanticCandidates = (patterns) => {
    const semanticCandidates = [];
    const clickableElements = document.querySelectorAll('button, [role="button"], .ytp-button');

    clickableElements.forEach((element) => {
      if (!isElementVisible(element)) {
        return;
      }

      const text = getElementText(element);
      if (!text) {
        return;
      }

      const matchesPattern = patterns.some((pattern) => text.includes(pattern));
      if (matchesPattern) {
        semanticCandidates.push({ element, source: 'semantic' });
      }
    });

    return semanticCandidates;
  };

  // Candidate ranking engine that picks the strongest skip target.
  const findSkipTarget = () => {
    const normalizedCustomIdentifiers = sanitizeCustomIdentifiers(state.customSkipIdentifiers);
    const selectorCandidates = [
      ...collectSelectorCandidates(DEFAULT_SELECTORS),
      ...collectSelectorCandidates(normalizedCustomIdentifiers)
    ];

    const textPatterns = [...DEFAULT_TEXT_PATTERNS, ...normalizedCustomIdentifiers.map((entry) => entry.toLowerCase())];
    const semanticCandidates = collectSemanticCandidates(textPatterns);
    const deduplicated = new Map();

    [...selectorCandidates, ...semanticCandidates].forEach((candidate) => {
      const clickable = getClickableElement(candidate.element);
      if (!clickable || !isElementVisible(clickable) || !isInsideAdUi(clickable)) {
        return;
      }

      if (!deduplicated.has(clickable)) {
        deduplicated.set(clickable, { source: candidate.source, score: 0 });
      }

      const meta = deduplicated.get(clickable);
      const text = getElementText(clickable);
      const classText = (clickable.className || '').toString().toLowerCase();

      if (candidate.source === 'selector') {
        meta.score += 4;
      }

      if (textPatterns.some((pattern) => text.includes(pattern))) {
        meta.score += 3;
      }

      if (classText.includes('ad-skip') || classText.includes('skip')) {
        meta.score += 2;
      }

      if (classText.includes('ytp-ad-component--clickable')) {
        meta.score += 3;
      }

      if (clickable.closest('.ytp-ad-skip-button-container')) {
        meta.score += 3;
      }

      if (isElementEnabled(clickable)) {
        meta.score += 4;
      }
    });

    const rankedCandidates = [...deduplicated.entries()]
      .map(([element, meta]) => ({ element, score: meta.score, source: meta.source }))
      .sort((a, b) => b.score - a.score);

    debugLog('Candidate counts', {
      selectorCandidates: selectorCandidates.length,
      semanticCandidates: semanticCandidates.length,
      eligibleCandidates: rankedCandidates.length,
      topScore: rankedCandidates[0]?.score || 0
    });

    return rankedCandidates[0]?.element || null;
  };

  // Uses pointer events in addition to .click() for better compatibility.
  const fireSyntheticClick = (target, coords = null) => {
    const rect = target.getBoundingClientRect();
    const centerX = coords?.x ?? rect.left + rect.width / 2;
    const centerY = coords?.y ?? rect.top + rect.height / 2;

    // Emit both pointer + mouse phases because some handlers are bound to one family only.
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((eventName) => {
      const EventCtor = eventName.startsWith('pointer') ? (window.PointerEvent || window.MouseEvent) : window.MouseEvent;
      target.dispatchEvent(
        new EventCtor(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: centerX,
          clientY: centerY
        })
      );
    });
  };

  const clampToViewport = (x, y) => {
    const maxX = Math.max(0, window.innerWidth - 1);
    const maxY = Math.max(0, window.innerHeight - 1);
    return {
      x: Math.min(maxX, Math.max(0, Math.round(x))),
      y: Math.min(maxY, Math.max(0, Math.round(y)))
    };
  };

  const dispatchPointerSequenceAtPoint = (x, y) => {
    const { x: cx, y: cy } = clampToViewport(x, y);
    const elementAtPoint = document.elementFromPoint(cx, cy);
    if (!(elementAtPoint instanceof HTMLElement)) {
      return false;
    }

    const clickable = getClickableElement(elementAtPoint);
    if (!(clickable instanceof HTMLElement)) {
      return false;
    }

    fireSyntheticClick(clickable, { x: cx, y: cy });
    clickable.click();
    return true;
  };

  // Fallback: try point-based clicks across the target rect (helps when wrappers intercept events).
  const tryCoordinateClickOnTarget = (target) => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    const points = [
      { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.3 },
      { x: rect.left + rect.width * 0.75, y: rect.top + rect.height * 0.3 },
      { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.7 },
      { x: rect.left + rect.width * 0.75, y: rect.top + rect.height * 0.7 }
    ];

    let clickedAny = false;
    points.forEach((point) => {
      clickedAny = dispatchPointerSequenceAtPoint(point.x, point.y) || clickedAny;
    });

    if (clickedAny) {
      debugLog('Performed coordinate fallback clicks on target bounds');
    }

    return clickedAny;
  };

  // Fallback: sweep 100x100-ish points in the lower-right player area.
  const tryLowerRightGridSweep = () => {
    const moviePlayer = document.getElementById('movie_player');
    const scopeRect = moviePlayer?.getBoundingClientRect?.() || {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight
    };

    const right = scopeRect.left + scopeRect.width;
    const bottom = scopeRect.top + scopeRect.height;
    const leftLimit = Math.max(scopeRect.left, right - GRID_SWEEP_STEP_PX * 4);
    const topLimit = Math.max(scopeRect.top, bottom - GRID_SWEEP_STEP_PX * 3);

    let clickedAny = false;
    for (let y = bottom - GRID_SWEEP_STEP_PX / 2; y >= topLimit; y -= GRID_SWEEP_STEP_PX) {
      for (let x = right - GRID_SWEEP_STEP_PX / 2; x >= leftLimit; x -= GRID_SWEEP_STEP_PX) {
        clickedAny = dispatchPointerSequenceAtPoint(x, y) || clickedAny;
      }
    }

    if (clickedAny) {
      debugLog('Performed lower-right grid sweep fallback');
    }

    return clickedAny;
  };

  // Returns a small randomized delay to make click timing less robotic.
  const getHumanizedDelayMs = () => {
    const span = Math.max(0, HUMANIZED_CLICK_DELAY_MAX_MS - HUMANIZED_CLICK_DELAY_MIN_MS);
    return HUMANIZED_CLICK_DELAY_MIN_MS + Math.floor(Math.random() * (span + 1));
  };

  const isNativeSkipButton = (target) => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const classText = (target.className || '').toString().toLowerCase();
    const idText = (target.id || '').toString().toLowerCase();
    return (
      classText.includes('ytp-ad-skip-button') ||
      classText.includes('ytp-skip-ad-button') ||
      idText.startsWith('skip-button:')
    );
  };

  // Schedules one click attempt after a short human-like delay.
  const queueClickTarget = (target) => {
    state.pendingClickTarget = target;

    if (state.pendingClickTimeoutId !== null) {
      debugLog('Updated queued skip target while timer already pending');
      return;
    }

    const delayMs = getHumanizedDelayMs();
    state.pendingClickTimeoutId = window.setTimeout(() => {
      const queuedTarget = state.pendingClickTarget;
      state.pendingClickTimeoutId = null;
      state.pendingClickTarget = null;
      clickTarget(queuedTarget, { bypassDebounce: delayMs === 0 });
    }, delayMs);

    debugLog('Scheduled click attempt with delay (ms):', delayMs);
  };

  // Invokes YouTube player API fallback when UI click path is blocked.
  const tryPlayerApiSkip = () => {
    const moviePlayer = document.getElementById('movie_player');
    if (!moviePlayer) {
      return false;
    }

    const skipMethods = ['skipAd', 'skipVideo', 'onSkipAd'];
    for (const methodName of skipMethods) {
      const method = moviePlayer[methodName];
      if (typeof method === 'function') {
        try {
          method.call(moviePlayer);
          debugLog(`Called movie_player.${methodName}() fallback`);
          return true;
        } catch (error) {
          debugLog(`movie_player.${methodName}() failed`, error?.message || error);
        }
      }
    }

    return false;
  };


  const dispatchMouseLifecycle = (element, x, y) => {
    ['mouseover', 'mouseenter', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((eventName) => {
      const EventCtor = eventName.startsWith('pointer') ? (window.PointerEvent || window.MouseEvent) : window.MouseEvent;
      element.dispatchEvent(
        new EventCtor(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: eventName.includes('down') ? 1 : 0,
          detail: eventName === 'click' ? 1 : 0
        })
      );
    });
  };

  const tryMultiMethodClick = (target) => {
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const rect = target.getBoundingClientRect();
    const center = clampToViewport(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const clickableAncestors = [target, getClickableElement(target), target.parentElement, target.closest('.ytp-ad-skip-button-container')].filter(
      (node, index, arr) => node instanceof HTMLElement && arr.indexOf(node) === index
    );

    clickableAncestors.forEach((element) => {
      element.focus?.();
      dispatchMouseLifecycle(element, center.x, center.y);
      fireSyntheticClick(element, center);
      element.click?.();

      // Keyboard activation fallback used by some UI frameworks.
      ['keydown', 'keyup'].forEach((eventName) => {
        element.dispatchEvent(
          new KeyboardEvent(eventName, {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true
          })
        );
        element.dispatchEvent(
          new KeyboardEvent(eventName, {
            key: ' ',
            code: 'Space',
            bubbles: true,
            cancelable: true
          })
        );
      });
    });

    const elementAtPoint = document.elementFromPoint(center.x, center.y);
    if (elementAtPoint instanceof HTMLElement) {
      const topClickable = getClickableElement(elementAtPoint);
      if (topClickable instanceof HTMLElement) {
        topClickable.focus?.();
        dispatchMouseLifecycle(topClickable, center.x, center.y);
        topClickable.click?.();
      }
    }

    debugLog('Executed multi-method click sequence', {
      x: center.x,
      y: center.y,
      attemptedElements: clickableAncestors.length
    });
  };

  // Performs a guarded click flow with debounce + eligibility checks.
  const clickTarget = (target, options = {}) => {
    const { bypassDebounce = false } = options;
    const now = Date.now();
    if (!bypassDebounce && now - state.lastClickTimestamp < CLICK_DEBOUNCE_MS) {
      debugLog('Skipped click due to debounce window', {
        sinceLastMs: now - state.lastClickTimestamp,
        debounceMs: CLICK_DEBOUNCE_MS
      });
      return;
    }

    if (!target) {
      debugLog('Skipped click because no target was queued');
      return;
    }

    if (!target.isConnected || !isElementVisible(target) || !isInsideAdUi(target)) {
      debugLog('Skipped click because target became non-actionable before execution');
      return;
    }

    if (!isElementEnabled(target)) {
      debugLog('Skip target found but not yet enabled; waiting for next cycle');
      return;
    }

    state.lastClickTimestamp = now;
    const targetSummary = target.outerHTML?.slice(0, 180) || '<unknown>';
    console.log(`[AASFY ${BUILD_SERIAL}] Click attempt starting`);
    debugLog('Build serial for click attempt:', BUILD_SERIAL);
    debugLog('Click target before attempt:', targetSummary);

    // Execute several click pathways (DOM click, pointer lifecycle, keyboard activation).
    tryMultiMethodClick(target);

    console.log(`[AASFY ${BUILD_SERIAL}] Click attempt finished`);
    console.log('AASFY clicked a skip control');
    debugLog('Clicked target:', target.outerHTML?.slice(0, 220) || '<unknown>');

    window.setTimeout(() => {
      if (state.active && isAdLikelyShowing()) {
        debugLog('Ad still showing after click; running fallback click strategies');

        const coordinateClicked = tryCoordinateClickOnTarget(target);
        if (coordinateClicked) {
          console.log('AASFY invoked coordinate click fallback on detected skip target');
        }

        if (state.active && isAdLikelyShowing()) {
          const gridSweepClicked = tryLowerRightGridSweep();
          if (gridSweepClicked) {
            console.log('AASFY invoked lower-right grid-sweep click fallback');
          }
        }

        if (tryPlayerApiSkip()) {
          console.log('AASFY invoked player API skip fallback after click retry');
        }

        attemptSkipAd();
      }
    }, RETRY_AFTER_CLICK_MS);
  };

  // Single pass: detect ad state, then find and click skip if possible.
  const attemptSkipAd = () => {
    if (!state.active) {
      return;
    }

    const adSignals = getAdSignals();
    const adLikelyShowing = isAdLikelyShowing(adSignals);
    debugLog('Ad state:', adLikelyShowing ? 'likely-showing' : 'not-detected');
    debugLog('Ad signals:', adSignals);

    if (!adLikelyShowing) {
      return;
    }

    const target = findSkipTarget();
    if (target) {
      debugLog('Skip target detected; attempting click');

      // Some YouTube variants ignore synthetic clicks unless a trusted gesture exists.
      // Invoke known player APIs in parallel when available.
      if (tryPlayerApiSkip()) {
        console.log('AASFY invoked player API skip fallback before UI click');
      }

      queueClickTarget(target);
    } else {
      debugLog('No skip target found in current cycle');
      if (tryPlayerApiSkip()) {
        console.log('AASFY invoked player API skip fallback');
      }
    }
  };

  // Coalesces frequent mutation bursts into one animation-frame attempt.
  const queueObserverAttempt = () => {
    if (state.observerQueued) {
      return;
    }

    state.observerQueued = true;
    window.requestAnimationFrame(() => {
      state.observerQueued = false;
      attemptSkipAd();
    });
  };

  // Tears down all timers/observers.
  const stopMonitoring = () => {
    if (state.intervalId !== null) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }

    if (state.pendingClickTimeoutId !== null) {
      clearTimeout(state.pendingClickTimeoutId);
      state.pendingClickTimeoutId = null;
    }

    state.pendingClickTarget = null;

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  };

  // Starts interval + mutation observer based monitoring.
  const startMonitoring = () => {
    stopMonitoring();

    state.intervalId = window.setInterval(attemptSkipAd, 1000);

    state.observer = new MutationObserver(queueObserverAttempt);
    state.observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-label', 'style', 'disabled']
    });

    attemptSkipAd();
  };

  // Applies storage settings to runtime state and (re)starts monitoring.
  const applySettings = (settings) => {
    const previousActive = state.active;

    state.active = settings.activationState === 'active';
    state.debugMode = Boolean(settings.debugMode);
    state.customSkipIdentifiers = sanitizeCustomIdentifiers(settings.customSkipIdentifiers);

    debugLog('Settings applied', {
      active: state.active,
      debugMode: state.debugMode,
      customIdentifierCount: state.customSkipIdentifiers.length
    });

    if (state.active && !previousActive) {
      startMonitoring();
      return;
    }

    if (!state.active && previousActive) {
      stopMonitoring();
      return;
    }

    if (state.active) {
      attemptSkipAd();
    }
  };

  // Initial bootstrap: load storage settings and begin active monitoring.
  const loadInitialSettings = () => {
    chrome.storage.sync.get(DEFAULTS, (result) => {
      const mergedSettings = {
        activationState: result.activationState || DEFAULTS.activationState,
        debugMode: Boolean(result.debugMode),
        customSkipIdentifiers: sanitizeCustomIdentifiers(result.customSkipIdentifiers)
      };

      chrome.storage.sync.set(mergedSettings);
      applySettings(mergedSettings);

      if (state.active) {
        console.log(`Auto Ad Skipper for YouTube (AASFY) is Active | Build ${BUILD_SERIAL}`);
        startMonitoring();
      }
    });
  };

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') {
      return;
    }

    const hasRelevantChange =
      Boolean(changes[STORAGE_KEYS.activationState]) ||
      Boolean(changes[STORAGE_KEYS.debugMode]) ||
      Boolean(changes[STORAGE_KEYS.customSkipIdentifiers]);

    if (!hasRelevantChange) {
      return;
    }

    chrome.storage.sync.get(DEFAULTS, (latestSettings) => {
      applySettings(latestSettings);
    });
  });

  window.addEventListener('beforeunload', stopMonitoring);
  loadInitialSettings();
})();

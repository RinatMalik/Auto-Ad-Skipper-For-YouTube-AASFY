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
  const BUILD_SERIAL = 'AASFY-PR-2026-03-15-02';

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

  // Multi-language keywords and common phrases used in skip controls.
  const DEFAULT_TEXT_PATTERNS = ['skip', 'skip ad', 'skip ads', 'saltar', 'überspringen', 'ignorer', '跳过'];

  // Timing controls to avoid over-clicking and to support short retries.
  const CLICK_DEBOUNCE_MS = 1200;
  const RETRY_AFTER_CLICK_MS = 650;
  const HUMANIZED_CLICK_DELAY_MIN_MS = 120;
  const HUMANIZED_CLICK_DELAY_MAX_MS = 260;

  // Runtime state cache.
  const state = {
    active: DEFAULTS.activationState === 'active',
    debugMode: DEFAULTS.debugMode,
    customSkipIdentifiers: [],
    intervalId: null,
    observer: null,
    observerQueued: false,
    pendingClickTimeoutId: null,
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

    // We intentionally do not use opacity heuristics because hover states can change opacity.
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

  // Reads multiple ad-related UI indicators to reduce false positives.
  const getAdSignals = () => {
    const moviePlayerAdShowing = Boolean(document.querySelector('#movie_player.ad-showing'));
    const adModuleVisible = isSelectorVisible('.video-ads.ytp-ad-module');
    const adOverlayVisible = isSelectorVisible('.ytp-ad-player-overlay');
    const adPreviewVisible = isSelectorVisible('.ytp-ad-preview-container');
    const adBadgeVisible = isSelectorVisible('.ytp-ad-text, .ytp-ad-simple-ad-badge');
    const skipControlVisible = DEFAULT_SELECTORS.some((selector) => isSelectorVisible(selector));

    return {
      moviePlayerAdShowing,
      adModuleVisible,
      adOverlayVisible,
      adPreviewVisible,
      adBadgeVisible,
      skipControlVisible
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
        signals.skipControlVisible
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
  const fireSyntheticClick = (target) => {
    // Emit both pointer + mouse phases because some handlers are bound to one family only.
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((eventName) => {
      const EventCtor = eventName.startsWith('pointer') ? (window.PointerEvent || window.MouseEvent) : window.MouseEvent;
      target.dispatchEvent(new EventCtor(eventName, { bubbles: true, cancelable: true, view: window }));
    });
  };

  // Returns a small randomized delay to make click timing less robotic.
  const getHumanizedDelayMs = () => {
    const span = Math.max(0, HUMANIZED_CLICK_DELAY_MAX_MS - HUMANIZED_CLICK_DELAY_MIN_MS);
    return HUMANIZED_CLICK_DELAY_MIN_MS + Math.floor(Math.random() * (span + 1));
  };

  // Schedules one click attempt after a short human-like delay.
  const queueClickTarget = (target) => {
    if (state.pendingClickTimeoutId !== null) {
      return;
    }

    const delayMs = getHumanizedDelayMs();
    state.pendingClickTimeoutId = window.setTimeout(() => {
      state.pendingClickTimeoutId = null;
      clickTarget(target);
    }, delayMs);

    debugLog('Scheduled click attempt with humanized delay (ms):', delayMs);
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

  // Performs a guarded click flow with debounce + eligibility checks.
  const clickTarget = (target) => {
    const now = Date.now();
    if (now - state.lastClickTimestamp < CLICK_DEBOUNCE_MS) {
      debugLog('Skipped click due to debounce window');
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
    // Primary action.
    target.click();
    // Secondary synthetic events for UI layers that require pointer lifecycle.
    fireSyntheticClick(target);

    console.log('AASFY clicked a skip control');
    debugLog('Clicked target:', target.outerHTML?.slice(0, 220) || '<unknown>');

    window.setTimeout(() => {
      if (state.active && isAdLikelyShowing()) {
        debugLog('Ad still showing after click; retrying target search');
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

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
  const BUILD_SERIAL = 'AASFY-PR-2026-03-16-10';

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
    '.ytp-ad-skip-button-container > button',
    '.ytp-ad-skip-button-container button',
    '.ytp-ad-skip-button-container',
    '[class*="skip-button"]',
    'button[data-testid*="skip" i]',
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

  // Runtime state cache.
  // state.active starts as false so applySettings can detect the initial
  // false→true transition and call startMonitoring() exactly once.
  const state = {
    active: false,
    debugMode: DEFAULTS.debugMode,
    customSkipIdentifiers: [],
    intervalId: null,
    observer: null,
    observerQueued: false,
    pendingClickTimeoutId: null,
    pendingClickTarget: null,
    lastClickTimestamp: 0,
    adFastForwarding: false,
    preAdPlaybackRate: null,
    preAdMuted: null
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
  // For button and role=button elements the pointer-events check is skipped
  // because YouTube's skip-button containers sometimes carry pointer-events:none
  // while the inner button itself is still clickable.
  const isElementVisible = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const isButton = element.tagName === 'BUTTON' || element.getAttribute('role') === 'button';

    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      (isButton || style.pointerEvents !== 'none') &&
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
    // ytd-ad-slot-renderer is present whenever a YouTube in-stream ad is rendering.
    const adSlotVisible = isSelectorVisible('ytd-ad-slot-renderer');

    return {
      moviePlayerAdShowing,
      adModuleVisible,
      adOverlayVisible,
      adPreviewVisible,
      adBadgeVisible,
      skipControlVisible,
      adContainerVisible,
      adSlotVisible
    };
  };

  // Final ad-likelihood decision used to gate skip attempts.
  const isAdLikelyShowing = (signals = getAdSignals()) => {
    return Boolean(
      signals.moviePlayerAdShowing ||
        signals.adModuleVisible ||
        signals.adOverlayVisible ||
        signals.adPreviewVisible ||
        signals.adBadgeVisible ||
        signals.adSlotVisible ||
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

  // Clamps coordinates to valid viewport bounds.
  const clampToViewport = (x, y) => {
    const maxX = Math.max(0, window.innerWidth - 1);
    const maxY = Math.max(0, window.innerHeight - 1);
    return {
      x: Math.min(maxX, Math.max(0, Math.round(x))),
      y: Math.min(maxY, Math.max(0, Math.round(y)))
    };
  };

  // Dispatches a full pointer + mouse event lifecycle on an element.
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

    const delayMs = isNativeSkipButton(target) || target?.closest?.('.ytp-ad-skip-button-container') ? 0 : getHumanizedDelayMs();
    state.pendingClickTimeoutId = window.setTimeout(() => {
      const queuedTarget = state.pendingClickTarget;
      state.pendingClickTimeoutId = null;
      state.pendingClickTarget = null;
      clickTarget(queuedTarget, { bypassDebounce: delayMs === 0 });
    }, delayMs);

    debugLog('Scheduled click attempt with delay (ms):', delayMs);
  };

  // Mutes the video and sets playback rate to 16x during an ad so the ad
  // finishes in ~2 seconds silently. YouTube checks event.isTrusted on the
  // skip button — no programmatic click from a content script can ever pass
  // that check. This approach sidesteps it entirely: the ad plays to
  // natural completion, just 16x faster and with no audio.
  // Re-applied on every cycle in case YouTube's player resets playbackRate.
  const fastForwardAd = () => {
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!(video instanceof HTMLVideoElement)) {
      return false;
    }

    // Save the user's original settings on the first call for this ad.
    if (!state.adFastForwarding) {
      state.preAdPlaybackRate = video.playbackRate;
      state.preAdMuted = video.muted;
      state.adFastForwarding = true;
      debugLog('Fast-forward started; saved pre-ad state', {
        rate: state.preAdPlaybackRate,
        muted: state.preAdMuted
      });
    }

    // Force maximum speed and mute. Re-applied every cycle in case
    // YouTube's player resets them between ticks.
    if (video.playbackRate < 16) {
      video.playbackRate = 16;
    }
    if (!video.muted) {
      video.muted = true;
    }

    return true;
  };

  // Restores the user's original playback rate and mute state once
  // the ad is no longer showing.
  const restorePlayback = () => {
    if (!state.adFastForwarding) {
      return;
    }

    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (video instanceof HTMLVideoElement) {
      video.playbackRate = state.preAdPlaybackRate ?? 1;
      video.muted = state.preAdMuted ?? false;
      debugLog('Restored pre-ad playback state', {
        rate: video.playbackRate,
        muted: video.muted
      });
    }

    state.adFastForwarding = false;
    state.preAdPlaybackRate = null;
    state.preAdMuted = null;
  };

  // Injects a one-shot script into the page's main JS execution context.
  // Content scripts run in an isolated world and cannot access window.yt or
  // other page-level globals. A <script> tag runs in the main world and can
  // reach internal YouTube player APIs that are invisible from the extension.
  const tryMainWorldSkip = () => {
    try {
      const script = document.createElement('script');
      script.textContent = `(function () {
        var player = document.getElementById('movie_player');
        if (!player) return;
        ['skipAd', 'skipVideo', 'onSkipAd'].forEach(function (m) {
          if (typeof player[m] === 'function') { try { player[m](); } catch (e) {} }
        });
        if (window.yt && window.yt.player) {
          var fn = window.yt.player.getPlayerByElement;
          var p = typeof fn === 'function' ? fn(player) : null;
          if (p) { ['skipAd', 'skipVideo', 'onSkipAd'].forEach(function (m) {
            if (typeof p[m] === 'function') { try { p[m](); } catch (e) {} }
          }); }
        }
      })();`;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch (err) {
      debugLog('Main world script injection failed:', err?.message || err);
    }
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
  // Click strategy (three layers):
  //   1. YouTube Player API — bypasses UI entirely, most reliable when available.
  //   2. Pointer + mouse event sequence — covers frameworks that bind to pointer events.
  //   3. Direct .click() — covers standard DOM click handlers.
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
    debugLog('Click target before attempt:', targetSummary);

    try {
      const rect = target.getBoundingClientRect();
      const center = clampToViewport(rect.left + rect.width / 2, rect.top + rect.height / 2);

      // Layer 1: Player API (most reliable, bypasses UI entirely).
      if (tryPlayerApiSkip()) {
        debugLog('Player API skip invoked');
      }

      // Layer 2: Pointer + mouse events on the button and its direct parent.
      dispatchMouseLifecycle(target, center.x, center.y);
      if (target.parentElement instanceof HTMLElement) {
        dispatchMouseLifecycle(target.parentElement, center.x, center.y);
      }

      // Layer 3: Direct DOM click.
      target.click();
    } catch (err) {
      debugLog('Click attempt error:', err?.message || err);
    }

    console.log(`[AASFY ${BUILD_SERIAL}] Click attempt finished`);

    // Retry after a short delay if the ad is still showing.
    window.setTimeout(() => {
      if (!state.active || !isAdLikelyShowing()) {
        return;
      }

      debugLog('Ad still showing after click; retrying');

      try {
        fastForwardAd();
        tryMainWorldSkip();
        tryPlayerApiSkip();

        if (target.isConnected && isElementVisible(target)) {
          const rect = target.getBoundingClientRect();
          const center = clampToViewport(rect.left + rect.width / 2, rect.top + rect.height / 2);
          dispatchMouseLifecycle(target, center.x, center.y);
          target.click();
        }
      } catch (err) {
        debugLog('Retry click error:', err?.message || err);
      }

      attemptSkipAd();
    }, RETRY_AFTER_CLICK_MS);
  };

  // Single pass: detect ad state, then attempt all skip strategies.
  const attemptSkipAd = () => {
    if (!state.active) {
      return;
    }

    const adSignals = getAdSignals();
    const adLikelyShowing = isAdLikelyShowing(adSignals);
    debugLog('Ad state:', adLikelyShowing ? 'likely-showing' : 'not-detected');
    debugLog('Ad signals:', adSignals);

    if (!adLikelyShowing) {
      // Ad finished — restore the user's playback settings.
      if (state.adFastForwarding) {
        restorePlayback();
        console.log(`[AASFY ${BUILD_SERIAL}] Ad ended; restored playback`);
      }
      return;
    }

    // Strategy 1: mute + 16x playback speed so the ad finishes in ~2s.
    // Re-applied every cycle in case YouTube's player resets it.
    fastForwardAd();

    // Strategy 2: main-world injection to reach window.yt internal APIs.
    tryMainWorldSkip();

    // Strategy 3: player API methods visible from content-script world.
    if (tryPlayerApiSkip()) {
      console.log(`[AASFY ${BUILD_SERIAL}] Ad skip via player API`);
    }

    // Strategy 4: find and click the skip button (still tried in case
    // YouTube changes their isTrusted policy in the future).
    const target = findSkipTarget();
    if (target) {
      debugLog('Skip target detected; queuing click');
      queueClickTarget(target);
    } else {
      debugLog('No skip target found in current cycle');
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
      console.log(`Auto Ad Skipper for YouTube (AASFY) is Active | Build ${BUILD_SERIAL}`);
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

// content.js
(() => {
  const STORAGE_KEYS = {
    activationState: 'activationState',
    debugMode: 'debugMode',
    customSkipIdentifiers: 'customSkipIdentifiers'
  };

  const DEFAULTS = {
    activationState: 'active',
    debugMode: false,
    customSkipIdentifiers: []
  };

  const DEFAULT_SELECTORS = [
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button',
    '.ytp-ad-skip-button-container',
    'button[aria-label*="Skip" i]'
  ];

  const DEFAULT_TEXT_PATTERNS = [
    'skip',
    'skip ad',
    'skip ads',
    'saltar',
    'überspringen',
    'ignorer',
    '跳过'
  ];

  const state = {
    active: DEFAULTS.activationState === 'active',
    debugMode: DEFAULTS.debugMode,
    customSkipIdentifiers: [],
    intervalId: null,
    observer: null,
    observerQueued: false,
    lastClickTimestamp: 0
  };

  const debugLog = (...parts) => {
    if (!state.debugMode) {
      return;
    }

    console.log('[AASFY DEBUG]', ...parts);
  };

  const sanitizeCustomIdentifiers = (value) => {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
      .slice(0, 25);
  };

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

  const isElementEnabled = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const isDisabledByAttr = element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
    const hasDisabledClass = (element.className || '').toString().toLowerCase().includes('disabled');
    return !isDisabledByAttr && !hasDisabledClass;
  };

  const getClickableElement = (element) => {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    return element.closest('button, [role="button"]') || element;
  };

  const isAdLikelyShowing = () => {
    return Boolean(
      document.querySelector('.ad-showing') ||
      document.querySelector('.video-ads.ytp-ad-module') ||
      document.querySelector('.ytp-ad-player-overlay') ||
      document.querySelector('.ytp-ad-preview-container')
    );
  };

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

  const getElementText = (element) => {
    const rawText = [
      element.textContent || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || ''
    ].join(' ');

    return rawText.trim().toLowerCase();
  };

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

  const findSkipTarget = () => {
    const normalizedCustomIdentifiers = sanitizeCustomIdentifiers(state.customSkipIdentifiers);
    const selectorCandidates = [
      ...collectSelectorCandidates(DEFAULT_SELECTORS),
      ...collectSelectorCandidates(normalizedCustomIdentifiers)
    ];

    const textPatterns = [
      ...DEFAULT_TEXT_PATTERNS,
      ...normalizedCustomIdentifiers.map((entry) => entry.toLowerCase())
    ];

    const semanticCandidates = collectSemanticCandidates(textPatterns);
    const deduplicated = new Map();

    [...selectorCandidates, ...semanticCandidates].forEach((candidate) => {
      const clickable = getClickableElement(candidate.element);
      if (!clickable || !isElementVisible(clickable) || !isElementEnabled(clickable)) {
        return;
      }

      if (!isInsideAdUi(clickable)) {
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

      if (clickable.closest('.ytp-ad-skip-button-container')) {
        meta.score += 3;
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

  const fireSyntheticClick = (target) => {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((eventName) => {
      target.dispatchEvent(new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window }));
    });
  };

  const clickTarget = (target) => {
    const now = Date.now();
    if (now - state.lastClickTimestamp < 900) {
      debugLog('Skipped click due to debounce window');
      return;
    }

    state.lastClickTimestamp = now;
    target.click();
    fireSyntheticClick(target);
    console.log('AASFY clicked a skip control');
    debugLog('Clicked target:', target.outerHTML?.slice(0, 200) || '<unknown>');
  };

  const attemptSkipAd = () => {
    if (!state.active) {
      return;
    }

    const adLikelyShowing = isAdLikelyShowing();
    debugLog('Ad state:', adLikelyShowing ? 'likely-showing' : 'not-detected');

    if (!adLikelyShowing) {
      return;
    }

    const target = findSkipTarget();
    if (target) {
      clickTarget(target);
    } else {
      debugLog('No skip target found in current cycle');
    }
  };

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

  const stopMonitoring = () => {
    if (state.intervalId !== null) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  };

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
        console.log('Auto Ad Skipper for YouTube (AASFY) is Active');
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

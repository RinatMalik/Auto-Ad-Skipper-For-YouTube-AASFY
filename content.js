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

  const isAdLikelyShowing = () => {
    return Boolean(
      document.querySelector('.ad-showing') ||
      document.querySelector('.video-ads.ytp-ad-module') ||
      document.querySelector('.ytp-ad-player-overlay') ||
      document.querySelector('.ytp-ad-preview-container')
    );
  };

  const collectSelectorCandidates = (selectors) => {
    const candidates = [];

    selectors.forEach((selector) => {
      try {
        const nodes = document.querySelectorAll(selector);
        nodes.forEach((node) => candidates.push(node));
      } catch (error) {
        debugLog('Invalid selector ignored:', selector, error?.message || error);
      }
    });

    return candidates;
  };

  const getElementText = (element) => {
    const rawText = [
      element.textContent || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || ''
    ].join(' ');

    return rawText.trim().toLowerCase();
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
        semanticCandidates.push(element);
      }
    });

    return semanticCandidates;
  };

  const findSkipTarget = () => {
    const normalizedCustomIdentifiers = sanitizeCustomIdentifiers(state.customSkipIdentifiers);
    const defaultSelectorCandidates = collectSelectorCandidates(DEFAULT_SELECTORS);
    const customSelectorCandidates = collectSelectorCandidates(normalizedCustomIdentifiers);

    const textPatterns = [
      ...DEFAULT_TEXT_PATTERNS,
      ...normalizedCustomIdentifiers.map((entry) => entry.toLowerCase())
    ];

    const semanticCandidates = collectSemanticCandidates(textPatterns);

    const uniqueCandidates = [];
    const seen = new Set();

    [...defaultSelectorCandidates, ...customSelectorCandidates, ...semanticCandidates].forEach((candidate) => {
      if (!(candidate instanceof HTMLElement) || !isElementVisible(candidate)) {
        return;
      }

      if (!seen.has(candidate)) {
        seen.add(candidate);
        uniqueCandidates.push(candidate);
      }
    });

    debugLog('Candidate counts', {
      defaultSelectorCandidates: defaultSelectorCandidates.length,
      customSelectorCandidates: customSelectorCandidates.length,
      semanticCandidates: semanticCandidates.length,
      uniqueCandidates: uniqueCandidates.length
    });

    return uniqueCandidates[0] || null;
  };

  const clickTarget = (target) => {
    const now = Date.now();
    if (now - state.lastClickTimestamp < 1200) {
      debugLog('Skipped click due to debounce window');
      return;
    }

    state.lastClickTimestamp = now;
    target.click();
    console.log('AASFY clicked a skip control');
    debugLog('Clicked target:', target.outerHTML?.slice(0, 150) || '<unknown>');
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

    state.intervalId = window.setInterval(attemptSkipAd, 1200);

    state.observer = new MutationObserver(queueObserverAttempt);
    state.observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-label', 'style']
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

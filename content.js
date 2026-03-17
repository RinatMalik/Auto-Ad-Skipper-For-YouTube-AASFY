// content.js
//
// This script runs on YouTube pages and is responsible for:
// 1) reading extension settings,
// 2) detecting when an ad is currently showing,
// 3) muting + fast-forwarding ads at 16x speed,
// 4) trying YouTube Player API skip methods as an instant fallback,
// 5) auto-dismissing overlay ad banners,
// 6) tracking ads handled (session + lifetime).
(() => {
  // Build serial to help confirm the loaded extension version in logs/UI.
  const BUILD_SERIAL = 'AASFY-PR-2026-03-17-04';

  // Storage keys used across popup + content script.
  const STORAGE_KEYS = {
    activationState: 'activationState',
    debugMode: 'debugMode'
  };

  // Default settings used when a key does not yet exist in storage.
  const DEFAULTS = {
    activationState: 'active',
    debugMode: false
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

  // Runtime state cache.
  // state.active starts as false so applySettings can detect the initial
  // false→true transition and call startMonitoring() exactly once.
  const state = {
    active: false,
    debugMode: DEFAULTS.debugMode,
    intervalId: null,
    observer: null,
    observerQueued: false,
    lastObserverRunTimestamp: 0,
    lastDebugAdState: null,
    adFastForwarding: false,
    preAdPlaybackRate: null,
    preAdMuted: null,
    sessionAdCount: 0
  };

  // Returns true if the extension context has been invalidated (e.g. after
  // the extension is reloaded while this script is still running on the page).
  // When this happens, all chrome.* API calls throw. We detect it early and
  // tear down monitoring to stop the error spam.
  const isContextInvalidated = () => {
    try {
      return !chrome.runtime?.id;
    } catch {
      return true;
    }
  };

  // Debug logger (active only when debugMode is enabled from popup).
  const debugLog = (...parts) => {
    if (!state.debugMode) {
      return;
    }

    console.log('[AASFY DEBUG]', ...parts);
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
      style.opacity !== '0' &&
      (isButton || style.pointerEvents !== 'none') &&
      rect.width > 0 &&
      rect.height > 0
    );
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
  // #movie_player.ad-showing is the authoritative signal — YouTube adds this
  // class when an ad starts and removes it when the ad truly ends. The other
  // DOM elements (ytd-ad-slot-renderer, .video-ads, etc.) frequently linger
  // in the page after the ad finishes, so they must NOT be trusted alone.
  const isAdLikelyShowing = (signals = getAdSignals()) => {
    // Primary: YouTube's own ad-showing class on the player element.
    if (signals.moviePlayerAdShowing) {
      return true;
    }

    // Secondary: a visible skip control inside an ad container is a strong
    // indicator even without .ad-showing (covers brief transition states).
    if (signals.skipControlVisible && signals.adContainerVisible) {
      return true;
    }

    return false;
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

  // Overlay element ID and label ID used to avoid duplicates.
  const OVERLAY_ID = 'aasfy-skip-overlay';
  const OVERLAY_LABEL_ID = 'aasfy-skip-overlay-label';

  // Shows a dark overlay on the video player while fast-forwarding.
  const showSkipOverlay = () => {
    if (document.getElementById(OVERLAY_ID)) return;

    const player = document.getElementById('movie_player');
    if (!player) return;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('style', [
      'position: absolute',
      'top: 0',
      'left: 0',
      'width: 100%',
      'height: 100%',
      'background: rgba(0, 0, 0, 0.85)',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'z-index: 9999',
      'pointer-events: none'
    ].join('; '));

    const label = document.createElement('span');
    label.id = OVERLAY_LABEL_ID;
    label.setAttribute('style', [
      'color: #fff',
      'font-family: Verdana, Geneva, sans-serif',
      'font-size: 56px',
      'font-weight: 700',
      'letter-spacing: 1px'
    ].join('; '));
    label.textContent = 'Skipping Ad';

    overlay.appendChild(label);
    player.style.position = player.style.position || 'relative';
    player.appendChild(overlay);
  };

  // Tracks when the CTA screen started so we can show a countdown.
  let ctaStartTimestamp = 0;
  const CTA_COUNTDOWN_SECONDS = 5;

  // Updates the overlay label text with phase-appropriate messages.
  const updateSkipOverlay = () => {
    const label = document.getElementById(OVERLAY_LABEL_ID);
    if (!label) return;

    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!(video instanceof HTMLVideoElement)) return;

    // Video ended/paused but ad-showing still present = CTA screen.
    if (video.ended || video.paused) {
      if (ctaStartTimestamp === 0) {
        ctaStartTimestamp = Date.now();
      }
      const elapsed = (Date.now() - ctaStartTimestamp) / 1000;
      const remaining = Math.max(0, CTA_COUNTDOWN_SECONDS - Math.floor(elapsed));
      if (remaining > 0) {
        label.textContent = `Ad ending in ${remaining}`;
      } else {
        label.textContent = 'Ad ending\u2026';
      }
      return;
    }

    // Reset CTA timer when video is still playing.
    ctaStartTimestamp = 0;

    const remaining = video.duration - video.currentTime;
    if (!isFinite(remaining) || remaining <= 0) {
      label.textContent = 'Skipping Ad';
      return;
    }

    // Show real-world seconds remaining (accounting for 16x speed).
    const realSeconds = Math.ceil(remaining / video.playbackRate);
    if (realSeconds <= 1) {
      label.textContent = 'Almost done\u2026';
    } else {
      label.textContent = 'Skipping Ad';
    }
  };

  // Removes the skip overlay when the ad ends.
  const removeSkipOverlay = () => {
    ctaStartTimestamp = 0;
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();
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
      showSkipOverlay();
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
    removeSkipOverlay();
  };

  // Auto-dismisses overlay ad banners (bottom banners, promotions).
  const OVERLAY_CLOSE_SELECTORS = [
    '.ytp-ad-overlay-close-button',
    '.ytp-ad-overlay-close-container button',
    '[class*="ad-overlay-close"]'
  ];

  const dismissOverlayAds = () => {
    OVERLAY_CLOSE_SELECTORS.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((button) => {
          if (isElementVisible(button)) {
            button.click();
            debugLog('Dismissed overlay ad via', selector);
          }
        });
      } catch (error) {
        debugLog('Overlay dismiss failed:', selector, error?.message || error);
      }
    });
  };

  // Increments the lifetime ad counter in chrome.storage.local.
  const incrementLifetimeAdCount = () => {
    try {
      chrome.storage.local.get({ lifetimeAdCount: 0 }, (data) => {
        if (chrome.runtime.lastError) return;
        chrome.storage.local.set({ lifetimeAdCount: (data.lifetimeAdCount || 0) + 1 });
      });
    } catch {
      // Extension context invalidated — ignore.
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

  // Single pass: detect ad state, then attempt all skip strategies.
  const attemptSkipAd = () => {
    // If the extension was reloaded, stop all monitoring to prevent
    // "Extension context invalidated" errors from spamming the console.
    if (isContextInvalidated()) {
      stopMonitoring();
      restorePlayback();
      return;
    }

    if (!state.active) {
      return;
    }

    // When already fast-forwarding, only check if the ad ended and
    // re-apply playback rate (YouTube may reset it between ticks).
    if (state.adFastForwarding) {
      if (!isAdLikelyShowing()) {
        restorePlayback();
        console.log(`[AASFY ${BUILD_SERIAL}] Ad ended; restored playback`);
      } else {
        fastForwardAd();
        updateSkipOverlay();
      }
      return;
    }

    const adSignals = getAdSignals();
    const adLikelyShowing = isAdLikelyShowing(adSignals);

    // Only log ad state when it changes to avoid flooding the console.
    const adStateLabel = adLikelyShowing ? 'likely-showing' : 'not-detected';
    if (adStateLabel !== state.lastDebugAdState) {
      debugLog('Ad state:', adStateLabel);
      debugLog('Ad signals:', adSignals);
      state.lastDebugAdState = adStateLabel;
    }

    if (!adLikelyShowing) {
      return;
    }

    // First ad detection — start fast-forwarding immediately.
    state.sessionAdCount++;
    try {
      chrome.storage.local.set({ sessionAdCount: state.sessionAdCount });
    } catch {
      // Extension context invalidated — ignore.
    }
    incrementLifetimeAdCount();
    console.log(`[AASFY ${BUILD_SERIAL}] Ad #${state.sessionAdCount} detected; muting + fast-forwarding at 16x`);
    fastForwardAd();

    // Try player API skip as an instant fallback.
    if (tryPlayerApiSkip()) {
      console.log(`[AASFY ${BUILD_SERIAL}] Ad skip via player API`);
    }

    // Auto-dismiss overlay ad banners.
    dismissOverlayAds();
  };

  // Throttles observer-triggered attempts to at most once per 2 seconds.
  // The polling interval already runs every 1 second; the observer only
  // needs to catch sudden ad-state transitions between intervals.
  const OBSERVER_THROTTLE_MS = 2000;

  const queueObserverAttempt = () => {
    if (state.observerQueued) {
      return;
    }

    const now = Date.now();
    const elapsed = now - state.lastObserverRunTimestamp;
    if (elapsed < OBSERVER_THROTTLE_MS) {
      return;
    }

    state.observerQueued = true;
    window.requestAnimationFrame(() => {
      state.observerQueued = false;
      state.lastObserverRunTimestamp = Date.now();
      attemptSkipAd();
    });
  };

  // Tears down all timers/observers.
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

    debugLog('Settings applied', {
      active: state.active,
      debugMode: state.debugMode
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
        debugMode: Boolean(result.debugMode)
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
      Boolean(changes[STORAGE_KEYS.debugMode]);

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

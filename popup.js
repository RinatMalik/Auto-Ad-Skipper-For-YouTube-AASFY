// popup.js
//
// This script powers the extension popup UI. It:
// 1) loads current settings from chrome.storage.sync,
// 2) renders activation state, debug toggle, and ad counters,
// 3) persists user changes back to storage,
// 4) displays a build serial so you can verify the exact loaded code.
(() => {
  // Build serial shown in popup to confirm the latest loaded extension build.
  const BUILD_SERIAL = 'AASFY-PR-2026-03-17-04';

  // Fallback defaults used when storage is empty for first-time users.
  const DEFAULTS = {
    activationState: 'active',
    debugMode: false
  };

  // Shared storage keys so reads/writes remain consistent and typo-safe.
  const STORAGE_KEYS = {
    activationState: 'activationState',
    debugMode: 'debugMode'
  };

  // Wait for the popup DOM to be fully available before binding handlers.
  document.addEventListener('DOMContentLoaded', () => {
    // Cache element references for all interactive controls.
    const activateButton = document.getElementById('activateButton');
    const statusPill = document.getElementById('statusPill');
    const debugToggle = document.getElementById('debugToggle');
    const buildSerialLabel = document.getElementById('buildSerialLabel');
    const sessionAdCountEl = document.getElementById('sessionAdCount');
    const lifetimeAdCountEl = document.getElementById('lifetimeAdCount');

    // Show current build serial in popup for merge/deploy verification.
    buildSerialLabel.textContent = `Build serial: ${BUILD_SERIAL}`;

    // Load ad counters from storage.
    const refreshAdCounts = () => {
      chrome.storage.local.get({ sessionAdCount: 0, lifetimeAdCount: 0 }, (data) => {
        sessionAdCountEl.textContent = data.sessionAdCount;
        lifetimeAdCountEl.textContent = data.lifetimeAdCount;
      });
    };

    refreshAdCounts();

    // Updates button + status pill visuals for active/inactive state.
    const renderActivationState = (activationState) => {
      const isActive = activationState === 'active';
      activateButton.textContent = isActive ? 'Deactivate' : 'Activate';
      statusPill.textContent = isActive ? 'Status: Active' : 'Status: Inactive';
      statusPill.classList.toggle('active', isActive);
      statusPill.classList.toggle('inactive', !isActive);
    };

    // Reads all relevant values from storage and paints full popup state.
    const refreshUIFromStorage = () => {
      chrome.storage.sync.get(DEFAULTS, (data) => {
        renderActivationState(data.activationState);
        debugToggle.checked = Boolean(data.debugMode);
      });
    };

    // Toggle active/inactive setting and update UI immediately.
    activateButton.addEventListener('click', () => {
      chrome.storage.sync.get(DEFAULTS, (data) => {
        const isActive = data.activationState === 'active';
        const newActivationState = isActive ? 'inactive' : 'active';
        chrome.storage.sync.set({ [STORAGE_KEYS.activationState]: newActivationState }, () => {
          renderActivationState(newActivationState);
        });
      });
    });

    // Persist debug mode toggle so content script can emit detailed logs.
    debugToggle.addEventListener('change', () => {
      chrome.storage.sync.set({ [STORAGE_KEYS.debugMode]: debugToggle.checked });
    });

    // Live-sync popup UI when any relevant storage key changes elsewhere.
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.sessionAdCount || changes.lifetimeAdCount) {
          refreshAdCounts();
        }
        return;
      }

      if (areaName !== 'sync') {
        return;
      }

      if (changes.activationState) {
        renderActivationState(changes.activationState.newValue);
      }

      if (changes.debugMode) {
        debugToggle.checked = Boolean(changes.debugMode.newValue);
      }
    });

    // Initial render.
    refreshUIFromStorage();
  });
})();

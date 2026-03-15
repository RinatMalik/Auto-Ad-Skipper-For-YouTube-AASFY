// popup.js
//
// This script powers the extension popup UI. It:
// 1) loads current settings from chrome.storage.sync,
// 2) renders current activation + debug + custom identifiers,
// 3) persists user changes back to storage,
// 4) displays a build serial so you can verify the exact loaded code.
(() => {
  // Build serial shown in popup to confirm the latest loaded extension build.
  const BUILD_SERIAL = 'AASFY-PR-2026-03-15-02';

  // Fallback defaults used when storage is empty for first-time users.
  const DEFAULTS = {
    activationState: 'active',
    debugMode: false,
    customSkipIdentifiers: []
  };

  // Shared storage keys so reads/writes remain consistent and typo-safe.
  const STORAGE_KEYS = {
    activationState: 'activationState',
    debugMode: 'debugMode',
    customSkipIdentifiers: 'customSkipIdentifiers'
  };

  // Sanitizes user-provided identifier entries before persisting/rendering.
  const sanitizeIdentifiers = (value) => {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
      .slice(0, 25);
  };

  // Wait for the popup DOM to be fully available before binding handlers.
  document.addEventListener('DOMContentLoaded', () => {
    // Cache element references for all interactive controls.
    const activateButton = document.getElementById('activateButton');
    const statusPill = document.getElementById('statusPill');
    const debugToggle = document.getElementById('debugToggle');
    const customIdentifierInput = document.getElementById('customIdentifierInput');
    const addIdentifierButton = document.getElementById('addIdentifierButton');
    const identifierList = document.getElementById('identifierList');
    const buildSerialLabel = document.getElementById('buildSerialLabel');

    // Show current build serial in popup for merge/deploy verification.
    buildSerialLabel.textContent = `Build serial: ${BUILD_SERIAL}`;

    // Updates button + status pill visuals for active/inactive state.
    const renderActivationState = (activationState) => {
      const isActive = activationState === 'active';
      activateButton.textContent = isActive ? 'Deactivate' : 'Activate';
      statusPill.textContent = isActive ? 'Status: Active' : 'Status: Inactive';
      statusPill.classList.toggle('active', isActive);
      statusPill.classList.toggle('inactive', !isActive);
    };

    // Renders the custom identifier list and wires per-item remove actions.
    const renderIdentifierList = (identifiers) => {
      const sanitized = sanitizeIdentifiers(identifiers);
      identifierList.innerHTML = '';

      // Empty state row for clarity when no custom identifiers exist.
      if (sanitized.length === 0) {
        const emptyItem = document.createElement('li');
        emptyItem.className = 'empty';
        emptyItem.textContent = 'No custom identifiers added yet.';
        identifierList.appendChild(emptyItem);
        return;
      }

      // Build one row per identifier with an inline remove button.
      sanitized.forEach((identifier, index) => {
        const item = document.createElement('li');
        const text = document.createElement('code');
        text.textContent = identifier;

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'remove';
        removeButton.textContent = 'Remove';
        removeButton.addEventListener('click', () => {
          chrome.storage.sync.get(DEFAULTS, (data) => {
            const nextIdentifiers = sanitizeIdentifiers(data.customSkipIdentifiers).filter((_, itemIndex) => itemIndex !== index);
            chrome.storage.sync.set({ [STORAGE_KEYS.customSkipIdentifiers]: nextIdentifiers }, () => {
              renderIdentifierList(nextIdentifiers);
            });
          });
        });

        item.appendChild(text);
        item.appendChild(removeButton);
        identifierList.appendChild(item);
      });
    };

    // Reads all relevant values from storage and paints full popup state.
    const refreshUIFromStorage = () => {
      chrome.storage.sync.get(DEFAULTS, (data) => {
        renderActivationState(data.activationState);
        debugToggle.checked = Boolean(data.debugMode);
        renderIdentifierList(data.customSkipIdentifiers);
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

    // Add new custom selector/text identifier used in skip target detection.
    addIdentifierButton.addEventListener('click', () => {
      const value = customIdentifierInput.value.trim();
      if (!value) {
        return;
      }

      chrome.storage.sync.get(DEFAULTS, (data) => {
        const existing = sanitizeIdentifiers(data.customSkipIdentifiers);
        if (existing.includes(value)) {
          customIdentifierInput.value = '';
          return;
        }

        const nextIdentifiers = sanitizeIdentifiers([...existing, value]);
        chrome.storage.sync.set({ [STORAGE_KEYS.customSkipIdentifiers]: nextIdentifiers }, () => {
          customIdentifierInput.value = '';
          renderIdentifierList(nextIdentifiers);
        });
      });
    });

    // Enter key shortcut to add a custom identifier without mouse click.
    customIdentifierInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        addIdentifierButton.click();
      }
    });

    // Live-sync popup UI when any relevant storage key changes elsewhere.
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') {
        return;
      }

      if (changes.activationState) {
        renderActivationState(changes.activationState.newValue);
      }

      if (changes.debugMode) {
        debugToggle.checked = Boolean(changes.debugMode.newValue);
      }

      if (changes.customSkipIdentifiers) {
        renderIdentifierList(changes.customSkipIdentifiers.newValue);
      }
    });

    // Initial render.
    refreshUIFromStorage();
  });
})();

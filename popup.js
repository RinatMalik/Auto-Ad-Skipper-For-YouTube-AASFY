// popup.js
(() => {
  const DEFAULTS = {
    activationState: 'active',
    debugMode: false,
    customSkipIdentifiers: []
  };

  const STORAGE_KEYS = {
    activationState: 'activationState',
    debugMode: 'debugMode',
    customSkipIdentifiers: 'customSkipIdentifiers'
  };

  const sanitizeIdentifiers = (value) => {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
      .slice(0, 25);
  };

  document.addEventListener('DOMContentLoaded', () => {
    const activateButton = document.getElementById('activateButton');
    const statusPill = document.getElementById('statusPill');
    const debugToggle = document.getElementById('debugToggle');
    const customIdentifierInput = document.getElementById('customIdentifierInput');
    const addIdentifierButton = document.getElementById('addIdentifierButton');
    const identifierList = document.getElementById('identifierList');

    const renderActivationState = (activationState) => {
      const isActive = activationState === 'active';
      activateButton.textContent = isActive ? 'Deactivate' : 'Activate';
      statusPill.textContent = isActive ? 'Status: Active' : 'Status: Inactive';
      statusPill.classList.toggle('active', isActive);
      statusPill.classList.toggle('inactive', !isActive);
    };

    const renderIdentifierList = (identifiers) => {
      const sanitized = sanitizeIdentifiers(identifiers);
      identifierList.innerHTML = '';

      if (sanitized.length === 0) {
        const emptyItem = document.createElement('li');
        emptyItem.className = 'empty';
        emptyItem.textContent = 'No custom identifiers added yet.';
        identifierList.appendChild(emptyItem);
        return;
      }

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

    const refreshUIFromStorage = () => {
      chrome.storage.sync.get(DEFAULTS, (data) => {
        renderActivationState(data.activationState);
        debugToggle.checked = Boolean(data.debugMode);
        renderIdentifierList(data.customSkipIdentifiers);
      });
    };

    activateButton.addEventListener('click', () => {
      chrome.storage.sync.get(DEFAULTS, (data) => {
        const isActive = data.activationState === 'active';
        const newActivationState = isActive ? 'inactive' : 'active';
        chrome.storage.sync.set({ [STORAGE_KEYS.activationState]: newActivationState }, () => {
          renderActivationState(newActivationState);
        });
      });
    });

    debugToggle.addEventListener('change', () => {
      chrome.storage.sync.set({ [STORAGE_KEYS.debugMode]: debugToggle.checked });
    });

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

    customIdentifierInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        addIdentifierButton.click();
      }
    });

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

    refreshUIFromStorage();
  });
})();

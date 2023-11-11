// popup.js
document.addEventListener('DOMContentLoaded', function() {
    const activateButton = document.getElementById('activateButton');
  
    // Retrieve the current extension activation state from Chrome storage
    chrome.storage.sync.get('activationState', function(data) {
      const isActive = data.activationState === 'active';
  
      // Update the button text based on the activation state
      activateButton.textContent = isActive ? 'Deactivate' : 'Activate';
    });
  
    // Toggle the extension activation state when the button is clicked
    activateButton.addEventListener('click', function() {
      chrome.storage.sync.get('activationState', function(data) {
        const isActive = data.activationState === 'active';
        const newActivationState = isActive ? 'inactive' : 'active';
  
        // Save the updated activation state to Chrome storage
        chrome.storage.sync.set({ 'activationState': newActivationState });
  
        // Update the button text based on the new activation state
        activateButton.textContent = newActivationState === 'active' ? 'Deactivate' : 'Activate';
      });
    });
  });
  
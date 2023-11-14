// content.js
chrome.storage.sync.get('activationState', function(data) {

    // Set the initial state to 'active' if not set
    const initialActivationState = data.activationState || 'active';
    chrome.storage.sync.set({ activationState: initialActivationState });

    const isActive = initialActivationState === 'active';
  
    if (isActive) {
      console.log("Auto Ad Skipper for YouTube Extension is Active");


      const clickSkipAd = () => {
         const skipAdButton = document.querySelector('.ytp-ad-skip-button-container');
  
        if (skipAdButton) {
          
          skipAdButton.click();
          console.log("------------------Clicked Skip Ad button------------------");      


        } else {
          console.log("Searching for Skip Ad button");
        }
      };
  
      
      // Check for the "Skip Ad" button every 2 seconds
      const intervalId = setInterval(clickSkipAd, 2000);

      // Check if the page has fully loaded before attempting to click the "Skip Ad" button
      window.addEventListener('load', clickSkipAd);

      // Listen for the page unload event (new video)
      window.onbeforeunload = () => {

       // Clear the interval when the page unloads
       clearInterval(intervalId);

      }
    }
  });
  
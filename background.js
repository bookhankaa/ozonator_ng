chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'showResult') {
    chrome.tabs.create({
      url: 'result.html',
      active: true
    });
  }
});

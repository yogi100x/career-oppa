import { readVisibleRolePage } from './read-page';

export async function captureActiveRolePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url))
    throw new Error('Open a job posting on an ordinary website first.');
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: readVisibleRolePage,
  });
  if (!result?.result || result.result.text.trim().length < 120)
    throw new Error(
      'There is too little visible job text. Paste the description in the web app instead.',
    );
  if (result.result.text.length > 100_000)
    throw new Error(
      'This page has too much text. Paste just the job description in the web app.',
    );
  return result.result;
}

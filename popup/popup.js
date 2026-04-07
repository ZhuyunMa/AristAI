const providerInput = document.getElementById("providerInput");
const baseUrlInput = document.getElementById("baseUrlInput");
const modelInput = document.getElementById("modelInput");
const settingsStatus = document.getElementById("settingsStatus");

function renderSettingsStatus(settings) {
  const lines = [
    `Provider: ${settings.provider}`,
    `Model: ${settings.model}`,
    `Base URL: ${settings.baseUrl}`
  ];

  settingsStatus.textContent = lines.join("\n");
}

chrome.runtime.sendMessage({ type: "GET_AI_SETTINGS" }, (response) => {
  if (!response) {
    return;
  }

  providerInput.value = response.provider || "ollama";
  baseUrlInput.value = response.baseUrl || "http://127.0.0.1:11434";
  modelInput.value = response.model || "qwen3:8b";
  renderSettingsStatus({
    provider: response.provider || "ollama",
    baseUrl: response.baseUrl || "http://127.0.0.1:11434",
    model: response.model || "qwen3:8b"
  });
});

document.getElementById("openSidebarBtn").addEventListener("click", async () => {
  chrome.runtime.sendMessage({ type: "GET_CURRENT_TAB" }, (response) => {
    const tabId = response?.tab?.id;
    if (!tabId) return;

    chrome.sidePanel.open({ tabId }).catch((error) => {
      console.error("Failed to open side panel:", error);
    });
  });
});

document.getElementById("saveSettingsBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({
    type: "SAVE_AI_SETTINGS",
    provider: providerInput.value,
    baseUrl: baseUrlInput.value,
    apiKey: "",
    model: modelInput.value
  }, (response) => {
    if (!response?.success) {
      settingsStatus.textContent = "Failed to save AI settings.";
      return;
    }

    renderSettingsStatus({
      provider: response.provider || "ollama",
      baseUrl: response.baseUrl || "http://127.0.0.1:11434",
      model: response.model || "qwen3:8b"
    });
  });
});

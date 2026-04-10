const providerInput = document.getElementById("providerInput");
const baseUrlInput = document.getElementById("baseUrlInput");
const modelInput = document.getElementById("modelInput");
const apiKeyInput = document.getElementById("apiKeyInput");
const notebookTargetInput = document.getElementById("notebookTargetInput");
const openNotebookUrlInput = document.getElementById("openNotebookUrlInput");
const settingsStatus = document.getElementById("settingsStatus");

function renderSettingsStatus(settings) {
  const lines = [
    `Provider: ${settings.provider}`,
    `Model: ${settings.model}`,
    `Base URL: ${settings.baseUrl}`,
    `API Key: ${settings.apiKey ? "saved" : "not set"}`,
    `Optional External App: ${settings.notebookTarget || "open-notebook"}`,
    `Optional App URL: ${settings.openNotebookUrl || "http://localhost:8502"}`
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
  apiKeyInput.value = response.apiKey || "";
  notebookTargetInput.value = response.notebookTarget || "open-notebook";
  openNotebookUrlInput.value = response.openNotebookUrl || "http://localhost:8502";
  renderSettingsStatus({
    provider: response.provider || "ollama",
    baseUrl: response.baseUrl || "http://127.0.0.1:11434",
    model: response.model || "qwen3:8b",
    apiKey: response.apiKey || "",
    notebookTarget: response.notebookTarget || "open-notebook",
    openNotebookUrl: response.openNotebookUrl || "http://localhost:8502"
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

document.getElementById("openExternalAppBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_NOTEBOOK_TARGET" }, (response) => {
    if (!response?.success) {
      settingsStatus.textContent = "Failed to open external app.";
      return;
    }

    settingsStatus.textContent = [
      `Opened: ${response.target || "open-notebook"}`,
      `URL: ${response.url || "unknown"}`
    ].join("\n");
  });
});

document.getElementById("saveSettingsBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({
    type: "SAVE_AI_SETTINGS",
    provider: providerInput.value,
    baseUrl: baseUrlInput.value,
    apiKey: apiKeyInput.value,
    model: modelInput.value,
    notebookTarget: notebookTargetInput.value,
    openNotebookUrl: openNotebookUrlInput.value
  }, (response) => {
    if (!response?.success) {
      settingsStatus.textContent = "Failed to save AI settings.";
      return;
    }

    renderSettingsStatus({
      provider: response.provider || "ollama",
      baseUrl: response.baseUrl || "http://127.0.0.1:11434",
      model: response.model || "qwen3:8b",
      apiKey: response.apiKey || "",
      notebookTarget: response.notebookTarget || "open-notebook",
      openNotebookUrl: response.openNotebookUrl || "http://localhost:8502"
    });
  });
});

const AI_SETTINGS_KEY = "aiSettings";
const DEFAULT_AI_SETTINGS = {
  provider: "ollama",
  model: "qwen3:8b",
  baseUrl: "http://127.0.0.1:11434",
  apiKey: ""
};

function normalizeAiSettings(rawSettings) {
  const settings = rawSettings || {};
  return {
    provider: String(settings.provider || DEFAULT_AI_SETTINGS.provider).trim() || DEFAULT_AI_SETTINGS.provider,
    model: String(settings.model || DEFAULT_AI_SETTINGS.model).trim() || DEFAULT_AI_SETTINGS.model,
    baseUrl: String(settings.baseUrl || DEFAULT_AI_SETTINGS.baseUrl).trim() || DEFAULT_AI_SETTINGS.baseUrl,
    apiKey: String(settings.apiKey || "").trim()
  };
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("AristAI installed.");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "OPEN_SIDEPANEL") {
    if (sender.tab && sender.tab.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).then(() => {
        sendResponse({ success: true });
      }).catch((error) => {
        const messageText = String(error?.message || error);
        if (!messageText.includes("user gesture")) {
          console.warn("Failed to open side panel:", error);
        }
        sendResponse({ success: false, error: error.message });
      });
      return true;
    }

    sendResponse({ success: false, error: "Missing sender tab." });
    return false;
  }

  if (message.type === "OPEN_NOTEBOOKLM") {
    chrome.tabs.create({ url: "https://notebooklm.google.com/" }, (tab) => {
      sendResponse({ success: true, tabId: tab?.id });
    });
    return true;
  }

  if (message.type === "GET_PAGE_CAPTION_TRACKS") {
    if (!sender.tab?.id) {
      sendResponse({ success: false, error: "Missing sender tab." });
      return false;
    }

    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: () => {
        function normalizeTracks(rawTracks) {
          if (!Array.isArray(rawTracks)) {
            return [];
          }

          return rawTracks
            .filter((track) => track?.baseUrl)
            .map((track) => ({
              baseUrl: track.baseUrl,
              languageCode: track.languageCode || "",
              kind: track.kind || "",
              name: track.name || null
            }));
        }

        let playerResponse = window.ytInitialPlayerResponse || window.__INITIAL_PLAYER_RESPONSE__ || null;

        if (!playerResponse) {
          try {
            const serialized = window.ytplayer?.config?.args?.player_response;
            if (serialized) {
              playerResponse = JSON.parse(serialized);
            }
          } catch (_error) {
            playerResponse = null;
          }
        }

        const responseTracks = normalizeTracks(
          playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks
        );

        if (responseTracks.length) {
          return responseTracks;
        }

        const player = document.getElementById("movie_player");
        if (!player?.getOption) {
          return [];
        }

        const tracklist =
          player.getOption("captions", "tracklist") ||
          player.getOption("captions", "tracklistRenderer") ||
          null;

        return normalizeTracks(
          tracklist?.captionTracks ||
          tracklist?.tracks ||
          tracklist?.playerCaptionsTracklistRenderer?.captionTracks
        );
      }
    }).then((results) => {
      sendResponse({
        success: true,
        tracks: results?.[0]?.result || []
      });
    }).catch((error) => {
      sendResponse({
        success: false,
        error: String(error?.message || error)
      });
    });

    return true;
  }

  if (message.type === "GET_CURRENT_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ tab: tabs[0] || null });
    });
    return true;
  }

  if (message.type === "GET_AI_SETTINGS") {
    chrome.storage.local.get([AI_SETTINGS_KEY], (result) => {
      const settings = normalizeAiSettings(result[AI_SETTINGS_KEY]);
      sendResponse({
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        hasApiKey: Boolean(settings.apiKey),
        model: settings.model
      });
    });
    return true;
  }

  if (message.type === "SAVE_AI_SETTINGS") {
    const settings = normalizeAiSettings({
      provider: message.provider,
      baseUrl: message.baseUrl,
      apiKey: message.apiKey,
      model: message.model
    });

    chrome.storage.local.set({
      [AI_SETTINGS_KEY]: settings
    }, () => {
      sendResponse({
        success: true,
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        hasApiKey: Boolean(settings.apiKey),
        model: settings.model
      });
    });
    return true;
  }

  if (message.type === "ASK_AI") {
    chrome.storage.local.get([AI_SETTINGS_KEY], async (result) => {
      try {
        const settings = normalizeAiSettings(result[AI_SETTINGS_KEY]);

        const inputText = String(message.input || "").trim();
        if (!inputText) {
          sendResponse({ success: false, error: "Missing AI input." });
          return;
        }

        if (settings.provider === "openai") {
          if (!settings.apiKey) {
            sendResponse({ success: false, error: "Missing OpenAI API key." });
            return;
          }

          const response = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${settings.apiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: settings.model,
              input: inputText
            })
          });

          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            sendResponse({
              success: false,
              error: data?.error?.message || `OpenAI request failed with status ${response.status}.`
            });
            return;
          }

          sendResponse({
            success: true,
            provider: "openai",
            text: data.output_text || ""
          });
          return;
        }

        const ollamaUrl = `${settings.baseUrl.replace(/\/$/, "")}/api/generate`;
        const response = await fetch(ollamaUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: settings.model,
            prompt: inputText,
            stream: false
          })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          sendResponse({
            success: false,
            error: data?.error || `Ollama request failed with status ${response.status}.`
          });
          return;
        }

        sendResponse({
          success: true,
          provider: "ollama",
          text: data.response || ""
        });
      } catch (error) {
        sendResponse({
          success: false,
          error: String(error?.message || error)
        });
      }
    });
    return true;
  }

  if (message.type === "QUEUE_UPDATED") {
    sendResponse({ success: true });
    return false;
  }

  sendResponse({ success: false, error: `Unhandled message type: ${message?.type || "unknown"}` });
  return false;
});

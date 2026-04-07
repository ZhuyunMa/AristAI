(function () {
  const BUTTON_ID = "aristai-add-button";
  const BUTTON_CONTAINER_ID = "aristai-button-container";

  let observer = null;
  let navigationTimer = null;
  let contextInvalidated = false;
  let lastVideoId = null;

  function markContextInvalidated(error) {
    const message = String(error?.message || error || "");
    if (!message.includes("Extension context invalidated")) {
      return false;
    }

    contextInvalidated = true;

    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (navigationTimer) {
      window.clearTimeout(navigationTimer);
      navigationTimer = null;
    }

    console.warn("AristAI content script stopped because the extension context was invalidated.");
    return true;
  }

  function isRuntimeAvailable() {
    if (contextInvalidated || typeof chrome === "undefined" || !chrome?.runtime?.id) {
      return false;
    }

    try {
      return Boolean(chrome.storage?.local && chrome.runtime?.sendMessage);
    } catch (error) {
      return !markContextInvalidated(error);
    }
  }

  function isWatchPage() {
    return location.pathname === "/watch" && Boolean(new URLSearchParams(location.search).get("v"));
  }

  function getVideoIdFromUrl() {
    return new URLSearchParams(location.search).get("v");
  }

  function getCurrentVideoData() {
    const id = getVideoIdFromUrl();
    if (!id) {
      return null;
    }

    const title =
      document.querySelector("ytd-watch-metadata h1 yt-formatted-string")?.textContent?.trim() ||
      document.querySelector("h1.title yt-formatted-string")?.textContent?.trim() ||
      document.querySelector("meta[name='title']")?.getAttribute("content") ||
      document.title.replace(/\s*-\s*YouTube\s*$/, "").trim();

    const channel =
      document.querySelector("#owner #channel-name a")?.textContent?.trim() ||
      document.querySelector("ytd-channel-name a")?.textContent?.trim() ||
      document.querySelector("meta[itemprop='author']")?.getAttribute("content") ||
      "";

    const description =
      document.querySelector("#description-inline-expander")?.textContent?.trim() ||
      document.querySelector("#description yt-attributed-string")?.textContent?.trim() ||
      document.querySelector('meta[name="description"]')?.getAttribute("content") ||
      "";

    return {
      id,
      title: title || "Untitled YouTube Video",
      channel,
      description: normalizeWhitespace(description),
      url: `https://www.youtube.com/watch?v=${id}`,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
    };
  }

  function normalizeWhitespace(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeHtmlEntities(text) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return textarea.value;
  }

  function extractBalancedJson(text, startIndex) {
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === "\\") {
        escapeNext = true;
        continue;
      }

      if (char === "\"") {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(startIndex, index + 1);
        }
      }
    }

    return "";
  }

  function parsePlayerResponseFromText(text) {
    const markers = [
      "var ytInitialPlayerResponse = ",
      "window[\"ytInitialPlayerResponse\"] = ",
      "ytInitialPlayerResponse = "
    ];

    for (const marker of markers) {
      const markerIndex = text.indexOf(marker);
      if (markerIndex === -1) {
        continue;
      }

      const jsonStart = text.indexOf("{", markerIndex + marker.length);
      if (jsonStart === -1) {
        continue;
      }

      const jsonText = extractBalancedJson(text, jsonStart);
      if (!jsonText) {
        continue;
      }

      try {
        return JSON.parse(jsonText);
      } catch (error) {
        console.warn("Failed to parse ytInitialPlayerResponse:", error);
      }
    }

    return null;
  }

  function getCaptionTracksFromPlayerResponse(playerResponse) {
    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
      [];

    return Array.isArray(tracks) ? tracks : [];
  }

  function getCaptionTracksFromCurrentDocument() {
    const scripts = Array.from(document.scripts);

    for (const script of scripts) {
      const text = script.textContent || "";
      if (!text.includes("ytInitialPlayerResponse")) {
        continue;
      }

      const playerResponse = parsePlayerResponseFromText(text);
      const tracks = getCaptionTracksFromPlayerResponse(playerResponse);
      if (tracks.length) {
        return tracks;
      }
    }

    return [];
  }

  async function getCaptionTracksFromPageBridge() {
    const response = await sendRuntimeMessage({ type: "GET_PAGE_CAPTION_TRACKS" });
    if (!response?.success || !Array.isArray(response.tracks)) {
      return [];
    }

    return response.tracks;
  }

  function getCaptionTracksFromWatchHtml(html) {
    const playerResponse = parsePlayerResponseFromText(html);
    return getCaptionTracksFromPlayerResponse(playerResponse);
  }

  function getTrackLabel(track) {
    const simpleText = track?.name?.simpleText;
    if (simpleText) {
      return simpleText;
    }

    const runs = track?.name?.runs;
    if (Array.isArray(runs) && runs.length) {
      return runs.map((run) => run.text || "").join("").trim();
    }

    return "";
  }

  function normalizeTranscriptChunks(chunks) {
    const seen = new Set();
    const ordered = [];

    for (const chunk of chunks) {
      const normalized = normalizeWhitespace(decodeHtmlEntities(chunk));
      if (!normalized || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      ordered.push(normalized);
    }

    return ordered.join(" ");
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function getTranscriptFromVideoTextTracks() {
    const video = document.querySelector("video");
    if (!video?.textTracks?.length) {
      return "";
    }

    const preferredLanguages = ["en", "en-US", "en-GB", "zh", "zh-CN", "zh-Hans", "zh-TW"];
    const textTracks = Array.from(video.textTracks || []);
    const candidateTracks = textTracks.filter((track) => {
      const kind = String(track.kind || "").toLowerCase();
      return kind === "captions" || kind === "subtitles";
    });

    const rankedTracks = candidateTracks.sort((a, b) => {
      const aLang = String(a.language || "");
      const bLang = String(b.language || "");
      const aRank = preferredLanguages.findIndex((lang) => aLang === lang || aLang.startsWith(lang));
      const bRank = preferredLanguages.findIndex((lang) => bLang === lang || bLang.startsWith(lang));
      return (aRank === -1 ? 999 : aRank) - (bRank === -1 ? 999 : bRank);
    });

    for (const track of rankedTracks) {
      let originalMode = track.mode;
      try {
        if (track.mode === "disabled") {
          track.mode = "hidden";
        }

        for (let attempt = 0; attempt < 4; attempt += 1) {
          const cues = Array.from(track.cues || []);
          const transcript = normalizeTranscriptChunks(cues.map((cue) => cue.text || ""));
          if (transcript) {
            return transcript;
          }

          await sleep(250);
        }
      } catch (error) {
        console.warn("Failed to read video text tracks:", error);
      } finally {
        try {
          track.mode = originalMode;
        } catch (_error) {
          // ignore mode reset failures
        }
      }
    }

    return "";
  }

  function getInteractiveElements() {
    return Array.from(document.querySelectorAll("button, [role='button'], tp-yt-paper-button, yt-button-view-model button"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
  }

  function findClickableByPatterns(patterns) {
    const regexes = patterns.map((pattern) => pattern instanceof RegExp ? pattern : new RegExp(pattern, "i"));
    return getInteractiveElements().find((element) => {
      const text = normalizeWhitespace(
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent
      ).toLowerCase();

      return regexes.some((regex) => regex.test(text));
    }) || null;
  }

  function extractTranscriptFromPanel() {
    const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript"]');
    if (!panel) {
      return "";
    }

    const segmentNodes = Array.from(
      panel.querySelectorAll(
        "ytd-transcript-segment-renderer #segment-text, ytd-transcript-segment-renderer .segment-text, ytd-transcript-segment-renderer yt-formatted-string"
      )
    );

    if (!segmentNodes.length) {
      return "";
    }

    const transcript = normalizeTranscriptChunks(
      segmentNodes.map((node) => node.textContent || "").filter((text) => {
        const normalized = normalizeWhitespace(text);
        return normalized && !/^\d{1,2}:\d{2}$/.test(normalized);
      })
    );

    return transcript;
  }

  async function fetchTranscriptFromTranscriptPanel() {
    let transcript = extractTranscriptFromPanel();
    if (transcript) {
      return transcript;
    }

    const transcriptButton = findClickableByPatterns([
      /show transcript/i,
      /open transcript/i,
      /^transcript$/i
    ]);

    if (!transcriptButton) {
      return "";
    }

    transcriptButton.click();

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(250);
      transcript = extractTranscriptFromPanel();
      if (transcript) {
        return transcript;
      }
    }

    return "";
  }

  function chooseTranscriptTrack(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) {
      return null;
    }

    const preferredLanguages = ["en", "en-US", "en-GB", "zh", "zh-CN", "zh-Hans", "zh-TW"];

    for (const lang of preferredLanguages) {
      const exactManual = tracks.find((track) => track.languageCode === lang && track.kind !== "asr");
      if (exactManual) {
        return exactManual;
      }
    }

    for (const lang of preferredLanguages) {
      const prefixManual = tracks.find((track) => track.languageCode?.startsWith(lang) && track.kind !== "asr");
      if (prefixManual) {
        return prefixManual;
      }
    }

    const firstManual = tracks.find((track) => track.kind !== "asr");
    return firstManual || tracks[0] || null;
  }

  async function fetchTranscriptJson(track) {
    const url = new URL(track.baseUrl);
    url.searchParams.set("fmt", "json3");

    const response = await fetch(url.toString(), {
      credentials: "include"
    });

    if (!response.ok) {
      throw new Error(`Transcript request failed with status ${response.status}`);
    }

    const responseText = await response.text();
    if (!responseText.trim()) {
      throw new Error("Transcript JSON response was empty.");
    }

    const payload = JSON.parse(responseText);
    const transcript = (payload.events || [])
      .flatMap((event) => event.segs || [])
      .map((segment) => segment.utf8 || "")
      .join(" ");

    return normalizeWhitespace(decodeHtmlEntities(transcript));
  }

  async function fetchTranscriptXml(track) {
    const response = await fetch(track.baseUrl, {
      credentials: "include"
    });

    if (!response.ok) {
      throw new Error(`Transcript XML request failed with status ${response.status}`);
    }

    const xmlText = await response.text();
    const xml = new DOMParser().parseFromString(xmlText, "application/xml");
    const transcript = Array.from(xml.getElementsByTagName("text"))
      .map((node) => node.textContent || "")
      .join(" ");

    return normalizeWhitespace(decodeHtmlEntities(transcript));
  }

  async function fetchTranscriptWithFallbackFormats(track) {
    const attempts = [
      () => fetchTranscriptJson(track),
      async () => {
        const url = new URL(track.baseUrl);
        url.searchParams.set("fmt", "srv3");
        const response = await fetch(url.toString(), { credentials: "include" });
        if (!response.ok) {
          throw new Error(`Transcript srv3 request failed with status ${response.status}`);
        }

        const xmlText = await response.text();
        const xml = new DOMParser().parseFromString(xmlText, "application/xml");
        const transcript = Array.from(xml.getElementsByTagName("text"))
          .map((node) => node.textContent || "")
          .join(" ");

        return normalizeWhitespace(decodeHtmlEntities(transcript));
      },
      () => fetchTranscriptXml(track)
    ];

    for (const attempt of attempts) {
      try {
        const transcript = await attempt();
        if (transcript) {
          return transcript;
        }
      } catch (_error) {
        // try the next format
      }
    }

    return "";
  }

  async function fetchTranscriptForVideo(video) {
    try {
      let tracks = await getCaptionTracksFromPageBridge();

      if (!tracks.length) {
        tracks = getCaptionTracksFromCurrentDocument();
      }

      if (!tracks.length) {
        const response = await fetch(video.url, {
          credentials: "include"
        });

        if (!response.ok) {
          return {
            transcript: "",
            transcriptStatus: "unavailable",
            transcriptError: `Watch page request failed with status ${response.status}`
          };
        }

        const html = await response.text();
        tracks = getCaptionTracksFromWatchHtml(html);
      }

      const selectedTrack = chooseTranscriptTrack(tracks);

      if (!selectedTrack?.baseUrl) {
        let textTrackTranscript = await getTranscriptFromVideoTextTracks();
        if (!textTrackTranscript) {
          textTrackTranscript = await fetchTranscriptFromTranscriptPanel();
        }
        if (textTrackTranscript) {
          return {
            transcript: textTrackTranscript,
            transcriptStatus: "ready",
            transcriptLanguage: "",
            transcriptLabel: "video-text-track",
            transcriptFetchedAt: new Date().toISOString()
          };
        }

        return {
          transcript: "",
          transcriptStatus: "unavailable",
          transcriptError: "No transcript track available for this video."
        };
      }

      let transcript = await fetchTranscriptWithFallbackFormats(selectedTrack);

      if (!transcript) {
        transcript = await getTranscriptFromVideoTextTracks();
      }

      if (!transcript) {
        transcript = await fetchTranscriptFromTranscriptPanel();
      }

      if (!transcript) {
        return {
          transcript: "",
          transcriptStatus: "unavailable",
          transcriptError: "Transcript track was empty."
        };
      }

      return {
        transcript,
        transcriptStatus: "ready",
        transcriptLanguage: selectedTrack.languageCode || "",
        transcriptLabel: getTrackLabel(selectedTrack),
        transcriptFetchedAt: new Date().toISOString()
      };
    } catch (error) {
      console.warn("Failed to fetch transcript:", error);
      return {
        transcript: "",
        transcriptStatus: "error",
        transcriptError: String(error?.message || error)
      };
    }
  }

  function getQueueFromStorage() {
    return new Promise((resolve) => {
      if (!isRuntimeAvailable()) {
        resolve({ queue: [] });
        return;
      }

      try {
        chrome.storage.local.get(["queue"], (result) => {
          const runtimeError = chrome.runtime?.lastError;
          if (runtimeError) {
            if (!markContextInvalidated(runtimeError)) {
              console.warn("chrome.storage.local.get failed:", runtimeError.message);
            }
            resolve({ queue: [] });
            return;
          }

          resolve(result || { queue: [] });
        });
      } catch (error) {
        if (!markContextInvalidated(error)) {
          console.warn("chrome.storage.local.get threw:", error);
        }
        resolve({ queue: [] });
      }
    });
  }

  async function updateStoredVideo(videoId, updater) {
    const result = await getQueueFromStorage();
    const queue = result.queue || [];
    const nextQueue = queue.map((item) => {
      if (item.id !== videoId) {
        return item;
      }

      return typeof updater === "function" ? updater(item) : item;
    });

    await setQueueToStorage(nextQueue);
    return nextQueue.find((item) => item.id === videoId) || null;
  }

  function setQueueToStorage(queue) {
    return new Promise((resolve) => {
      if (!isRuntimeAvailable()) {
        resolve(false);
        return;
      }

      try {
        chrome.storage.local.set({ queue }, () => {
          const runtimeError = chrome.runtime?.lastError;
          if (runtimeError) {
            if (!markContextInvalidated(runtimeError)) {
              console.warn("chrome.storage.local.set failed:", runtimeError.message);
            }
            resolve(false);
            return;
          }

          resolve(true);
        });
      } catch (error) {
        if (!markContextInvalidated(error)) {
          console.warn("chrome.storage.local.set threw:", error);
        }
        resolve(false);
      }
    });
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      if (!isRuntimeAvailable()) {
        resolve({ success: false, contextInvalidated });
        return;
      }

      try {
        chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime?.lastError;
          if (runtimeError) {
            if (!markContextInvalidated(runtimeError)) {
              console.warn(`Runtime message ${message.type} failed:`, runtimeError.message);
            }
            resolve({ success: false, error: runtimeError.message });
            return;
          }

          resolve(response || { success: true });
        });
      } catch (error) {
        if (!markContextInvalidated(error)) {
          console.warn(`Runtime message ${message.type} threw:`, error);
        }
        resolve({ success: false, error: String(error?.message || error) });
      }
    });
  }

  function applyButtonState(btn, exists) {
    btn.textContent = exists ? "Already Added" : "Add to AristAI";
    btn.disabled = false;
    btn.style.opacity = exists ? "0.78" : "1";
    btn.style.cursor = "pointer";
  }

  async function focusCurrentVideoInSidebar(videoId) {
    await sendRuntimeMessage({
      type: "QUEUE_UPDATED",
      payload: { videoId }
    });
  }

  async function addCurrentVideoToQueue() {
    const video = getCurrentVideoData();
    if (!video) {
      alert("AristAI could not detect a YouTube video on this page.");
      return;
    }

    const sidePanelRequest = sendRuntimeMessage({ type: "OPEN_SIDEPANEL" });
    const transcriptData = await fetchTranscriptForVideo(video);
    const result = await getQueueFromStorage();
    const queue = result.queue || [];
    const existingItem = queue.find((item) => item.id === video.id);
    const exists = Boolean(existingItem);

    if (!exists) {
      queue.unshift({
        ...video,
        ...transcriptData
      });
      await setQueueToStorage(queue);
    } else if (!existingItem.transcript) {
      const nextQueue = queue.map((item) => {
        if (item.id !== video.id) {
          return item;
        }

        return {
          ...item,
          ...video,
          ...transcriptData
        };
      });
      await setQueueToStorage(nextQueue);
    }

    await focusCurrentVideoInSidebar(video.id);
    await sidePanelRequest;

    const btn = document.getElementById(BUTTON_ID);
    if (btn) {
      applyButtonState(btn, true);
    }
  }

  async function updateButtonState() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) {
      return;
    }

    if (!isWatchPage()) {
      btn.remove();
      document.getElementById(BUTTON_CONTAINER_ID)?.remove();
      return;
    }

    const video = getCurrentVideoData();
    if (!video) {
      applyButtonState(btn, false);
      return;
    }

    const result = await getQueueFromStorage();
    const queue = result.queue || [];
    const exists = queue.some((item) => item.id === video.id);
    applyButtonState(btn, exists);
  }

  function createButton() {
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "Add to AristAI";
    button.style.padding = "8px 14px";
    button.style.borderRadius = "18px";
    button.style.border = "1px solid rgba(0, 0, 0, 0.12)";
    button.style.background = "#111111";
    button.style.color = "#ffffff";
    button.style.fontSize = "14px";
    button.style.fontWeight = "600";
    button.style.lineHeight = "20px";
    button.style.cursor = "pointer";
    button.style.marginLeft = "8px";
    button.style.transition = "opacity 120ms ease";
    button.addEventListener("click", addCurrentVideoToQueue);
    return button;
  }

  function findInjectionTarget() {
    return (
      document.querySelector("#top-level-buttons-computed") ||
      document.querySelector("#menu #top-level-buttons-computed") ||
      document.querySelector("ytd-watch-metadata #actions-inner") ||
      null
    );
  }

  function injectButton() {
    if (!isWatchPage() || contextInvalidated) {
      return;
    }

    const target = findInjectionTarget();
    if (!target) {
      return;
    }

    let container = document.getElementById(BUTTON_CONTAINER_ID);
    let button = document.getElementById(BUTTON_ID);

    if (!container) {
      container = document.createElement("div");
      container.id = BUTTON_CONTAINER_ID;
      container.style.display = "inline-flex";
      container.style.alignItems = "center";
      target.prepend(container);
    } else if (container.parentElement !== target) {
      target.prepend(container);
    }

    if (!button) {
      button = createButton();
      container.appendChild(button);
    }

    updateButtonState();
  }

  function handleNavigationChange() {
    const currentVideoId = getVideoIdFromUrl();
    if (currentVideoId === lastVideoId) {
      injectButton();
      return;
    }

    lastVideoId = currentVideoId;

    if (navigationTimer) {
      window.clearTimeout(navigationTimer);
    }

    navigationTimer = window.setTimeout(() => {
      injectButton();
    }, 250);
  }

  function startObservers() {
    if (contextInvalidated) {
      return;
    }

    observer = new MutationObserver(() => {
      injectButton();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener("yt-navigate-finish", handleNavigationChange);
    window.addEventListener("popstate", handleNavigationChange);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        updateButtonState();
      }
    });
  }

  function bindRuntimeListeners() {
    if (!isRuntimeAvailable()) {
      return;
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "FETCH_TRANSCRIPT") {
        return false;
      }

      const currentVideo = getCurrentVideoData();
      if (!currentVideo || (message.videoId && currentVideo.id !== message.videoId)) {
        sendResponse({
          success: false,
          error: "Requested video is not open in this YouTube tab."
        });
        return false;
      }

      fetchTranscriptForVideo(currentVideo)
        .then(async (transcriptData) => {
          const updatedItem = await updateStoredVideo(currentVideo.id, (item) => ({
            ...item,
            ...currentVideo,
            ...transcriptData
          }));

          await sendRuntimeMessage({
            type: "QUEUE_UPDATED",
            payload: { videoId: currentVideo.id, transcriptRefetched: true }
          });

          sendResponse({
            success: Boolean(updatedItem?.transcript),
            item: updatedItem,
            error: updatedItem?.transcript ? null : updatedItem?.transcriptError || "Transcript unavailable."
          });
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: String(error?.message || error)
          });
        });

      return true;
    });
  }

  lastVideoId = getVideoIdFromUrl();
  injectButton();
  startObservers();
  bindRuntimeListeners();
})();

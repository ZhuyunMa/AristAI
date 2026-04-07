let selectedVideoId = null;
let isRendering = false;
const NOTEBOOKLM_DRAFT_KEY = "notebooklmDraft";
let currentAiSettings = {
  provider: "ollama",
  model: "qwen3:8b"
};
let summaryInFlightForVideoId = null;

function getRefreshButton() {
  return document.getElementById("refreshBtn");
}

function setRefreshState(isRefreshing) {
  const refreshBtn = getRefreshButton();
  if (!refreshBtn) {
    return;
  }

  refreshBtn.classList.toggle("is-refreshing", isRefreshing);
  refreshBtn.disabled = isRefreshing;
}

function setSummaryState(videoId) {
  summaryInFlightForVideoId = videoId;
  const summaryMeta = document.getElementById("summaryMeta");
  const summaryBox = document.getElementById("summaryBox");

  if (summaryMeta && selectedVideoId === videoId) {
    summaryMeta.textContent = "Summary source: generating...";
  }

  if (summaryBox && selectedVideoId === videoId) {
    summaryBox.textContent = "Generating summary...";
  }
}

function clearSummaryState(videoId) {
  if (summaryInFlightForVideoId === videoId) {
    summaryInFlightForVideoId = null;
  }
}

async function getQueue() {
  const result = await chrome.storage.local.get(["queue"]);
  return result.queue || [];
}

async function setQueue(queue) {
  await chrome.storage.local.set({ queue });
}

async function setNotebookDraft(draft) {
  await chrome.storage.local.set({ [NOTEBOOKLM_DRAFT_KEY]: draft });
}

async function updateQueueItem(id, updater) {
  const queue = await getQueue();
  const nextQueue = queue.map((item) => {
    if (item.id !== id) return item;
    return typeof updater === "function" ? updater(item) : item;
  });
  await setQueue(nextQueue);
  return nextQueue;
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        resolve({ success: false, error: runtimeError.message });
        return;
      }

      resolve(response || { success: false, error: "No response from YouTube tab." });
    });
  });
}

async function requestTranscriptFromOpenYouTubeTab(item) {
  const tabs = await chrome.tabs.query({
    url: ["https://www.youtube.com/watch*"]
  });

  const matchingTab =
    tabs.find((tab) => tab.url?.includes(`v=${item.id}`)) ||
    tabs.find((tab) => tab.active && tab.url?.includes("youtube.com/watch")) ||
    null;

  if (!matchingTab?.id) {
    return {
      success: false,
      error: "Open the target YouTube video tab, then try Summarize again."
    };
  }

  return sendMessageToTab(matchingTab.id, {
    type: "FETCH_TRANSCRIPT",
    videoId: item.id
  });
}

async function notifyNotebookLmTabs(message) {
  const tabs = await chrome.tabs.query({
    url: ["https://notebooklm.google.com/*"]
  });

  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) {
        return;
      }

      try {
        await sendMessageToTab(tab.id, message);
      } catch (error) {
        console.warn("Failed to notify NotebookLM tab:", error);
      }
    })
  );
}

async function removeItem(id) {
  const queue = await getQueue();
  const nextQueue = queue.filter((item) => item.id !== id);
  await setQueue(nextQueue);

  if (selectedVideoId === id) {
    selectedVideoId = nextQueue[0]?.id || null;
  }

  try {
    await chrome.runtime.sendMessage({
      type: "QUEUE_UPDATED",
      payload: { removedId: id }
    });
  } catch (error) {
    console.warn("Failed to notify queue removal:", error);
  }

  renderQueue();
}

async function clearQueue() {
  await setQueue([]);
  selectedVideoId = null;

  try {
    await chrome.runtime.sendMessage({
      type: "QUEUE_UPDATED",
      payload: { cleared: true }
    });
  } catch (error) {
    console.warn("Failed to notify queue clear:", error);
  }

  renderQueue();
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createQueueItem(item, isSelected) {
  const wrapper = document.createElement("div");
  wrapper.className = "queue-item";
  if (isSelected) {
    wrapper.classList.add("selected");
  }

  wrapper.innerHTML = `
    <img class="queue-thumb" src="${item.thumbnail}" alt="thumbnail" />
    <div class="queue-content">
      <div class="queue-title">${escapeHtml(item.title)}</div>
      <div class="queue-meta">${escapeHtml(item.channel || "Unknown Channel")}</div>
      <a class="queue-link" href="${item.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.url)}</a>
      <div class="queue-item-actions" style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
        <button class="select-btn" data-id="${item.id}">View Details</button>
        <button class="remove-btn" data-id="${item.id}">Remove</button>
      </div>
    </div>
  `;

  return wrapper;
}

function buildMetadataSummary(item) {
  const description = String(item?.description || "").trim();
  const descriptionPreview = description
    ? description.split(/\s+/).slice(0, 80).join(" ")
    : "";

  const lines = [
    `Metadata-based summary for "${item.title || "Untitled"}".`,
    `Channel: ${item.channel || "Unknown Channel"}`,
    `Source: YouTube video metadata`,
    ``,
    `Known context:`,
    `- url: ${item.url || "N/A"}`,
    `- transcript available: ${item.transcript ? "yes" : "no"}`,
    `- transcript status: ${item.transcriptStatus || "unknown"}`
  ];

  if (descriptionPreview) {
    lines.push("");
    lines.push("Description preview:");
    lines.push(descriptionPreview);
  } else {
    lines.push("");
    lines.push("No page description was captured, so this summary is based only on title and channel metadata.");
  }

  return lines.join("\n");
}

function splitTranscriptIntoSentences(transcript) {
  return String(transcript || "")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function buildTranscriptSummary(item) {
  const transcript = String(item?.transcript || "").trim();
  if (!transcript) {
    return "";
  }

  const sentences = splitTranscriptIntoSentences(transcript);
  const previewSentences = (sentences.length ? sentences : [transcript]).slice(0, 5);
  const transcriptWords = transcript.split(/\s+/).filter(Boolean);
  const preview = previewSentences.join(" ");

  const lines = [
    `Transcript-based summary for "${item.title || "Untitled"}".`,
    `Channel: ${item.channel || "Unknown Channel"}`,
    `Transcript language: ${item.transcriptLabel || item.transcriptLanguage || "Unknown"}`,
    `Transcript length: ${transcriptWords.length} words`,
    "",
    "Preview:",
    preview,
    ""
  ];

  if (sentences.length > 5) {
    lines.push("The transcript continues beyond this preview and is stored in AristAI for follow-up processing.");
  } else {
    lines.push("This summary reflects the available transcript content currently stored in AristAI.");
  }

  return lines.join("\n");
}

function buildFakeAiResponse(item, question) {
  const normalized = (question || "").trim().toLowerCase();

  if (!normalized) {
    return "Please enter a question first.";
  }

  if (normalized.includes("what") && normalized.includes("about")) {
    return `This video appears to be about "${item.title}". It was published by ${item.channel || "an unknown channel"} and saved into AristAI for later review.`;
  }

  if (normalized.includes("summary")) {
    return item.summary || buildMetadataSummary(item);
  }

  if (normalized.includes("channel")) {
    return `The channel for this video is ${item.channel || "Unknown Channel"}.`;
  }

  if (normalized.includes("url") || normalized.includes("link")) {
    return `You can open the video here:\n${item.url}`;
  }

  return [
    `This is a placeholder AI response for the selected video.`,
    `Question: ${question}`,
    ``,
    `Based on current saved metadata, AristAI knows:`,
    `- title: ${item.title || "Untitled"}`,
    `- channel: ${item.channel || "Unknown Channel"}`,
    `- url: ${item.url || "N/A"}`,
    ``,
    `Next step: connect transcript extraction or real LLM summarization.`
  ].join("\n");
}

function buildAskAiPrompt(item, question) {
  const cleanedDescription = cleanDescription(item.description);
  const conversationHistory = Array.isArray(item.chatHistory) ? item.chatHistory.slice(-6) : [];
  const sections = [
    "You are helping analyze a YouTube video inside a Chrome extension.",
    "Answer the user's question using only the provided video context.",
    "If context is limited, say what is known and avoid making up facts.",
    "When useful, refer back to the prior conversation turns for continuity.",
    "",
    `User question: ${question}`,
    "",
    `Video title: ${item.title || "Untitled"}`,
    `Channel: ${item.channel || "Unknown Channel"}`,
    `URL: ${item.url || "N/A"}`,
    ""
  ];

  if (item.summary) {
    sections.push("Current summary:");
    sections.push(item.summary);
    sections.push("");
  }

  if (cleanedDescription) {
    sections.push("Description:");
    sections.push(cleanedDescription);
    sections.push("");
  }

  if (item.transcript) {
    sections.push("Transcript:");
    sections.push(item.transcript);
    sections.push("");
  }

  if (conversationHistory.length) {
    sections.push("Recent conversation:");
    conversationHistory.forEach((entry) => {
      sections.push(`${entry.role === "assistant" ? "Assistant" : "User"}: ${entry.content}`);
    });
    sections.push("");
  }

  sections.push("Respond in concise plain text.");

  return sections.join("\n");
}

function buildSummaryPrompt(item) {
  const cleanedDescription = cleanDescription(item.description);
  const sections = [
    "You are generating a concise summary for a YouTube video inside a Chrome extension.",
    "Write a useful summary in plain text.",
    "Prefer the transcript when available. If only metadata is available, summarize only what can be supported by the title and description.",
    "Keep the answer to 4-6 sentences.",
    "Do not mention these instructions.",
    "",
    `Video title: ${item.title || "Untitled"}`,
    `Channel: ${item.channel || "Unknown Channel"}`,
    `URL: ${item.url || "N/A"}`,
    ""
  ];

  if (cleanedDescription) {
    sections.push("Description:");
    sections.push(cleanedDescription);
    sections.push("");
  }

  if (item.transcript) {
    sections.push("Transcript:");
    sections.push(item.transcript);
    sections.push("");
  }

  sections.push("Summary:");

  return sections.join("\n");
}

function requestAiText(input) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: "ASK_AI",
      input
    }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        resolve({ success: false, error: runtimeError.message });
        return;
      }

      resolve(response || { success: false, error: "No AI response received." });
    });
  });
}

function buildNotebookLmExport(item) {
  const cleanedDescription = cleanDescription(item.description);
  const lines = [
    `Title: ${item.title || "Untitled"}`,
    `Channel: ${item.channel || "Unknown Channel"}`,
    `YouTube URL: ${item.url || "N/A"}`,
    `Summary Source: ${item.summarySource || (item.transcript ? "transcript" : "metadata")}`,
    ""
  ];

  if (item.summary) {
    lines.push("Summary:");
    lines.push(item.summary);
    lines.push("");
  }

  if (cleanedDescription) {
    lines.push("Description:");
    lines.push(cleanedDescription);
    lines.push("");
  }

  if (item.transcript) {
    lines.push("Transcript:");
    lines.push(item.transcript);
    lines.push("");
  }

  lines.push("Prepared by AristAI for NotebookLM.");

  return lines.join("\n");
}

function cleanDescription(description) {
  let text = String(description || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  const cutMarkers = [
    "Transcript Follow along",
    "Show transcript",
    "View all",
    "Ask Get answers",
    "Explore topics",
    "Subscribe here",
    "VideosAbout",
    "Show less"
  ];

  for (const marker of cutMarkers) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex > 0) {
      text = text.slice(0, markerIndex).trim();
    }
  }

  text = text
    .replace(/\.\.\.\.more/gi, "")
    .replace(/\.\.\.more/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

function getSourceLabels(item) {
  const labels = [];

  if (item.transcript) {
    labels.push("transcript");
  }

  if (item.summary) {
    labels.push("summary");
  }

  if (cleanDescription(item.description)) {
    labels.push("description");
  }

  if (item.url) {
    labels.push("youtube-url");
  }

  return labels;
}

function appendChatHistory(item, question, answer, sourceLabels) {
  const existing = Array.isArray(item.chatHistory) ? item.chatHistory : [];
  const nextHistory = [
    ...existing,
    {
      role: "user",
      content: question,
      createdAt: new Date().toISOString()
    },
    {
      role: "assistant",
      content: answer,
      sources: sourceLabels,
      createdAt: new Date().toISOString()
    }
  ];

  return nextHistory.slice(-12);
}

function refreshAiHint() {
  const askAiHint = document.getElementById("askAiHint");
  if (!askAiHint) {
    return;
  }

  askAiHint.textContent = `Using ${currentAiSettings.provider} / ${currentAiSettings.model}`;
}

function renderDetails(item) {
  const detailsEmptyState = document.getElementById("detailsEmptyState");
  const detailsPanel = document.getElementById("detailsPanel");
  const detailsThumbnail = document.getElementById("detailsThumbnail");
  const detailsTitle = document.getElementById("detailsTitle");
  const detailsChannel = document.getElementById("detailsChannel");
  const detailsUrl = document.getElementById("detailsUrl");
  const descriptionBox = document.getElementById("descriptionBox");
  const descriptionMeta = document.getElementById("descriptionMeta");
  const summaryBox = document.getElementById("summaryBox");
  const summaryMeta = document.getElementById("summaryMeta");
  const notebookExportStatus = document.getElementById("notebookExportStatus");
  const askAiResponse = document.getElementById("askAiResponse");
  const askAiInput = document.getElementById("askAiInput");
  const askAiSources = document.getElementById("askAiSources");

  if (!item) {
    detailsEmptyState.style.display = "block";
    detailsPanel.style.display = "none";
    return;
  }

  detailsEmptyState.style.display = "none";
  detailsPanel.style.display = "block";

  detailsThumbnail.src = item.thumbnail || "";
  detailsTitle.textContent = item.title || "Untitled";
  detailsChannel.textContent = item.channel || "Unknown Channel";
  detailsUrl.href = item.url || "#";
  detailsUrl.textContent = item.url || "";
  const cleanedDescription = cleanDescription(item.description);
  descriptionBox.textContent = cleanedDescription || "No description yet.";
  descriptionMeta.textContent = cleanedDescription
    ? "Description source: YouTube page metadata"
    : "No description captured yet.";
  if (summaryInFlightForVideoId === item.id && !item.summary) {
    summaryBox.textContent = "Generating summary...";
    summaryMeta.textContent = "Summary source: generating...";
  } else {
    summaryBox.textContent = item.summary || "No summary yet.";
    summaryMeta.textContent = item.summary
      ? `Summary source: ${item.summarySource || "unknown"}`
      : `Summary source: not generated`;
  }
  if (item.notebookLmImportedAt && item.notebookLmNotebookUrl) {
    notebookExportStatus.textContent = `Imported into NotebookLM ${new Date(item.notebookLmImportedAt).toLocaleString()}.\nNotebook: ${item.notebookLmNotebookUrl}`;
  } else {
    notebookExportStatus.textContent = item.lastNotebookLmExportAt
      ? `NotebookLM export prepared ${new Date(item.lastNotebookLmExportAt).toLocaleString()}.`
      : "No export prepared yet.";
  }
  askAiResponse.textContent = item.lastAiResponse || "No response yet.";
  askAiInput.value = item.lastQuestion || "";
  const sourceLabels = Array.isArray(item.lastAiSources) ? item.lastAiSources : [];
  const priorTurnCount = Math.floor((Array.isArray(item.chatHistory) ? item.chatHistory.length : 0) / 2);
  const providerLabel = `Using ${currentAiSettings.provider} / ${currentAiSettings.model}`;
  const memoryLabel = priorTurnCount ? ` ${priorTurnCount} prior turn${priorTurnCount === 1 ? "" : "s"}.` : " No prior turns yet.";
  document.getElementById("askAiHint").textContent = `${providerLabel}.${memoryLabel}`;
  askAiSources.textContent = sourceLabels.length
    ? `Sources used: ${sourceLabels.join(", ")}`
    : "Sources used: none yet.";
}

async function renderQueue() {
  if (isRendering) return;
  isRendering = true;

  try {
    const queue = await getQueue();
    const queueList = document.getElementById("queueList");
    const emptyState = document.getElementById("emptyState");

    if (!queueList || !emptyState) return;

    queueList.innerHTML = "";

    if (!queue.length) {
      emptyState.style.display = "block";
      selectedVideoId = null;
      renderDetails(null);
      return;
    }

    emptyState.style.display = "none";

    if (!selectedVideoId || !queue.some((item) => item.id === selectedVideoId)) {
      selectedVideoId = queue[0].id;
    }

    queue.forEach((item) => {
      const node = createQueueItem(item, item.id === selectedVideoId);
      queueList.appendChild(node);
    });

    queueList.querySelectorAll(".remove-btn").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        removeItem(btn.dataset.id);
      });
    });

    queueList.querySelectorAll(".select-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedVideoId = btn.dataset.id;
        renderQueue();
      });
    });

    queueList.querySelectorAll(".queue-item").forEach((node) => {
      node.addEventListener("click", () => {
        const selectBtn = node.querySelector(".select-btn");
        if (selectBtn?.dataset?.id) {
          selectedVideoId = selectBtn.dataset.id;
          renderQueue();
        }
      });
    });

    const selectedItem = queue.find((item) => item.id === selectedVideoId) || null;
    renderDetails(selectedItem);

    if (selectedItem && !selectedItem.summary && summaryInFlightForVideoId !== selectedItem.id) {
      handleSummarize({ silent: true });
    }
  } catch (error) {
    console.error("Failed to render queue:", error);
  } finally {
    isRendering = false;
  }
}

async function handleRefresh() {
  setRefreshState(true);

  try {
    await Promise.all([
      renderQueue(),
      new Promise((resolve) => window.setTimeout(resolve, 450))
    ]);
  } finally {
    setRefreshState(false);
  }
}

async function handleSummarize(options = {}) {
  let queue = await getQueue();
  let item = queue.find((video) => video.id === selectedVideoId);

  if (!item) {
    if (!options.silent) {
      alert("Please select a video first.");
    }
    return;
  }

  setSummaryState(item.id);

  try {
    let summary = "";
    let summarySource = "metadata";

    if (!item.transcript) {
      await requestTranscriptFromOpenYouTubeTab(item);
      queue = await getQueue();
      item = queue.find((video) => video.id === selectedVideoId) || item;
    }

    const aiPrompt = buildSummaryPrompt(item);
    const aiResult = await requestAiText(aiPrompt);

    if (aiResult.success && String(aiResult.text || "").trim()) {
      summary = String(aiResult.text).trim();
      summarySource = item.transcript ? "transcript+ai" : "metadata+ai";
    } else if (item.transcript) {
      summary = buildTranscriptSummary(item);
      summarySource = "transcript";
    } else {
      summary = buildMetadataSummary(item);
      summarySource = "metadata";
    }

    await updateQueueItem(item.id, (oldItem) => ({
      ...oldItem,
      summary,
      summarySource,
      summaryUpdatedAt: new Date().toISOString()
    }));

    try {
      await chrome.runtime.sendMessage({
        type: "QUEUE_UPDATED",
        payload: { summarizedId: item.id }
      });
    } catch (error) {
      console.warn("Failed to notify summary update:", error);
    }
  } finally {
    clearSummaryState(item.id);
    renderQueue();
  }
}

async function handleAskAi() {
  const queue = await getQueue();
  const item = queue.find((video) => video.id === selectedVideoId);

  if (!item) {
    alert("Please select a video first.");
    return;
  }

  const askAiInput = document.getElementById("askAiInput");
  const question = askAiInput.value.trim();

  if (!question) {
    alert("Please enter a question.");
    return;
  }

  const askAiResponse = document.getElementById("askAiResponse");
  askAiResponse.textContent = "Thinking...";

  const prompt = buildAskAiPrompt(item, question);
  const aiResult = await requestAiText(prompt);

  if (!aiResult.success) {
    askAiResponse.textContent = "No response yet.";
    alert(`AI request failed.\n\n${aiResult.error || "Unknown error."}\n\nOpen the extension popup and confirm your provider, model, and local Ollama URL settings.`);
    return;
  }

  const answerText = aiResult.text || buildFakeAiResponse(item, question);
  const sourceLabels = getSourceLabels(item);

  await updateQueueItem(item.id, (oldItem) => ({
    ...oldItem,
    lastQuestion: question,
    lastAiResponse: answerText,
    lastAiModel: aiResult.provider || "unknown",
    lastAiSources: sourceLabels,
    chatHistory: appendChatHistory(oldItem, question, answerText, sourceLabels)
  }));

  try {
    await chrome.runtime.sendMessage({
      type: "QUEUE_UPDATED",
      payload: { askedAiForId: item.id }
    });
  } catch (error) {
    console.warn("Failed to notify AI response update:", error);
  }

  renderQueue();
}

async function handleSendToNotebookLm() {
  const queue = await getQueue();
  const item = queue.find((video) => video.id === selectedVideoId);

  if (!item) {
    alert("Please select a video first.");
    return;
  }

  let exportItem = item;
  if (!exportItem.summary) {
    await handleSummarize();
    const refreshedQueue = await getQueue();
    exportItem = refreshedQueue.find((video) => video.id === selectedVideoId) || exportItem;
  }

  const exportText = buildNotebookLmExport(exportItem);
  const draft = {
    videoId: exportItem.id,
    title: exportItem.title || "Untitled",
    text: exportText,
    createdAt: new Date().toISOString(),
    autoImport: true,
    status: "pending"
  };

  await setNotebookDraft(draft);

  try {
    await navigator.clipboard.writeText(exportText);
  } catch (error) {
    console.warn("Failed to copy NotebookLM export text:", error);
  }

  await updateQueueItem(exportItem.id, (oldItem) => ({
    ...oldItem,
    lastNotebookLmExportAt: draft.createdAt
  }));

  try {
    await chrome.runtime.sendMessage({ type: "OPEN_NOTEBOOKLM" });
    await notifyNotebookLmTabs({ type: "REFRESH_NOTEBOOKLM_DRAFT" });
    await chrome.runtime.sendMessage({
      type: "QUEUE_UPDATED",
      payload: { notebookLmExportedId: exportItem.id }
    });
  } catch (error) {
    console.warn("Failed to open NotebookLM after export:", error);
  }

  renderQueue();
}

function bindActions() {
  document.getElementById("refreshBtn").addEventListener("click", handleRefresh);

  document.getElementById("clearBtn").addEventListener("click", clearQueue);

  document.getElementById("copyBtn").addEventListener("click", async () => {
    const queue = await getQueue();

    if (!queue.length) {
      alert("No videos to copy.");
      return;
    }

    const urls = queue.map((item) => item.url).join("\n");

    try {
      await navigator.clipboard.writeText(urls);
      alert("All URLs copied!");
    } catch (error) {
      console.error("Clipboard error:", error);
      alert("Failed to copy.");
    }
  });

  document.getElementById("jumpToQueueBtn").addEventListener("click", () => {
    document.getElementById("queueSection")?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  });

  document.getElementById("summarizeBtn").addEventListener("click", handleSummarize);
  document.getElementById("sendToNotebookBtn").addEventListener("click", handleSendToNotebookLm);
  document.getElementById("askAiBtn").addEventListener("click", handleAskAi);
}

function bindRealtimeListeners() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.queue) {
      renderQueue();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "QUEUE_UPDATED") {
      if (message?.payload?.videoId) {
        selectedVideoId = message.payload.videoId;
      }
      renderQueue();
    }
  });

  window.addEventListener("focus", renderQueue);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      renderQueue();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const subtitle = document.querySelector(".subtitle");
  if (subtitle) {
    subtitle.textContent = "YouTube -> NotebookLM workflow";
  }

  bindActions();
  bindRealtimeListeners();
  chrome.runtime.sendMessage({ type: "GET_AI_SETTINGS" }, (response) => {
    if (response) {
      currentAiSettings = {
        provider: response.provider || "ollama",
        model: response.model || "qwen3:8b"
      };
    }
    refreshAiHint();
  });
  renderQueue();
});

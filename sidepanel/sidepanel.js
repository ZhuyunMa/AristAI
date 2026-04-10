let selectedVideoId = null;
let selectedNotebookId = null;
let isRendering = false;
const NOTEBOOKLM_DRAFT_KEY = "notebooklmDraft";
const NOTEBOOKS_KEY = "notebooks";
const SELECTED_NOTEBOOK_KEY = "selectedNotebookId";
let currentAiSettings = {
  provider: "ollama",
  model: "qwen3:8b",
  notebookTarget: "open-notebook",
  openNotebookUrl: "http://localhost:8502"
};
let summaryInFlightForVideoId = null;
let askAiInFlightForVideoId = null;
let notebookSummaryInFlightForNotebookId = null;
let notebookAskAiInFlightForNotebookId = null;
let notebookPresentationInFlightForNotebookId = null;

function createNotebook(title = "Research Workspace") {
  return {
    id: `notebook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    sourceVideoIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

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
  const summaryStateChip = document.getElementById("summaryStateChip");

  if (summaryMeta && selectedVideoId === videoId) {
    summaryMeta.textContent = "Summary source: generating...";
  }

  if (summaryBox && selectedVideoId === videoId) {
    summaryBox.textContent = "Generating summary...";
  }

  if (summaryStateChip && selectedVideoId === videoId) {
    setStatusPill(summaryStateChip, "Generating", "active");
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

async function getNotebookState() {
  const result = await chrome.storage.local.get([NOTEBOOKS_KEY, SELECTED_NOTEBOOK_KEY]);
  let notebooks = Array.isArray(result[NOTEBOOKS_KEY]) ? result[NOTEBOOKS_KEY] : [];
  let currentSelectedNotebookId = result[SELECTED_NOTEBOOK_KEY] || null;
  let changed = false;

  if (!notebooks.length) {
    const defaultNotebook = createNotebook("My First Workspace");
    notebooks = [defaultNotebook];
    currentSelectedNotebookId = defaultNotebook.id;
    changed = true;
  }

  if (!currentSelectedNotebookId || !notebooks.some((notebook) => notebook.id === currentSelectedNotebookId)) {
    currentSelectedNotebookId = notebooks[0].id;
    changed = true;
  }

  if (changed) {
    await chrome.storage.local.set({
      [NOTEBOOKS_KEY]: notebooks,
      [SELECTED_NOTEBOOK_KEY]: currentSelectedNotebookId
    });
  }

  selectedNotebookId = currentSelectedNotebookId;

  return {
    notebooks,
    selectedNotebookId: currentSelectedNotebookId,
    selectedNotebook: notebooks.find((notebook) => notebook.id === currentSelectedNotebookId) || notebooks[0]
  };
}

async function setNotebookState(notebooks, nextSelectedNotebookId = selectedNotebookId) {
  selectedNotebookId = nextSelectedNotebookId;
  await chrome.storage.local.set({
    [NOTEBOOKS_KEY]: notebooks,
    [SELECTED_NOTEBOOK_KEY]: nextSelectedNotebookId
  });
}

async function updateNotebook(notebookId, updater) {
  const state = await getNotebookState();
  const nextNotebooks = state.notebooks.map((notebook) => {
    if (notebook.id !== notebookId) {
      return notebook;
    }

    const nextNotebook = typeof updater === "function" ? updater(notebook) : notebook;
    return {
      ...nextNotebook,
      updatedAt: new Date().toISOString()
    };
  });

  await setNotebookState(nextNotebooks, state.selectedNotebookId);
  return nextNotebooks.find((notebook) => notebook.id === notebookId) || null;
}

function getNotebookSourceItems(queue, notebook) {
  if (!notebook?.sourceVideoIds?.length) {
    return [];
  }

  return notebook.sourceVideoIds
    .map((videoId) => queue.find((item) => item.id === videoId))
    .filter(Boolean);
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

function invalidateDerivedVideoState(oldItem, patch) {
  const nextTranscript = cleanTranscript(patch?.transcript ?? oldItem?.transcript ?? "");
  const prevTranscript = cleanTranscript(oldItem?.transcript || "");
  const transcriptChanged = nextTranscript !== prevTranscript;

  const nextItem = {
    ...oldItem,
    ...patch
  };

  if (!transcriptChanged) {
    return nextItem;
  }

  return {
    ...nextItem,
    summary: "",
    summarySource: "",
    summaryUpdatedAt: "",
    lastQuestion: "",
    lastAiResponse: "",
    lastAiModel: "",
    lastAiSources: [],
    chatHistory: [],
    lastNotebookLmExportAt: "",
    notebookLmImportedAt: "",
    notebookLmNotebookUrl: ""
  };
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
  const notebookState = await getNotebookState();
  const nextNotebooks = notebookState.notebooks.map((notebook) => ({
    ...notebook,
    sourceVideoIds: (Array.isArray(notebook.sourceVideoIds) ? notebook.sourceVideoIds : []).filter((videoId) => videoId !== id),
    updatedAt: new Date().toISOString()
  }));
  await setNotebookState(nextNotebooks, notebookState.selectedNotebookId);

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
  const notebookState = await getNotebookState();
  const clearedNotebooks = notebookState.notebooks.map((notebook) => ({
    ...notebook,
    sourceVideoIds: [],
    updatedAt: new Date().toISOString()
  }));
  await setNotebookState(clearedNotebooks, notebookState.selectedNotebookId);
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

async function createNotebookFromPrompt() {
  const title = window.prompt("Workspace name", "Research Workspace");
  if (title === null) {
    return;
  }

  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    alert("Workspace name cannot be empty.");
    return;
  }

  const state = await getNotebookState();
  const notebook = createNotebook(trimmedTitle);
  const nextNotebooks = [notebook, ...state.notebooks];
  await setNotebookState(nextNotebooks, notebook.id);
  renderQueue();
}

async function renameSelectedNotebook() {
  const state = await getNotebookState();
  const notebook = state.selectedNotebook;
  if (!notebook) {
    return;
  }

  const title = window.prompt("Rename workspace", notebook.title || "Research Workspace");
  if (title === null) {
    return;
  }

  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    alert("Workspace name cannot be empty.");
    return;
  }

  await updateNotebook(notebook.id, (currentNotebook) => ({
    ...currentNotebook,
    title: trimmedTitle
  }));

  renderQueue();
}

async function deleteSelectedNotebook() {
  const state = await getNotebookState();
  const notebook = state.selectedNotebook;
  if (!notebook) {
    return;
  }

  const confirmed = window.confirm(`Delete workspace "${notebook.title}"?`);
  if (!confirmed) {
    return;
  }

  let nextNotebooks = state.notebooks.filter((item) => item.id !== notebook.id);
  let nextSelectedId = nextNotebooks[0]?.id || null;

  if (!nextNotebooks.length) {
    const fallbackNotebook = createNotebook("My First Workspace");
    nextNotebooks = [fallbackNotebook];
    nextSelectedId = fallbackNotebook.id;
  }

  await setNotebookState(nextNotebooks, nextSelectedId);

  const nextSelectedNotebook = nextNotebooks.find((item) => item.id === nextSelectedId);
  selectedVideoId = nextSelectedNotebook?.sourceVideoIds?.[0] || selectedVideoId;
  renderQueue();
}

async function addSelectedVideoToNotebook() {
  if (!selectedVideoId) {
    alert("Select a video first.");
    return;
  }

  const state = await getNotebookState();
  if (!state.selectedNotebook) {
    alert("Create a workspace first.");
    return;
  }

  await updateNotebook(state.selectedNotebook.id, (notebook) => ({
    ...notebook,
    sourceVideoIds: Array.from(new Set([...(Array.isArray(notebook.sourceVideoIds) ? notebook.sourceVideoIds : []), selectedVideoId]))
  }));

  renderQueue();
}

async function addAllQueueVideosToNotebook() {
  const state = await getNotebookState();
  if (!state.selectedNotebook) {
    alert("Create a workspace first.");
    return;
  }

  const queue = await getQueue();
  if (!queue.length) {
    alert("No queued videos to add.");
    return;
  }

  await updateNotebook(state.selectedNotebook.id, (notebook) => ({
    ...notebook,
    sourceVideoIds: Array.from(
      new Set([
        ...(Array.isArray(notebook.sourceVideoIds) ? notebook.sourceVideoIds : []),
        ...queue.map((item) => item.id).filter(Boolean)
      ])
    )
  }));

  renderQueue();
}

async function copyNotebookSourceUrls() {
  const state = await getNotebookState();
  const queue = await getQueue();
  const sourceItems = getNotebookSourceItems(queue, state.selectedNotebook);

  if (!sourceItems.length) {
    alert("This notebook has no source URLs yet.");
    return;
  }

  const urls = sourceItems
    .map((item) => item.url)
    .filter(Boolean)
    .join("\n");

  try {
    await navigator.clipboard.writeText(urls);
    alert("Notebook source URLs copied.");
  } catch (error) {
    console.error("Failed to copy workspace source URLs:", error);
    alert("Failed to copy workspace source URLs.");
  }
}

async function handleGeneratePresentationPrompt() {
  const notebookState = await getNotebookState();
  const notebook = notebookState.selectedNotebook;
  const queue = await getQueue();
  const sourceItems = getNotebookSourceItems(queue, notebook);

  if (!notebook || !sourceItems.length) {
    alert("Add workspace sources first.");
    return;
  }

  notebookPresentationInFlightForNotebookId = notebook.id;
  renderQueue();

  try {
    const promptRequest = buildNotebookPresentationPromptRequest(notebook, sourceItems);
    const aiResult = await requestAiText(promptRequest);
    const generatedText = String(aiResult?.text || "").trim();

    await updateNotebook(notebook.id, (currentNotebook) => ({
      ...currentNotebook,
      presentationPrompt: generatedText || buildNotebookPresentationPromptFallback(notebook, sourceItems),
      presentationSource: generatedText ? "deck+ai" : "deck+template",
      presentationPromptUpdatedAt: new Date().toISOString()
    }));
  } finally {
    notebookPresentationInFlightForNotebookId = null;
    renderQueue();
  }
}

async function handleCopyPresentationPrompt() {
  const notebookState = await getNotebookState();
  const notebook = notebookState.selectedNotebook;

  if (!notebook?.presentationPrompt) {
    alert("Generate a presentation prompt first.");
    return;
  }

  try {
    await navigator.clipboard.writeText(notebook.presentationPrompt);
    alert("Presentation prompt copied.");
  } catch (error) {
    console.error("Failed to copy presentation prompt:", error);
    alert("Failed to copy presentation prompt.");
  }
}

async function handleOpenNotebookStudio() {
  const notebookState = await getNotebookState();
  const notebook = notebookState.selectedNotebook;

  if (notebook?.presentationPrompt) {
    try {
      await navigator.clipboard.writeText(notebook.presentationPrompt);
    } catch (error) {
      console.warn("Failed to copy presentation prompt before opening NotebookLM:", error);
    }
  }

  try {
    await chrome.runtime.sendMessage({ type: "OPEN_NOTEBOOK_TARGET" });
  } catch (error) {
    console.warn("Failed to open primary notebook app:", error);
  }
}

async function handleCopyOpenNotebookMarkdown() {
  const notebookState = await getNotebookState();
  const notebook = notebookState.selectedNotebook;
  const queue = await getQueue();
  const sourceItems = getNotebookSourceItems(queue, notebook);

  if (!notebook || !sourceItems.length) {
    alert("Add workspace sources first.");
    return;
  }

  const markdown = buildOpenNotebookMarkdown(notebook, sourceItems);
  try {
    await navigator.clipboard.writeText(markdown);
    alert("Notebook markdown copied for Open Notebook.");
  } catch (error) {
    console.error("Failed to copy notebook markdown:", error);
    alert("Failed to copy notebook markdown.");
  }
}

async function removeVideoFromNotebook(videoId) {
  const state = await getNotebookState();
  if (!state.selectedNotebook) {
    return;
  }

  const updatedNotebook = await updateNotebook(state.selectedNotebook.id, (notebook) => ({
    ...notebook,
    sourceVideoIds: (Array.isArray(notebook.sourceVideoIds) ? notebook.sourceVideoIds : []).filter((id) => id !== videoId)
  }));

  if (selectedVideoId === videoId) {
    selectedVideoId = updatedNotebook?.sourceVideoIds?.[0] || selectedVideoId;
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

function setStatusPill(element, label, tone = "neutral") {
  if (!element) {
    return;
  }

  element.className = `status-pill ${tone}`;
  element.textContent = label;
}

function renderSourceChips(container, labels) {
  if (!container) {
    return;
  }

  container.innerHTML = "";

  if (!Array.isArray(labels) || !labels.length) {
    container.textContent = "Sources used: none yet.";
    return;
  }

  const heading = document.createElement("span");
  heading.textContent = "Sources used:";
  container.appendChild(heading);

  labels.forEach((label) => {
    const chip = document.createElement("span");
    chip.className = "source-chip";
    chip.textContent = label;
    container.appendChild(chip);
  });
}

function getSelectedVideoState(item) {
  if (!item) {
    return { label: "Waiting", tone: "neutral" };
  }

  if (summaryInFlightForVideoId === item.id || askAiInFlightForVideoId === item.id) {
    return { label: "Working", tone: "active" };
  }

  if (item.transcript) {
    return { label: "Transcript", tone: "success" };
  }

  if (item.summary) {
    return { label: "Ready", tone: "success" };
  }

  return { label: "Metadata", tone: "warn" };
}

function getSummaryChipState(item) {
  if (!item) {
    return { label: "Pending", tone: "neutral" };
  }

  if (summaryInFlightForVideoId === item.id) {
    return { label: "Generating", tone: "active" };
  }

  if (item.summarySource?.includes("transcript")) {
    return { label: "Transcript", tone: "success" };
  }

  if (item.summarySource?.includes("metadata")) {
    return { label: "Metadata", tone: "warn" };
  }

  if (item.summary) {
    return { label: "Ready", tone: "success" };
  }

  return { label: "Pending", tone: "neutral" };
}

function getTranscriptChipState(item) {
  if (!item) {
    return { label: "Missing", tone: "neutral" };
  }

  if (item.manualTranscript) {
    return { label: "Manual", tone: "active" };
  }

  if (item.transcript) {
    return { label: "Ready", tone: "success" };
  }

  if (item.transcriptStatus === "error") {
    return { label: "Error", tone: "error" };
  }

  if (item.transcriptStatus === "unavailable") {
    return { label: "Missing", tone: "warn" };
  }

  return { label: "Missing", tone: "neutral" };
}

function getNotebookChipState(item) {
  if (!item) {
    return { label: "Draft", tone: "neutral" };
  }

  if (item.notebookLmImportedAt) {
    return { label: "Imported", tone: "success" };
  }

  if (item.lastNotebookLmExportAt) {
    return { label: "Prepared", tone: "active" };
  }

  return { label: "Draft", tone: "neutral" };
}

function getAskAiChipState(item) {
  if (!item) {
    return { label: "Ready", tone: "neutral" };
  }

  if (askAiInFlightForVideoId === item.id) {
    return { label: "Thinking", tone: "active" };
  }

  if (item.lastAiResponse) {
    return { label: "Answered", tone: "success" };
  }

  return { label: "Ready", tone: "neutral" };
}

function createQueueItem(item, isSelected) {
  const badges = [];
  if (item.summarySource) {
    badges.push(item.summarySource);
  }
  if (item.transcript) {
    badges.push("transcript");
  }
  if (item.notebookLmImportedAt) {
    badges.push("notebooklm");
  }

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
      ${badges.length ? `<div class="queue-badges">${badges.map((badge) => `<span class="queue-badge">${escapeHtml(badge)}</span>`).join("")}</div>` : ""}
      <div class="queue-item-actions">
        <button class="select-btn" data-id="${item.id}">View Details</button>
        <button class="remove-btn" data-id="${item.id}">Remove</button>
      </div>
    </div>
  `;

  return wrapper;
}

function createNotebookSourceItem(item, isSelected) {
  const wrapper = document.createElement("div");
  wrapper.className = "source-item";
  if (isSelected) {
    wrapper.classList.add("active");
  }

  wrapper.innerHTML = `
    <div class="source-item-title">${escapeHtml(item.title || "Untitled")}</div>
    <div class="source-item-meta">${escapeHtml(item.channel || "Unknown Channel")}</div>
    <div class="source-item-actions">
      <button class="open-source-btn" data-id="${item.id}">Open Source</button>
      <button class="remove-source-btn secondary-btn" data-id="${item.id}">Remove</button>
    </div>
  `;

  return wrapper;
}

function buildMetadataSummary(item) {
  const description = cleanDescription(item?.description || "");
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

function buildTranscriptMeta(item) {
  if (!item?.transcript) {
    if (item?.transcriptError) {
      return `Transcript status: ${item.transcriptStatus || "unavailable"}. ${item.transcriptError}`;
    }

    return "No transcript captured yet. Retry fetch or paste one manually.";
  }

  const transcriptWordCount = cleanTranscript(item.transcript).split(/\s+/).filter(Boolean).length;
  const sourceLabel = item.manualTranscript
    ? "manual transcript"
    : (item.transcriptLabel || item.transcriptLanguage || item.transcriptStatus || "captured transcript");
  const capturedAt = item.transcriptFetchedAt
    ? ` Saved ${new Date(item.transcriptFetchedAt).toLocaleString()}.`
    : "";

  return `Transcript source: ${sourceLabel}. ${transcriptWordCount} words.${capturedAt}`;
}

function buildTranscriptPreview(item) {
  const transcript = cleanTranscript(item?.transcript || "");
  if (!transcript) {
    return "No transcript yet.";
  }

  return clipText(transcript, 1200);
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
  const cleanedDescription = buildDescriptionContext(item);
  const transcriptContext = buildTranscriptContext(item);
  const conversationHistory = Array.isArray(item.chatHistory) ? item.chatHistory.slice(-6) : [];
  const sections = [
    "You are helping analyze a YouTube video inside a Chrome extension.",
    "Answer the user's question using only the provided video context.",
    "If context is limited, say what is known and avoid making up facts.",
    "When useful, refer back to the prior conversation turns for continuity.",
    "If the transcript is partial or missing, say so briefly rather than over-claiming.",
    "Prefer crisp, concrete answers over generic summaries.",
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

  if (transcriptContext) {
    sections.push("Transcript:");
    sections.push(transcriptContext);
    sections.push("");
  }

  if (conversationHistory.length) {
    sections.push("Recent conversation:");
    conversationHistory.forEach((entry) => {
      sections.push(`${entry.role === "assistant" ? "Assistant" : "User"}: ${entry.content}`);
    });
    sections.push("");
  }

  sections.push("Respond in concise plain text. When possible, ground the answer in transcript, summary, or description.");

  return sections.join("\n");
}

function buildSummaryPrompt(item) {
  const cleanedDescription = buildDescriptionContext(item);
  const transcriptContext = buildTranscriptContext(item);
  const sections = [
    "You are generating a concise summary for a YouTube video inside a Chrome extension.",
    "Write a useful summary in plain text.",
    "Prefer the transcript when available. If only metadata is available, summarize only what can be supported by the title and description.",
    "Keep the answer to 4-6 sentences.",
    "Focus on the video's main topic, key points, and why it matters.",
    "Do not output headings, bullets, or labels.",
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

  if (transcriptContext) {
    sections.push("Transcript:");
    sections.push(transcriptContext);
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

function clipText(text, maxChars) {
  const normalized = String(text || "").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const head = normalized.slice(0, Math.max(0, maxChars - 220)).trim();
  const tail = normalized.slice(-160).trim();
  return `${head}\n...\n${tail}`;
}

function buildTranscriptContext(item) {
  return clipText(cleanTranscript(item?.transcript || ""), 7000);
}

function buildDescriptionContext(item) {
  return clipText(cleanDescription(item?.description || ""), 1800);
}

function buildNotebookLmExport(item) {
  const cleanedDescription = buildDescriptionContext(item);
  const transcriptContext = buildTranscriptContext(item);
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

  if (transcriptContext) {
    lines.push("Transcript:");
    lines.push(transcriptContext);
    lines.push("");
  }

  lines.push("Prepared by AristAI as an optional external export bundle.");

  return lines.join("\n");
}

function buildOpenNotebookMarkdown(notebook, sourceItems) {
  const lines = [
    `# ${notebook?.title || "Research Workspace"}`,
    "",
    "Exported from AristAI for Open Notebook.",
    ""
  ];

  if (notebook?.summary) {
    lines.push("## Workspace Summary");
    lines.push(String(notebook.summary).trim());
    lines.push("");
  }

  sourceItems.forEach((item, index) => {
    lines.push(`## Source ${index + 1}: ${item.title || "Untitled"}`);
    lines.push(`Channel: ${item.channel || "Unknown Channel"}`);
    if (item.url) {
      lines.push(`URL: ${item.url}`);
    }
    if (item.summary) {
      lines.push("");
      lines.push("Summary:");
      lines.push(String(item.summary).trim());
    }
    const description = cleanDescription(item.description || "");
    if (description) {
      lines.push("");
      lines.push("Description:");
      lines.push(description);
    }
    const transcript = cleanTranscript(item.transcript || "");
    if (transcript) {
      lines.push("");
      lines.push("Transcript:");
      lines.push(clipText(transcript, 6000));
    }
    lines.push("");
  });

  return lines.join("\n");
}

function buildNotebookSourceContext(item) {
  const parts = [
    `Source title: ${item.title || "Untitled"}`,
    `Channel: ${item.channel || "Unknown Channel"}`
  ];

  if (item.summary) {
    parts.push(`Summary: ${item.summary}`);
  }

  const cleanedDescription = buildDescriptionContext(item);
  if (cleanedDescription) {
    parts.push(`Description: ${cleanedDescription}`);
  }

  const transcriptContext = buildTranscriptContext(item);
  if (transcriptContext) {
    parts.push(`Transcript excerpt: ${transcriptContext}`);
  }

  return parts.join("\n");
}

function buildNotebookSummaryPrompt(notebook, sourceItems) {
  const sections = [
    "You are summarizing a research notebook that contains multiple YouTube sources.",
    "Write a concise notebook-level synthesis in plain text.",
    "Focus on the shared themes, notable differences, and the most important takeaways across the sources.",
    "Keep the answer to 5-7 sentences.",
    "Do not output headings or bullets.",
    "",
    `Notebook title: ${notebook.title || "Untitled Notebook"}`,
    `Source count: ${sourceItems.length}`,
    ""
  ];

  sourceItems.forEach((item, index) => {
    sections.push(`Source ${index + 1}`);
    sections.push(buildNotebookSourceContext(item));
    sections.push("");
  });

  sections.push("Notebook summary:");
  return sections.join("\n");
}

function buildNotebookAskAiPrompt(notebook, sourceItems, question) {
  const history = Array.isArray(notebook.chatHistory) ? notebook.chatHistory.slice(-8) : [];
  const sections = [
    "You are answering questions about a notebook that contains multiple YouTube video sources.",
    "Use only the provided source context.",
    "If the sources are incomplete, say so briefly rather than inventing details.",
    "When possible, mention which source or channel supports the answer.",
    "",
    `Notebook title: ${notebook.title || "Untitled Notebook"}`,
    `User question: ${question}`,
    ""
  ];

  sourceItems.forEach((item, index) => {
    sections.push(`Source ${index + 1}`);
    sections.push(buildNotebookSourceContext(item));
    sections.push("");
  });

  if (history.length) {
    sections.push("Recent notebook conversation:");
    history.forEach((entry) => {
      sections.push(`${entry.role === "assistant" ? "Assistant" : "User"}: ${entry.content}`);
    });
    sections.push("");
  }

  sections.push("Respond in concise plain text and ground the answer in the workspace sources.");
  return sections.join("\n");
}

function buildNotebookPresentationPromptRequest(notebook, sourceItems) {
  const sections = [
    "You are writing a prompt for generating a presentation deck in a notebook-style research app.",
    "Return only the prompt text that the user should paste into the target app's slide deck generator.",
    "Ask for a polished 8-10 slide presentation grounded only in the provided notebook context.",
    "Ask for a logical narrative arc, strong slide titles, 3-5 concrete bullets per slide, and concise speaker notes.",
    "Request a title slide, overview, key themes, evidence/examples, why it matters, and a closing takeaway slide.",
    "Do not include markdown fences.",
    "",
    `Notebook title: ${notebook.title || "Untitled Notebook"}`,
    ""
  ];

  if (notebook.summary) {
    sections.push("Notebook summary:");
    sections.push(notebook.summary);
    sections.push("");
  }

  sections.push("Source context:");
  sourceItems.forEach((item, index) => {
    sections.push(`Source ${index + 1}`);
    sections.push(buildNotebookSourceContext(item));
    sections.push("");
  });

  sections.push("Presentation prompt:");
  return sections.join("\n");
}

function buildNotebookPresentationPromptFallback(notebook, sourceItems) {
  const sourceLines = sourceItems.map((item, index) => {
    const title = item.title || `Source ${index + 1}`;
    const channel = item.channel || "Unknown Channel";
    return `- Source ${index + 1}: "${title}" by ${channel}`;
  });

  const promptLines = [
    `Create a polished slide deck based only on the sources in my workspace "${notebook?.title || "Research Workspace"}".`,
    "Build 8-10 slides with a clear narrative arc.",
    "Include a title slide, overview, major themes, evidence/examples, implications, and closing takeaways.",
    "For each slide, provide a slide title, 3-5 concise bullets, and short speaker notes.",
    "Keep the deck factual, specific, and grounded in the workspace sources.",
    "Avoid generic filler."
  ];

  if (notebook?.summary) {
    promptLines.push("");
    promptLines.push("Use this workspace summary as the main synthesis:");
    promptLines.push(notebook.summary);
  }

  promptLines.push("");
  promptLines.push("Notebook sources:");
  promptLines.push(...sourceLines);

  return promptLines.join("\n");
}

function getNotebookSourceLabels(sourceItems) {
  return sourceItems.map((item) => item.channel || item.title || item.id).slice(0, 6);
}

function appendNotebookChatHistory(notebook, question, answer, sourceLabels) {
  const existing = Array.isArray(notebook.chatHistory) ? notebook.chatHistory : [];
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

function getNotebookSummaryChipState(notebook) {
  if (!notebook) {
    return { label: "Pending", tone: "neutral" };
  }

  if (notebookSummaryInFlightForNotebookId === notebook.id) {
    return { label: "Generating", tone: "active" };
  }

  if (notebook.summary) {
    return { label: "Ready", tone: "success" };
  }

  return { label: "Pending", tone: "neutral" };
}

function getNotebookAskAiChipState(notebook) {
  if (!notebook) {
    return { label: "Ready", tone: "neutral" };
  }

  if (notebookAskAiInFlightForNotebookId === notebook.id) {
    return { label: "Thinking", tone: "active" };
  }

  if (notebook.lastAiResponse) {
    return { label: "Answered", tone: "success" };
  }

  return { label: "Ready", tone: "neutral" };
}

function getNotebookPresentationChipState(notebook) {
  if (!notebook) {
    return { label: "Draft", tone: "neutral" };
  }

  if (notebookPresentationInFlightForNotebookId === notebook.id) {
    return { label: "Generating", tone: "active" };
  }

  if (notebook.presentationPrompt) {
    return { label: "Ready", tone: "success" };
  }

  return { label: "Draft", tone: "neutral" };
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

function cleanTranscript(transcript) {
  let text = String(transcript || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return "";
  }

  const segments = text
    .split(/(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const deduped = [];
  for (const segment of segments) {
    if (deduped[deduped.length - 1] === segment) {
      continue;
    }

    deduped.push(segment);
  }

  return deduped.join(" ");
}

function getSourceLabels(item) {
  const labels = [];

  if (item.transcript) {
    labels.push(item.manualTranscript ? "manual-transcript" : "transcript");
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

async function handleRefetchTranscript() {
  const queue = await getQueue();
  const item = queue.find((video) => video.id === selectedVideoId);

  if (!item) {
    alert("Please select a video first.");
    return;
  }

  const transcriptMeta = document.getElementById("transcriptMeta");
  const transcriptBox = document.getElementById("transcriptBox");
  const transcriptChip = document.getElementById("transcriptChip");

  if (transcriptMeta) {
    transcriptMeta.textContent = "Transcript fetch in progress...";
  }
  if (transcriptBox) {
    transcriptBox.textContent = "Trying the YouTube transcript fallbacks again...";
  }
  if (transcriptChip) {
    setStatusPill(transcriptChip, "Working", "active");
  }

  const response = await requestTranscriptFromOpenYouTubeTab(item);
  if (!response?.success) {
    renderQueue();
    alert(`Transcript fetch failed.\n\n${response?.error || "Unknown error."}\n\nYou can still paste a transcript manually below.`);
    return;
  }

  const nextTranscript = cleanTranscript(response.item?.transcript || "");
  const transcriptChanged = nextTranscript !== cleanTranscript(item.transcript || "");

  await updateQueueItem(item.id, (oldItem) => {
    const nextItem = {
      ...oldItem,
      transcript: nextTranscript,
      transcriptStatus: response.item?.transcriptStatus || oldItem.transcriptStatus || "ready",
      transcriptLanguage: response.item?.transcriptLanguage || "",
      transcriptLabel: response.item?.transcriptLabel || "",
      transcriptError: response.item?.transcriptError || "",
      transcriptFetchedAt: response.item?.transcriptFetchedAt || new Date().toISOString(),
      manualTranscript: false
    };

    if (!transcriptChanged) {
      return nextItem;
    }

    return invalidateDerivedVideoState(oldItem, nextItem);
  });

  renderQueue();
}

async function handleSaveManualTranscript() {
  const queue = await getQueue();
  const item = queue.find((video) => video.id === selectedVideoId);

  if (!item) {
    alert("Please select a video first.");
    return;
  }

  const manualTranscriptInput = document.getElementById("manualTranscriptInput");
  const transcript = cleanTranscript(manualTranscriptInput?.value || "");
  if (!transcript) {
    alert("Paste a transcript first.");
    return;
  }

  await updateQueueItem(item.id, (oldItem) => invalidateDerivedVideoState(oldItem, {
    transcript,
    transcriptStatus: "ready",
    transcriptLanguage: oldItem.transcriptLanguage || "",
    transcriptLabel: "manual transcript",
    transcriptError: "",
    transcriptFetchedAt: new Date().toISOString(),
    manualTranscript: true
  }));

  renderQueue();
}

async function handleClearTranscript() {
  const queue = await getQueue();
  const item = queue.find((video) => video.id === selectedVideoId);

  if (!item) {
    alert("Please select a video first.");
    return;
  }

  await updateQueueItem(item.id, (oldItem) => invalidateDerivedVideoState(oldItem, {
    transcript: "",
    transcriptStatus: "manual-cleared",
    transcriptLanguage: "",
    transcriptLabel: "",
    transcriptError: "",
    transcriptFetchedAt: "",
    manualTranscript: false
  }));

  renderQueue();
}

function renderNotebookWorkspace(queue, notebookState) {
  const notebookSelect = document.getElementById("notebookSelect");
  const workspaceChip = document.getElementById("workspaceChip");
  const workspaceTitle = document.getElementById("workspaceTitle");
  const workspaceMeta = document.getElementById("workspaceMeta");
  const notebookSourceChip = document.getElementById("notebookSourceChip");
  const notebookSourcesEmptyState = document.getElementById("notebookSourcesEmptyState");
  const notebookSourcesList = document.getElementById("notebookSourcesList");
  const addToNotebookBtn = document.getElementById("addToNotebookBtn");
  const addAllToNotebookBtn = document.getElementById("addAllToNotebookBtn");
  const copyNotebookUrlsBtn = document.getElementById("copyNotebookUrlsBtn");
  const copyNotebookMarkdownBtn = document.getElementById("copyNotebookMarkdownBtn");
  const renameNotebookBtn = document.getElementById("renameNotebookBtn");
  const deleteNotebookBtn = document.getElementById("deleteNotebookBtn");
  const notebookSummaryChip = document.getElementById("notebookSummaryChip");
  const notebookSummaryMeta = document.getElementById("notebookSummaryMeta");
  const notebookSummaryBox = document.getElementById("notebookSummaryBox");
  const notebookAskAiChip = document.getElementById("notebookAskAiChip");
  const notebookAskAiMeta = document.getElementById("notebookAskAiMeta");
  const notebookAskAiInput = document.getElementById("notebookAskAiInput");
  const notebookAskAiResponse = document.getElementById("notebookAskAiResponse");
  const notebookAskAiSources = document.getElementById("notebookAskAiSources");
  const presentationChip = document.getElementById("presentationChip");
  const presentationMeta = document.getElementById("presentationMeta");
  const presentationPromptBox = document.getElementById("presentationPromptBox");
  const generatePresentationBtn = document.getElementById("generatePresentationBtn");
  const copyPresentationBtn = document.getElementById("copyPresentationBtn");
  const openNotebookStudioBtn = document.getElementById("openNotebookStudioBtn");

  if (!notebookSelect || !workspaceChip || !workspaceTitle || !workspaceMeta || !notebookSourceChip || !notebookSourcesEmptyState || !notebookSourcesList || !addToNotebookBtn || !addAllToNotebookBtn || !copyNotebookUrlsBtn || !copyNotebookMarkdownBtn || !renameNotebookBtn || !deleteNotebookBtn || !notebookSummaryChip || !notebookSummaryMeta || !notebookSummaryBox || !notebookAskAiChip || !notebookAskAiMeta || !notebookAskAiInput || !notebookAskAiResponse || !notebookAskAiSources || !presentationChip || !presentationMeta || !presentationPromptBox || !generatePresentationBtn || !copyPresentationBtn || !openNotebookStudioBtn) {
    return;
  }

  const notebooks = notebookState.notebooks || [];
  const selectedNotebook = notebookState.selectedNotebook || null;

  setStatusPill(workspaceChip, `${notebooks.length} workspace${notebooks.length === 1 ? "" : "s"}`, notebooks.length ? "active" : "neutral");

  notebookSelect.innerHTML = "";
  notebooks.forEach((notebook) => {
    const option = document.createElement("option");
    option.value = notebook.id;
    option.textContent = notebook.title;
    option.selected = notebook.id === notebookState.selectedNotebookId;
    notebookSelect.appendChild(option);
  });

  if (!selectedNotebook) {
    workspaceTitle.textContent = "No workspace selected";
    workspaceMeta.textContent = `Create a workspace to start organizing sources. Optional external app: ${currentAiSettings.notebookTarget}.`;
    setStatusPill(notebookSourceChip, "0 sources", "neutral");
    notebookSourcesEmptyState.style.display = "block";
    notebookSourcesList.innerHTML = "";
    addToNotebookBtn.disabled = true;
    addAllToNotebookBtn.disabled = true;
    copyNotebookUrlsBtn.disabled = true;
    copyNotebookMarkdownBtn.disabled = true;
    renameNotebookBtn.disabled = true;
    deleteNotebookBtn.disabled = true;
    setStatusPill(notebookSummaryChip, "Pending", "neutral");
    notebookSummaryMeta.textContent = "No workspace summary yet.";
    notebookSummaryBox.textContent = "No workspace summary yet.";
    setStatusPill(notebookAskAiChip, "Ready", "neutral");
    notebookAskAiMeta.textContent = "Ask across all sources in the current workspace.";
    notebookAskAiInput.value = "";
    notebookAskAiResponse.textContent = "No workspace response yet.";
    renderSourceChips(notebookAskAiSources, []);
    setStatusPill(presentationChip, "Draft", "neutral");
    presentationMeta.textContent = "Generate a slide deck prompt from this workspace.";
    presentationPromptBox.textContent = "No presentation prompt yet.";
    generatePresentationBtn.disabled = true;
    copyPresentationBtn.disabled = true;
    openNotebookStudioBtn.disabled = true;
    return;
  }

  const notebookSources = getNotebookSourceItems(queue, selectedNotebook);
  workspaceTitle.textContent = selectedNotebook.title;
  const currentSource = notebookSources.find((item) => item.id === selectedVideoId) || null;
  workspaceMeta.textContent = `${notebookSources.length} source${notebookSources.length === 1 ? "" : "s"} in this workspace. Created ${new Date(selectedNotebook.createdAt).toLocaleDateString()}. Optional external app: ${currentAiSettings.notebookTarget}.${currentSource ? ` Current source: ${currentSource.title}` : " Select or add a source to continue."}`;
  setStatusPill(notebookSourceChip, `${notebookSources.length} source${notebookSources.length === 1 ? "" : "s"}`, notebookSources.length ? "success" : "neutral");
  renameNotebookBtn.disabled = false;
  deleteNotebookBtn.disabled = false;

  const currentSourceInNotebook = selectedVideoId && selectedNotebook.sourceVideoIds.includes(selectedVideoId);
  addToNotebookBtn.textContent = currentSourceInNotebook ? "Already in Notebook" : "Add Selected Video";
  addToNotebookBtn.disabled = !selectedVideoId || currentSourceInNotebook;
  addAllToNotebookBtn.disabled = !queue.length;
  copyNotebookUrlsBtn.disabled = !notebookSources.length;
  copyNotebookMarkdownBtn.disabled = !notebookSources.length;

  const summaryChipState = getNotebookSummaryChipState(selectedNotebook);
  setStatusPill(notebookSummaryChip, summaryChipState.label, summaryChipState.tone);
  if (notebookSummaryInFlightForNotebookId === selectedNotebook.id && !selectedNotebook.summary) {
    notebookSummaryMeta.textContent = "Workspace summary is generating...";
    notebookSummaryBox.textContent = "Generating workspace summary...";
  } else {
    notebookSummaryMeta.textContent = selectedNotebook.summary
      ? `Workspace summary updated ${new Date(selectedNotebook.summaryUpdatedAt || selectedNotebook.updatedAt).toLocaleString()}.`
      : "No workspace summary yet.";
    notebookSummaryBox.textContent = selectedNotebook.summary || "No workspace summary yet.";
  }

  const notebookAskAiChipState = getNotebookAskAiChipState(selectedNotebook);
  setStatusPill(notebookAskAiChip, notebookAskAiChipState.label, notebookAskAiChipState.tone);
  const notebookTurns = Math.floor((Array.isArray(selectedNotebook.chatHistory) ? selectedNotebook.chatHistory.length : 0) / 2);
  notebookAskAiMeta.textContent = `Using ${currentAiSettings.provider} / ${currentAiSettings.model}. ${notebookTurns ? `${notebookTurns} prior workspace turn${notebookTurns === 1 ? "" : "s"}.` : "Ask across all sources in the current workspace."}`;
  notebookAskAiInput.value = selectedNotebook.lastQuestion || "";
  notebookAskAiResponse.textContent = selectedNotebook.lastAiResponse || "No workspace response yet.";
  renderSourceChips(notebookAskAiSources, Array.isArray(selectedNotebook.lastAiSources) ? selectedNotebook.lastAiSources : []);
  const presentationState = getNotebookPresentationChipState(selectedNotebook);
  setStatusPill(presentationChip, presentationState.label, presentationState.tone);
  if (notebookPresentationInFlightForNotebookId === selectedNotebook.id && !selectedNotebook.presentationPrompt) {
    presentationMeta.textContent = "Generating a workspace slide deck prompt...";
    presentationPromptBox.textContent = "Generating presentation prompt...";
  } else {
    presentationMeta.textContent = selectedNotebook.presentationPrompt
      ? `Presentation prompt updated ${new Date(selectedNotebook.presentationPromptUpdatedAt || selectedNotebook.updatedAt).toLocaleString()}. Source: ${selectedNotebook.presentationSource || "unknown"}. Paste this into any external slide workflow if needed.`
      : "Generate a slide deck prompt from this workspace.";
    presentationPromptBox.textContent = selectedNotebook.presentationPrompt || "No presentation prompt yet.";
  }
  generatePresentationBtn.disabled = !notebookSources.length;
  copyPresentationBtn.disabled = !selectedNotebook.presentationPrompt;
  openNotebookStudioBtn.disabled = !notebookSources.length;

  notebookSourcesList.innerHTML = "";
  if (!notebookSources.length) {
    notebookSourcesEmptyState.style.display = "block";
  } else {
    notebookSourcesEmptyState.style.display = "none";
    notebookSources.forEach((item) => {
      notebookSourcesList.appendChild(createNotebookSourceItem(item, item.id === selectedVideoId));
    });
  }
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
  const transcriptBox = document.getElementById("transcriptBox");
  const transcriptMeta = document.getElementById("transcriptMeta");
  const transcriptChip = document.getElementById("transcriptChip");
  const manualTranscriptInput = document.getElementById("manualTranscriptInput");
  const askAiResponse = document.getElementById("askAiResponse");
  const askAiInput = document.getElementById("askAiInput");
  const askAiSources = document.getElementById("askAiSources");
  const selectedVideoChip = document.getElementById("selectedVideoChip");
  const descriptionChip = document.getElementById("descriptionChip");
  const summaryStateChip = document.getElementById("summaryStateChip");
  const askAiStateChip = document.getElementById("askAiStateChip");

  if (!item) {
    detailsEmptyState.style.display = "block";
    detailsPanel.style.display = "none";
    setStatusPill(selectedVideoChip, "Waiting", "neutral");
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
  setStatusPill(descriptionChip, cleanedDescription ? "Metadata" : "Missing", cleanedDescription ? "neutral" : "warn");
  transcriptBox.textContent = buildTranscriptPreview(item);
  transcriptMeta.textContent = buildTranscriptMeta(item);
  manualTranscriptInput.value = item.manualTranscript ? cleanTranscript(item.transcript || "") : "";
  const transcriptState = getTranscriptChipState(item);
  setStatusPill(transcriptChip, transcriptState.label, transcriptState.tone);
  if (summaryInFlightForVideoId === item.id && !item.summary) {
    summaryBox.textContent = "Generating summary...";
    summaryMeta.textContent = "Summary source: generating...";
  } else {
    summaryBox.textContent = item.summary || "No summary yet.";
    summaryMeta.textContent = item.summary
      ? `Summary source: ${item.summarySource || "unknown"}`
      : `Summary source: not generated`;
  }
  const summaryState = getSummaryChipState(item);
  setStatusPill(summaryStateChip, summaryState.label, summaryState.tone);
  askAiResponse.textContent = item.lastAiResponse || "No response yet.";
  askAiInput.value = item.lastQuestion || "";
  const sourceLabels = Array.isArray(item.lastAiSources) ? item.lastAiSources : [];
  const priorTurnCount = Math.floor((Array.isArray(item.chatHistory) ? item.chatHistory.length : 0) / 2);
  const providerLabel = `Using ${currentAiSettings.provider} / ${currentAiSettings.model}`;
  const memoryLabel = priorTurnCount ? ` ${priorTurnCount} prior turn${priorTurnCount === 1 ? "" : "s"}.` : " No prior turns yet.";
  document.getElementById("askAiHint").textContent = `${providerLabel}.${memoryLabel}`;
  renderSourceChips(askAiSources, sourceLabels);
  const askAiState = getAskAiChipState(item);
  setStatusPill(askAiStateChip, askAiState.label, askAiState.tone);
  const selectedVideoState = getSelectedVideoState(item);
  setStatusPill(selectedVideoChip, selectedVideoState.label, selectedVideoState.tone);
}

async function renderQueue() {
  if (isRendering) return;
  isRendering = true;

  try {
    const queue = await getQueue();
    const notebookState = await getNotebookState();
    const queueList = document.getElementById("queueList");
    const emptyState = document.getElementById("emptyState");
    const queueCountChip = document.getElementById("queueCountChip");

    if (!queueList || !emptyState) return;

    queueList.innerHTML = "";
    setStatusPill(queueCountChip, `${queue.length} video${queue.length === 1 ? "" : "s"}`, queue.length ? "active" : "neutral");
    renderNotebookWorkspace(queue, notebookState);

    if (!queue.length) {
      emptyState.style.display = "block";
      const notebookSources = getNotebookSourceItems(queue, notebookState.selectedNotebook);
      selectedVideoId = notebookSources[0]?.id || null;
      renderDetails(null);
      return;
    }

    emptyState.style.display = "none";

    const notebookSources = getNotebookSourceItems(queue, notebookState.selectedNotebook);

    if (!selectedVideoId || !queue.some((item) => item.id === selectedVideoId)) {
      selectedVideoId = notebookSources[0]?.id || queue[0].id;
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

    document.querySelectorAll(".open-source-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedVideoId = btn.dataset.id;
        renderQueue();
      });
    });

    document.querySelectorAll(".remove-source-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        removeVideoFromNotebook(btn.dataset.id);
      });
    });

    const selectedNotebook = notebookState.selectedNotebook || null;
    if (selectedNotebook && notebookSources.length && !selectedNotebook.summary && notebookSummaryInFlightForNotebookId !== selectedNotebook.id) {
      handleSummarizeNotebook({ silent: true });
    }

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

async function handleSummarizeNotebook(options = {}) {
  const notebookState = await getNotebookState();
  const notebook = notebookState.selectedNotebook;
  const queue = await getQueue();
  const sourceItems = getNotebookSourceItems(queue, notebook);

  if (!notebook || !sourceItems.length) {
    if (!options.silent) {
      alert("Add at least one source to the notebook first.");
    }
    return;
  }

  notebookSummaryInFlightForNotebookId = notebook.id;
  renderQueue();

  try {
    const prompt = buildNotebookSummaryPrompt(notebook, sourceItems);
    const aiResult = await requestAiText(prompt);

    if (!aiResult.success || !String(aiResult.text || "").trim()) {
      if (!options.silent) {
        alert(`Notebook summary failed.\n\n${aiResult.error || "No summary returned."}`);
      }
      return;
    }

    await updateNotebook(notebook.id, (currentNotebook) => ({
      ...currentNotebook,
      summary: String(aiResult.text).trim(),
      summaryUpdatedAt: new Date().toISOString(),
      summarySource: "notebook+ai"
    }));
  } finally {
    notebookSummaryInFlightForNotebookId = null;
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
  const askAiStateChip = document.getElementById("askAiStateChip");
  askAiInFlightForVideoId = item.id;
  askAiResponse.textContent = "Thinking...";
  setStatusPill(askAiStateChip, "Thinking", "active");

  try {
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
  } finally {
    askAiInFlightForVideoId = null;
    renderQueue();
  }
}

async function handleAskNotebookAi() {
  const notebookState = await getNotebookState();
  const notebook = notebookState.selectedNotebook;
  const queue = await getQueue();
  const sourceItems = getNotebookSourceItems(queue, notebook);

  if (!notebook || !sourceItems.length) {
    alert("Add workspace sources first.");
    return;
  }

  const input = document.getElementById("notebookAskAiInput");
  const question = input.value.trim();
  if (!question) {
    alert("Please enter a notebook question.");
    return;
  }

  notebookAskAiInFlightForNotebookId = notebook.id;
  const responseBox = document.getElementById("notebookAskAiResponse");
  responseBox.textContent = "Thinking...";
  renderQueue();

  try {
    const prompt = buildNotebookAskAiPrompt(notebook, sourceItems, question);
    const aiResult = await requestAiText(prompt);

    if (!aiResult.success) {
      responseBox.textContent = "No workspace response yet.";
      alert(`Notebook AI request failed.\n\n${aiResult.error || "Unknown error."}`);
      return;
    }

    const answerText = aiResult.text || "No workspace response returned.";
    const sourceLabels = getNotebookSourceLabels(sourceItems);

    await updateNotebook(notebook.id, (currentNotebook) => ({
      ...currentNotebook,
      lastQuestion: question,
      lastAiResponse: answerText,
      lastAiSources: sourceLabels,
      chatHistory: appendNotebookChatHistory(currentNotebook, question, answerText, sourceLabels)
    }));
  } finally {
    notebookAskAiInFlightForNotebookId = null;
    renderQueue();
  }
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
  document.getElementById("createNotebookBtn").addEventListener("click", createNotebookFromPrompt);
  document.getElementById("renameNotebookBtn").addEventListener("click", renameSelectedNotebook);
  document.getElementById("deleteNotebookBtn").addEventListener("click", deleteSelectedNotebook);
  document.getElementById("addToNotebookBtn").addEventListener("click", addSelectedVideoToNotebook);
  document.getElementById("addAllToNotebookBtn").addEventListener("click", addAllQueueVideosToNotebook);
  document.getElementById("copyNotebookUrlsBtn").addEventListener("click", copyNotebookSourceUrls);
  document.getElementById("copyNotebookMarkdownBtn").addEventListener("click", handleCopyOpenNotebookMarkdown);
  document.getElementById("generatePresentationBtn").addEventListener("click", handleGeneratePresentationPrompt);
  document.getElementById("copyPresentationBtn").addEventListener("click", handleCopyPresentationPrompt);
  document.getElementById("openNotebookStudioBtn").addEventListener("click", handleOpenNotebookStudio);
  document.getElementById("notebookSelect").addEventListener("change", async (event) => {
    const nextNotebookId = event.target.value;
    const state = await getNotebookState();
    await setNotebookState(state.notebooks, nextNotebookId);
    const nextNotebook = state.notebooks.find((notebook) => notebook.id === nextNotebookId);
    if (nextNotebook?.sourceVideoIds?.length) {
      if (!nextNotebook.sourceVideoIds.includes(selectedVideoId)) {
        selectedVideoId = nextNotebook.sourceVideoIds[0];
      }
    } else {
      selectedVideoId = null;
    }
    renderQueue();
  });

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
  document.getElementById("refetchTranscriptBtn").addEventListener("click", handleRefetchTranscript);
  document.getElementById("saveTranscriptBtn").addEventListener("click", handleSaveManualTranscript);
  document.getElementById("clearTranscriptBtn").addEventListener("click", handleClearTranscript);
  document.getElementById("summarizeNotebookBtn").addEventListener("click", handleSummarizeNotebook);
  document.getElementById("askAiBtn").addEventListener("click", handleAskAi);
  document.getElementById("notebookAskAiBtn").addEventListener("click", handleAskNotebookAi);
}

function bindRealtimeListeners() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (changes.queue || changes[NOTEBOOKS_KEY] || changes[SELECTED_NOTEBOOK_KEY])) {
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
    subtitle.textContent = "YouTube -> research workspace";
  }

  bindActions();
  bindRealtimeListeners();
  chrome.runtime.sendMessage({ type: "GET_AI_SETTINGS" }, (response) => {
    if (response) {
      currentAiSettings = {
        provider: response.provider || "ollama",
        model: response.model || "qwen3:8b",
        notebookTarget: response.notebookTarget || "open-notebook",
        openNotebookUrl: response.openNotebookUrl || "http://localhost:8502"
      };
    }
    refreshAiHint();
  });
  renderQueue();
});

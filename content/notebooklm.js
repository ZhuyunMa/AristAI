(function () {
  const DRAFT_KEY = "notebooklmDraft";
  const PANEL_ID = "aristai-notebooklm-panel";
  let autoImportInFlight = false;

  console.log("AristAI NotebookLM bridge loaded.");

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function createButton(label) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.padding = "9px 13px";
    button.style.borderRadius = "12px";
    button.style.border = "1px solid rgba(255,255,255,0.14)";
    button.style.background = "#ffffff";
    button.style.color = "#111111";
    button.style.fontSize = "13px";
    button.style.fontWeight = "600";
    button.style.cursor = "pointer";
    button.style.boxShadow = "0 6px 16px rgba(0,0,0,0.12)";
    return button;
  }

  async function getDraft() {
    const result = await chrome.storage.local.get([DRAFT_KEY]);
    return result[DRAFT_KEY] || null;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  async function setDraft(nextDraft) {
    await chrome.storage.local.set({ [DRAFT_KEY]: nextDraft });
    return nextDraft;
  }

  async function patchDraft(patch) {
    const currentDraft = await getDraft();
    if (!currentDraft) {
      return null;
    }

    const nextDraft = {
      ...currentDraft,
      ...patch
    };

    await setDraft(nextDraft);
    return nextDraft;
  }

  async function updateQueueNotebookRelation(videoId, patch) {
    const result = await chrome.storage.local.get(["queue"]);
    const queue = Array.isArray(result.queue) ? result.queue : [];
    const nextQueue = queue.map((item) => {
      if (item.id !== videoId) {
        return item;
      }

      return {
        ...item,
        ...patch
      };
    });

    await chrome.storage.local.set({ queue: nextQueue });

    try {
      await chrome.runtime.sendMessage({
        type: "QUEUE_UPDATED",
        payload: { videoId, notebookLmImported: true }
      });
    } catch (error) {
      console.warn("Failed to notify queue update from NotebookLM page:", error);
    }
  }

  function getStatusLabel(draft) {
    if (draft.status === "running") {
      return `Auto-importing into NotebookLM...${draft.importAttemptCount ? ` Attempt ${draft.importAttemptCount}.` : ""}`;
    }

    if (draft.status === "completed") {
      return "NotebookLM source created successfully.";
    }

    if (draft.status === "failed") {
      return draft.error || "Auto import failed. You can retry or copy manually.";
    }

    if (draft.importAttemptCount) {
      return `NotebookLM auto import is queued for retry. Last error: ${draft.error || "unknown"}`;
    }

    return "NotebookLM auto import is queued.";
  }

  function getStatusTone(draft) {
    if (draft.status === "completed") {
      return {
        ink: "#def7c7",
        bg: "rgba(124, 196, 101, 0.16)",
        border: "rgba(124, 196, 101, 0.28)"
      };
    }

    if (draft.status === "failed") {
      return {
        ink: "#ffcabd",
        bg: "rgba(214, 88, 63, 0.16)",
        border: "rgba(214, 88, 63, 0.24)"
      };
    }

    return {
      ink: "#cde4ff",
      bg: "rgba(79, 131, 230, 0.16)",
      border: "rgba(79, 131, 230, 0.24)"
    };
  }

  function getInteractiveElements() {
    return Array.from(document.querySelectorAll("button, [role='button'], a, div[role='button']"))
      .filter(isVisible);
  }

  function findClickableByPatterns(patterns) {
    const regexes = patterns.map((pattern) => (pattern instanceof RegExp ? pattern : new RegExp(pattern, "i")));

    return getInteractiveElements().find((element) => {
      const text = normalizeText(
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent
      );

      return regexes.some((regex) => regex.test(text));
    }) || null;
  }

  async function clickByPatterns(patterns, timeoutMs = 5000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const element = findClickableByPatterns(patterns);
      if (element) {
        element.click();
        return true;
      }

      await sleep(250);
    }

    return false;
  }

  async function clickFirstSuccessful(patternGroups, timeoutMs = 5000) {
    for (const patterns of patternGroups) {
      const clicked = await clickByPatterns(patterns, timeoutMs);
      if (clicked) {
        return true;
      }
    }

    return false;
  }

  function getVisibleTextInputs() {
    const candidates = Array.from(
      document.querySelectorAll("textarea, input[type='text'], input:not([type]), [contenteditable='true'], [role='textbox']")
    ).filter(isVisible);

    return candidates.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      return (rectB.width * rectB.height) - (rectA.width * rectA.height);
    });
  }

  function dispatchTextEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setElementText(element, value) {
    element.focus();

    if ("value" in element) {
      element.value = value;
    } else {
      element.textContent = value;
    }

    dispatchTextEvents(element);
  }

  function findTitleField() {
    const inputs = getVisibleTextInputs();
    return inputs.find((input) => {
      const hint = normalizeText(
        input.getAttribute("aria-label") ||
        input.getAttribute("placeholder") ||
        input.getAttribute("name")
      );

      return /title|name/.test(hint);
    }) || null;
  }

  function findBodyField() {
    const inputs = getVisibleTextInputs();
    const field = inputs.find((input) => {
      const tagName = input.tagName.toLowerCase();
      const hint = normalizeText(
        input.getAttribute("aria-label") ||
        input.getAttribute("placeholder") ||
        input.getAttribute("name")
      );

      return tagName === "textarea" || /text|content|paste|source/.test(hint);
    });

    return field || inputs[0] || null;
  }

  async function fillSourceFields(draft) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 8000) {
      const titleField = findTitleField();
      const bodyField = findBodyField();

      if (bodyField) {
        if (titleField && titleField !== bodyField) {
          setElementText(titleField, draft.title || "AristAI Import");
          await sleep(120);
        }

        setElementText(bodyField, draft.text);
        return true;
      }

      await sleep(250);
    }

    return false;
  }

  async function waitForNotebookUrlChange(originalUrl, timeoutMs = 8000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (location.href !== originalUrl) {
        return location.href;
      }

      await sleep(250);
    }

    return location.href;
  }

  async function runNotebookImport(draft) {
    const startingUrl = location.href;

    await sleep(1200);

    const openedNotebook = await clickByPatterns([/create new notebook/i, /^new notebook$/i], 3500);
    if (openedNotebook) {
      await waitForNotebookUrlChange(startingUrl, 6000);
    }

    const openedSourceDialog = await clickFirstSuccessful([
      [/add source/i],
      [/sources/i, /add/i],
      [/create your first source/i]
    ], 4500);

    if (!openedSourceDialog) {
      throw new Error("Could not open the NotebookLM source dialog.");
    }

    const sourceTypeSelected = await clickFirstSuccessful([
      [/copied text/i],
      [/paste text/i],
      [/pasted text/i],
      [/^text$/i]
    ], 6000);

    if (!sourceTypeSelected) {
      console.warn("NotebookLM text source option was not found; trying to fill any visible source form.");
    }

    const filled = await fillSourceFields(draft);
    if (!filled) {
      throw new Error("Could not find the NotebookLM text source input.");
    }

    const submitted = await clickFirstSuccessful([
      [/insert/i],
      [/add source/i],
      [/save/i],
      [/done/i],
      [/create/i]
    ], 6000);
    if (!submitted) {
      throw new Error("Could not find the NotebookLM submit button for the source.");
    }

    await sleep(2200);

    return {
      notebookUrl: location.href
    };
  }

  async function maybeAutoImportDraft() {
    if (autoImportInFlight) {
      return;
    }

    const draft = await getDraft();
    if (!draft?.text || !draft.autoImport || draft.status !== "pending") {
      return;
    }

    autoImportInFlight = true;

    try {
      const nextAttempt = Number(draft.importAttemptCount || 0) + 1;
      await patchDraft({
        status: "running",
        startedAt: new Date().toISOString(),
        error: "",
        importAttemptCount: nextAttempt
      });

      await renderDraftPanel();

      const result = await runNotebookImport(draft);
      const importedAt = new Date().toISOString();

      await patchDraft({
        status: "completed",
        autoImport: false,
        notebookUrl: result.notebookUrl,
        importedAt
      });

      await updateQueueNotebookRelation(draft.videoId, {
        notebookLmNotebookUrl: result.notebookUrl,
        notebookLmImportedAt: importedAt
      });
    } catch (error) {
      const failedDraft = await getDraft();
      const attemptCount = Number(failedDraft?.importAttemptCount || draft.importAttemptCount || 1);
      const shouldRetry = attemptCount < 2;

      await patchDraft({
        status: shouldRetry ? "pending" : "failed",
        autoImport: shouldRetry,
        error: String(error?.message || error)
      });

      if (shouldRetry) {
        await sleep(1200);
        autoImportInFlight = false;
        renderDraftPanel();
        maybeAutoImportDraft();
        return;
      }
    } finally {
      autoImportInFlight = false;
      renderDraftPanel();
    }
  }

  function findBlockingDialogRect() {
    const dialogCandidates = Array.from(
      document.querySelectorAll("dialog, [role='dialog'], [aria-modal='true']")
    ).filter(isVisible);

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    return dialogCandidates
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > viewportWidth * 0.35 && rect.height > viewportHeight * 0.35)
      .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
  }

  function placePanel(panel) {
    const margin = 20;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const dialogRect = findBlockingDialogRect();

    let width = Math.min(320, Math.max(280, viewportWidth - (margin * 2)));
    let top = margin;
    let right = margin;
    let left = "auto";
    let bottom = "auto";
    let maxHeight = viewportHeight - (margin * 2);

    if (dialogRect) {
      const availableRight = viewportWidth - dialogRect.right - margin;
      const availableLeft = dialogRect.left - margin;

      if (availableRight >= 280) {
        width = Math.min(320, availableRight);
      } else if (availableLeft >= 280) {
        width = Math.min(320, availableLeft);
        left = margin;
        right = "auto";
      } else {
        width = Math.min(320, viewportWidth - (margin * 2));
        top = "auto";
        bottom = margin;
        maxHeight = Math.min(320, viewportHeight - (margin * 2));
      }
    }

    panel.style.position = "fixed";
    panel.style.top = typeof top === "number" ? `${top}px` : top;
    panel.style.right = typeof right === "number" ? `${right}px` : right;
    panel.style.left = typeof left === "number" ? `${left}px` : left;
    panel.style.bottom = typeof bottom === "number" ? `${bottom}px` : bottom;
    panel.style.width = `${width}px`;
    panel.style.maxWidth = `calc(100vw - ${margin * 2}px)`;
    panel.style.maxHeight = `${maxHeight}px`;
  }

  function refreshPanelPlacement() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      placePanel(panel);
    }
  }

  async function renderDraftPanel() {
    const draft = await getDraft();

    removePanel();

    if (!draft?.text) {
      return;
    }

    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.style.overflow = "auto";
    panel.style.zIndex = "2147483647";
    panel.style.padding = "14px";
    panel.style.borderRadius = "18px";
    panel.style.background = "rgba(12, 12, 12, 0.97)";
    panel.style.border = "1px solid rgba(255,255,255,0.08)";
    panel.style.color = "#ffffff";
    panel.style.boxShadow = "0 18px 50px rgba(0,0,0,0.38)";
    panel.style.backdropFilter = "blur(16px)";
    panel.style.fontFamily = "Segoe UI, Arial, sans-serif";

    placePanel(panel);

    const header = document.createElement("div");
    header.style.display = "grid";
    header.style.gap = "6px";

    const title = document.createElement("div");
    title.textContent = "AristAI Draft Ready";
    title.style.fontSize = "17px";
    title.style.fontWeight = "700";
    title.style.letterSpacing = "-0.02em";

    const subtitle = document.createElement("div");
    subtitle.textContent = draft.title || "Untitled";
    subtitle.style.fontSize = "14px";
    subtitle.style.lineHeight = "1.45";
    subtitle.style.color = "rgba(255,255,255,0.82)";

    header.appendChild(title);
    header.appendChild(subtitle);

    const statusTone = getStatusTone(draft);
    const status = document.createElement("div");
    status.textContent = getStatusLabel(draft);
    status.style.marginTop = "12px";
    status.style.padding = "10px 12px";
    status.style.borderRadius = "14px";
    status.style.background = statusTone.bg;
    status.style.border = `1px solid ${statusTone.border}`;
    status.style.fontSize = "13px";
    status.style.lineHeight = "1.45";
    status.style.color = statusTone.ink;

    const help = document.createElement("div");
    help.textContent = "AristAI will try to create a notebook source automatically. You can still copy the draft manually if NotebookLM changes its UI.";
    help.style.marginTop = "10px";
    help.style.fontSize = "13px";
    help.style.lineHeight = "1.45";
    help.style.color = "rgba(255,255,255,0.76)";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.flexWrap = "wrap";
    actions.style.marginTop = "12px";

    const copyBtn = createButton("Copy Draft");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(draft.text);
      } catch (error) {
        console.warn("Failed to copy NotebookLM draft:", error);
      }
    });

    const retryBtn = createButton("Retry Import");
    retryBtn.addEventListener("click", async () => {
      await patchDraft({
        autoImport: true,
        status: "pending",
        error: "",
        importAttemptCount: 0
      });
      await renderDraftPanel();
      maybeAutoImportDraft();
    });

    const clearBtn = createButton("Clear Draft");
    clearBtn.addEventListener("click", async () => {
      await chrome.storage.local.remove(DRAFT_KEY);
      removePanel();
    });

    actions.appendChild(copyBtn);
    actions.appendChild(retryBtn);
    actions.appendChild(clearBtn);

    let notebookLink = null;
    if (draft.notebookUrl) {
      notebookLink = document.createElement("a");
      notebookLink.href = draft.notebookUrl;
      notebookLink.target = "_blank";
      notebookLink.rel = "noopener noreferrer";
      notebookLink.textContent = "Open Imported Notebook";
      notebookLink.style.display = "inline-block";
      notebookLink.style.marginTop = "12px";
      notebookLink.style.color = "#9bd1ff";
      notebookLink.style.textDecoration = "none";
      notebookLink.style.fontWeight = "600";
    }

    const content = document.createElement("pre");
    content.textContent = draft.text;
    content.style.marginTop = "14px";
    content.style.padding = "12px";
    content.style.borderRadius = "12px";
    content.style.background = "rgba(255,255,255,0.08)";
    content.style.border = "1px solid rgba(255,255,255,0.06)";
    content.style.whiteSpace = "pre-wrap";
    content.style.wordBreak = "break-word";
    content.style.fontSize = "12px";
    content.style.lineHeight = "1.45";
    content.style.maxHeight = "360px";
    content.style.overflow = "auto";

    panel.appendChild(header);
    panel.appendChild(status);
    panel.appendChild(help);
    panel.appendChild(actions);
    if (notebookLink) {
      panel.appendChild(notebookLink);
    }
    panel.appendChild(content);
    document.body.appendChild(panel);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "PING_NOTEBOOKLM") {
      sendResponse({ success: true, page: "NotebookLM" });
      return false;
    }

    if (message.type === "REFRESH_NOTEBOOKLM_DRAFT") {
      renderDraftPanel()
        .then(() => maybeAutoImportDraft())
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: String(error?.message || error) }));
      return true;
    }

    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[DRAFT_KEY]) {
      renderDraftPanel();
      maybeAutoImportDraft();
    }
  });

  let placementFrame = 0;
  const placementObserver = new MutationObserver(() => {
    if (placementFrame) {
      return;
    }

    placementFrame = window.requestAnimationFrame(() => {
      placementFrame = 0;
      refreshPanelPlacement();
    });
  });

  window.addEventListener("resize", refreshPanelPlacement);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      placementObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true
      });
      renderDraftPanel();
      maybeAutoImportDraft();
    });
  } else {
    placementObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true
    });
    renderDraftPanel();
    maybeAutoImportDraft();
  }
})();

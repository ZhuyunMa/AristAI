# AristAI

AristAI is a Chrome extension that merges two workflows into one product experience:

- `YouTube -> NotebookLM`
- `AI-powered sidebar for video understanding`

The extension lets a user collect a YouTube video, review it inside a side panel, ask follow-up questions with a local LLM, and send the result into a NotebookLM workflow from the same workspace.

## Project Status

This project currently delivers a working `MVP / demo version`.

It is not a production-ready release, but the core workflow is implemented and can be demonstrated end-to-end:

1. Open a YouTube video
2. Add it to AristAI
3. Generate a summary automatically in the sidebar
4. Ask AI questions about the current video with conversational memory
5. Export and auto-import a NotebookLM-ready source
6. Open NotebookLM with the prepared draft and import status visible in-page

## Implemented Features

- Detect the current YouTube video from a watch page
- Inject an `Add to AristAI` button into YouTube
- Re-open the AristAI side panel even for videos that are already added
- Save selected videos into a local queue with metadata
- Manage the queue inside a Chrome side panel
- Display selected video details including title, channel, URL, description, and summary
- Generate a summary from transcript when available
- Fall back to metadata + local AI summary generation when transcript is unavailable
- Ask questions about the selected video using a local Ollama model
- Keep per-video multi-turn chat history in the AI sidebar
- Show which sources were used for each AI answer
- Prepare a NotebookLM-ready export draft
- Open NotebookLM, surface the draft in a floating AristAI panel, and attempt automatic source import
- Store a best-effort `video -> notebook` relationship after NotebookLM import succeeds

## Current AI Setup

The current demo version is configured for `local Ollama inference`.

Default local settings:

- Provider: `ollama`
- Base URL: `http://127.0.0.1:11434`
- Model: `qwen3:8b`

The popup keeps the provider, base URL, and model configurable so the project can later be switched back to OpenAI or another provider.

## Architecture Overview

### YouTube Content Script

The YouTube content script:

- detects video metadata
- injects the action button
- stores video data in `chrome.storage.local`
- attempts transcript retrieval when possible

### Side Panel

The side panel is the main AristAI workspace. It supports:

- queue browsing
- video selection
- selected video metadata review
- summary generation
- AI Q&A with short conversation memory
- NotebookLM export

### Background Service Worker

The background worker coordinates:

- opening the side panel
- opening NotebookLM
- storing AI settings
- routing AI requests to the configured provider

### NotebookLM Bridge

The NotebookLM content script reads the prepared export draft from local extension storage, displays it inside a floating panel on the NotebookLM page, and attempts a best-effort automatic text-source import into NotebookLM.

## Demo Workflow

### 1. Add a YouTube Video

Open a YouTube video page and click `Add to AristAI`.

### 2. Review in the Side Panel

Use the side panel to:

- inspect the selected video
- review the description and summary
- ask a question with the local AI model

### 3. Export to NotebookLM

Click `Send to NotebookLM` to:

- build a NotebookLM-ready draft
- copy it when possible
- open NotebookLM
- display the prepared draft inside the NotebookLM page
- attempt to create a NotebookLM text source automatically
- expose retry / status feedback inside the AristAI NotebookLM panel

## Local Setup

### Prerequisites

- Google Chrome
- Local Ollama installation
- A local model installed in Ollama, for example `qwen3:8b`

### Chrome Extension Setup

1. Clone or download this repository
2. Open `chrome://extensions`
3. Enable `Developer mode`
4. Click `Load unpacked`
5. Select this project folder

### Ollama Setup

Make sure Ollama is running locally and the model exists:

```powershell
ollama list
```

If needed, pull the model:

```powershell
ollama pull qwen3:8b
```

### Important: Allow the Chrome Extension Origin

For local Ollama calls from the Chrome extension, the extension origin may need to be allowed.

On Windows PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*", "User")
```

Then fully restart Ollama.

If this is not configured, the extension may fail with an Ollama `403` response even when Ollama is running correctly.

## Popup Settings

The extension popup currently exposes:

- AI Provider
- Base URL
- Model

Recommended demo settings:

- Provider: `ollama`
- Base URL: `http://127.0.0.1:11434`
- Model: `qwen3:8b`

## Known Limitations

- Transcript retrieval from YouTube is not fully reliable
- When transcript retrieval fails, the system falls back to metadata + local AI summary generation
- NotebookLM integration uses DOM automation rather than an official API, so automatic import is best-effort and may break if NotebookLM changes its UI
- Source citations in the AI sidebar are heuristic source labels, not NotebookLM-native citations
- The current UI is functional but still closer to an engineering prototype than a polished production interface
- OpenAI provider support is not the primary demo path right now, although the architecture keeps the provider configurable

## Project Structure

- `manifest.json` - Chrome extension manifest
- `background.js` - background service worker
- `content/youtube.js` - YouTube page integration
- `content/notebooklm.js` - NotebookLM page bridge
- `sidepanel/sidepanel.html` - side panel UI
- `sidepanel/sidepanel.js` - side panel logic
- `popup/popup.html` - popup UI
- `popup/popup.js` - popup settings logic
- `lib/` - helper modules

## Future Improvements

- Improve transcript reliability
- Clean noisy YouTube description text before summary/export
- Add clearer loading / success / error states in the UI
- Improve NotebookLM import reliability across NotebookLM UI changes
- Re-enable and harden OpenAI provider support for a cloud-backed version
- Add stronger provider abstraction for switching between Ollama and OpenAI cleanly

## Summary

AristAI currently achieves the original project goal at the `MVP` level:

- a merged `YouTube to NotebookLM` workflow
- an `AI sidebar` experience
- a single Chrome extension interface that connects both

This version is intended for demonstration, iteration, and further refinement.

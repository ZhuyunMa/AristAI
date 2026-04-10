# AristAI

AristAI is a Chrome extension for turning YouTube videos into an organized research workflow. It combines source collection, AI-assisted understanding, workspace management, and export support inside one side panel.

## What It Does

AristAI currently supports this workflow:

1. Open a YouTube video
2. Add it to AristAI from the YouTube page
3. Review metadata, transcript, and summary in the side panel
4. Ask AI questions about a single video
5. Group videos into research workspaces
6. Ask AI questions across all sources in a workspace
7. Generate a presentation prompt from the workspace
8. Export content toward NotebookLM or an optional external app

## Current Feature Set

### YouTube Collection

- Detects the current YouTube video on watch pages
- Injects an `Add to AristAI` button into YouTube
- Stores video metadata in `chrome.storage.local`
- Keeps a local source library / queue of collected videos
- Lets the user reopen and continue working with previously collected videos

### Source Review

- Displays title, channel, URL, thumbnail, description, transcript, and summary
- Attempts transcript retrieval from available YouTube page data and fallbacks
- Allows manual transcript paste-in when automatic extraction fails
- Generates a summary for the selected video

### AI Workspace

- Supports per-video `Ask AI`
- Supports multi-source workspace organization
- Lets the user create, rename, and delete workspaces
- Allows adding one selected video or the full queue into a workspace
- Supports workspace-level summarization
- Supports workspace-level `Ask AI` grounded in the workspace sources
- Shows basic source labels used in AI responses

### Export and Presentation Support

- Copies workspace source URLs
- Copies workspace markdown for downstream tools
- Generates a deck / presentation prompt from workspace materials
- Opens an optional external app target from extension settings
- Keeps support for the NotebookLM-oriented workflow already present in the extension

## UI Areas

### Side Panel

The side panel is the main working surface. It includes:

- `Research Workspace`
- `Collected Sources`
- `Workspace Summary`
- `Workspace Ask AI`
- `Presentation`
- `Selected Video`
- `Source Library`

### Popup

The popup is used for runtime settings:

- AI provider
- Base URL
- Model
- API key
- Optional external app target
- Optional external app URL

## AI Configuration

The current default setup is local inference with Ollama.

Default values:

- Provider: `ollama`
- Base URL: `http://127.0.0.1:11434`
- Model: `qwen3:8b`

The popup also keeps the architecture configurable for other providers such as OpenAI.

## Local Setup

### Prerequisites

- Google Chrome
- Ollama running locally if you want local AI
- A local Ollama model such as `qwen3:8b`

### Load the Extension

1. Clone or download this repository
2. Open `chrome://extensions`
3. Enable `Developer mode`
4. Click `Load unpacked`
5. Select this project folder

### Ollama Setup

Check your installed models:

```powershell
ollama list
```

Pull the default model if needed:

```powershell
ollama pull qwen3:8b
```

### Allow the Chrome Extension Origin

For local Ollama requests from a Chrome extension, you may need to allow Chrome extension origins:

```powershell
[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*", "User")
```

Then fully restart Ollama.

If this is missing, local AI requests can fail with an Ollama `403`.

## Architecture Overview

- `manifest.json`: Chrome extension manifest
- `background.js`: background service worker and settings / provider routing
- `content/youtube.js`: YouTube integration and add-to-AristAI flow
- `content/notebooklm.js`: NotebookLM page bridge
- `sidepanel/sidepanel.html`: side panel markup
- `sidepanel/sidepanel.css`: side panel styling
- `sidepanel/sidepanel.js`: workspace, queue, summary, AI, and presentation logic
- `popup/popup.html`: popup settings UI
- `popup/popup.js`: popup settings behavior
- `lib/storage.js`: local storage helpers and workspace data handling

## Known Limitations

- YouTube transcript extraction is still best-effort and not fully reliable
- Some videos expose incomplete or inaccessible transcript data to extensions
- When transcript extraction fails, quality depends more heavily on metadata or pasted transcript text
- NotebookLM integration is UI-driven rather than API-based, so it can break if NotebookLM changes
- Source labels in AI responses are heuristic, not formal citations
- The project is suitable for demo and iteration use, but it is still not a production release

## Recommended Demo Path

1. Start Ollama locally
2. Load the extension in Chrome
3. Open a YouTube video and click `Add to AristAI`
4. Open the side panel
5. Review the video transcript / summary
6. Add the video into a workspace
7. Generate a workspace summary
8. Ask a workspace-level question
9. Generate the presentation prompt
10. Export to your preferred downstream tool

## Repository

GitHub remote:

- `https://github.com/ZhuyunMa/AristAI.git`

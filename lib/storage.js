const AristAIStorage = {
  async getQueue() {
    const result = await chrome.storage.local.get(["queue"]);
    return result.queue || [];
  },

  async setQueue(queue) {
    await chrome.storage.local.set({ queue });
  },

  async addItem(item) {
    const queue = await this.getQueue();
    const exists = queue.some((q) => q.id === item.id);
    if (!exists) {
      queue.unshift(item);
      await this.setQueue(queue);
    }
    return queue;
  },

  async removeItem(id) {
    const queue = await this.getQueue();
    const nextQueue = queue.filter((item) => item.id !== id);
    await this.setQueue(nextQueue);
    return nextQueue;
  },

  async clearQueue() {
    await this.setQueue([]);
    return [];
  },

  async getNotebooks() {
    const result = await chrome.storage.local.get(["notebooks"]);
    return Array.isArray(result.notebooks) ? result.notebooks : [];
  },

  async setNotebooks(notebooks) {
    await chrome.storage.local.set({ notebooks });
  },

  async getSelectedNotebookId() {
    const result = await chrome.storage.local.get(["selectedNotebookId"]);
    return result.selectedNotebookId || null;
  },

  async setSelectedNotebookId(selectedNotebookId) {
    await chrome.storage.local.set({ selectedNotebookId });
  },

  createNotebook(title = "Research Workspace") {
    return {
      id: `notebook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      sourceVideoIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  },

  async ensureNotebookState() {
    let notebooks = await this.getNotebooks();
    let selectedNotebookId = await this.getSelectedNotebookId();
    let changed = false;

    if (!notebooks.length) {
      const defaultNotebook = this.createNotebook("My First Workspace");
      notebooks = [defaultNotebook];
      selectedNotebookId = defaultNotebook.id;
      changed = true;
    }

    if (!selectedNotebookId || !notebooks.some((notebook) => notebook.id === selectedNotebookId)) {
      selectedNotebookId = notebooks[0].id;
      changed = true;
    }

    if (changed) {
      await chrome.storage.local.set({
        notebooks,
        selectedNotebookId
      });
    }

    return {
      notebooks,
      selectedNotebookId
    };
  }
};

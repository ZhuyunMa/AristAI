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
  }
};
import type { CanvasDocument } from "../api/compatClient";

export class CanvasCreationTracker {
  private readonly seen = new Set<string>();
  private initialized = false;

  remember(id: string) {
    this.seen.add(id);
  }

  update(documents: CanvasDocument[], chatId: string): CanvasDocument | undefined {
    const items = documents.filter((item) => item.chat_id === chatId);
    const created = this.initialized ? items.find((item) => item.created_by_ai && !this.seen.has(item.id)) : undefined;
    for (const item of items) this.seen.add(item.id);
    this.initialized = true;
    return created;
  }
}

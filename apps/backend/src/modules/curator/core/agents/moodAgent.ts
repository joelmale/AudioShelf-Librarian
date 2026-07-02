import { LlmClient } from '../llmClient.js';
import { Book, TagResponse, TokenUsage } from '../types.js';

export class MoodAgent {
  constructor(private client: LlmClient) {}

  async analyze(book: Book): Promise<{ tags: TagResponse['tags'], usage: TokenUsage }> {
    const result = await this.client.tagBook(book);
    const filteredTags = result.tags.filter(t => ['mood', 'pacing', 'theme'].includes(t.category));
    return { tags: filteredTags, usage: result.usage };
  }
}

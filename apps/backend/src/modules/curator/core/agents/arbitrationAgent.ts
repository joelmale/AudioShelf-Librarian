import { LlmClient } from '../llmClient.js';
import { Book, TagResponse, TokenUsage, GeneratedTag } from '../types.js';

export class ArbitrationAgent {
  constructor(private client: LlmClient) {}

  async arbitrate(book: Book, proposedTags: GeneratedTag[]): Promise<{ tags: TagResponse['tags'], usage: TokenUsage }> {
    // In a full implementation, this agent would specifically hit the Cloud priority model
    // overriding the LLM priority for this single call to guarantee high intelligence arbitration.
    
    // For now, we will just re-tag the book as a fallback.
    const result = await this.client.tagBook(book);
    return { tags: result.tags, usage: result.usage };
  }
}

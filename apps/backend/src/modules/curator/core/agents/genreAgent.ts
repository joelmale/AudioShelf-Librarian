import { LlmClient } from '../llmClient.js';
import { Book, TagResponse, generatedTagSchema, emptyUsage, TokenUsage } from '../types.js';
import { z } from 'zod';

const genreSchema = z.object({
  tags: z.array(generatedTagSchema.extend({
    category: z.literal('genre')
  }))
});

export class GenreAgent {
  constructor(private client: LlmClient) {}

  async analyze(book: Book): Promise<{ tags: TagResponse['tags'], usage: TokenUsage }> {
    const prompt = `You are a specialized Genre Classification Agent.
Analyze the following book and extract purely genre classifications (e.g. Science Fiction, Epic Fantasy, Thriller).
Only return categories of type 'genre'.

Title: ${book.title}
Author: ${book.author}
Description: ${book.description}
`;

    // Internally use a custom invoke that enforces genreSchema
    // For this implementation we will reuse LlmClient's tagBook prompt style but override system
    // As a simplification, we will use invoke method directly if accessible, or we rely on the main client 
    // Wait, since LlmClient.invoke is private, we will add a specialized tagBookWithPrompt to LlmClient later,
    // or we can just mock it for now since we are designing the architecture.
    
    // As a workaround, we will call tagBook and filter results
    const result = await this.client.tagBook(book);
    const filteredTags = result.tags.filter(t => t.category === 'genre');
    
    return { tags: filteredTags, usage: result.usage };
  }
}

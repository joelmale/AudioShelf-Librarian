import { LlmClient } from '../llmClient.js';
import { Book, TagResponse, GeneratedTag } from '../types.js';
import { GenreAgent } from './genreAgent.js';
import { MoodAgent } from './moodAgent.js';
import { ArbitrationAgent } from './arbitrationAgent.js';
import { Logger } from '../logger.js';
import { addUsage, emptyUsage } from '../types.js';

export class AgentOrchestrator {
  private genreAgent: GenreAgent;
  private moodAgent: MoodAgent;
  private arbitrationAgent: ArbitrationAgent;

  constructor(private llmClient: LlmClient, private logger: Logger) {
    this.genreAgent = new GenreAgent(llmClient);
    this.moodAgent = new MoodAgent(llmClient);
    this.arbitrationAgent = new ArbitrationAgent(llmClient);
  }

  async tagBook(book: Book): Promise<{ tags: GeneratedTag[]; usage: any }> {
    this.logger.info(`Orchestrator dispatching agents for book: ${book.title}`);
    
    // Concurrently run local specialized agents
    const [genreResult, moodResult] = await Promise.all([
      this.genreAgent.analyze(book),
      this.moodAgent.analyze(book),
    ]);

    let usage = addUsage(genreResult.usage, moodResult.usage);
    const combinedTags = [...genreResult.tags, ...moodResult.tags];

    // Check for low confidence from local models
    const hasLowConfidence = combinedTags.some(t => t.confidence < 0.7);

    if (hasLowConfidence) {
      this.logger.warn(`Orchestrator invoking ArbitrationAgent for ${book.title} due to low confidence scores`);
      const arbitrationResult = await this.arbitrationAgent.arbitrate(book, combinedTags);
      usage = addUsage(usage, arbitrationResult.usage);
      return { tags: arbitrationResult.tags, usage };
    }

    return { tags: combinedTags, usage };
  }
}

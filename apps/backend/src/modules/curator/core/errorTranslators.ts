import {
  AppError,
  LlmRateLimitError,
  LlmQuotaError,
  LlmRequestError,
  LlmInvalidResponseError,
} from './errors.js';
import Anthropic from '@anthropic-ai/sdk';

/** Type guard checking if an error is a standard JS Error object */
export function isErrorWithType(err: unknown): err is Error & { type: string } {
  return err instanceof Error && 'type' in err;
}

export function isErrorWithNestedType(
  err: unknown
): err is Error & { error: { type: string; message?: string } } {
  return (
    err instanceof Error &&
    'error' in err &&
    typeof err.error === 'object' &&
    err.error !== null &&
    'type' in err.error
  );
}

export function isHttpError(
  err: unknown
): err is Error & { status: number; headers?: Record<string, string> } {
  return err instanceof Error && 'status' in err && typeof err.status === 'number';
}

/**
 * Strategy interface for translating provider-specific errors into
 * our generic AppError domain (LlmRateLimitError, LlmQuotaError, etc.)
 */
export interface ProviderErrorTranslator {
  translate(err: unknown): AppError | unknown;
}

export class AnthropicErrorTranslator implements ProviderErrorTranslator {
  translate(err: unknown): AppError | unknown {
    if (err instanceof Anthropic.RateLimitError) {
      const h = err.headers as any;
      const retryAfter = h?.['retry-after'] || h?.get?.('retry-after');
      return new LlmRateLimitError(
        err.message,
        retryAfter ? parseInt(retryAfter, 10) : undefined
      );
    }
    
    if (isHttpError(err)) {
      if (err.status === 429) {
        // Fallback for 429s not caught by the SDK class
        const h = err.headers as any;
        const retryStr = h?.['retry-after'] || h?.get?.('retry-after');
        return new LlmRateLimitError(err.message, retryStr ? parseInt(retryStr, 10) : undefined);
      }
      
      const isOverloaded =
        err.status === 529 ||
        (err.status === 503 && err.message.toLowerCase().includes('overloaded'));
        
      if (isOverloaded) {
        return new LlmRateLimitError(`Provider overloaded: ${err.message}`);
      }

      if (err.status === 400 && err.message.toLowerCase().includes('credit')) {
        return new LlmQuotaError(err.message);
      }
    }

    // Generic Anthropic API errors
    if (err instanceof Anthropic.APIError) {
      if (err.message.toLowerCase().includes('invalid response')) {
        return new LlmInvalidResponseError(err.message);
      }
      return new LlmRequestError(err.message);
    }

    return err; // Return the original error if we couldn't translate it
  }
}

export class OllamaErrorTranslator implements ProviderErrorTranslator {
  translate(err: unknown): AppError | unknown {
    if (isHttpError(err)) {
      if (err.status === 404) {
        return new LlmRequestError(`Ollama model not found: ${err.message}`);
      }
      if (err.status === 500) {
        return new LlmRequestError(`Ollama server error: ${err.message}`);
      }
    }
    
    if (err instanceof Error) {
      if (err.message.includes('fetch failed') || err.message.includes('ECONNREFUSED')) {
        return new LlmRequestError(`Cannot connect to Ollama: ${err.message}`);
      }
    }

    return err;
  }
}

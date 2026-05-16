/**
 * services/groqService.js — v23.0 (compatibility shim)
 *
 * This file now routes through aiService.js.
 * OpenAI is the primary provider; Groq is the automatic fallback.
 *
 * All imports of groqService.js continue to work unchanged — no other
 * files need to be updated. This shim re-exports the unified AI functions
 * under the original groqService names.
 */

export {
  getAIReply,
  generateGreeting,
  answerAboutQuestion,
  isAboutQuestion,
  aiHealthCheck as groqHealthCheck,
} from './aiService.js';

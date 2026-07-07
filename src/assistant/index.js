import { fetchJson as defaultFetchJson } from '../utils/httpClient.js';
import { createOllamaClient } from './ollamaClient.js';
import { AssistantService } from './assistantService.js';

// Assemble the natural-language search assistant from a local Ollama server.
// Opt-in and OFF by default (it needs an external model server). Returns null
// when disabled. The assistant only suggests structured search queries; it is
// never wired to pricing, booking, or any money or compliance path.
export function createAssistantService(config, { fetchJson = defaultFetchJson } = {}) {
  if (!config.assistantEnabled) return null;
  const client = createOllamaClient({
    baseUrl: config.ollamaUrl,
    model: config.ollamaModel,
    enabled: true,
    fetchJson
  });
  return new AssistantService({ client });
}

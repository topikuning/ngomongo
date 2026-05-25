import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGroq } from "@langchain/groq";
import { ChatMistralAI } from "@langchain/mistralai";

export type ProviderType = "google" | "deepseek" | "groq" | "openai" | "mistral";

export interface ProviderConfig {
  provider: ProviderType;
  model: string;
  apiKey: string;
}

export function buildChatModel(cfg: ProviderConfig): BaseChatModel {
  switch (cfg.provider) {
    case "google":
      return new ChatGoogleGenerativeAI({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.7,
      });

    case "openai":
      return new ChatOpenAI({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.7,
      });

    case "deepseek":
      return new ChatOpenAI({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.7,
        configuration: {
          baseURL: "https://api.deepseek.com",
        },
      });

    case "groq":
      return new ChatGroq({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.7,
      });

    case "mistral":
      return new ChatMistralAI({
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: 0.7,
      });

    default:
      throw new Error(`Provider tidak dikenal: ${cfg.provider}`);
  }
}

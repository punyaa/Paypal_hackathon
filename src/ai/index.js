// AI provider: Anthropic, OpenAI, Google Gemini or Meta Muse through the Vercel AI SDK, or the offline mock.
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible";
import { config } from "../config.js";
import { MockAI } from "./mock.js";
import { criteriaSchema, verifySchema, DRAFT_SYSTEM, VERIFY_SYSTEM, verifyUserText } from "./prompts.js";

export function languageModel(cfg = config.ai) {
  if (cfg.provider === "anthropic") return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(cfg.anthropicModel);
  if (cfg.provider === "openai") return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(cfg.openaiModel);
  if (cfg.provider === "google") {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
    return createGoogleGenerativeAI({ apiKey })(cfg.googleModel);
  }
  if (cfg.provider === "meta") return metaModel(cfg);
  return null;
}

// Meta's Model API (Muse Spark) is OpenAI-compatible and supports response_format with a
// JSON schema, so structured output uses that rather than tool calls.
export function metaModel(cfg = config.ai, fetchImpl) {
  const apiKey = process.env.META_API_KEY || process.env.MODEL_API_KEY;
  const base = cfg.metaBaseUrl.replace(/\/$/, "");
  return new OpenAICompatibleChatLanguageModel(
    cfg.metaModel,
    {},
    {
      provider: "meta.chat",
      url: ({ path }) => `${base}${path}`,
      headers: () => ({ Authorization: `Bearer ${apiKey}` }),
      fetch: fetchImpl,
      defaultObjectGenerationMode: "json",
      supportsStructuredOutputs: true,
    },
  );
}

const MODEL_NAME = {
  anthropic: (c) => `anthropic:${c.anthropicModel}`,
  openai: (c) => `openai:${c.openaiModel}`,
  google: (c) => `google:${c.googleModel}`,
  meta: (c) => `meta:${c.metaModel}`,
};

export function createAI(cfg = config.ai) {
  if (cfg.provider === "mock") return new MockAI();
  const model = languageModel(cfg);
  if (!model) throw new Error(`Unknown AI_PROVIDER "${cfg.provider}". Use anthropic, openai, google, meta or mock.`);
  return new LlmAI(model, MODEL_NAME[cfg.provider](cfg));
}

export class LlmAI {
  constructor(model, name) {
    this.model = model;
    this.name = name;
  }

  async draftCriteria(description) {
    const { object } = await generateObject({
      model: this.model,
      schema: criteriaSchema,
      system: DRAFT_SYSTEM,
      prompt: `Milestone description:\n${description}`,
      temperature: 0.2,
    });
    return object.criteria;
  }

  async verify({ milestone, evidence }) {
    const content = [{ type: "text", text: verifyUserText({ milestone, evidence }) }];
    for (const shot of evidence.screenshots || []) {
      if (!shot.base64) continue;
      content.push({ type: "text", text: `${shot.label} screenshot:` });
      content.push({ type: "image", image: shot.base64, mimeType: shot.mimeType || "image/jpeg" });
    }
    const { object } = await generateObject({
      model: this.model,
      schema: verifySchema,
      system: VERIFY_SYSTEM,
      messages: [{ role: "user", content }],
      temperature: 0,
    });
    // Keep only results for real criteria, one per id.
    const ids = new Set(milestone.criteria.map((c) => c.id));
    const seen = new Set();
    return object.results.filter((r) => ids.has(r.criterionId) && !seen.has(r.criterionId) && seen.add(r.criterionId));
  }
}

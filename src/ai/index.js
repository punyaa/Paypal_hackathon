// AI provider: Anthropic or OpenAI through the Vercel AI SDK, or the offline mock.
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { config } from "../config.js";
import { MockAI } from "./mock.js";
import { criteriaSchema, verifySchema, DRAFT_SYSTEM, VERIFY_SYSTEM, verifyUserText } from "./prompts.js";

export function languageModel(cfg = config.ai) {
  if (cfg.provider === "anthropic") return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(cfg.anthropicModel);
  if (cfg.provider === "openai") return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(cfg.openaiModel);
  return null;
}

export function createAI(cfg = config.ai) {
  if (cfg.provider === "mock") return new MockAI();
  return new LlmAI(languageModel(cfg), cfg.provider === "anthropic" ? `anthropic:${cfg.anthropicModel}` : `openai:${cfg.openaiModel}`);
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

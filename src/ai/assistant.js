// ProofPay assistant: an AI agent with escrow tools (ours) and PayPal Agent Toolkit tools.
// Guardrail: the assistant can create milestones, look things up and send plain invoices,
// but it has no tool that captures, refunds or voids held money. Releases only happen
// through the deterministic release policy and the people involved.
import { generateText, tool } from "ai";
import { z } from "zod";
import { languageModel } from "./index.js";

// PayPal toolkit actions the assistant may use. Nothing that moves held money.
export const TOOLKIT_ACTIONS = {
  orders: { get: true },
  invoices: { create: true, send: true, list: true, get: true, generateQRC: true, sendReminder: true },
  transactions: { list: true },
};

const SYSTEM = `You are the ProofPay assistant for a freelancer.
ProofPay holds a client's payment with PayPal (authorize now, capture later) and releases it when
delivered work passes agreed acceptance criteria.

You can:
- draft acceptance criteria and create protected milestones (returns a link the client uses to fund it)
- check the status of milestones
- look up PayPal orders and recent transactions, and send plain PayPal invoices for small jobs that
  don't need protection (PayPal Agent Toolkit tools, when connected)

You cannot release, capture, refund or cancel held money. If asked, explain that releases happen
automatically when the work passes and the client doesn't object, or through the client and reviewer
buttons on the milestone page.

Be brief. Use the user's currency (default SGD). Criteria must be objective and checkable on the
delivered page. After creating a milestone, give the client link.`;

export function createAssistant({ service, config }) {
  const escrowTools = buildEscrowTools(service, config);
  const model = config.ai.provider === "mock" ? null : languageModel(config.ai);

  async function paypalTools() {
    if (service.paypal.mode === "mock" || !config.paypal.clientId) return {};
    try {
      const { PayPalAgentToolkit } = await import("@paypal/agent-toolkit/ai-sdk");
      const toolkit = new PayPalAgentToolkit({
        clientId: config.paypal.clientId,
        clientSecret: config.paypal.clientSecret,
        configuration: { actions: TOOLKIT_ACTIONS, context: { sandbox: config.paypal.mode !== "live" } },
      });
      return toolkit.getTools();
    } catch (err) {
      console.error("PayPal Agent Toolkit unavailable:", err.message);
      return {};
    }
  }

  return {
    async chat(messages) {
      const clean = messages
        .filter((m) => ["user", "assistant"].includes(m.role) && typeof m.content === "string")
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      if (!clean.length) return { reply: "Ask me to set up a protected milestone, or check on one.", steps: [] };
      if (!model) return mockChat(clean.at(-1).content, escrowTools);

      const tools = { ...escrowTools, ...(await paypalTools()) };
      const result = await generateText({ model, system: SYSTEM, messages: clean, tools, maxSteps: 6, temperature: 0.2 });
      const steps = result.steps.flatMap((s) =>
        (s.toolCalls || []).map((c, i) => ({
          tool: c.toolName,
          source: c.toolName in escrowTools ? "proofpay" : "paypal-agent-toolkit",
          args: c.args,
          result: summarize(s.toolResults?.[i]?.result),
        })),
      );
      return { reply: result.text, steps, toolsAvailable: Object.keys(tools) };
    },
  };
}

function buildEscrowTools(service, config) {
  const link = (m) => `${config.baseUrl}/m/${m.id}?k=${m.clientKey}`;
  return {
    draft_criteria: tool({
      description: "Draft 3-6 objective acceptance criteria for a milestone from a plain description of the work.",
      parameters: z.object({ description: z.string().min(10) }),
      execute: async ({ description }) => ({ criteria: await service.draftCriteria(description) }),
    }),
    create_milestone: tool({
      description: "Create a protected milestone. The client funds it from the returned link; the money is held by PayPal until the work passes.",
      parameters: z.object({
        title: z.string().min(3),
        amount: z.number().positive(),
        currency: z.string().length(3).default("SGD"),
        clientName: z.string().default("Client"),
        description: z.string().default(""),
        criteria: z.array(z.string()).optional().describe("Acceptance criteria; drafted automatically if omitted"),
      }),
      execute: async (args) => {
        const m = await service.create({
          title: args.title,
          amount: args.amount,
          currency: args.currency,
          description: args.description || args.title,
          criteria: args.criteria,
          client: { name: args.clientName },
          source: "assistant",
        });
        service.trace(m, "ai", "Milestone created by the ProofPay assistant", { args }, "assistant");
        service.store.put(m);
        return { id: m.id, title: m.title, amount: m.amount, currency: m.currency, criteria: m.criteria.map((c) => c.text), clientLink: link(m), freelancerLink: `${config.baseUrl}/f/${m.id}?k=${m.freelancerKey}` };
      },
    }),
    list_milestones: tool({
      description: "List the freelancer's milestones with status and where the money is.",
      parameters: z.object({}),
      execute: async () =>
        service.store.list().slice(0, 20).map((m) => ({ id: m.id, title: m.title, client: m.client.name, amount: m.amount, currency: m.currency, status: m.status, lastScore: m.decision ? Math.round(m.decision.score * 100) : null })),
    }),
    milestone_status: tool({
      description: "Get one milestone's status, last check result and next step.",
      parameters: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const m = service.get(id);
        return {
          id: m.id,
          title: m.title,
          status: m.status,
          releaseAt: m.releaseAt,
          decision: m.decision ? { action: m.decision.action, reason: m.decision.reason, score: m.decision.score } : null,
          paypal: { orderId: m.paypal.orderId, authorizationId: m.paypal.authorizationId, captures: m.paypal.captures.map((c) => ({ id: c.id, amount: c.amount })) },
        };
      },
    }),
  };
}

// Rule-based fallback so the assistant works in mock mode without an AI key.
async function mockChat(text, tools) {
  const t = text.toLowerCase();
  const steps = [];
  const run = async (name, args) => {
    const result = await tools[name].execute(args, { toolCallId: name, messages: [] });
    steps.push({ tool: name, source: "proofpay", args, result: summarize(result) });
    return result;
  };
  if (/(list|show|status|how are|what's|whats)/.test(t) && !/create|set up|new/.test(t)) {
    const list = await run("list_milestones", {});
    if (!list.length) return { reply: "You have no milestones yet.", steps };
    return { reply: list.map((m) => `${m.title}: ${m.status.replace(/_/g, " ")} (${m.currency} ${m.amount})`).join("\n"), steps };
  }
  const amount = Number((text.match(/(?:s\$|\$|sgd|usd)?\s?(\d[\d,]*(?:\.\d+)?)/i) || [])[1]?.replace(/,/g, ""));
  if (/(create|set up|new|protected)/.test(t) && amount > 0) {
    const currency = /usd|us\$/i.test(text) ? "USD" : "SGD";
    const forMatch = text.match(/for (.+?)(?:,|\.|$| at | worth )/i);
    const clientMatch = text.match(/client (?:is )?([A-Z][\w&' .]+?)(?:,|\.|$)/);
    const criteriaPart = text.split(/criteria:?/i)[1];
    const criteria = criteriaPart ? criteriaPart.split(/;|\n|,(?=\s*[A-Z])/).map((s) => s.trim()).filter(Boolean) : undefined;
    const m = await run("create_milestone", {
      title: capitalize((forMatch?.[1] || "New milestone").replace(/^(a|an|the)\s+/i, "").slice(0, 80)),
      amount,
      currency,
      clientName: clientMatch?.[1]?.trim() || "Client",
      description: text,
      criteria,
    });
    return { reply: `Created "${m.title}" for ${m.currency} ${m.amount}. Send your client this link to fund it: ${m.clientLink}`, steps };
  }
  return {
    reply: 'Mock assistant (no AI key set). Try: "Create a protected milestone for a landing page, S$600, client Kopi & Crumbs" or "Show my milestones".',
    steps,
  };
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function summarize(result) {
  const s = JSON.stringify(result ?? null);
  return s.length > 1500 ? `${s.slice(0, 1500)}...` : JSON.parse(s);
}

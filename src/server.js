import express from "express";
import path from "node:path";
import { config, ROOT } from "./config.js";
import { Store } from "./store.js";
import { createPayPal } from "./paypal/index.js";
import { createAI } from "./ai/index.js";
import { createVerifier, EVIDENCE_DIR } from "./evidence.js";
import { MilestoneService, AppError, toPublic, roleFor } from "./milestones.js";
import { createAssistant } from "./ai/assistant.js";

export function createApp({ service, assistant } = {}) {
  service ||= new MilestoneService({
    store: new Store(config.dataFile),
    paypal: createPayPal(),
    ai: createAI(),
    verifier: createVerifier(),
    config,
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const keyOf = (req) => req.query.k || req.get("x-proofpay-key") || req.body?.k;

  // Load a milestone and check the caller's role from the key in its link.
  const withRole = (...allowed) =>
    wrap(async (req, res, next) => {
      const m = service.get(req.params.id);
      const role = roleFor(m, keyOf(req));
      if (!role || (allowed.length && !allowed.includes(role))) throw new AppError(403, "This link does not allow that action");
      req.milestone = m;
      req.role = role;
      next();
    });

  const send = (res, m, role) => res.json(toPublic(m, role));

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  // ---------- public config ----------
  app.get("/api/config", (req, res) => {
    res.json({
      paypalMode: service.paypal.mode,
      paypalClientId: service.paypal.mode === "mock" ? null : config.paypal.clientId,
      aiProvider: service.ai.name,
      verifier: service.verifier.name,
      defaultCurrency: config.defaultCurrency,
      objectionWindowSeconds: config.objectionWindowSeconds,
    });
  });

  // ---------- freelancer ----------
  app.post(
    "/api/criteria/draft",
    wrap(async (req, res) => res.json({ criteria: await service.draftCriteria(req.body.description) })),
  );

  app.post(
    "/api/milestones",
    wrap(async (req, res) => {
      const m = await service.create(req.body);
      res.status(201).json(toPublic(m, "freelancer"));
    }),
  );

  // Dashboard list. Single-workspace demo: lists every milestone with its freelancer links.
  app.get("/api/milestones", (req, res) => res.json(service.store.list().map((m) => toPublic(m, "freelancer"))));

  app.get("/api/milestones/:id", withRole(), (req, res) => send(res, req.milestone, req.role));

  app.post(
    "/api/milestones/:id/submit",
    withRole("freelancer"),
    wrap(async (req, res) => {
      const m = await service.submit(req.params.id, req.body);
      send(res, m, req.role);
      // Verification runs in the background; the page polls for the result.
      service.verify(m.id).catch((err) => console.error(`verify ${m.id}:`, err.message));
    }),
  );

  app.post(
    "/api/milestones/:id/verify",
    withRole("freelancer"),
    wrap(async (req, res) => send(res, await service.verify(req.params.id), req.role)),
  );

  app.post(
    "/api/milestones/:id/offer-partial",
    withRole("freelancer"),
    wrap(async (req, res) => send(res, await service.offerPartial(req.params.id), req.role)),
  );

  // ---------- client ----------
  app.post(
    "/api/milestones/:id/order",
    withRole("client"),
    wrap(async (req, res) => res.json(await service.createOrder(req.params.id))),
  );

  app.post(
    "/api/milestones/:id/authorize",
    withRole("client"),
    wrap(async (req, res) => send(res, await service.authorize(req.params.id, req.body.orderId), req.role)),
  );

  app.post(
    "/api/milestones/:id/approve",
    withRole("client"),
    wrap(async (req, res) => send(res, await service.approve(req.params.id), req.role)),
  );

  app.post(
    "/api/milestones/:id/object",
    withRole("client"),
    wrap(async (req, res) => send(res, await service.object(req.params.id, req.body.reason), req.role)),
  );

  // ---------- either side ----------
  app.post(
    "/api/milestones/:id/cancel",
    withRole(),
    wrap(async (req, res) => send(res, await service.cancel(req.params.id, req.role), req.role)),
  );

  // Human review. In this demo the freelancer's workspace doubles as the reviewer console.
  app.post(
    "/api/milestones/:id/resolve",
    withRole("freelancer"),
    wrap(async (req, res) => send(res, await service.resolve(req.params.id, req.body), req.role)),
  );

  // ---------- assistant ----------
  assistant ||= createAssistant({ service, config });
  app.post(
    "/api/assistant",
    wrap(async (req, res) => res.json(await assistant.chat(req.body.messages || []))),
  );

  // ---------- pages ----------
  const pub = path.join(ROOT, "public");
  const page = (file) => (req, res) => res.sendFile(path.join(pub, file));
  app.get("/", page("index.html"));
  app.get("/new", page("new.html"));
  app.get("/m/:id", page("client.html"));
  app.get("/f/:id", page("freelancer.html"));
  app.get("/board", page("board.html"));
  app.use("/evidence", express.static(EVIDENCE_DIR, { maxAge: "1h" }));
  app.use(express.static(pub));

  // ---------- errors ----------
  app.use((err, req, res, next) => {
    const status = err.status && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || "Something went wrong" });
  });

  return { app, service };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, service } = createApp();
  setInterval(() => service.tick().catch((err) => console.error("tick:", err.message)), 5000);
  app.listen(config.port, () => {
    console.log(`ProofPay running at ${config.baseUrl}`);
    console.log(`PayPal: ${service.paypal.mode} | AI: ${service.ai.name} | Verifier: ${service.verifier.name}`);
  });
}

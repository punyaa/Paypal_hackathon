# ProofPay

**AI-verified milestone escrow on PayPal.** The client's money is held by PayPal when work starts. An AI agent checks the delivered work against criteria both sides agreed upfront. Code, not the AI, then decides whether to release full payment, partial payment or nothing.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (2026).

**Demo video:** _coming soon_
**Live demo:** _coming soon_

---

## The problem

Most freelance work is found outside marketplaces, through referrals, repeat clients, LinkedIn and WhatsApp. Those direct deals have no escrow:

- Pay upfront, and the client carries the risk.
- Pay after, and the freelancer carries the risk.
- Marketplaces fix this for a 13-25% cut (Freelancer.com ~13%, Upwork ~15%, Fiverr ~25%), and only for clients found on the marketplace.
- PayPal Seller Protection does not cover claims that an item "isn't what was ordered", which is the dispute freelancers face most.

## What ProofPay does

1. **Create.** The freelancer describes the milestone. The AI drafts checkable acceptance criteria.
2. **Share.** ProofPay gives a protected link to send on WhatsApp, email or LinkedIn.
3. **Fund.** The client approves with PayPal. The money is **authorized and held, not charged**.
4. **Deliver.** The freelancer submits a link to the work.
5. **Verify.** The AI opens the work on desktop and mobile, captures evidence and judges each criterion.
6. **Release.** A deterministic policy captures the full amount, offers a partial capture, or voids the hold. The client can object before any money moves.

Every AI decision and every PayPal request is recorded in the milestone's **trace**.

## How it uses PayPal

| PayPal capability | How ProofPay uses it |
| --- | --- |
| Orders v2, `intent: AUTHORIZE` | Hold the client's money when the milestone is funded |
| Payments v2, capture authorization | Release full or partial payment (`final_capture`) |
| Payments v2, void authorization | Release the hold back to the client |
| Payments v2, reauthorize | Extend a hold past the 3-day honor period (up to 29 days) |
| PayPal JS SDK | Client approves the hold in PayPal checkout |
| PayPal Agent Toolkit | Assistant agent tools for orders, refunds, invoices and transactions |

## How it uses AI

| Step | AI | Guardrail |
| --- | --- | --- |
| Draft criteria | Turns a plain description into objective, checkable criteria | Freelancer edits; client sees them before funding |
| Verify work | Judges each criterion from page text and desktop/mobile screenshots, with evidence and confidence | Low confidence goes to a human; the AI never moves money itself |
| Assistant | Creates milestones and looks up PayPal records from a chat message | Uses the same API and policy as the UI |

## Run it locally

```bash
npm install
npx playwright install chromium   # browser for the AI verifier
cp .env.example .env              # add PayPal sandbox and AI keys
npm start                         # http://localhost:3000
```

With no keys in `.env`, ProofPay runs in **mock mode**: PayPal and the AI are simulated, so the whole flow can be tried offline.

```bash
npm test                # unit tests
npm run check:sandbox   # verify PayPal sandbox credentials
```

## Docs

- [Implementation plan](docs/PLAN.md): architecture, state machine, release policy, API, build steps

## License

[MIT](LICENSE)

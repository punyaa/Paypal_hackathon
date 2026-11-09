# ProofPay - Implementation Plan

ProofPay is AI-verified milestone escrow on PayPal. The client's money is put on hold with PayPal when work starts, an AI agent checks the delivered work against criteria both sides agreed upfront, and deterministic rules release full payment, partial payment or nothing.

Deadline: Thu 12 Nov 2026, 12:00 PT (Fri 13 Nov, 04:00 Singapore time). Target: submitted Thursday evening, Singapore time.

---

## 1. The problem in one paragraph

Most freelance work is found outside marketplaces: referrals, repeat clients, LinkedIn, WhatsApp. On those direct deals there is no escrow, so either the client pays upfront and trusts the freelancer, or the freelancer works first and trusts the client. Marketplaces solve this for a 13-25% cut (Freelancer.com ~13%, Upwork ~15%, Fiverr ~25%). PayPal's Seller Protection does not cover "the work isn't what I ordered" claims, which is exactly the dispute freelancers face most.

## 2. How it works (user flow)

1. **Create.** The freelancer describes the milestone in plain words. The AI drafts 3-6 checkable acceptance criteria. The freelancer edits and saves.
2. **Share.** ProofPay produces a protected link. The freelancer sends it on WhatsApp, email or LinkedIn.
3. **Fund.** The client opens the link, reads the criteria and approves with PayPal. The money is **authorized (held), not captured**.
4. **Deliver.** The freelancer submits a link to the work.
5. **Verify.** The AI agent opens the work in a headless browser (desktop and mobile), captures text and screenshots, and judges each criterion with evidence and a confidence score.
6. **Decide (code, not AI).** A deterministic release policy turns the verdict into an action:
   - all criteria pass with high confidence: full release after the objection window
   - some pass: the freelancer can fix and resubmit, or offer a partial release for the passed share
   - few pass or low confidence: no money moves, a human decides
7. **Object.** The client can object during the window. An objection freezes the money and moves the milestone to human review.
8. **Settle.** ProofPay captures the full or partial amount through PayPal, or voids the authorization and the client's money is released.

Every AI decision, policy decision and PayPal request is written to the milestone's **trace**, which the UI shows end to end.

## 3. Architecture

```
Browser pages (plain HTML + JS, AG Grid, PayPal JS SDK)
   |  dashboard  |  client link /m/:id  |  freelancer /f/:id  |  job board /board  |  embed.js
   v
Express API (Node 22)
   |-- milestones service: state machine + deterministic release policy
   |-- trace: append-only event log per milestone
   |-- scheduler: releases funds when the objection window closes
   |-- AI layer (Vercel AI SDK; OpenAI or Anthropic; offline mock)
   |      |-- draftCriteria(description)
   |      |-- verifyWork(criteria, evidence)
   |      |-- assistant agent: escrow tools + PayPal Agent Toolkit tools
   |-- evidence collector (Playwright headless Chromium; fetch fallback)
   |-- PayPal client (REST, sandbox or offline mock)
   |      |-- Orders v2: create order with intent AUTHORIZE, get order, authorize
   |      |-- Payments v2: capture authorization (full or partial, final_capture), void, reauthorize
   v
JSON file store (data/db.json)
```

Why direct REST for the hold: the PayPal Agent Toolkit's `create_order` always uses `intent: CAPTURE`, so it cannot place a hold. The toolkit is still used by the assistant agent for invoices, order lookups, refunds and transactions.

## 4. Milestone state machine

```
draft -> awaiting_funding -> funded -> submitted -> verifying -> verified
verified -> released            (full capture after objection window, or client approves early)
verified -> partially_released  (partial capture, final, rest released to client)
verified -> changes_requested -> submitted (freelancer resubmits)
verified -> disputed            (client objects; human resolves)
funded | changes_requested -> cancelled (void; client's money released)
disputed -> released | partially_released | cancelled (human resolution)
```

## 5. Release policy (deterministic)

- Each criterion has a weight (default equal). A criterion counts as passed only if the AI says pass **and** confidence >= 0.7.
- `score = passed weight / total weight`.
- `score == 1` and no low-confidence criteria: **auto full release** when the objection window closes.
- `0.5 <= score < 1`: **no auto release.** The freelancer chooses: resubmit, or offer `round(amount * score, 2)` as a partial release, which the client can approve or object to.
- `score < 0.5` or any low-confidence criterion: **human review**, no money moves.
- Hard limits, enforced in code: capture <= authorized amount; one final capture per milestone; no capture after the authorization expires; every call logged to the trace.
- Objection window: 48h by default; `OBJECTION_WINDOW_SECONDS` shortens it for demos.

## 6. API

| Method | Path | Who | What |
| --- | --- | --- | --- |
| POST | /api/criteria/draft | freelancer | AI drafts criteria from a description |
| POST | /api/milestones | freelancer | Create a milestone |
| GET | /api/milestones | freelancer | List milestones (dashboard) |
| GET | /api/milestones/:id | both | Milestone with trace (role-filtered by key) |
| POST | /api/milestones/:id/order | client | Create PayPal order (AUTHORIZE) |
| POST | /api/milestones/:id/authorize | client | Authorize after PayPal approval: money on hold |
| POST | /api/milestones/:id/submit | freelancer | Submit work URL |
| POST | /api/milestones/:id/verify | system | Run the AI verifier |
| POST | /api/milestones/:id/approve | client | Approve early: release now |
| POST | /api/milestones/:id/object | client | Object: freeze for review |
| POST | /api/milestones/:id/offer-partial | freelancer | Offer partial release |
| POST | /api/milestones/:id/cancel | either | Void the hold |
| POST | /api/milestones/:id/resolve | reviewer | Human resolution |
| POST | /api/assistant | freelancer | AI assistant with escrow + PayPal toolkit tools |

Role keys: each milestone has a `clientKey` and a `freelancerKey` carried in its links (`?k=`). No accounts for the hackathon.

## 7. Step-by-step build (one commit per step)

| Step | Commit | Done when |
| --- | --- | --- |
| 1 | Plan and README | This file and the README describe ProofPay |
| 2 | Server, store, PayPal client | `npm test` passes the PayPal client in mock mode; sandbox check works with keys |
| 3 | Milestones API, policy, trace | Unit tests cover every state transition and the policy |
| 4 | AI layer and evidence collector | Verifier passes the "good" sample site and partially fails the "partial" one |
| 5 | Frontend pages | Create, fund, submit, verify and release work in the browser (mock mode) |
| 6 | AG Grid dashboard and trace view | Tracker and end-to-end trace render |
| 7 | Embed widget and job board | `/board` shows "Hire with protection" buttons that open the flow |
| 8 | Assistant agent (Agent Toolkit) | Assistant creates a milestone and looks up a PayPal order from a chat message |
| 9 | Sandbox end to end | Real sandbox authorization, partial capture and void appear in the trace |
| 10 | Deploy and submission | Live on Render; README, Devpost text and video script final |

## 8. Daily checks

**Mon 9 Nov:** steps 1-4. Done when the full flow runs from the command line in mock mode.
**Tue 10 Nov:** steps 5-6, plus step 9 once sandbox keys are in. Done when the flow works in the browser against the PayPal sandbox.
**Wed 11 Nov:** steps 7-8 and deploy. Feature freeze 21:00 Singapore time.
**Thu 12 Nov:** README, Devpost text, screenshots, video, submit by the evening.

## 9. Demo script (target 2:50)

1. 0:00 The problem: direct freelance deals have no protection; PayPal Seller Protection excludes "not what I ordered".
2. 0:25 Freelancer (Bangalore) creates a S$1,200 landing-page milestone; AI drafts criteria.
3. 0:50 Client (Singapore) opens the link and approves with PayPal: money held, not charged.
4. 1:15 Freelancer submits; the AI checks the site on desktop and mobile; 3 of 4 criteria pass, with screenshots.
5. 1:45 Policy offers partial release; freelancer fixes, resubmits, 4 of 4 pass; release after the objection window.
6. 2:15 Trace view: every AI decision and PayPal call, end to end.
7. 2:30 Scale: embed button on a job board; assistant tools; built on PayPal authorize and capture.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| AI misjudges work | Objective criteria only, evidence for every verdict, confidence threshold, client objection window |
| Authorization limits | Milestones under 29 days; 3-day honor period, reauthorize when needed; card holds may be shorter |
| Headless browser on Render | Fetch-based text fallback on the live site; full check shown in the video |
| Sandbox keys late | Everything runs in mock mode first; sandbox wired behind the same interface |

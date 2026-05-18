# Hearme Seed Loop

> The minimum viable wedge to get Hearme from zero to a defensible, growing marketplace — built around the people who are already running personal AI infrastructure today.

## Strategic Logic

Hearme's full vision depends on a future in which most people have a personal AI agent that knows them well. That future is arriving, but it is not here yet. A v1 that tries to be the full vision will fail twice: the respondent side will be too thin, and the buyer side will reject methodology it cannot defend.

The seed loop solves this by picking a wedge that satisfies three constraints simultaneously:

1. **The respondents already exist.** A real, motivated, technically capable pool is reachable today — not in three years.
2. **The buyer side will pay before validation is mature.** The category has buyers who are hungry, fast-moving, and methodologically tolerant.
3. **The questions don't require deep personal context.** The agent only needs to know what is already in its conversation history with the user.

The Openclaw and Hermes user base satisfies (1) directly. They have opted into self-hosted personal AI, they are looking for things to do with that infrastructure, and they are ideologically pre-sold on the "your voice, your data, your terms" framing. They are not a generic seed pool — they are the right one.

---

## The Wedge: AI Developer Tools and Crypto/Web3 Brand Perception

The cleanest fit is brand and product perception in two adjacent technical verticals:

- **AI developer tools.** Coding agents, IDE assistants, agent frameworks, evaluation tools, inference providers.
- **Crypto / web3 consumer products.** Wallets, L2s, on-chain apps, developer infrastructure.

Why this segment:

- The Openclaw and Hermes user base **is** the population those buyers are trying to reach. Vercel, Anthropic, OpenAI, Linear, Cursor, Replit, every agent framework company, every wallet — they spend real money trying to learn what technical builders think, and they have no good panel today. The current state of the art is "ask on Twitter and hope."
- Questions in this domain need *shallow* personal context. "Which coding agent do you prefer for refactors?", "Did Cursor's pricing change move you off?", "Would you switch from N8N to Hermes?" — the agent only needs to know what tools the user actually uses, which is already in its conversation history. The agent does not need to model the user's foreign policy views.
- Buyers in this segment will tolerate a methodologically novel product. A CMO at Coca-Cola will not. A DevRel lead at a YC company will pay $500 to see what 2,000 verified builders think by Friday.
- Failure modes are bounded. If an early pilot produces a weird result on "preferred IDE," nobody's legitimacy is in crisis. The same is not true for civic questions.

---

## The Seed Loop

### Respondent Side (Weeks 1–4)

- Ship a Hearme skill / MCP server installable in one command on Openclaw and Hermes.
- User configures category opt-ins ("AI tools: yes, crypto: yes, politics: no"), sets a minimum stake threshold, and forgets about it.
- Identity for MVP: GitHub OAuth (account at least one year old) plus Openclaw or Hermes deployment fingerprint. Manually review the first 500 sign-ups.
- This is not Worldcoin-grade sybil resistance. It is good enough to defend a $50,000 buyer pilot, which is all that is needed at this stage.
- Payment in USDC on Base. Fiat off-ramp comes later. Do not fight payment rails in v1.

### Buyer Side (Weeks 1–8)

- One named lighthouse customer per question type. Target: Anthropic, an AI agent framework company, a developer-tools YC company, a crypto wallet. Three of these are reachable through the founder's existing network.
- MVP pricing: **$0.01 per response**, not a fraction of a cent. Subsidize the cohort to bootstrap a tight feedback loop. Drop the price as N grows and inference costs fall.
- Turnaround SLA: 48 hours to N=500, one week to N=2,000.
- Invoice manually. No Stripe integration in v1.

### The Validation Moment (Months 2–3)

- Replicate a known public dataset head-to-head from Hearme respondents. Candidates: the Stack Overflow Developer Survey, State of JS, the JetBrains developer survey.
- Publish the result: *"We reproduced the IDE preference distribution within X% across the seven largest demographic buckets, using N=Y agent-mediated responses at Z% of the cost."*
- This single artifact is what unlocks the next ten buyers. Without it, every buyer conversation restarts from skepticism. With it, every conversation starts from "show me the methodology paper."

---

## What Gets Built, What Gets Deferred

### Build now

- Openclaw and Hermes plugin — the "you already have the infrastructure" play.
- Question feed, agent-side answering, aggregation, demographic composition view.
- GitHub OAuth identity layer with manual review queue.
- Planted-test infrastructure from day one. Even at small N, it is the credibility story.
- Override and review UI: "here is what your agent said this week — fix anything."

### Defer

- **MACI and cryptographic anti-collusion.** Beautiful, but premature. Nobody is bribing voters at N=500. Ship in v2 once the system is worth attacking.
- **Civic and political questions.** Especially these. The mechanism should not be litigating "is Hearme legitimate on Ukraine?" while still proving the basic primitive works on dev tools.
- **Credit-card buyer onboarding.** Invoice the first ten buyers manually.
- **General-purpose web sign-up flow.** Openclaw and Hermes only at first is a feature, not a limitation — it tells buyers "your respondents are real, technical, self-hosted humans," which is a stronger story than "anyone with an email."
- **Demographic re-weighting.** Publish composition, do not weight. Honest composition is the v1 transparency story.

---

## The Pitch

### To respondents

> You already run Openclaw or Hermes. You already have opinions about the tools you use every day. Install one skill. Your agent answers questions in categories you have chosen. You earn somewhere between $5 and $30 a month at current rates, growing as buyers come online. Every answer your agent gave is reviewable. Override anything. Pause anytime.

This pitch is true today. It does not require the "agent that knows your soul" future to arrive. It gives the Openclaw and Hermes communities a concrete second use case for infrastructure they already run.

### To buyers

> Traditional developer surveys take six months and cost $50,000. This costs $500 and turns around in 48 hours. Respondents are real, verified, GitHub-aged builders running their own self-hosted AI agents — the exact population you are trying to reach. We publish full demographic composition alongside every result, so you can judge the data rather than trust a hidden weighting scheme. Use Hearme for one of your next ten research questions. Compare it to whatever else you trust.

---

## Success Criteria for Graduating to V2

The seed loop is done when:

- 2,000+ verified Openclaw / Hermes respondents are actively connected.
- Five repeat buyers have run at least three questions each.
- One published validation study shows fidelity against an external public dataset.
- Planted-test failure rates are below 2% and stable.
- Monthly run rate exceeds $20,000 in buyer revenue.

At that point, the platform earns the right to expand:

- Broader respondent on-ramp beyond Openclaw and Hermes.
- MACI integration.
- First civic questions, starting with low-stakes technology policy where the dev-tools respondent pool is already credible.
- Stripe and fiat payments on both sides.

---

## The Strategic Point

Do not try to be Hearme-the-vision in v1. Be **"Stack Overflow Survey, but continuous, and the respondents get paid"** in v1. The vision is what the platform grows into once the dev-tools wedge has produced a few quarters of buyer-defensible data and a five-figure respondent pool. The Openclaw and Hermes user base is the head start that makes this credible — they are already running the infrastructure, already aligned with the principles, and already looking for the next thing to do with their agent.

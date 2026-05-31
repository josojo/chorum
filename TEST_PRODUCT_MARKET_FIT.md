# Testing Product Market Fit

This document describes the current product-market-fit strategy for Hearme.
The goal is not to prove the full long-term vision immediately. The goal is to
prove, as fast as possible, that a buyer will pay for fast, AI-assisted,
human-validated opinion signal from a real respondent group.

The main PMF risk is not whether the system can eventually support identity,
payments, cryptographic auditability, or agent integrations. The main risk is
whether buyers believe the output is decision-grade human signal rather than
model-shaped synthetic opinion.

The fastest test is therefore a narrow paid pilot: one buyer niche, around 100
real participants, easy agent onboarding, explicit identity linking, and a
clear measurement of how faithfully the agents represented their users.

Onboarding is part of the product, not an implementation detail. If connecting
an agent, importing a ChatGPT export, or linking identity feels confusing,
users will simply not complete the pilot. The PMF test only works if onboarding
is simple, well tested, and fast enough that a normal participant can finish it
without developer support.

## 1. Minimum Technical Proof

Before selling serious pilots, Hearme needs a working technical loop that is
simple enough for early users and credible enough for buyers.

The minimum technical proof is:

1. An asker can post a question.
2. Real users can connect an agent or memory source.
3. Each user is linked to a unique identity.
4. The agent answers on the user's behalf.
5. The user can inspect, approve, edit, reject, or override the answer.
6. The aggregate result is visible to the buyer with basic respondent metadata.
7. The system records enough fidelity data to say whether the answer was
   accepted by the user or corrected.

The onboarding flow must be tested as carefully as the answering loop. A user
should understand what is being connected, what data stays local, what will be
sent to Hearme, and how to stop participation. Any confusing step will create
drop-off and will make the PMF test unreliable.

The first integrations should cover three participant paths:

- **OpenClaw agents**: users who already run or want to run an OpenClaw-style
  personal agent.
- **Hermes agents**: users who can install the Hearme skill into Hermes and let
  it answer through their existing model and memory setup.
- **ChatGPT export-only agents**: users who do not run a persistent agent yet,
  but can export their ChatGPT history and use that export as the memory source
  for a lightweight Hearme participant.

The ChatGPT export path is especially important for PMF because it broadens the
initial participant pool. If Hearme only works for people already running
Hermes or OpenClaw, the early supply side will be too small.

For this PMF test, the identity requirement should be practical rather than
perfect. The system should link each participant to a unique identity and make
duplicate participation difficult. Full production-grade identity can improve
later, but the pilot must already avoid obvious duplicate-response abuse.

The target onboarding bar:

- a participant can complete setup in under 10 minutes;
- the user never has to understand the full architecture;
- the user sees a clear confirmation that their agent or export is connected;
- the user sees exactly what answer will be submitted before trusting the
  system;
- the user can pause or leave the pilot without asking for help.

## 2. Buyer Niche

The first buyer niche should be agent developers and agent-tool builders.

This is the most natural early market because:

- they understand the idea of personal agents;
- they have concrete questions about positioning, trust, onboarding, and user
  demand;
- they are reachable directly;
- they are more likely to tolerate an early product;
- they may themselves become distribution partners;
- OpenClaw or Hermes-related teams could plausibly buy the first study.

The initial offer should be specific:

> Ask 100 real AI-agent users or potential AI-agent users what they think about
> your agent product, onboarding flow, positioning, trust model, or missing
> features. Get results in days, with human-validated agent answers and clear
> demographic/context breakdowns.

Good first buyer questions:

- "What would make you trust a personal agent enough to run it continuously?"
- "What stops you from installing Hermes or OpenClaw today?"
- "Which agent capabilities would you pay for first?"
- "Would you rather run an agent locally, in the cloud, or through a managed
  provider?"
- "How do developers compare OpenClaw, Hermes, ChatGPT, Claude, and other agent
  systems?"
- "What part of the onboarding flow feels too hard or too risky?"

The buyer should not be sold a generic survey product. The buyer should be sold
access to a very specific panel: real people who are close to adopting personal
agents.

## 3. Recruit 100 Real Participants

The first supply-side goal is 100 real participants.

This number is large enough to create a meaningful first study, but small
enough to recruit manually. The goal is not scale yet. The goal is to learn
whether users are willing to connect memory, let an agent answer, and review
the answer.

The best recruiting strategy is direct, manual, and local:

- visit coworking spaces;
- talk to people individually;
- explain the idea in person;
- help them set up the agent or ChatGPT export path;
- observe where they hesitate;
- record which objections repeat;
- keep the onboarding flow as hands-on as needed.

This is deliberately not a passive online launch. Early PMF will be learned
from conversations, objections, failed installs, privacy concerns, and actual
review behavior.

During recruiting, every onboarding session should be treated as a usability
test. Watch where people hesitate. Do not explain too early. If the same step
needs verbal explanation three times, the product needs to make that step
simpler.

Target participant profiles:

- AI developers;
- startup founders;
- indie hackers;
- product managers;
- technical writers;
- designers working on AI tools;
- people already using ChatGPT heavily;
- people curious about personal agents but not yet running one.

Possible recruiting locations:

- coworking spaces;
- AI meetups;
- hackathons;
- university entrepreneurship centers;
- startup accelerators;
- local developer communities;
- open-source agent Discords and Telegram groups;
- Hermes and OpenClaw communities.

## 4. Participant Incentive

A practical first recruiting budget is $1,000 for 100 participants.

One concrete plan:

- give each participant a $10 voucher;
- the voucher pays for running their Hermes/OpenClaw agent, model usage, or
  Hearme onboarding experiment;
- in exchange, the participant connects an agent or ChatGPT export, answers the
  first study, and reviews the agent's answer.

The point of the $10 is not to create a long-term payout model. It is to remove
friction from the first experiment and create enough real participant data to
sell and validate the first pilots.

The participant ask should be simple:

1. Join the pilot.
2. Connect Hermes, OpenClaw, or a ChatGPT export.
3. Answer a short onboarding profile.
4. Let the agent answer study questions.
5. Review the answers and approve/edit/reject them.

The most important measurement is not whether users like the $10. The most
important measurement is whether users are comfortable letting an agent speak
for them after they see the actual answer.

## 5. Sell Five Paid Pilots

The commercial PMF goal is to sell five paid pilots.

The first pilots should be small and concrete. A good initial price range is
$500 to $2,000 per study, depending on how much manual work is needed and how
specific the buyer segment is.

Pilot success should be measured by buyer behavior, not compliments.

Strong evidence:

- a buyer pays for a study;
- a buyer uses the result to change messaging, onboarding, roadmap, pricing, or
  positioning;
- a buyer asks for a follow-up study;
- a buyer refers another buyer;
- a buyer says the result was faster, cheaper, or more useful than interviews,
  surveys, or community polling.

Weak evidence:

- people say the idea is interesting;
- people sign up for updates;
- participants answer because they received a voucher;
- buyers like the vision but do not pay;
- crypto or agent communities discuss the idea but no one funds a question.

The minimum PMF target:

- 100 recruited participants;
- 5 paid buyer pilots;
- at least 1 repeat buyer;
- at least 70% of agent-generated answers approved or only lightly edited by
  users;
- clear evidence that buyers used the output for a real decision.

## 6. What To Measure

The PMF test should measure both sides of the marketplace.

Participant-side metrics:

- signup-to-connected-agent conversion;
- time to connect Hermes, OpenClaw, or ChatGPT export;
- percentage of users who complete identity linking;
- percentage of users who allow agent answering;
- percentage of answers approved without edit;
- percentage of answers lightly edited;
- percentage of answers rejected;
- no-signal rate;
- privacy objections;
- drop-off point during onboarding.

Buyer-side metrics:

- number of buyer conversations;
- number of pilots sold;
- price paid per pilot;
- time from first conversation to payment;
- buyer's stated alternative;
- whether the result changed a real decision;
- whether the buyer buys again;
- whether the buyer asks for different respondent niches.

The key metric is agent fidelity:

> When a user reviews what the agent said on their behalf, do they accept it as
> a fair representation of their view?

If this fails, the product does not yet have a trustworthy supply side. If this
works, then identity, payments, and stronger integrity mechanisms become worth
scaling.

## 7. Recommended Execution Plan

### Week 1: Prepare the pilot

- Define the first buyer offer for agent developers.
- Create a short demo study around agent adoption, trust, and onboarding.
- Make sure all three participant paths are usable: Hermes, OpenClaw, and
  ChatGPT export.
- Create a simple review flow where users approve, edit, or reject answers.
- Prepare a simple results report template for buyers.
- Test onboarding with at least 5 friendly users before recruiting broadly.
- Fix every blocking or confusing onboarding step before asking strangers to
  participate.

### Weeks 2-3: Recruit participants manually

- Visit coworking spaces and talk to people one by one.
- Offer the $10 voucher.
- Help users onboard live.
- Record every onboarding problem and objection.
- Recruit toward 100 participants.

### Weeks 3-4: Sell pilots while recruiting

- Contact OpenClaw, Hermes, and adjacent agent-tool builders.
- Offer a paid study with the first 100-agent-user panel.
- Sell the outcome, not the protocol: fast insight from real AI-agent users.
- Aim for five paid pilots.

### Weeks 4-6: Run the studies

- Run each buyer's questions through the participant pool.
- Require answer review where possible.
- Track approval/edit/reject rates.
- Deliver a concise buyer report with aggregate answers, notable segments,
  no-signal rates, and fidelity metrics.
- Ask for a follow-up purchase immediately after delivery.

## 8. Decision Rules

Continue if:

- buyers pay for the studies;
- participants complete onboarding without heavy hand-holding after the first
  few iterations;
- most users accept their agent's answers as representative;
- buyers request follow-up questions or new segments.

Pause and rethink if:

- onboarding regularly takes more than 10 minutes;
- users need repeated explanation to understand what they are connecting;
- users do not want to connect memory or exports;
- users consistently reject the agent's answers;
- buyers find the results interesting but not useful;
- every pilot requires too much manual explanation;
- the only interested buyers are people excited by the ideology, not people
  with a concrete research need.

The core question is simple:

> Can Hearme produce an answer that users recognize as their own and buyers
> trust enough to pay for?

That is the product-market-fit test.

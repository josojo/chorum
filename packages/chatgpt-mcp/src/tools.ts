import type { ChorumService } from "./service.js";

/** Maps MCP tool calls to the consented service; no credential is in any result. */
export function createToolDispatcher(service: ChorumService) {
  return async (userId: string, name: string, args: Record<string, unknown>) => {
    switch (name) {
      case "chorum_authorize":
        return service.authorize(userId, args.consentAutomaticVoting === true, args.consentHistoryUse === true);
      case "chorum_complete_identity":
        return service.completeIdentity(userId, String(args.state ?? ""));
      case "chorum_latest_questions":
        return { questions: await service.latestQuestions(userId) };
      case "chorum_vote":
        if (typeof args.question_id !== "string" || !(typeof args.answer === "string" || args.answer === null)) throw new Error("question_id and answer are required");
        return service.vote(userId, args.question_id, args.answer);
      case "chorum_review":
        return service.review(userId);
      case "chorum_revoke":
        if (typeof args.question_id !== "string") throw new Error("question_id is required");
        return service.revoke(userId, args.question_id);
      case "chorum_reset":
        return service.reset(userId);
      default:
        throw new Error("unknown Chorum tool");
    }
  };
}

// The /customize_order agent the visualizer hosts, as the run page sees it. Shared by the server and the UI.

export interface QuestionOption {
  label: string;
  description: string;
}

/** One question from the agent's AskUserQuestion call. "Other" (free text) is always allowed and not listed. */
export interface AgentQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/**
 * none: no agent for this PR. starting / running: working, nothing to answer.
 * waiting: `pending` holds questions to answer with the card.
 * idle: the agent's turn ended without answering the request (it asked in plain text); answer with the reply box.
 * done: the request was answered (its summary is posted). failed: `error` says why.
 */
export type CustomizeStatus = "none" | "starting" | "running" | "waiting" | "idle" | "done" | "failed";

export interface CustomizeState {
  pr: number;
  status: CustomizeStatus;
  sessionId: string | null;
  pending: { id: string; questions: AgentQuestion[] } | null;
  error: string | null;
}

/**
 * POST /api/customize/:pr/answer. Keyed by question text. A multi-select answer joins its labels with ", ";
 * "Other" sends the typed text as the answer.
 */
export interface AnswerBody {
  id: string;
  answers: Record<string, string>;
}

/** POST /api/customize/:pr/reply: a free-text message, for when the agent asked in plain text (status idle). */
export interface ReplyBody {
  text: string;
}

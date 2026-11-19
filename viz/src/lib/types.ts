// Single switch point onto the server's contract: everything UI-side imports
// table shapes from here, which re-exports shared/types.ts.
export type {
  Session,
  SessionSummary,
  SessionUsage,
  SessionDetail,
  Phase,
  Event as EventRow,
  EventsPage,
  Envelope,
  GateResult,
  GateCheck,
  AgentSession,
  AgentStartPayload,
  AgentEndPayload,
  UsageBreakdown,
  ToolCallPayload,
  AgentPrompts,
  PromptsResponse,
  HealthResponse,
  SessionStatus,
  PhaseStatus,
  PhaseKind,
  EventType,
} from '@shared/types'

// The factory backend's extras on top of the shared shapes (type-only, erased at build).
export type {
  Need,
  NeedKind,
  LaneMeta,
  OrderStatus,
  OrderSummary,
  OrderDetail,
} from '../../server/factory-model'
export type { FeedItem } from '../../server/transcripts'

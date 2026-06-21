// ---------------------------------------------------------------------------
// Mail-logs — barrel exports
// ---------------------------------------------------------------------------

export {
  listMailLogs,
  getMailLog
} from "./actions";

export type {
  MailLogListItem,
  ListMailLogsResult
} from "./schemas";

export {
  mailLogListItemSchema,
  listMailLogsResultSchema,
  listMailLogsSchema,
  getMailLogSchema
} from "./schemas";

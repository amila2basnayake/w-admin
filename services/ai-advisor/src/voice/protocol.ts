// Retell Custom-LLM WebSocket protocol (https://docs.retellai.com/api-references/llm-websocket) and the
// slice of the REST/webhook shapes we touch. Field names are Retell's, verbatim.

export interface RetellUtterance {
  role: 'agent' | 'user';
  content: string;
  words?: Array<{ word: string; start: number; end: number }>;
}

/** Messages Retell sends us. */
export type RetellInbound =
  | { interaction_type: 'ping_pong'; timestamp: number }
  | { interaction_type: 'call_details'; call: RetellCall }
  | { interaction_type: 'update_only'; transcript: RetellUtterance[]; turntaking?: 'agent_turn' | 'user_turn' }
  | { interaction_type: 'response_required'; response_id: number; transcript: RetellUtterance[] }
  | { interaction_type: 'reminder_required'; response_id: number; transcript: RetellUtterance[] };

/** Messages we send Retell. */
export type RetellOutbound =
  | { response_type: 'config'; config: { auto_reconnect?: boolean; call_details?: boolean; transcript_with_tool_calls?: boolean } }
  | { response_type: 'ping_pong'; timestamp: number }
  | {
      response_type: 'response';
      response_id: number;
      content: string;
      content_complete: boolean;
      no_interruption_allowed?: boolean;
      end_call?: boolean;
      transfer_number?: string;
    }
  | { response_type: 'agent_interrupt'; interrupt_id: number; content: string; content_complete: boolean; no_interruption_allowed?: boolean; end_call?: boolean }
  | { response_type: 'update_agent'; agent_config: { responsiveness?: number; interruption_sensitivity?: number; reminder_trigger_ms?: number; reminder_max_count?: number } }
  | { response_type: 'metadata'; metadata: Record<string, unknown> };

/** The call object (Register/Get Call response, webhook payload). Subset. */
export interface RetellCall {
  call_id: string;
  agent_id?: string;
  call_type?: 'phone_call' | 'web_call';
  call_status?: 'registered' | 'not_connected' | 'ongoing' | 'ended' | 'error';
  direction?: 'inbound' | 'outbound';
  from_number?: string;
  to_number?: string;
  metadata?: Record<string, unknown>;
  retell_llm_dynamic_variables?: Record<string, string>;
  start_timestamp?: number;
  end_timestamp?: number;
  disconnection_reason?: string;
  transcript?: string;
  transcript_object?: RetellUtterance[];
  recording_url?: string;
  call_analysis?: { call_summary?: string; user_sentiment?: string; call_successful?: boolean; in_voicemail?: boolean; custom_analysis_data?: Record<string, unknown> };
  call_cost?: { combined_cost?: number; total_duration_seconds?: number };
  duration_ms?: number;
}

export interface RetellWebhookEvent {
  event: 'call_started' | 'call_ended' | 'call_analyzed' | string;
  call: RetellCall;
}

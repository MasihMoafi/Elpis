//! Elpis: the Context Ledger's category shares on `thread/tokenUsage/updated`.
//!
//! Core keeps the latest request's composition in the thread's extension data
//! (`codex_core::elpis_context_attribution`); this reads it when token usage is forwarded. It
//! carries estimated sizes per category only, never message content.

use codex_app_server_protocol::ThreadContextAttribution;
use codex_core::CodexThread;
use codex_core::elpis_context_attribution::ContextAttributionSnapshot;

/// The thread's latest request composition, if a request has been built.
pub(crate) fn latest(thread: &CodexThread) -> Option<ThreadContextAttribution> {
    codex_core::elpis_context_attribution::latest(thread.thread_extension_data())
        .map(thread_context_attribution)
}

fn thread_context_attribution(snapshot: ContextAttributionSnapshot) -> ThreadContextAttribution {
    ThreadContextAttribution {
        system_instructions: snapshot.system_instructions,
        developer_messages: snapshot.developer_messages,
        user_messages: snapshot.user_messages,
        agent_messages: snapshot.agent_messages,
        reasoning: snapshot.reasoning,
        tool_calls: snapshot.tool_calls,
        tool_results: snapshot.tool_results,
        tool_definitions: snapshot.tool_definitions,
        output_schema: snapshot.output_schema,
        unrecognized_items: snapshot.unrecognized_items,
        estimated_total: snapshot.estimated_total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn every_category_crosses_the_wire_unchanged() {
        let snapshot = ContextAttributionSnapshot {
            system_instructions: 1,
            developer_messages: 2,
            user_messages: 3,
            agent_messages: 4,
            reasoning: 5,
            tool_calls: 6,
            tool_results: 7,
            tool_definitions: 8,
            output_schema: 9,
            unrecognized_items: 10,
            estimated_total: 55,
        };
        assert_eq!(
            thread_context_attribution(snapshot),
            ThreadContextAttribution {
                system_instructions: 1,
                developer_messages: 2,
                user_messages: 3,
                agent_messages: 4,
                reasoning: 5,
                tool_calls: 6,
                tool_results: 7,
                tool_definitions: 8,
                output_schema: 9,
                unrecognized_items: 10,
                estimated_total: 55,
            }
        );
    }
}

use super::*;
use pretty_assertions::assert_eq;
use serde_json::json;

#[test]
fn subscription_logins_say_so_and_every_other_login_says_observation_is_off() {
    for mode in [
        AuthMode::Chatgpt,
        AuthMode::ChatgptAuthTokens,
        AuthMode::Headers,
        AuthMode::AgentIdentity,
        AuthMode::PersonalAccessToken,
    ] {
        assert_eq!(
            turn_cost(Some(mode)),
            TurnCostState::Unavailable {
                reason: TurnCostAvailability::SubscriptionAuthentication,
            },
            "{mode:?}"
        );
    }
    for mode in [
        Some(AuthMode::ApiKey),
        Some(AuthMode::BedrockApiKey),
        Some(AuthMode::BedrockAccessKeys),
        None,
    ] {
        assert_eq!(
            turn_cost(mode),
            TurnCostState::Unavailable {
                reason: TurnCostAvailability::CostObservationDisabled,
            },
            "{mode:?}"
        );
    }
}

#[test]
fn activity_and_cost_go_out_as_v0_3_0_named_them_with_scalars_only() -> anyhow::Result<()> {
    let thread_id = ThreadId::new();
    let activity = turn_activity(
        thread_id,
        "turn-1",
        TurnActivityStatus::Completed,
        Some(1_234),
        Some(56),
    );
    assert_eq!(
        serde_json::to_value(&activity)?,
        json!({
            "method": "turn/activityUpdated",
            "params": {
                "threadId": thread_id.to_string(),
                "turnId": "turn-1",
                "status": "completed",
                "durationMs": 1_234,
                "timeToFirstTokenMs": 56,
            }
        })
    );

    let cost = ServerNotification::TurnCostUpdated(TurnCostUpdatedNotification {
        thread_id: thread_id.to_string(),
        turn_id: "turn-1".to_string(),
        cost: turn_cost(Some(AuthMode::Chatgpt)),
    });
    assert_eq!(
        serde_json::to_value(&cost)?,
        json!({
            "method": "turn/costUpdated",
            "params": {
                "threadId": thread_id.to_string(),
                "turnId": "turn-1",
                "cost": {"type": "unavailable", "reason": "subscriptionAuthentication"},
            }
        })
    );
    Ok(())
}

#[test]
fn unknown_timing_stays_unknown() -> anyhow::Result<()> {
    let activity = turn_activity(
        ThreadId::new(),
        "turn-2",
        TurnActivityStatus::Interrupted,
        /*duration_ms*/ None,
        /*time_to_first_token_ms*/ None,
    );
    let value = serde_json::to_value(&activity)?;
    assert_eq!(value["params"]["status"], "interrupted");
    assert_eq!(value["params"]["durationMs"], serde_json::Value::Null);
    assert_eq!(value["params"]["timeToFirstTokenMs"], serde_json::Value::Null);
    Ok(())
}

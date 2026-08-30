//! Pure CI causality and build-activation policy contracts.
//!
//! This module consumes the lossless workflow inventory without executing a
//! workflow, contacting a service, or changing a repository.  It deliberately
//! keeps eligibility separate from observed execution: a trigger result is a
//! conclusion about configured conditions, while an observed run is accepted
//! only when its supplied full commit exactly equals the README update commit.

use crate::{
    Availability, BuildExtraction, BuildOperation, EvidenceLocator, ExactText, FoundationError,
    FullId, InclusiveSpan, LocatedText, NonBuildCategory, RepoRelativePath, WorkflowEvent,
    WorkflowInventory, WorkflowRecord, WorkflowSchedule,
};
use serde::{Deserialize, Serialize};

/// Stable gap text required whenever configured trigger eligibility has no
/// corresponding supplied execution record.
pub const NO_OBSERVED_RUN_GAP: &str =
    "trigger eligibility does not prove an observed CI run for the README update commit";
/// Compatibility names for callers that use a more specific gap label.
pub const NO_MATCHING_RUN_GAP: &str = NO_OBSERVED_RUN_GAP;
pub const NO_OBSERVED_CI_RUN_GAP: &str = NO_OBSERVED_RUN_GAP;
pub const TRIGGER_ELIGIBILITY_NO_RUN_GAP: &str = NO_OBSERVED_RUN_GAP;

/// The explicit text used in activation predicates when a workflow event has
/// no branch, tag, path, schedule, manual-input, or job-level restriction.
pub const NO_ADDITIONAL_FILTER_TEXT: &str = "no additional filter or value is required";

/// The parser calls a retained workflow file a `WorkflowRecord`; this alias
/// keeps the CI-facing vocabulary used by the design contract available.
pub type WorkflowFile = WorkflowRecord;
/// The design's full-commit spelling is an alias of the foundation's validated
/// object-ID type.
pub type FullCommitId = FullId;

/// Exact inputs supplied for one README update.  `Empty` means the source was
/// inspected and contained no entries; `Unavailable` means it could not supply
/// the field.  Constructors never infer a value for either state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadmeUpdateInput {
    pub update_commit: Availability<FullId>,
    pub parent_commits: Availability<Vec<FullId>>,
    pub changed_paths: Availability<Vec<RepoRelativePath>>,
    pub event: Availability<ExactText>,
    pub r#ref: Availability<ExactText>,
}

impl ReadmeUpdateInput {
    /// Construct an input from already-typed availability values without
    /// normalizing, sorting, or filling any field.
    pub fn new(
        update_commit: Availability<FullId>,
        parent_commits: Availability<Vec<FullId>>,
        changed_paths: Availability<Vec<RepoRelativePath>>,
        event: Availability<ExactText>,
        reference: Availability<ExactText>,
    ) -> Self {
        Self {
            update_commit,
            parent_commits,
            changed_paths,
            event,
            r#ref: reference,
        }
    }

    /// Construct a complete input while preserving the supplied collection
    /// order and every exact text value.  An empty supplied vector remains a
    /// present empty vector rather than being changed into `Empty`.
    pub fn complete(
        update_commit: FullId,
        parent_commits: Vec<FullId>,
        changed_paths: Vec<RepoRelativePath>,
        event: ExactText,
        reference: ExactText,
    ) -> Self {
        Self::new(
            Availability::Present(update_commit),
            Availability::Present(parent_commits),
            Availability::Present(changed_paths),
            Availability::Present(event),
            Availability::Present(reference),
        )
    }

    /// Fallible convenience constructor for callers holding source strings.
    /// The full-ID and repository-relative-path validators are the only
    /// normalization boundary; supplied exact event/ref text is not trimmed.
    pub fn complete_from_strings(
        update_commit: impl Into<String>,
        parent_commits: impl IntoIterator<Item = impl Into<String>>,
        changed_paths: impl IntoIterator<Item = impl Into<String>>,
        event: impl Into<String>,
        reference: impl Into<String>,
    ) -> Result<Self, FoundationError> {
        let update_commit = FullId::new(update_commit)?;
        let parent_commits = parent_commits
            .into_iter()
            .map(|value| FullId::new(value))
            .collect::<Result<Vec<_>, _>>()?;
        let changed_paths = changed_paths
            .into_iter()
            .map(|value| RepoRelativePath::new(value))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self::complete(
            update_commit,
            parent_commits,
            changed_paths,
            ExactText::new(event),
            ExactText::new(reference),
        ))
    }

    /// Construct an explicitly unavailable input.  No event/ref/path/commit
    /// is guessed from another field.
    pub fn unavailable() -> Self {
        Self::new(
            Availability::Unavailable,
            Availability::Unavailable,
            Availability::Unavailable,
            Availability::Unavailable,
            Availability::Unavailable,
        )
    }

    /// Compatibility spelling for an unavailable source record.
    pub fn all_unavailable() -> Self {
        Self::unavailable()
    }

    pub fn reference(&self) -> &Availability<ExactText> {
        &self.r#ref
    }
}

/// One supplied CI execution observation.  A matching commit is the only
/// field used for inclusion; all other fields remain present in the returned
/// record even when they are unavailable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservedCiRun {
    pub run_id: Availability<ExactText>,
    pub workflow_id_or_path: Availability<ExactText>,
    pub event: Availability<ExactText>,
    pub r#ref: Availability<ExactText>,
    pub commit: Availability<FullId>,
    pub outcome: Availability<ExactText>,
}

impl ObservedCiRun {
    pub fn new(
        run_id: Availability<ExactText>,
        workflow_id_or_path: Availability<ExactText>,
        event: Availability<ExactText>,
        reference: Availability<ExactText>,
        commit: Availability<FullId>,
        outcome: Availability<ExactText>,
    ) -> Self {
        Self {
            run_id,
            workflow_id_or_path,
            event,
            r#ref: reference,
            commit,
            outcome,
        }
    }

    pub fn complete(
        run_id: ExactText,
        workflow_id_or_path: ExactText,
        event: ExactText,
        reference: ExactText,
        commit: FullId,
        outcome: ExactText,
    ) -> Self {
        Self::new(
            Availability::Present(run_id),
            Availability::Present(workflow_id_or_path),
            Availability::Present(event),
            Availability::Present(reference),
            Availability::Present(commit),
            Availability::Present(outcome),
        )
    }

    pub fn unavailable() -> Self {
        Self::new(
            Availability::Unavailable,
            Availability::Unavailable,
            Availability::Unavailable,
            Availability::Unavailable,
            Availability::Unavailable,
            Availability::Unavailable,
        )
    }

    pub fn reference(&self) -> &Availability<ExactText> {
        &self.r#ref
    }
}

/// Execution evidence after exact full-commit filtering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionEvidence {
    pub matching_runs: Vec<ObservedCiRun>,
    pub no_matching_run_gap: Availability<ExactText>,
}

impl ExecutionEvidence {
    pub fn has_observed_run(&self) -> bool {
        !self.matching_runs.is_empty()
    }

    pub fn gap(&self) -> &Availability<ExactText> {
        &self.no_matching_run_gap
    }
}

pub type ObservedCiEvidence = ExecutionEvidence;

/// Return only observations whose available full commit is exactly equal to
/// the available full README update commit.  Abbreviations cannot enter this
/// function through `FullId`, and eligibility is intentionally not an input.
pub fn matching_observed_ci_runs(
    input: &ReadmeUpdateInput,
    runs: &[ObservedCiRun],
) -> Vec<ObservedCiRun> {
    let Some(update_commit) = present_ref(&input.update_commit) else {
        return Vec::new();
    };
    let mut matching = runs
        .iter()
        .filter(|run| present_ref(&run.commit) == Some(update_commit))
        .cloned()
        .collect::<Vec<_>>();
    matching.sort_by(observed_run_order);
    matching
}

/// Filter supplied observations and always produce either matching execution
/// records or the named no-observed-run gap.
pub fn observe_ci_execution(
    input: &ReadmeUpdateInput,
    runs: &[ObservedCiRun],
) -> ExecutionEvidence {
    let matching_runs = matching_observed_ci_runs(input, runs);
    let no_matching_run_gap = if matching_runs.is_empty() {
        Availability::Present(ExactText::new(NO_OBSERVED_RUN_GAP))
    } else {
        Availability::Empty
    };
    ExecutionEvidence {
        matching_runs,
        no_matching_run_gap,
    }
}

/// Compatibility spelling emphasizing that matching is not eligibility.
pub fn match_observed_ci_runs(
    input: &ReadmeUpdateInput,
    runs: &[ObservedCiRun],
) -> ExecutionEvidence {
    observe_ci_execution(input, runs)
}

pub fn filter_observed_ci_runs(
    input: &ReadmeUpdateInput,
    runs: &[ObservedCiRun],
) -> ExecutionEvidence {
    observe_ci_execution(input, runs)
}

/// Closed three-valued trigger result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum TriggerResult {
    Eligible,
    Ineligible,
    Undetermined,
}

/// A configured trigger condition kind.  Values are deliberately structural,
/// not free-form labels, so serialized reports cannot silently invent a fourth
/// condition category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ConditionKind {
    Event,
    Branch,
    BranchIgnore,
    Tag,
    TagIgnore,
    Path,
    PathIgnore,
    Schedule,
    Manual,
    WorkflowCall,
    JobIf,
    NoAdditionalFilter,
    Unavailable,
}

/// One condition result with exact configured values and an inclusive workflow
/// source citation.  `configured_values` retains parser `raw` text; `configured`
/// is a convenient exact-text view of those same values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConditionEvaluation {
    pub condition_kind: ConditionKind,
    pub configured_values: Availability<Vec<LocatedText>>,
    pub configured: Availability<Vec<ExactText>>,
    pub workflow_path: RepoRelativePath,
    pub source_span: InclusiveSpan,
    pub evidence: EvidenceLocator,
    pub condition: Availability<ExactText>,
    pub result: TriggerResult,
    pub reason: Availability<ExactText>,
    pub unavailable_condition: Availability<ExactText>,
}

impl ConditionEvaluation {
    pub fn is_cited(&self) -> bool {
        self.evidence.path == self.workflow_path
            && self.evidence.span == self.source_span
            && self.source_span.start > 0
            && self.source_span.end >= self.source_span.start
    }

    pub fn kind(&self) -> ConditionKind {
        self.condition_kind
    }
}

/// Per-workflow-event trigger evaluation.  Multiple documented events are
/// represented by multiple records; callers can OR their results to obtain the
/// workflow-level eligibility.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TriggerEvaluation {
    pub workflow_path: RepoRelativePath,
    pub event: ExactText,
    pub result: TriggerResult,
    pub conditions: Vec<ConditionEvaluation>,
    pub reason: Availability<ExactText>,
    pub unavailable_condition: Availability<ExactText>,
}

impl TriggerEvaluation {
    pub fn is_cited(&self) -> bool {
        !self.conditions.is_empty() && self.conditions.iter().all(ConditionEvaluation::is_cited)
    }

    pub fn condition(&self, kind: ConditionKind) -> Option<&ConditionEvaluation> {
        self.conditions
            .iter()
            .find(|condition| condition.condition_kind == kind)
    }
}

/// Evaluate every configured event and its event-local filters/conditions in
/// workflow-path/event/source-span order.
pub fn evaluate_trigger_conditions(
    inventory: &WorkflowInventory,
    input: &ReadmeUpdateInput,
) -> Vec<TriggerEvaluation> {
    let mut evaluations = Vec::new();
    if let Availability::Present(records) = &inventory.workflows {
        for record in records.iter().filter(|record| record.is_workflow()) {
            evaluations.extend(evaluate_workflow_file(record, input));
        }
    }
    evaluations.sort_by(|left, right| {
        left.workflow_path
            .cmp(&right.workflow_path)
            .then_with(|| left.event.cmp(&right.event))
    });
    evaluations
}

pub fn evaluate_triggers(
    inventory: &WorkflowInventory,
    input: &ReadmeUpdateInput,
) -> Vec<TriggerEvaluation> {
    evaluate_trigger_conditions(inventory, input)
}

pub fn evaluate_workflow_triggers(
    inventory: &WorkflowInventory,
    input: &ReadmeUpdateInput,
) -> Vec<TriggerEvaluation> {
    evaluate_trigger_conditions(inventory, input)
}

pub fn evaluate_ci_triggers(
    inventory: &WorkflowInventory,
    input: &ReadmeUpdateInput,
) -> Vec<TriggerEvaluation> {
    evaluate_trigger_conditions(inventory, input)
}

/// Evaluate all documented events for one parser workflow file.
pub fn evaluate_workflow_file(
    workflow: &WorkflowFile,
    input: &ReadmeUpdateInput,
) -> Vec<TriggerEvaluation> {
    let Some(events) = present_ref(&workflow.triggers.events) else {
        return match &workflow.triggers.events {
            Availability::Unavailable => vec![unavailable_event_evaluation(workflow)],
            Availability::Empty => Vec::new(),
            Availability::Present(_) => Vec::new(),
        };
    };
    let mut evaluations = events
        .iter()
        .map(|event| evaluate_event(workflow, event, input))
        .collect::<Vec<_>>();
    evaluations.sort_by(|left, right| left.event.cmp(&right.event));
    evaluations
}

pub fn evaluate_workflow(
    workflow: &WorkflowRecord,
    input: &ReadmeUpdateInput,
) -> Vec<TriggerEvaluation> {
    evaluate_workflow_file(workflow, input)
}

/// OR-combine alternative event records for a workflow.  An event is eligible
/// if any alternative is eligible; otherwise an unavailable alternative keeps
/// the aggregate undetermined unless every alternative is known ineligible.
pub fn aggregate_trigger_result(evaluations: &[TriggerEvaluation]) -> TriggerResult {
    if evaluations
        .iter()
        .any(|evaluation| evaluation.result == TriggerResult::Eligible)
    {
        TriggerResult::Eligible
    } else if evaluations
        .iter()
        .any(|evaluation| evaluation.result == TriggerResult::Undetermined)
    {
        TriggerResult::Undetermined
    } else {
        TriggerResult::Ineligible
    }
}

/// A policy-facing activation condition, retaining the source path and span
/// even though it does not carry a README-specific result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivationCondition {
    pub condition_kind: ConditionKind,
    pub configured_values: Availability<Vec<LocatedText>>,
    pub workflow_path: RepoRelativePath,
    pub source_span: InclusiveSpan,
    pub evidence: EvidenceLocator,
    pub condition: Availability<ExactText>,
    pub unavailable_condition: Availability<ExactText>,
}

/// One explicit activation predicate per Build Workflow/documented event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildActivationPredicate {
    pub workflow_path: RepoRelativePath,
    pub event: ExactText,
    pub conditions: Vec<ActivationCondition>,
    pub activation_condition: ExactText,
    pub no_additional_filter: Availability<ExactText>,
    pub source_span: InclusiveSpan,
    pub evidence: EvidenceLocator,
}

impl BuildActivationPredicate {
    pub fn has_complete_activation_record(&self) -> bool {
        !self.conditions.is_empty()
            && self.conditions.iter().all(|condition| {
                condition.workflow_path == self.workflow_path
                    && condition.source_span.start > 0
                    && condition.source_span.end >= condition.source_span.start
            })
    }
}

/// README-only expected outcome for one Build Workflow/event pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExpectedBuildResult {
    BuildRunsAutomatically,
    BuildDoesNotRun,
    BuildRunsOnlyAfterManualActivation,
    ResultCannotBeDetermined { unavailable_condition: ExactText },
}

impl ExpectedBuildResult {
    pub fn unavailable_condition(&self) -> Availability<&ExactText> {
        match self {
            Self::ResultCannotBeDetermined {
                unavailable_condition,
            } => Availability::Present(unavailable_condition),
            _ => Availability::Empty,
        }
    }

    pub fn is_determined(&self) -> bool {
        !matches!(self, Self::ResultCannotBeDetermined { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpectedBuildOutcome {
    pub workflow_path: RepoRelativePath,
    pub event: ExactText,
    pub result: ExpectedBuildResult,
    pub activation_condition: ExactText,
    pub source_span: InclusiveSpan,
    pub evidence: EvidenceLocator,
}

pub type BuildExpectedResult = ExpectedBuildOutcome;

/// Action categories that the policy must keep visible even when they are not
/// Build Workflow commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ActionKind {
    Security,
    Audit,
    Diagnostic,
    Manual,
    Scheduled,
    Release,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ActionDependencyClassification {
    Independent,
    BuildDependent,
    Undetermined,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionDependencyRecord {
    pub action: ExactText,
    pub kind: ActionKind,
    pub classification: ActionDependencyClassification,
    pub activation_condition: ExactText,
    pub unavailable_condition: Availability<ExactText>,
    pub workflow_path: RepoRelativePath,
    pub source_span: InclusiveSpan,
    pub evidence: EvidenceLocator,
}

pub type ActionDependency = ActionDependencyRecord;

/// Complete deterministic build-policy output.  `no_actions_documented` is
/// `Present("none documented")` only when the inspected inventory establishes
/// that no relevant action was found; an unavailable workflow inventory stays
/// `Unavailable` rather than being collapsed into an empty result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildPolicyReport {
    pub predicates: Vec<BuildActivationPredicate>,
    pub expected_results: Vec<ExpectedBuildOutcome>,
    pub action_dependencies: Vec<ActionDependencyRecord>,
    pub no_actions_documented: Availability<ExactText>,
    pub gaps: Vec<ExactText>,
}

pub type CiPolicyReport = BuildPolicyReport;
pub type CiBuildPolicy = BuildPolicyReport;
pub type BuildPolicy = BuildPolicyReport;

/// Produce activation predicates, README-only outcomes, and action dependency
/// classifications without executing or scheduling anything.
pub fn build_policy(inventory: &WorkflowInventory, input: &ReadmeUpdateInput) -> BuildPolicyReport {
    let mut predicates = Vec::new();
    let mut expected_results = Vec::new();
    let mut action_dependencies = Vec::new();
    let mut gaps = Vec::new();
    let mut inventory_unavailable = false;

    match &inventory.workflows {
        Availability::Present(records) => {
            for workflow in records.iter().filter(|record| record.is_workflow()) {
                let evaluations = evaluate_workflow_file(workflow, input);
                if workflow.is_build_workflow() {
                    if let Availability::Present(events) = &workflow.triggers.events {
                        if events.is_empty() {
                            predicates.push(synthetic_predicate(workflow));
                        } else {
                            for event in events {
                                let predicate = activation_predicate(workflow, event);
                                let evaluation = evaluations
                                    .iter()
                                    .find(|evaluation| evaluation.event == event.name);
                                let result = expected_result_for_event(workflow, event, evaluation);
                                expected_results.push(ExpectedBuildOutcome {
                                    workflow_path: workflow.path.clone(),
                                    event: event.name.clone(),
                                    result,
                                    activation_condition: predicate.activation_condition.clone(),
                                    source_span: predicate.source_span,
                                    evidence: predicate.evidence.clone(),
                                });
                                predicates.push(predicate);
                            }
                        }
                    } else {
                        predicates.push(synthetic_predicate(workflow));
                        gaps.push(ExactText::new(format!(
                            "{}: documented workflow events unavailable",
                            workflow.path
                        )));
                    }
                }
                collect_action_dependencies(workflow, &evaluations, &mut action_dependencies);
            }
        }
        Availability::Unavailable => {
            inventory_unavailable = true;
            gaps.push(ExactText::new("workflow inventory unavailable"));
        }
        Availability::Empty => {}
    }

    predicates.sort_by(predicate_order);
    expected_results.sort_by(|left, right| {
        left.workflow_path
            .cmp(&right.workflow_path)
            .then_with(|| left.event.cmp(&right.event))
    });
    action_dependencies.sort_by(action_order);
    action_dependencies.dedup_by(|left, right| {
        left.workflow_path == right.workflow_path
            && left.source_span == right.source_span
            && left.kind == right.kind
            && left.action == right.action
    });
    gaps.sort();
    gaps.dedup();

    let no_actions_documented = if inventory_unavailable {
        Availability::Unavailable
    } else if action_dependencies.is_empty() {
        Availability::Present(ExactText::new("none documented"))
    } else {
        Availability::Empty
    };

    BuildPolicyReport {
        predicates,
        expected_results,
        action_dependencies,
        no_actions_documented,
        gaps,
    }
}

pub fn recommend_build_activation(
    inventory: &WorkflowInventory,
    input: &ReadmeUpdateInput,
) -> BuildPolicyReport {
    build_policy(inventory, input)
}

pub fn evaluate_build_policy(
    inventory: &WorkflowInventory,
    input: &ReadmeUpdateInput,
) -> BuildPolicyReport {
    build_policy(inventory, input)
}

fn evaluate_event(
    workflow: &WorkflowRecord,
    event: &WorkflowEvent,
    input: &ReadmeUpdateInput,
) -> TriggerEvaluation {
    let mut conditions = Vec::new();
    let event_located = LocatedText {
        raw: event.raw_name.clone(),
        value: event.name.clone(),
        span: event.span,
    };
    let (event_result, event_reason) = evaluate_event_name(event.name.as_str(), &input.event);
    conditions.push(make_condition(
        ConditionKind::Event,
        Availability::Present(vec![event_located]),
        workflow,
        event.span,
        event_result,
        Availability::Present(event.name.clone()),
        event_reason,
    ));

    let relation = event_relation(event.name.as_str(), &input.event);
    add_filter_condition(
        &mut conditions,
        workflow,
        event,
        ConditionKind::Branch,
        &event.branches,
        relation,
        input,
        FilterKind::Branch,
    );
    add_filter_condition(
        &mut conditions,
        workflow,
        event,
        ConditionKind::BranchIgnore,
        &event.branches_ignore,
        relation,
        input,
        FilterKind::BranchIgnore,
    );
    add_filter_condition(
        &mut conditions,
        workflow,
        event,
        ConditionKind::Tag,
        &event.tags,
        relation,
        input,
        FilterKind::Tag,
    );
    add_filter_condition(
        &mut conditions,
        workflow,
        event,
        ConditionKind::TagIgnore,
        &event.tags_ignore,
        relation,
        input,
        FilterKind::TagIgnore,
    );
    add_filter_condition(
        &mut conditions,
        workflow,
        event,
        ConditionKind::Path,
        &event.paths,
        relation,
        input,
        FilterKind::Path,
    );
    add_filter_condition(
        &mut conditions,
        workflow,
        event,
        ConditionKind::PathIgnore,
        &event.paths_ignore,
        relation,
        input,
        FilterKind::PathIgnore,
    );

    if event.name.as_str() == "schedule" {
        let configured = schedules_as_located(&event.schedules);
        let (result, reason) = match relation {
            EventRelation::Other => (
                TriggerResult::Eligible,
                Availability::Present(ExactText::new(
                    "schedule condition is not applicable to the supplied event",
                )),
            ),
            EventRelation::Unknown => (
                TriggerResult::Undetermined,
                Availability::Present(ExactText::new(
                    "event is unavailable for schedule evaluation",
                )),
            ),
            EventRelation::Match => match &event.schedules {
                Availability::Present(values) if !values.is_empty() => (
                    TriggerResult::Undetermined,
                    Availability::Present(ExactText::new(
                        "scheduled occurrence time is unavailable",
                    )),
                ),
                Availability::Unavailable => (
                    TriggerResult::Undetermined,
                    Availability::Present(ExactText::new("schedule configuration is unavailable")),
                ),
                _ => (
                    TriggerResult::Undetermined,
                    Availability::Present(ExactText::new("schedule value is unavailable")),
                ),
            },
        };
        conditions.push(make_condition(
            ConditionKind::Schedule,
            configured,
            workflow,
            event.span,
            result,
            Availability::Present(ExactText::new("schedule")),
            reason,
        ));
    }

    if matches!(event.name.as_str(), "workflow_dispatch" | "workflow_call") {
        let configured = manual_inputs_as_located(&event.manual_inputs);
        let kind = if event.name.as_str() == "workflow_call" {
            ConditionKind::WorkflowCall
        } else {
            ConditionKind::Manual
        };
        let (result, reason) = match relation {
            EventRelation::Other => (
                TriggerResult::Eligible,
                Availability::Present(ExactText::new(
                    "manual activation condition is not applicable to the supplied event",
                )),
            ),
            EventRelation::Unknown => (
                TriggerResult::Undetermined,
                Availability::Present(ExactText::new("event is unavailable for manual evaluation")),
            ),
            EventRelation::Match => (
                TriggerResult::Undetermined,
                Availability::Present(ExactText::new(
                    "manual activation was not supplied as execution evidence",
                )),
            ),
        };
        conditions.push(make_condition(
            kind,
            configured,
            workflow,
            event.span,
            result,
            Availability::Present(event.name.clone()),
            reason,
        ));
    }

    match &workflow.job_conditions {
        Availability::Present(job_conditions) => {
            for job_condition in job_conditions {
                let (result, reason) =
                    evaluate_job_condition(job_condition.condition.value.as_str(), input);
                let configured = Availability::Present(vec![LocatedText {
                    raw: job_condition.condition.raw.clone(),
                    value: job_condition.condition.value.clone(),
                    span: job_condition.span,
                }]);
                conditions.push(make_condition(
                    ConditionKind::JobIf,
                    configured,
                    workflow,
                    job_condition.span,
                    result,
                    Availability::Present(job_condition.condition.raw.clone()),
                    reason,
                ));
            }
        }
        Availability::Unavailable => {
            conditions.push(make_condition(
                ConditionKind::JobIf,
                Availability::Unavailable,
                workflow,
                workflow.source_span,
                TriggerResult::Undetermined,
                Availability::Unavailable,
                Availability::Present(ExactText::new("job condition is unavailable")),
            ));
        }
        Availability::Empty => {}
    }

    let result = combine_and(conditions.iter().map(|condition| condition.result));
    let (reason, unavailable_condition) = aggregate_reason(&conditions, result);
    TriggerEvaluation {
        workflow_path: workflow.path.clone(),
        event: event.name.clone(),
        result,
        conditions,
        reason,
        unavailable_condition,
    }
}

fn unavailable_event_evaluation(workflow: &WorkflowRecord) -> TriggerEvaluation {
    let condition = make_condition(
        ConditionKind::Event,
        Availability::Unavailable,
        workflow,
        workflow.source_span,
        TriggerResult::Undetermined,
        Availability::Unavailable,
        Availability::Present(ExactText::new(
            "workflow event configuration is unavailable",
        )),
    );
    TriggerEvaluation {
        workflow_path: workflow.path.clone(),
        event: ExactText::new("event unavailable"),
        result: TriggerResult::Undetermined,
        conditions: vec![condition],
        reason: Availability::Present(ExactText::new(
            "workflow event configuration is unavailable",
        )),
        unavailable_condition: Availability::Present(ExactText::new(
            "workflow event configuration is unavailable",
        )),
    }
}

#[derive(Debug, Clone, Copy)]
enum EventRelation {
    Match,
    Other,
    Unknown,
}

fn event_relation(event: &str, supplied: &Availability<ExactText>) -> EventRelation {
    match supplied {
        Availability::Present(value) if value.as_str() == event => EventRelation::Match,
        Availability::Present(_) | Availability::Empty => EventRelation::Other,
        Availability::Unavailable => EventRelation::Unknown,
    }
}

fn evaluate_event_name(
    event: &str,
    supplied: &Availability<ExactText>,
) -> (TriggerResult, Availability<ExactText>) {
    match event_relation(event, supplied) {
        EventRelation::Match => (TriggerResult::Eligible, Availability::Empty),
        EventRelation::Other => (
            TriggerResult::Ineligible,
            Availability::Present(ExactText::new(
                "supplied event does not match configured event",
            )),
        ),
        EventRelation::Unknown => (
            TriggerResult::Undetermined,
            Availability::Present(ExactText::new("supplied event is unavailable")),
        ),
    }
}

#[derive(Debug, Clone, Copy)]
enum FilterKind {
    Branch,
    BranchIgnore,
    Tag,
    TagIgnore,
    Path,
    PathIgnore,
}

fn add_filter_condition(
    conditions: &mut Vec<ConditionEvaluation>,
    workflow: &WorkflowRecord,
    event: &WorkflowEvent,
    kind: ConditionKind,
    values: &Availability<Vec<LocatedText>>,
    relation: EventRelation,
    input: &ReadmeUpdateInput,
    filter_kind: FilterKind,
) {
    if matches!(values, Availability::Empty) {
        return;
    }
    let (result, reason) = match relation {
        EventRelation::Other => (
            TriggerResult::Eligible,
            Availability::Present(ExactText::new(
                "configured filter is not applicable to the supplied event",
            )),
        ),
        EventRelation::Unknown => (
            TriggerResult::Undetermined,
            Availability::Present(ExactText::new(
                "supplied event is unavailable for filter applicability",
            )),
        ),
        EventRelation::Match => match filter_scope_for_ref(event, input, filter_kind) {
            Some((result, reason)) => (result, reason),
            None => evaluate_filter(values, input, filter_kind, event.name.as_str()),
        },
    };
    let span = values_span(values).unwrap_or(event.span);
    conditions.push(make_condition(
        kind,
        values.clone(),
        workflow,
        span,
        result,
        Availability::Present(ExactText::new(filter_name(filter_kind))),
        reason,
    ));
}

fn filter_name(kind: FilterKind) -> &'static str {
    match kind {
        FilterKind::Branch => "branches",
        FilterKind::BranchIgnore => "branches-ignore",
        FilterKind::Tag => "tags",
        FilterKind::TagIgnore => "tags-ignore",
        FilterKind::Path => "paths",
        FilterKind::PathIgnore => "paths-ignore",
    }
}

fn evaluate_filter(
    values: &Availability<Vec<LocatedText>>,
    input: &ReadmeUpdateInput,
    kind: FilterKind,
    event: &str,
) -> (TriggerResult, Availability<ExactText>) {
    let values = match values {
        Availability::Present(values) => values,
        Availability::Empty => return (TriggerResult::Eligible, Availability::Empty),
        Availability::Unavailable => {
            return (
                TriggerResult::Undetermined,
                Availability::Present(ExactText::new("configured filter values are unavailable")),
            )
        }
    };
    match kind {
        FilterKind::Path | FilterKind::PathIgnore => {
            if !path_filter_event(event) {
                return (
                    TriggerResult::Undetermined,
                    Availability::Present(ExactText::new(
                        "path-filter applicability is unavailable for this event",
                    )),
                );
            }
            let changed_paths = match &input.changed_paths {
                Availability::Present(paths) => paths.as_slice(),
                Availability::Empty => &[],
                Availability::Unavailable => {
                    return (
                        TriggerResult::Undetermined,
                        Availability::Present(ExactText::new("changed paths are unavailable")),
                    )
                }
            };
            if matches!(kind, FilterKind::Path) {
                let matched = changed_paths
                    .iter()
                    .any(|path| ordered_patterns_match(values, path.as_str(), false));
                if matched {
                    (TriggerResult::Eligible, Availability::Empty)
                } else {
                    (
                        TriggerResult::Ineligible,
                        Availability::Present(ExactText::new(
                            "no supplied changed path matches the configured paths",
                        )),
                    )
                }
            } else if changed_paths.is_empty() {
                (
                    TriggerResult::Eligible,
                    Availability::Present(ExactText::new(
                        "no supplied changed path is excluded by paths-ignore",
                    )),
                )
            } else {
                let any_not_ignored = changed_paths
                    .iter()
                    .any(|path| !ordered_patterns_match(values, path.as_str(), true));
                if any_not_ignored {
                    (TriggerResult::Eligible, Availability::Empty)
                } else {
                    (
                        TriggerResult::Ineligible,
                        Availability::Present(ExactText::new(
                            "all supplied changed paths match paths-ignore",
                        )),
                    )
                }
            }
        }
        FilterKind::Branch | FilterKind::BranchIgnore | FilterKind::Tag | FilterKind::TagIgnore => {
            let is_branch_filter = matches!(kind, FilterKind::Branch | FilterKind::BranchIgnore);
            let reference = match &input.r#ref {
                Availability::Present(reference) => reference.as_str(),
                Availability::Empty => {
                    return (
                        TriggerResult::Ineligible,
                        Availability::Present(ExactText::new("supplied ref is empty")),
                    )
                }
                Availability::Unavailable => {
                    return (
                        TriggerResult::Undetermined,
                        Availability::Present(ExactText::new("supplied ref is unavailable")),
                    )
                }
            };
            let Some((ref_kind, subject)) = ref_kind_and_subject(reference) else {
                return (
                    TriggerResult::Undetermined,
                    Availability::Present(ExactText::new(
                        "supplied ref is neither refs/heads nor refs/tags",
                    )),
                );
            };
            if ref_kind != is_branch_filter {
                return (
                    TriggerResult::Ineligible,
                    Availability::Present(ExactText::new(
                        "configured branch/tag filter does not match the supplied ref kind",
                    )),
                );
            }
            let matches = ordered_patterns_match(values, subject, false);
            let ignored = matches!(kind, FilterKind::BranchIgnore | FilterKind::TagIgnore);
            if ignored == matches {
                (
                    TriggerResult::Ineligible,
                    Availability::Present(ExactText::new(if ignored {
                        "supplied ref matches an ignore filter"
                    } else {
                        "supplied ref does not match the configured filter"
                    })),
                )
            } else {
                (TriggerResult::Eligible, Availability::Empty)
            }
        }
    }
}

fn filter_scope_for_ref(
    event: &WorkflowEvent,
    input: &ReadmeUpdateInput,
    kind: FilterKind,
) -> Option<(TriggerResult, Availability<ExactText>)> {
    let reference = match &input.r#ref {
        Availability::Present(reference) => reference.as_str(),
        Availability::Empty | Availability::Unavailable => return None,
    };
    let Some((is_branch, _)) = ref_kind_and_subject(reference) else {
        return None;
    };
    match kind {
        FilterKind::Branch | FilterKind::BranchIgnore if !is_branch => {
            if event.tags.is_present() {
                Some((
                    TriggerResult::Eligible,
                    Availability::Present(ExactText::new(
                        "branch filter is not applicable to the supplied tag ref",
                    )),
                ))
            } else {
                None
            }
        }
        FilterKind::Tag | FilterKind::TagIgnore if is_branch => {
            if event.branches.is_present() {
                Some((
                    TriggerResult::Eligible,
                    Availability::Present(ExactText::new(
                        "tag filter is not applicable to the supplied branch ref",
                    )),
                ))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn path_filter_event(event: &str) -> bool {
    matches!(
        event,
        "push"
            | "pull_request"
            | "pull_request_target"
            | "merge_group"
            | "workflow_run"
            | "release"
    )
}

fn ref_kind_and_subject(reference: &str) -> Option<(bool, &str)> {
    if let Some(subject) = reference.strip_prefix("refs/heads/") {
        Some((true, subject))
    } else if let Some(subject) = reference.strip_prefix("refs/tags/") {
        Some((false, subject))
    } else {
        None
    }
}

fn make_condition(
    kind: ConditionKind,
    configured_values: Availability<Vec<LocatedText>>,
    workflow: &WorkflowRecord,
    span: InclusiveSpan,
    result: TriggerResult,
    condition: Availability<ExactText>,
    reason: Availability<ExactText>,
) -> ConditionEvaluation {
    let configured = match &configured_values {
        Availability::Empty => Availability::Empty,
        Availability::Unavailable => Availability::Unavailable,
        Availability::Present(values) => Availability::Present(
            values
                .iter()
                .map(|value| value.raw.clone())
                .collect::<Vec<_>>(),
        ),
    };
    let unavailable_condition = if result == TriggerResult::Undetermined {
        match &reason {
            Availability::Present(value) => Availability::Present(value.clone()),
            Availability::Empty => Availability::Present(ExactText::new("condition unavailable")),
            Availability::Unavailable => {
                Availability::Present(ExactText::new("condition unavailable"))
            }
        }
    } else {
        Availability::Empty
    };
    ConditionEvaluation {
        condition_kind: kind,
        configured_values,
        configured,
        workflow_path: workflow.path.clone(),
        source_span: span,
        evidence: EvidenceLocator::new(workflow.path.clone(), span),
        condition,
        result,
        reason,
        unavailable_condition,
    }
}

fn combine_and(results: impl Iterator<Item = TriggerResult>) -> TriggerResult {
    let mut undetermined = false;
    for result in results {
        match result {
            TriggerResult::Ineligible => return TriggerResult::Ineligible,
            TriggerResult::Undetermined => undetermined = true,
            TriggerResult::Eligible => {}
        }
    }
    if undetermined {
        TriggerResult::Undetermined
    } else {
        TriggerResult::Eligible
    }
}

fn aggregate_reason(
    conditions: &[ConditionEvaluation],
    result: TriggerResult,
) -> (Availability<ExactText>, Availability<ExactText>) {
    if let Some(condition) = conditions.iter().find(|condition| {
        (result == TriggerResult::Ineligible && condition.result == TriggerResult::Ineligible)
            || (result == TriggerResult::Undetermined
                && condition.result == TriggerResult::Undetermined)
    }) {
        return (
            condition.reason.clone(),
            condition.unavailable_condition.clone(),
        );
    }
    (Availability::Empty, Availability::Empty)
}

fn evaluate_job_condition(
    expression: &str,
    input: &ReadmeUpdateInput,
) -> (TriggerResult, Availability<ExactText>) {
    let (result, reason) = evaluate_job_expression(expression, input);
    (result, Availability::Present(ExactText::new(reason)))
}

fn evaluate_job_expression(expression: &str, input: &ReadmeUpdateInput) -> (TriggerResult, String) {
    let expression = strip_expression(expression);
    let expression = trim_outer_parentheses(expression);
    if let Some(parts) = split_boolean(expression, "||") {
        let mut undetermined = false;
        let mut first_unknown = None;
        for part in parts {
            let (result, reason) = evaluate_job_expression(part, input);
            match result {
                TriggerResult::Eligible => return (TriggerResult::Eligible, reason),
                TriggerResult::Undetermined => {
                    undetermined = true;
                    first_unknown.get_or_insert(reason);
                }
                TriggerResult::Ineligible => {}
            }
        }
        return if undetermined {
            (
                TriggerResult::Undetermined,
                first_unknown.unwrap_or_else(|| "job condition is unavailable".to_owned()),
            )
        } else {
            (
                TriggerResult::Ineligible,
                "all job condition alternatives are unsatisfied".to_owned(),
            )
        };
    }
    if let Some(parts) = split_boolean(expression, "&&") {
        let mut undetermined = false;
        let mut first_unknown = None;
        for part in parts {
            let (result, reason) = evaluate_job_expression(part, input);
            match result {
                TriggerResult::Ineligible => return (TriggerResult::Ineligible, reason),
                TriggerResult::Undetermined => {
                    undetermined = true;
                    first_unknown.get_or_insert(reason);
                }
                TriggerResult::Eligible => {}
            }
        }
        return if undetermined {
            (
                TriggerResult::Undetermined,
                first_unknown.unwrap_or_else(|| "job condition is unavailable".to_owned()),
            )
        } else {
            (
                TriggerResult::Eligible,
                "job condition is satisfied".to_owned(),
            )
        };
    }
    let expression = expression.trim();
    if let Some(rest) = expression.strip_prefix('!') {
        let (result, reason) = evaluate_job_expression(rest, input);
        return (
            match result {
                TriggerResult::Eligible => TriggerResult::Ineligible,
                TriggerResult::Ineligible => TriggerResult::Eligible,
                TriggerResult::Undetermined => TriggerResult::Undetermined,
            },
            reason,
        );
    }
    match expression.to_ascii_lowercase().as_str() {
        "true" | "always()" => {
            return (
                TriggerResult::Eligible,
                "job condition is unconditionally true".to_owned(),
            )
        }
        "false" => {
            return (
                TriggerResult::Ineligible,
                "job condition is unconditionally false".to_owned(),
            )
        }
        "success()" | "failure()" | "cancelled()" => {
            return (
                TriggerResult::Undetermined,
                "job status required by condition is unavailable".to_owned(),
            )
        }
        _ => {}
    }
    if let Some((function, arguments)) = expression.split_once('(') {
        if function.trim() == "contains" && arguments.ends_with(')') {
            let arguments = &arguments[..arguments.len() - 1];
            let mut parts = arguments.splitn(2, ',');
            let left = parts.next().unwrap_or("").trim();
            let right = parts.next().unwrap_or("").trim();
            let Some(left) = input_symbol(left, input) else {
                return (
                    TriggerResult::Undetermined,
                    "job condition references an unavailable value".to_owned(),
                );
            };
            let Some(right) = literal_value(right) else {
                return (
                    TriggerResult::Undetermined,
                    "job condition contains an unsupported value".to_owned(),
                );
            };
            return if left == right {
                (
                    TriggerResult::Eligible,
                    "job condition contains the supplied value".to_owned(),
                )
            } else {
                (
                    TriggerResult::Ineligible,
                    "job condition does not contain the supplied value".to_owned(),
                )
            };
        }
    }
    for operator in ["!=", "=="] {
        if let Some((left, right)) = expression.split_once(operator) {
            let Some(left) = input_symbol(left.trim(), input) else {
                return (
                    TriggerResult::Undetermined,
                    "job condition references an unavailable value".to_owned(),
                );
            };
            let Some(right) = literal_value(right.trim()) else {
                return (
                    TriggerResult::Undetermined,
                    "job condition contains an unsupported comparison value".to_owned(),
                );
            };
            let equal = left == right;
            let satisfied = if operator == "==" { equal } else { !equal };
            return if satisfied {
                (
                    TriggerResult::Eligible,
                    "job condition comparison is satisfied".to_owned(),
                )
            } else {
                (
                    TriggerResult::Ineligible,
                    "job condition comparison is unsatisfied".to_owned(),
                )
            };
        }
    }
    (
        TriggerResult::Undetermined,
        "job condition syntax or referenced value is unavailable".to_owned(),
    )
}

fn strip_expression(expression: &str) -> &str {
    let expression = expression.trim();
    expression
        .strip_prefix("${{")
        .and_then(|value| value.strip_suffix("}}"))
        .map(str::trim)
        .unwrap_or(expression)
}

fn trim_outer_parentheses(mut expression: &str) -> &str {
    loop {
        if expression.starts_with('(') && expression.ends_with(')') {
            let mut depth = 0_u32;
            let mut balanced = true;
            for (index, character) in expression.chars().enumerate() {
                match character {
                    '(' => depth += 1,
                    ')' => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 && index + 1 != expression.len() {
                            balanced = false;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            if balanced && depth == 0 {
                expression = expression[1..expression.len() - 1].trim();
                continue;
            }
        }
        return expression;
    }
}

fn split_boolean<'a>(expression: &'a str, operator: &str) -> Option<Vec<&'a str>> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let bytes = expression.as_bytes();
    let operator_bytes = operator.as_bytes();
    let mut index = 0;
    while index + operator_bytes.len() <= bytes.len() {
        match bytes[index] {
            b'\'' | b'"' if quote.is_none() => quote = Some(bytes[index]),
            value if quote == Some(value) => quote = None,
            _ => {}
        }
        if quote.is_none() && &bytes[index..index + operator_bytes.len()] == operator_bytes {
            pieces.push(expression[start..index].trim());
            index += operator_bytes.len();
            start = index;
            continue;
        }
        index += 1;
    }
    if pieces.is_empty() {
        None
    } else {
        pieces.push(expression[start..].trim());
        Some(pieces)
    }
}

fn input_symbol(symbol: &str, input: &ReadmeUpdateInput) -> Option<String> {
    match symbol.trim() {
        "github.ref" | "github.event.ref" => match &input.r#ref {
            Availability::Present(value) => Some(value.as_str().to_owned()),
            Availability::Empty | Availability::Unavailable => None,
        },
        "github.ref_name" => match &input.r#ref {
            Availability::Present(value) => {
                ref_kind_and_subject(value.as_str()).map(|(_, subject)| subject.to_owned())
            }
            Availability::Empty | Availability::Unavailable => None,
        },
        "github.event_name" | "github.event" => match &input.event {
            Availability::Present(value) => Some(value.as_str().to_owned()),
            Availability::Empty | Availability::Unavailable => None,
        },
        _ => None,
    }
}

fn literal_value(value: &str) -> Option<String> {
    let value = value.trim();
    if value.len() >= 2
        && ((value.starts_with('\'') && value.ends_with('\''))
            || (value.starts_with('"') && value.ends_with('"')))
    {
        Some(value[1..value.len() - 1].to_owned())
    } else if !value.is_empty() {
        Some(value.to_owned())
    } else {
        None
    }
}

fn activation_predicate(
    workflow: &WorkflowRecord,
    event: &WorkflowEvent,
) -> BuildActivationPredicate {
    let mut conditions = Vec::new();
    let event_value = LocatedText {
        raw: event.raw_name.clone(),
        value: event.name.clone(),
        span: event.span,
    };
    conditions.push(activation_condition(
        ConditionKind::Event,
        Availability::Present(vec![event_value]),
        workflow,
        event.span,
        Availability::Present(event.raw_name.clone()),
        Availability::Empty,
    ));
    add_activation_filter(
        &mut conditions,
        workflow,
        event,
        ConditionKind::Branch,
        &event.branches,
        "branches",
    );
    add_activation_filter(
        &mut conditions,
        workflow,
        event,
        ConditionKind::BranchIgnore,
        &event.branches_ignore,
        "branches-ignore",
    );
    add_activation_filter(
        &mut conditions,
        workflow,
        event,
        ConditionKind::Tag,
        &event.tags,
        "tags",
    );
    add_activation_filter(
        &mut conditions,
        workflow,
        event,
        ConditionKind::TagIgnore,
        &event.tags_ignore,
        "tags-ignore",
    );
    add_activation_filter(
        &mut conditions,
        workflow,
        event,
        ConditionKind::Path,
        &event.paths,
        "paths",
    );
    add_activation_filter(
        &mut conditions,
        workflow,
        event,
        ConditionKind::PathIgnore,
        &event.paths_ignore,
        "paths-ignore",
    );
    if event.name.as_str() == "schedule" {
        add_activation_filter(
            &mut conditions,
            workflow,
            event,
            ConditionKind::Schedule,
            &schedules_as_located(&event.schedules),
            "schedule",
        );
    }
    if event.name.as_str() == "workflow_dispatch" {
        add_activation_filter(
            &mut conditions,
            workflow,
            event,
            ConditionKind::Manual,
            &manual_inputs_as_located(&event.manual_inputs),
            "workflow_dispatch inputs",
        );
    }
    if event.name.as_str() == "workflow_call" {
        add_activation_filter(
            &mut conditions,
            workflow,
            event,
            ConditionKind::WorkflowCall,
            &manual_inputs_as_located(&event.manual_inputs),
            "workflow_call inputs",
        );
    }
    if let Availability::Present(job_conditions) = &workflow.job_conditions {
        for job_condition in job_conditions {
            let configured = Availability::Present(vec![LocatedText {
                raw: job_condition.condition.raw.clone(),
                value: job_condition.condition.value.clone(),
                span: job_condition.span,
            }]);
            conditions.push(activation_condition(
                ConditionKind::JobIf,
                configured,
                workflow,
                job_condition.span,
                Availability::Present(job_condition.condition.raw.clone()),
                Availability::Empty,
            ));
        }
    } else if matches!(workflow.job_conditions, Availability::Unavailable) {
        conditions.push(activation_condition(
            ConditionKind::JobIf,
            Availability::Unavailable,
            workflow,
            workflow.source_span,
            Availability::Unavailable,
            Availability::Present(ExactText::new("job condition is unavailable")),
        ));
    }
    let source_span = conditions
        .iter()
        .map(|condition| condition.source_span)
        .min()
        .unwrap_or(event.span);
    let no_additional_filter = if conditions.len() == 1 {
        Availability::Present(ExactText::new(NO_ADDITIONAL_FILTER_TEXT))
    } else {
        Availability::Empty
    };
    BuildActivationPredicate {
        workflow_path: workflow.path.clone(),
        event: event.name.clone(),
        activation_condition: render_activation_condition(&conditions),
        conditions,
        no_additional_filter,
        source_span,
        evidence: EvidenceLocator::new(workflow.path.clone(), source_span),
    }
}

fn synthetic_predicate(workflow: &WorkflowRecord) -> BuildActivationPredicate {
    let span = workflow.source_span;
    let condition = activation_condition(
        ConditionKind::Unavailable,
        Availability::Unavailable,
        workflow,
        span,
        Availability::Unavailable,
        Availability::Present(ExactText::new(
            "workflow event configuration is unavailable",
        )),
    );
    BuildActivationPredicate {
        workflow_path: workflow.path.clone(),
        event: ExactText::new("event unavailable"),
        activation_condition: ExactText::new("event configuration unavailable"),
        conditions: vec![condition],
        no_additional_filter: Availability::Unavailable,
        source_span: span,
        evidence: EvidenceLocator::new(workflow.path.clone(), span),
    }
}

fn add_activation_filter(
    conditions: &mut Vec<ActivationCondition>,
    workflow: &WorkflowRecord,
    event: &WorkflowEvent,
    kind: ConditionKind,
    values: &Availability<Vec<LocatedText>>,
    label: &str,
) {
    if matches!(values, Availability::Empty) {
        return;
    }
    let span = values_span(values).unwrap_or(event.span);
    let condition = match values {
        Availability::Present(_) => Availability::Present(ExactText::new(label)),
        Availability::Unavailable => {
            Availability::Present(ExactText::new(format!("{label} configuration unavailable")))
        }
        Availability::Empty => Availability::Empty,
    };
    let unavailable = if matches!(values, Availability::Unavailable) {
        Availability::Present(ExactText::new(format!("{label} configuration unavailable")))
    } else {
        Availability::Empty
    };
    conditions.push(activation_condition(
        kind,
        values.clone(),
        workflow,
        span,
        condition,
        unavailable,
    ));
}

fn activation_condition(
    kind: ConditionKind,
    configured_values: Availability<Vec<LocatedText>>,
    workflow: &WorkflowRecord,
    span: InclusiveSpan,
    condition: Availability<ExactText>,
    unavailable_condition: Availability<ExactText>,
) -> ActivationCondition {
    ActivationCondition {
        condition_kind: kind,
        configured_values,
        workflow_path: workflow.path.clone(),
        source_span: span,
        evidence: EvidenceLocator::new(workflow.path.clone(), span),
        condition,
        unavailable_condition,
    }
}

fn render_activation_condition(conditions: &[ActivationCondition]) -> ExactText {
    if conditions.len() == 1 {
        return ExactText::new(format!(
            "event {} ({NO_ADDITIONAL_FILTER_TEXT})",
            activation_condition_value(&conditions[0])
        ));
    }
    let rendered = conditions
        .iter()
        .map(activation_condition_value)
        .collect::<Vec<_>>()
        .join("; ");
    ExactText::new(rendered)
}

fn activation_condition_value(condition: &ActivationCondition) -> String {
    let values = match &condition.configured_values {
        Availability::Present(values) => values
            .iter()
            .map(|value| value.raw.as_str().to_owned())
            .collect::<Vec<_>>()
            .join(", "),
        Availability::Empty => "none".to_owned(),
        Availability::Unavailable => "unavailable".to_owned(),
    };
    format!("{:?}: {values}", condition.condition_kind)
}

fn expected_result_for_event(
    workflow: &WorkflowRecord,
    event: &WorkflowEvent,
    evaluation: Option<&TriggerEvaluation>,
) -> ExpectedBuildResult {
    if matches!(event.name.as_str(), "workflow_dispatch" | "workflow_call") {
        return ExpectedBuildResult::BuildRunsOnlyAfterManualActivation;
    }
    if event.name.as_str() == "schedule" {
        return match &event.schedules {
            Availability::Present(values) if !values.is_empty() => {
                ExpectedBuildResult::BuildRunsAutomatically
            }
            Availability::Present(_) | Availability::Empty | Availability::Unavailable => {
                ExpectedBuildResult::ResultCannotBeDetermined {
                    unavailable_condition: ExactText::new("schedule configuration unavailable"),
                }
            }
        };
    }
    match evaluation.map(|evaluation| evaluation.result) {
        Some(TriggerResult::Eligible) => ExpectedBuildResult::BuildRunsAutomatically,
        Some(TriggerResult::Ineligible) => ExpectedBuildResult::BuildDoesNotRun,
        Some(TriggerResult::Undetermined) | None => {
            let unavailable_condition = evaluation
                .and_then(|evaluation| present_ref(&evaluation.unavailable_condition))
                .cloned()
                .unwrap_or_else(|| {
                    if workflow.triggers.events.is_unavailable() {
                        ExactText::new("workflow event configuration unavailable")
                    } else {
                        ExactText::new("trigger condition unavailable")
                    }
                });
            ExpectedBuildResult::ResultCannotBeDetermined {
                unavailable_condition,
            }
        }
    }
}

fn collect_action_dependencies(
    workflow: &WorkflowRecord,
    evaluations: &[TriggerEvaluation],
    output: &mut Vec<ActionDependencyRecord>,
) {
    for category in &workflow.categories {
        let Some((kind, label)) = category_action(*category) else {
            continue;
        };
        let (classification, unavailable) = classify_action(workflow, None, evaluations);
        output.push(ActionDependencyRecord {
            action: ExactText::new(label),
            kind,
            classification,
            activation_condition: ExactText::new(format!("workflow category {label}")),
            unavailable_condition: unavailable,
            workflow_path: workflow.path.clone(),
            source_span: workflow.source_span,
            evidence: EvidenceLocator::new(workflow.path.clone(), workflow.source_span),
        });
    }

    if let Availability::Present(events) = &workflow.triggers.events {
        for event in events {
            let event_evaluation = evaluations
                .iter()
                .find(|evaluation| evaluation.event == event.name);
            let action_kind = match event.name.as_str() {
                "workflow_dispatch" | "workflow_call" => Some(ActionKind::Manual),
                "schedule" => Some(ActionKind::Scheduled),
                "release" => Some(ActionKind::Release),
                _ => None,
            };
            if let Some(kind) = action_kind {
                let (classification, unavailable) =
                    classify_action(workflow, event_evaluation, evaluations);
                output.push(ActionDependencyRecord {
                    action: ExactText::new(event.name.as_str()),
                    kind,
                    classification,
                    activation_condition: ExactText::new(format!(
                        "event {} activation",
                        event.name
                    )),
                    unavailable_condition: unavailable,
                    workflow_path: workflow.path.clone(),
                    source_span: event.span,
                    evidence: EvidenceLocator::new(workflow.path.clone(), event.span),
                });
            }
        }
    }

    if let BuildExtraction::Commands(commands) = &workflow.build {
        for command in commands {
            if command.operation == BuildOperation::Publish {
                let (classification, unavailable) = classify_action(workflow, None, evaluations);
                output.push(ActionDependencyRecord {
                    action: command.text.clone(),
                    kind: ActionKind::Release,
                    classification,
                    activation_condition: ExactText::new("publish command activation"),
                    unavailable_condition: unavailable,
                    workflow_path: workflow.path.clone(),
                    source_span: command.span,
                    evidence: EvidenceLocator::new(workflow.path.clone(), command.span),
                });
            }
        }
    }
}

fn category_action(category: NonBuildCategory) -> Option<(ActionKind, &'static str)> {
    match category {
        NonBuildCategory::Security => Some((ActionKind::Security, "security")),
        NonBuildCategory::Audit => Some((ActionKind::Audit, "audit")),
        NonBuildCategory::Diagnostic => Some((ActionKind::Diagnostic, "diagnostic")),
        NonBuildCategory::Other => None,
    }
}

fn classify_action(
    workflow: &WorkflowRecord,
    event_evaluation: Option<&TriggerEvaluation>,
    evaluations: &[TriggerEvaluation],
) -> (ActionDependencyClassification, Availability<ExactText>) {
    if workflow.triggers.events.is_unavailable() || workflow.job_conditions.is_unavailable() {
        return (
            ActionDependencyClassification::Undetermined,
            Availability::Present(ExactText::new("workflow activation condition unavailable")),
        );
    }
    if let Some(evaluation) = event_evaluation {
        if evaluation.result == TriggerResult::Undetermined {
            return (
                ActionDependencyClassification::Undetermined,
                evaluation.unavailable_condition.clone(),
            );
        }
    }
    if evaluations
        .iter()
        .flat_map(|evaluation| evaluation.conditions.iter())
        .any(|condition| condition.result == TriggerResult::Undetermined)
    {
        return (
            ActionDependencyClassification::Undetermined,
            Availability::Present(ExactText::new("activation condition is undetermined")),
        );
    }
    if workflow.is_build_workflow() {
        (
            ActionDependencyClassification::BuildDependent,
            Availability::Empty,
        )
    } else {
        (
            ActionDependencyClassification::Independent,
            Availability::Empty,
        )
    }
}

fn predicate_order(
    left: &BuildActivationPredicate,
    right: &BuildActivationPredicate,
) -> std::cmp::Ordering {
    left.workflow_path
        .cmp(&right.workflow_path)
        .then_with(|| left.event.cmp(&right.event))
}

fn action_order(
    left: &ActionDependencyRecord,
    right: &ActionDependencyRecord,
) -> std::cmp::Ordering {
    left.workflow_path
        .cmp(&right.workflow_path)
        .then_with(|| left.source_span.cmp(&right.source_span))
        .then_with(|| left.kind.cmp(&right.kind))
        .then_with(|| left.action.cmp(&right.action))
}

fn observed_run_order(left: &ObservedCiRun, right: &ObservedCiRun) -> std::cmp::Ordering {
    availability_text(&left.run_id)
        .cmp(&availability_text(&right.run_id))
        .then_with(|| {
            availability_text(&left.workflow_id_or_path)
                .cmp(&availability_text(&right.workflow_id_or_path))
        })
        .then_with(|| availability_text(&left.event).cmp(&availability_text(&right.event)))
        .then_with(|| availability_text(&left.r#ref).cmp(&availability_text(&right.r#ref)))
        .then_with(|| availability_full_id(&left.commit).cmp(&availability_full_id(&right.commit)))
        .then_with(|| availability_text(&left.outcome).cmp(&availability_text(&right.outcome)))
}

fn availability_text(value: &Availability<ExactText>) -> String {
    match value {
        Availability::Empty => "0:".to_owned(),
        Availability::Unavailable => "1:".to_owned(),
        Availability::Present(value) => format!("2:{}", value.as_str()),
    }
}

fn availability_full_id(value: &Availability<FullId>) -> String {
    match value {
        Availability::Empty => "0:".to_owned(),
        Availability::Unavailable => "1:".to_owned(),
        Availability::Present(value) => format!("2:{}", value.as_str()),
    }
}

fn present_ref<T>(value: &Availability<T>) -> Option<&T> {
    match value {
        Availability::Present(value) => Some(value),
        Availability::Empty | Availability::Unavailable => None,
    }
}

fn values_span(values: &Availability<Vec<LocatedText>>) -> Option<InclusiveSpan> {
    let values = present_ref(values)?;
    let start = values.iter().map(|value| value.span.start).min()?;
    let end = values.iter().map(|value| value.span.end).max()?;
    Some(InclusiveSpan { start, end })
}

fn schedules_as_located(
    schedules: &Availability<Vec<WorkflowSchedule>>,
) -> Availability<Vec<LocatedText>> {
    match schedules {
        Availability::Empty => Availability::Empty,
        Availability::Unavailable => Availability::Unavailable,
        Availability::Present(values) => Availability::Present(
            values
                .iter()
                .map(|schedule| schedule.cron.clone())
                .collect(),
        ),
    }
}

fn manual_inputs_as_located(
    inputs: &Availability<Vec<crate::ManualInput>>,
) -> Availability<Vec<LocatedText>> {
    match inputs {
        Availability::Empty => Availability::Empty,
        Availability::Unavailable => Availability::Unavailable,
        Availability::Present(values) => {
            Availability::Present(values.iter().map(|input| input.name.clone()).collect())
        }
    }
}

fn ordered_patterns_match(patterns: &[LocatedText], value: &str, ignore_mode: bool) -> bool {
    let mut matched = false;
    let mut has_positive = false;
    for pattern in patterns {
        let raw = pattern.value.as_str();
        let (negative, pattern) = raw
            .strip_prefix('!')
            .map_or((false, raw), |value| (true, value));
        if !negative {
            has_positive = true;
        }
        if glob_matches(pattern, value) {
            matched = !negative;
        }
    }
    if ignore_mode && !has_positive {
        matched
    } else {
        matched
    }
}

/// Conservative common glob matching: `*` and `?` do not cross `/`, `**` may
/// cross path components, and simple character classes are supported.  A
/// pattern without `/` is also tried against each path component, matching the
/// common workflow-filter convention without changing the stored source text.
pub fn glob_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.strip_prefix("./").unwrap_or(pattern);
    if glob_matches_exact(pattern, value) {
        return true;
    }
    if !pattern.contains('/') {
        return value
            .split('/')
            .any(|component| glob_matches_exact(pattern, component));
    }
    false
}

fn glob_matches_exact(pattern: &str, value: &str) -> bool {
    let pattern = pattern.chars().collect::<Vec<_>>();
    let value = value.chars().collect::<Vec<_>>();
    let mut memo = vec![vec![None; value.len() + 1]; pattern.len() + 1];
    glob_matches_at(&pattern, &value, 0, 0, &mut memo)
}

fn glob_matches_at(
    pattern: &[char],
    value: &[char],
    pattern_index: usize,
    value_index: usize,
    memo: &mut [Vec<Option<bool>>],
) -> bool {
    if let Some(result) = memo[pattern_index][value_index] {
        return result;
    }
    let result = if pattern_index == pattern.len() {
        value_index == value.len()
    } else if pattern[pattern_index] == '*' {
        let double = pattern_index + 1 < pattern.len() && pattern[pattern_index + 1] == '*';
        if double {
            let next = if pattern_index + 2 < pattern.len() && pattern[pattern_index + 2] == '/' {
                pattern_index + 3
            } else {
                pattern_index + 2
            };
            glob_matches_at(pattern, value, next, value_index, memo)
                || (value_index < value.len()
                    && glob_matches_at(pattern, value, pattern_index, value_index + 1, memo))
        } else {
            glob_matches_at(pattern, value, pattern_index + 1, value_index, memo)
                || (value_index < value.len()
                    && value[value_index] != '/'
                    && glob_matches_at(pattern, value, pattern_index, value_index + 1, memo))
        }
    } else if pattern[pattern_index] == '?' {
        value_index < value.len()
            && value[value_index] != '/'
            && glob_matches_at(pattern, value, pattern_index + 1, value_index + 1, memo)
    } else if pattern[pattern_index] == '[' {
        if let Some(close) = pattern[pattern_index + 1..]
            .iter()
            .position(|value| *value == ']')
        {
            let close = pattern_index + 1 + close;
            let matched = character_class_matches(
                &pattern[pattern_index + 1..close],
                value.get(value_index).copied(),
            );
            matched && glob_matches_at(pattern, value, close + 1, value_index + 1, memo)
        } else {
            value_index < value.len()
                && value[value_index] == '['
                && glob_matches_at(pattern, value, pattern_index + 1, value_index + 1, memo)
        }
    } else if pattern[pattern_index] == '\\' && pattern_index + 1 < pattern.len() {
        value_index < value.len()
            && value[value_index] == pattern[pattern_index + 1]
            && glob_matches_at(pattern, value, pattern_index + 2, value_index + 1, memo)
    } else {
        value_index < value.len()
            && value[value_index] == pattern[pattern_index]
            && glob_matches_at(pattern, value, pattern_index + 1, value_index + 1, memo)
    };
    memo[pattern_index][value_index] = Some(result);
    result
}

fn character_class_matches(class: &[char], value: Option<char>) -> bool {
    let Some(value) = value else { return false };
    if class.is_empty() {
        return false;
    }
    let (negated, class) = if matches!(class[0], '!' | '^') {
        (true, &class[1..])
    } else {
        (false, class)
    };
    let mut matched = false;
    let mut index = 0;
    while index < class.len() {
        if index + 2 < class.len() && class[index + 1] == '-' {
            matched |= class[index] <= value && value <= class[index + 2];
            index += 3;
        } else {
            matched |= class[index] == value;
            index += 1;
        }
    }
    if negated {
        !matched
    } else {
        matched
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_supports_workflow_path_forms() {
        assert!(glob_matches("README.md", "README.md"));
        assert!(glob_matches("docs/**", "docs/guide/README.md"));
        assert!(glob_matches("**/README.md", "README.md"));
        assert!(!glob_matches("src/*.rs", "src/nested/lib.rs"));
        assert!(glob_matches("src/**.rs", "src/nested/lib.rs"));
    }

    #[test]
    fn full_commit_matching_is_not_prefix_matching() {
        let commit = FullId::new("0123456789abcdef0123456789abcdef01234567").unwrap();
        let input = ReadmeUpdateInput::complete(
            commit.clone(),
            Vec::new(),
            Vec::new(),
            ExactText::new("push"),
            ExactText::new("refs/heads/main"),
        );
        let incomplete = ObservedCiRun::new(
            Availability::Present(ExactText::new("1")),
            Availability::Present(ExactText::new("ci.yml")),
            Availability::Present(ExactText::new("push")),
            Availability::Present(ExactText::new("refs/heads/main")),
            Availability::Unavailable,
            Availability::Empty,
        );
        let matching = ObservedCiRun::complete(
            ExactText::new("2"),
            ExactText::new("ci.yml"),
            ExactText::new("push"),
            ExactText::new("refs/heads/main"),
            commit,
            ExactText::new("success"),
        );
        let evidence = observe_ci_execution(&input, &[incomplete, matching]);
        assert_eq!(evidence.matching_runs.len(), 1);
        assert!(evidence.no_matching_run_gap.is_empty());
    }
}

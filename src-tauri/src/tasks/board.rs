use serde::{Deserialize, Serialize};

/// The file a project's workflow lives in, beside its cards. Named once here:
/// the card scan ignores it because `fs.rs` accepts only `.md`.
pub const BOARD_FILE: &str = "board.json";

fn board_v1() -> u8 { 1 }
fn is_false(b: &bool) -> bool { !*b }

/// A step id and a kind id are both strings and both travel through the same
/// functions — `cowork_task status <id> <step>`, the drag handler, the modal's
/// two selects. Newtypes so swapping them is a compile error rather than a card
/// written into the wrong field.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct StepId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct KindId(pub String);

impl StepId {
    pub fn as_str(&self) -> &str { &self.0 }
}
impl KindId {
    pub fn as_str(&self) -> &str { &self.0 }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub id: StepId,
    pub label: String,
    /// The target of ✓ and of `cowork_task done`, and "closed" for the sidebar
    /// counts. More than one is legal; the first in order is what ✓ writes.
    #[serde(default, skip_serializing_if = "is_false")]
    pub terminal: bool,
    /// Where ▶ moves a card when it launches a session. At most one.
    #[serde(default, skip_serializing_if = "is_false")]
    pub working: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Kind {
    pub id: KindId,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoardConfig {
    #[serde(rename = "v", default = "board_v1")]
    pub v: u8,
    /// Order is the order of the columns.
    pub steps: Vec<Step>,
    pub kinds: Vec<Kind>,
}

#[derive(Debug)]
pub enum BoardConfigError {
    Json(String),
    NoSteps,
    EmptyStepId,
    WhitespaceInStepId(String),
    DuplicateStepId(String),
    NoTerminalStep,
    TwoWorkingSteps,
    NoKinds,
    EmptyKindId,
    DuplicateKindId(String),
}

impl std::fmt::Display for BoardConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BoardConfigError::Json(e) => write!(f, "board.json is not valid JSON: {e}"),
            BoardConfigError::NoSteps => write!(f, "board.json lists no steps"),
            BoardConfigError::EmptyStepId => write!(f, "a step has an empty id"),
            BoardConfigError::WhitespaceInStepId(s) => {
                write!(f, "step id \"{s}\" contains whitespace")
            }
            BoardConfigError::DuplicateStepId(s) => write!(f, "two steps share the id \"{s}\""),
            BoardConfigError::NoTerminalStep => {
                write!(f, "no step is marked terminal, so no step means \"closed\"")
            }
            BoardConfigError::TwoWorkingSteps => {
                write!(f, "more than one step is marked working")
            }
            BoardConfigError::NoKinds => write!(f, "board.json lists no card kinds"),
            BoardConfigError::EmptyKindId => write!(f, "a kind has an empty id"),
            BoardConfigError::DuplicateKindId(s) => write!(f, "two kinds share the id \"{s}\""),
        }
    }
}

impl BoardConfig {
    /// What a project gets before anyone configures it: today's two steps and
    /// three kinds, so a board that has never been configured looks exactly as
    /// it did before this existed.
    pub fn default_config() -> BoardConfig {
        let step = |id: &str, terminal: bool| Step {
            id: StepId(id.to_string()),
            label: id.to_string(),
            terminal,
            working: false,
        };
        let kind = |id: &str| Kind { id: KindId(id.to_string()), label: id.to_string() };
        BoardConfig {
            v: 1,
            steps: vec![step("open", false), step("done", true)],
            kinds: vec![kind("bug"), kind("task"), kind("idea")],
        }
    }

    pub fn validate(&self) -> Result<(), BoardConfigError> {
        if self.steps.is_empty() {
            return Err(BoardConfigError::NoSteps);
        }
        let mut seen: Vec<&str> = Vec::new();
        for s in &self.steps {
            let id = s.id.as_str();
            if id.is_empty() {
                return Err(BoardConfigError::EmptyStepId);
            }
            if id.chars().any(char::is_whitespace) {
                return Err(BoardConfigError::WhitespaceInStepId(id.to_string()));
            }
            if seen.contains(&id) {
                return Err(BoardConfigError::DuplicateStepId(id.to_string()));
            }
            seen.push(id);
        }
        if !self.steps.iter().any(|s| s.terminal) {
            return Err(BoardConfigError::NoTerminalStep);
        }
        if self.steps.iter().filter(|s| s.working).count() > 1 {
            return Err(BoardConfigError::TwoWorkingSteps);
        }
        if self.kinds.is_empty() {
            return Err(BoardConfigError::NoKinds);
        }
        let mut seen: Vec<&str> = Vec::new();
        for k in &self.kinds {
            let id = k.id.as_str();
            if id.is_empty() {
                return Err(BoardConfigError::EmptyKindId);
            }
            if seen.contains(&id) {
                return Err(BoardConfigError::DuplicateKindId(id.to_string()));
            }
            seen.push(id);
        }
        Ok(())
    }

    /// Where ✓ and `cowork_task done` send a card. Never panics on a validated
    /// config: `validate` refuses one with no terminal step, and every
    /// `BoardConfig` in the program comes through `parse` or `default_config`.
    pub fn first_terminal(&self) -> &StepId {
        &self
            .steps
            .iter()
            .find(|s| s.terminal)
            .expect("validate guarantees a terminal step")
            .id
    }

    pub fn is_terminal(&self, id: &StepId) -> bool {
        self.steps.iter().any(|s| &s.id == id && s.terminal)
    }

    pub fn working_step(&self) -> Option<&StepId> {
        self.steps.iter().find(|s| s.working).map(|s| &s.id)
    }

    pub fn has_step(&self, id: &StepId) -> bool {
        self.steps.iter().any(|s| &s.id == id)
    }

    pub fn has_kind(&self, id: &KindId) -> bool {
        self.kinds.iter().any(|k| &k.id == id)
    }

    /// What `ProviderCapabilities.statuses` reports, in board order.
    pub fn step_ids(&self) -> Vec<String> {
        self.steps.iter().map(|s| s.id.0.clone()).collect()
    }
}

/// Read a configuration from text. Invalid JSON and an invalid configuration are
/// the same kind of answer to the caller: fall back and say why.
pub fn parse(text: &str) -> Result<BoardConfig, BoardConfigError> {
    let cfg: BoardConfig =
        serde_json::from_str(text).map_err(|e| BoardConfigError::Json(e.to_string()))?;
    cfg.validate()?;
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"v":1,
      "steps":[{"id":"todo","label":"To do"},
               {"id":"doing","label":"Doing","working":true},
               {"id":"done","label":"Done","terminal":true}],
      "kinds":[{"id":"bug","label":"Bug"}]}"#;

    #[test]
    fn parses_a_good_config_and_keeps_step_order() {
        let c = parse(GOOD).expect("valid");
        assert_eq!(c.step_ids(), vec!["todo", "doing", "done"]);
        assert_eq!(c.steps[1].label, "Doing");
    }

    #[test]
    fn flags_default_to_false_when_absent() {
        let c = parse(GOOD).unwrap();
        assert!(!c.steps[0].terminal && !c.steps[0].working);
        assert!(c.steps[2].terminal);
    }

    #[test]
    fn reports_the_terminal_and_working_steps() {
        let c = parse(GOOD).unwrap();
        assert_eq!(c.first_terminal().as_str(), "done");
        assert_eq!(c.working_step().map(StepId::as_str), Some("doing"));
        assert!(c.is_terminal(&StepId("done".into())));
        assert!(!c.is_terminal(&StepId("todo".into())));
    }

    #[test]
    fn a_config_without_a_working_step_is_valid_and_reports_none() {
        let text = r#"{"steps":[{"id":"a","label":"A","terminal":true}],
                       "kinds":[{"id":"k","label":"K"}]}"#;
        assert_eq!(parse(text).unwrap().working_step(), None);
    }

    #[test]
    fn knows_which_steps_and_kinds_it_has() {
        let c = parse(GOOD).unwrap();
        assert!(c.has_step(&StepId("todo".into())));
        assert!(!c.has_step(&StepId("next".into())));
        assert!(c.has_kind(&KindId("bug".into())));
        assert!(!c.has_kind(&KindId("chore".into())));
    }

    #[test]
    fn the_version_defaults_to_one_when_absent() {
        let text = r#"{"steps":[{"id":"a","label":"A","terminal":true}],
                       "kinds":[{"id":"k","label":"K"}]}"#;
        assert_eq!(parse(text).unwrap().v, 1);
    }

    #[test]
    fn the_default_config_is_valid_and_is_today_s_two_steps() {
        let c = BoardConfig::default_config();
        c.validate().expect("the default must be valid");
        assert_eq!(c.step_ids(), vec!["open", "done"]);
        assert_eq!(c.first_terminal().as_str(), "done");
        assert_eq!(c.working_step(), None);
        let kinds: Vec<&str> = c.kinds.iter().map(|k| k.id.as_str()).collect();
        assert_eq!(kinds, vec!["bug", "task", "idea"]);
    }

    // One test per rule: a single "invalid config" test would pass while
    // silently accepting the cases it does not exercise.

    #[test]
    fn rejects_an_empty_step_list() {
        let e = parse(r#"{"steps":[],"kinds":[{"id":"k","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::NoSteps), "{e}");
    }

    #[test]
    fn rejects_an_empty_step_id() {
        let e = parse(r#"{"steps":[{"id":"","label":"A","terminal":true}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::EmptyStepId), "{e}");
    }

    #[test]
    fn rejects_whitespace_in_a_step_id() {
        // It would go into YAML frontmatter unquoted and into a CLI argument.
        let e = parse(r#"{"steps":[{"id":"in progress","label":"A","terminal":true}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::WhitespaceInStepId(ref s) if s == "in progress"), "{e}");
    }

    #[test]
    fn rejects_duplicate_step_ids() {
        let e = parse(r#"{"steps":[{"id":"a","label":"A","terminal":true},
                                   {"id":"a","label":"Again"}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::DuplicateStepId(ref s) if s == "a"), "{e}");
    }

    #[test]
    fn rejects_a_config_with_no_terminal_step() {
        let e = parse(r#"{"steps":[{"id":"a","label":"A"}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::NoTerminalStep), "{e}");
    }

    #[test]
    fn accepts_more_than_one_terminal_step() {
        // So a `cancelled` step can join `done` later without a model change,
        // and `first_terminal` is the one ✓ writes.
        let c = parse(r#"{"steps":[{"id":"a","label":"A"},
                                   {"id":"done","label":"Done","terminal":true},
                                   {"id":"cancelled","label":"Cancelled","terminal":true}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap();
        assert_eq!(c.first_terminal().as_str(), "done");
        assert!(c.is_terminal(&StepId("cancelled".into())));
    }

    #[test]
    fn rejects_two_working_steps() {
        let e = parse(r#"{"steps":[{"id":"a","label":"A","working":true},
                                   {"id":"b","label":"B","working":true},
                                   {"id":"d","label":"D","terminal":true}],
                          "kinds":[{"id":"k","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::TwoWorkingSteps), "{e}");
    }

    #[test]
    fn rejects_an_empty_kind_list() {
        let e = parse(r#"{"steps":[{"id":"a","label":"A","terminal":true}],"kinds":[]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::NoKinds), "{e}");
    }

    #[test]
    fn rejects_an_empty_kind_id() {
        let e = parse(r#"{"steps":[{"id":"a","label":"A","terminal":true}],
                          "kinds":[{"id":"","label":"K"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::EmptyKindId), "{e}");
    }

    #[test]
    fn rejects_duplicate_kind_ids() {
        let e = parse(r#"{"steps":[{"id":"a","label":"A","terminal":true}],
                          "kinds":[{"id":"k","label":"K"},{"id":"k","label":"K2"}]}"#).unwrap_err();
        assert!(matches!(e, BoardConfigError::DuplicateKindId(ref s) if s == "k"), "{e}");
    }

    #[test]
    fn malformed_json_is_an_error_not_a_panic() {
        let e = parse("{not json").unwrap_err();
        assert!(matches!(e, BoardConfigError::Json(_)), "{e}");
    }

    #[test]
    fn round_trips_through_serde() {
        let c = parse(GOOD).unwrap();
        let back = parse(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back.step_ids(), c.step_ids());
        assert_eq!(back.steps[1].working, c.steps[1].working);
    }
}

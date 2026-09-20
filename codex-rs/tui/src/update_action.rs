/// Update action the CLI should perform after the TUI exits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateAction {
    /// Replace the installed binary with the latest published Elpis release.
    SelfUpdate,
}

impl UpdateAction {
    /// Returns the list of command-line arguments for invoking the update.
    pub fn command_args(self) -> (&'static str, &'static [&'static str]) {
        match self {
            UpdateAction::SelfUpdate => ("elpis", &["--update"]),
        }
    }

    /// Returns string representation of the command-line arguments for invoking the update.
    pub fn command_str(self) -> String {
        let (command, args) = self.command_args();
        shlex::try_join(std::iter::once(command).chain(args.iter().copied()))
            .unwrap_or_else(|_| format!("{command} {}", args.join(" ")))
    }
}

#[cfg(not(debug_assertions))]
pub fn get_update_action() -> Option<UpdateAction> {
    // Elpis publishes one artifact and updates it one way, so there is no
    // install method to detect. Asking a package manager instead would answer
    // for whatever product it happens to know about, not for this binary.
    Some(UpdateAction::SelfUpdate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn the_update_command_runs_the_elpis_updater() {
        assert_eq!(
            UpdateAction::SelfUpdate.command_args(),
            ("elpis", &["--update"][..])
        );
        assert_eq!(UpdateAction::SelfUpdate.command_str(), "elpis --update");
    }
}

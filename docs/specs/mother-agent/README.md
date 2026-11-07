# Mother agent

Mother ports the MIT dsh-superagent prototype (local reference: `ext/dsh-superagent-prototype` in the workspace) to Elpis, under [Decision 5](../matilda-manager.md#decisions-masih-7-nov). Matilda keeps her separate role.

The acceptance contract is the parity brief supplied on 7 November 2026: every applicable domain behavior, the full assessment and prompt set, GitHub events through the existing `gh` login, and an Elpis panel. Automated evidence and the remaining real-app checks are recorded in `/tmp/mother/parity-report.txt`; the module ledger is `/tmp/mother/parity-progress.md`.

Read in order:

1. [Domain](domain.md)
2. [Authorization](authorization.md)
3. [Execution](execution.md)
4. [Prompts](prompts.md)
5. [Panel](panel.md)
6. [Deployment](deployment.md)
7. [Architecture](architecture.md)
8. [Adding a Source](adding-source.md)

The reference's MIT notice ships at `apps/elpis-desktop/bridge/router/LICENSE-dsh-superagent`. Adapted modules and prompt assets name their source.

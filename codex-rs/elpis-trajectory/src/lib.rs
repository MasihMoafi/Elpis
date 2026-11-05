//! Elpis: the Trajectory page, an observability view of one chat modelled on DeepSeek Harness's
//! Trajectory tab. [`project`] turns a rollout into the page's JSON
//! (`docs/specs/trajectory-contract.ts`); [`serve`] serves the page and that JSON on 127.0.0.1.

mod projection;
mod server;

pub use projection::CacheVerdict;
pub use projection::RequestNumber;
pub use projection::TrajectoryCell;
pub use projection::TrajectoryDocument;
pub use projection::TrajectoryGroup;
pub use projection::TrajectoryTurn;
pub use projection::Usage;
pub use projection::project;
pub use server::TrajectoryServer;
pub use server::serve;

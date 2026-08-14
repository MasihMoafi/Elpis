use thiserror::Error;

pub type Result<T> = std::result::Result<T, ElpisError>;

#[derive(Error, Debug)]
pub enum ElpisError {
    #[error("Context window overflowed maximum capacity: {0}")]
    ContextOverflow(usize),

    #[error("Prompt cache prefix was invalidated at epoch {0}")]
    PrefixInvalidated(usize),

    #[error("Internal I/O failure: {0}")]
    Io(#[from] std::io::Error),
}

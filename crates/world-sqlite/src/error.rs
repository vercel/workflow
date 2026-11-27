use std::{error, fmt, io};

pub type Result<T> = std::result::Result<T, Error>;

/// A failed World operation. It displays and chains to the underlying
/// filesystem or SQLite error, whose type remains an implementation detail.
#[derive(Debug)]
pub struct Error(Kind);

#[derive(Debug)]
enum Kind {
    Io(io::Error),
    Sqlite(rusqlite::Error),
}

impl Error {
    /// SQLite's extended result code, when SQLite itself reported the failure.
    pub fn sqlite_code(&self) -> Option<i32> {
        match &self.0 {
            Kind::Sqlite(error) => error.sqlite_error().map(|error| error.extended_code),
            Kind::Io(_) => None,
        }
    }

    /// SQLite's generic description of [`sqlite_code`](Self::sqlite_code),
    /// as returned by `sqlite3_errstr`.
    pub fn sqlite_description(&self) -> Option<&'static str> {
        self.sqlite_code().map(rusqlite::ffi::code_to_str)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            Kind::Io(error) => error.fmt(f),
            Kind::Sqlite(error) => error.fmt(f),
        }
    }
}

impl error::Error for Error {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        match &self.0 {
            Kind::Io(error) => error.source(),
            Kind::Sqlite(error) => error.source(),
        }
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self(Kind::Io(error))
    }
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self(Kind::Sqlite(error))
    }
}

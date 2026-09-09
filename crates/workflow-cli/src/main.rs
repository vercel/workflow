use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use serde::Serialize;
use workflow_protocol::WorldError;
use workflow_world_sqlite::{
    DatabaseMetadata, RunMetadata, SqliteWorld, sqlite_library_version, sqlite_schema_version,
};

#[derive(Debug, Parser)]
#[command(
    name = "workflow",
    about = "Experimental native Workflow maintenance CLI"
)]
struct Cli {
    #[arg(long, global = true, help = "Emit machine-readable JSON")]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print native component versions.
    Version,
    /// Validate that a SQLite World can be inspected without mutating it.
    Doctor(DatabaseArgs),
    /// Explicit SQLite maintenance commands.
    Sqlite {
        #[command(subcommand)]
        command: SqliteCommand,
    },
}

#[derive(Debug, Subcommand)]
enum SqliteCommand {
    /// Create or advance the selected SQLite schema.
    Migrate(DatabaseArgs),
    /// Read database or run metadata without migration or queue consumption.
    Inspect(InspectArgs),
}

#[derive(Clone, Debug, Args)]
struct DatabaseArgs {
    #[arg(long, conflicts_with = "database_dir", value_name = "FILE")]
    database: Option<PathBuf>,
    #[arg(long, value_name = "DIR")]
    database_dir: Option<PathBuf>,
}

#[derive(Debug, Args)]
struct InspectArgs {
    #[command(flatten)]
    database: DatabaseArgs,
    #[arg(long, value_name = "RUN_ID")]
    run: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionOutput<'a> {
    cli_version: &'a str,
    rust_version_floor: &'a str,
    sqlite_version: &'a str,
    sqlite_schema_version: i64,
    persisted_spec_min: u32,
    persisted_spec_max: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectOutput {
    database: DatabaseOutput,
    #[serde(skip_serializing_if = "Option::is_none")]
    run: Option<RunOutput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseOutput {
    path: String,
    format: String,
    format_version: u32,
    context_codec: String,
    schema_version: u32,
    run_count: u64,
    event_count: u64,
    step_count: u64,
    queue_message_count: u64,
    journal_mode: String,
}

impl From<DatabaseMetadata> for DatabaseOutput {
    fn from(metadata: DatabaseMetadata) -> Self {
        Self {
            path: metadata.path.display().to_string(),
            format: metadata.format,
            format_version: metadata.format_version,
            context_codec: metadata.context_codec,
            schema_version: metadata.schema_version,
            run_count: metadata.run_count,
            event_count: metadata.event_count,
            step_count: metadata.step_count,
            queue_message_count: metadata.queue_message_count,
            journal_mode: metadata.journal_mode,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunOutput {
    run_id: String,
    status: &'static str,
    deployment_id: String,
    workflow_name: String,
    spec_version: u32,
    event_count: u64,
    step_count: u64,
    created_at_ms: i64,
    started_at_ms: Option<i64>,
    completed_at_ms: Option<i64>,
    updated_at_ms: i64,
}

impl From<RunMetadata> for RunOutput {
    fn from(metadata: RunMetadata) -> Self {
        Self {
            run_id: metadata.run_id,
            status: metadata.status.as_str(),
            deployment_id: metadata.deployment_id,
            workflow_name: metadata.workflow_name,
            spec_version: metadata.spec_version,
            event_count: metadata.event_count,
            step_count: metadata.step_count,
            created_at_ms: metadata.created_at_ms,
            started_at_ms: metadata.started_at_ms,
            completed_at_ms: metadata.completed_at_ms,
            updated_at_ms: metadata.updated_at_ms,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorOutput<'a> {
    code: &'a str,
    message: &'a str,
    retryable: bool,
    details: &'a serde_json::Value,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(&cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            if cli.json {
                let output = ErrorOutput {
                    code: error.kind().as_str(),
                    message: error.message(),
                    retryable: error.retryable(),
                    details: error.details(),
                };
                eprintln!(
                    "{}",
                    serde_json::to_string(&output).expect("error output is serializable")
                );
            } else {
                eprintln!("{}: {}", error.kind().as_str(), error.message());
            }
            ExitCode::FAILURE
        }
    }
}

// @lat: [[rust-portability#Native CLI#Command Ownership]]
fn run(cli: &Cli) -> Result<(), WorldError> {
    match &cli.command {
        Command::Version => print_version(cli.json),
        Command::Doctor(args) => {
            let path = resolve_database_path(args)?;
            let metadata = SqliteWorld::new(path).inspect_metadata()?;
            print_inspection(metadata, None, cli.json, "healthy")
        }
        Command::Sqlite {
            command: SqliteCommand::Migrate(args),
        } => {
            let path = resolve_database_path(args)?;
            let world = SqliteWorld::new(&path);
            world.migrate()?;
            let metadata = world.inspect_metadata()?;
            print_inspection(metadata, None, cli.json, "migrated")
        }
        Command::Sqlite {
            command: SqliteCommand::Inspect(args),
        } => {
            let path = resolve_database_path(&args.database)?;
            let world = SqliteWorld::new(path);
            let metadata = world.inspect_metadata()?;
            let run = args
                .run
                .as_deref()
                .map(|run_id| world.inspect_run_metadata(run_id))
                .transpose()?;
            print_inspection(metadata, run, cli.json, "inspected")
        }
    }
}

fn print_version(json_output: bool) -> Result<(), WorldError> {
    let output = VersionOutput {
        cli_version: env!("CARGO_PKG_VERSION"),
        rust_version_floor: "1.88.0",
        sqlite_version: sqlite_library_version(),
        sqlite_schema_version: sqlite_schema_version(),
        persisted_spec_min: workflow_protocol::SUPPORTED_PERSISTED_SPEC_VERSION,
        persisted_spec_max: workflow_protocol::SUPPORTED_PERSISTED_SPEC_VERSION,
    };
    if json_output {
        println!(
            "{}",
            serde_json::to_string(&output).expect("version output is serializable")
        );
    } else {
        println!("workflow native {}", output.cli_version);
        println!(
            "SQLite {} (schema {})",
            output.sqlite_version, output.sqlite_schema_version
        );
        println!("persisted spec {}", output.persisted_spec_max);
    }
    Ok(())
}

fn print_inspection(
    database: DatabaseMetadata,
    run: Option<RunMetadata>,
    json_output: bool,
    verb: &str,
) -> Result<(), WorldError> {
    let output = InspectOutput {
        database: database.into(),
        run: run.map(RunOutput::from),
    };
    if json_output {
        println!(
            "{}",
            serde_json::to_string(&output).expect("inspection output is serializable")
        );
    } else {
        println!("{verb} {}", output.database.path);
        println!(
            "format {} v{}, schema {}, SQLite {}",
            output.database.format,
            output.database.format_version,
            output.database.schema_version,
            sqlite_library_version()
        );
        println!(
            "runs {}, events {}, steps {}, queued {}",
            output.database.run_count,
            output.database.event_count,
            output.database.step_count,
            output.database.queue_message_count
        );
        if let Some(run) = output.run {
            println!(
                "run {}: {} ({} events, {} steps)",
                run.run_id, run.status, run.event_count, run.step_count
            );
        }
    }
    Ok(())
}

fn resolve_database_path(args: &DatabaseArgs) -> Result<PathBuf, WorldError> {
    let selected = if let Some(path) = &args.database {
        path.clone()
    } else {
        let directory = args.database_dir.clone().or_else(|| {
            env::var_os("WORKFLOW_LOCAL_DATABASE_DIR")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        });
        directory
            .unwrap_or_else(|| PathBuf::from(".workflow-database"))
            .join("workflow.sqlite")
    };
    make_absolute(&selected)
}

fn make_absolute(path: &Path) -> Result<PathBuf, WorldError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| {
                WorldError::new(
                    workflow_protocol::WorldErrorKind::Storage,
                    format!("failed to resolve current directory: {error}"),
                )
            })?
    };
    let absolute = normalize_path(&absolute);
    let mut ancestor = absolute.as_path();
    let mut suffix = Vec::<OsString>::new();
    while !ancestor.exists() {
        let component = ancestor.file_name().ok_or_else(|| {
            WorldError::new(
                workflow_protocol::WorldErrorKind::Storage,
                "failed to find an existing database path ancestor",
            )
        })?;
        suffix.push(component.to_os_string());
        ancestor = ancestor.parent().ok_or_else(|| {
            WorldError::new(
                workflow_protocol::WorldErrorKind::Storage,
                "failed to find an existing database path ancestor",
            )
        })?;
    }
    let mut resolved = fs::canonicalize(ancestor).map_err(|error| {
        WorldError::new(
            workflow_protocol::WorldErrorKind::Storage,
            format!("failed to canonicalize database path: {error}"),
        )
    })?;
    for component in suffix.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

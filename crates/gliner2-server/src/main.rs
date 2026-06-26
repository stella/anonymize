#![allow(clippy::print_stdout)]

use axum::{Router, serve};
use clap::Parser;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

mod engine;
mod health;
mod infer;
mod types;

#[derive(Parser, Debug)]
#[command(name = "gliner2-server")]
struct Cli {
  #[arg(short, long, default_value = "0")]
  port: u16,
  #[arg(short = 'H', long, default_value = "127.0.0.1")]
  host: String,
  #[arg(
    short,
    long,
    default_value = "SemplificaAI/gliner2-privacy-filter-PII-multi"
  )]
  model: String,
  #[arg(short, long)]
  variant: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
  tracing_subscriber::fmt()
    .with_env_filter(
      EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
    )
    .init();

  let cli = Cli::parse();
  let max_attempts = 3;

  for attempt in 0..max_attempts {
    let port = if attempt == 0 { cli.port } else { 0 };
    let addr: SocketAddr = format!("{}:{}", cli.host, port).parse()?;

    match TcpListener::bind(addr).await {
      Ok(listener) => {
        let local = listener.local_addr()?;
        let startup = serde_json::json!({"event":"listening","host":format!("{}", local.ip()),"port":local.port()});
        writeln!(std::io::stdout(), "{startup}")?;
        let state = Arc::new(infer::AppState {
          model_id: cli.model.clone(),
          variant: cli.variant.clone(),
        });

        let app = Router::new()
          .route("/v1/health", axum::routing::get(health::health_handler))
          .route("/v1/infer", axum::routing::post(infer::infer_handler))
          .with_state(state);
        serve(listener, app).await?;
        return Ok(());
      }
      Err(e) if attempt + 1 < max_attempts => {
        tracing::warn!(
          "port {port} failed (attempt {}): {e}; retrying with random port",
          attempt + 1
        );
      }
      Err(e) => {
        anyhow::bail!("failed to bind after {max_attempts} attempts: {e}");
      }
    }
  }

  Ok(())
}

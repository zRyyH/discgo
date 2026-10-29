//! JSON-lines logger on stderr (stdout is reserved for protocol events).

use std::io::Write;

struct Logger;

static LOGGER: Logger = Logger;

pub fn init() {
    let level = match std::env::var("DISCGO_ENGINE_LOG").as_deref() {
        Ok("trace") => log::LevelFilter::Trace,
        Ok("debug") => log::LevelFilter::Debug,
        Ok("warn") => log::LevelFilter::Warn,
        Ok("error") => log::LevelFilter::Error,
        _ => log::LevelFilter::Info,
    };
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(level);
}

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let line = serde_json::json!({
            "ts_ms": ts,
            "level": record.level().as_str().to_lowercase(),
            "target": record.target(),
            "msg": record.args().to_string(),
        });
        let mut err = std::io::stderr().lock();
        let _ = writeln!(err, "{line}");
    }

    fn flush(&self) {}
}

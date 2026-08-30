const COMMANDS: &[&str] = &[
    "status",
    "create_session",
    "fetch",
    "cancel",
    "close_session",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}

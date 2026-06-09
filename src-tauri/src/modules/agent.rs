use serde_json::{json, Value};
use std::io::Write;
use toml_edit::{value as toml_value, Array, DocumentMut, Item, Table};

const HOOK_EVENTS: [(&str, &str); 3] = [
    ("UserPromptSubmit", "working"),
    ("Notification", "attention"),
    ("Stop", "finished"),
];

// Includes the pre-v2.1.139 /dev/tty variant so re-running migrates it.
const OWNED_MARKERS: [&str; 2] = ["notify;Terax;", "terax;notify"];
const CODEX_NOTIFICATION_EVENTS: [&str; 3] = [
    "agent-turn-complete",
    "approval-requested",
    "plan-mode-prompt",
];

// Gated on TERAX_TERMINAL; no-op outside Terax. Returns the sequence via
// `terminalSequence` because hooks lost /dev/tty access in v2.1.139.
fn hook_cmd(event: &str) -> String {
    format!(
        r#"[ -n "$TERAX_TERMINAL" ] && printf '{{"terminalSequence":"\\u001b]777;notify;Terax;{event}\\u0007"}}' || true"#
    )
}

fn is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|c| OWNED_MARKERS.iter().any(|m| c.contains(m)))
            })
        })
}

// A group with no hooks is inert cruft (e.g. left behind when someone deletes
// our command but not its wrapper). Drop it so the file stays clean.
fn is_empty_group(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_none_or(|hs| hs.is_empty())
}

fn merge_hooks(mut root: Value) -> Value {
    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();

    for (event, marker) in HOOK_EVENTS {
        let arr = hooks.entry(event).or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let arr = arr.as_array_mut().unwrap();
        arr.retain(|group| !is_ours(group) && !is_empty_group(group));
        arr.push(json!({
            "hooks": [ { "type": "command", "command": hook_cmd(marker) } ]
        }));
    }
    root
}

fn existing_config(contents: Option<&str>, path: &std::path::Path) -> Result<Value, String> {
    match contents {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Value>(s).map_err(|e| {
            format!(
                "{} is not valid JSON ({e}); refusing to overwrite",
                path.display()
            )
        }),
        _ => Ok(json!({})),
    }
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(".claude")
        .join("settings.json"))
}

fn merge_codex_notifications(contents: &str) -> Result<String, String> {
    let mut doc = if contents.trim().is_empty() {
        DocumentMut::new()
    } else {
        contents
            .parse::<DocumentMut>()
            .map_err(|e| format!("config.toml is not valid TOML ({e}); refusing to overwrite"))?
    };
    if !doc.contains_key("tui") {
        doc["tui"] = Item::Table(Table::new());
    }
    let tui = doc["tui"]
        .as_table_mut()
        .ok_or_else(|| "config.toml [tui] is not a table; refusing to overwrite".to_string())?;

    let mut notifications = Array::new();
    if let Some(existing) = tui.get("notifications").and_then(Item::as_array) {
        for event in existing.iter().filter_map(|item| item.as_str()) {
            if !notifications
                .iter()
                .any(|item| item.as_str() == Some(event))
            {
                notifications.push(event);
            }
        }
    }
    for event in CODEX_NOTIFICATION_EVENTS {
        if !notifications
            .iter()
            .any(|item| item.as_str() == Some(event))
        {
            notifications.push(event);
        }
    }

    tui["notifications"] = toml_value(notifications);
    tui["notification_method"] = toml_value("osc9");
    tui["notification_condition"] = toml_value("always");
    Ok(doc.to_string())
}

fn codex_notifications_ready(contents: &str) -> bool {
    let Ok(doc) = contents.parse::<DocumentMut>() else {
        return false;
    };
    let Some(tui) = doc.get("tui").and_then(Item::as_table) else {
        return false;
    };
    let events_ready = match tui.get("notifications") {
        Some(item) if item.as_bool() == Some(true) => true,
        Some(item) => item.as_array().is_some_and(|events| {
            CODEX_NOTIFICATION_EVENTS
                .iter()
                .all(|required| events.iter().any(|event| event.as_str() == Some(*required)))
        }),
        None => false,
    };
    events_ready
        && tui.get("notification_method").and_then(Item::as_str) == Some("osc9")
        && tui.get("notification_condition").and_then(Item::as_str) == Some("always")
}

fn codex_config_path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(".codex")
        .join("config.toml"))
}

fn write_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let permissions = std::fs::metadata(path).ok().map(|meta| meta.permissions());
    let mut tmp = tempfile::NamedTempFile::new_in(dir)
        .map_err(|e| format!("create temporary config in {}: {e}", dir.display()))?;
    tmp.write_all(contents.as_bytes())
        .map_err(|e| format!("write temporary config: {e}"))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("sync temporary config: {e}"))?;
    tmp.persist(path)
        .map_err(|e| format!("replace {}: {}", path.display(), e.error))?;
    if let Some(permissions) = permissions {
        std::fs::set_permissions(path, permissions)
            .map_err(|e| format!("restore permissions on {}: {e}", path.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn agent_enable_claude_hooks() -> Result<(), String> {
    let path = settings_path()?;
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => existing_config(Some(&s), &path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };

    let merged = merge_hooks(existing);
    let out = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;

    // Write to a sibling temp file then rename so a crash mid-write can't leave
    // a truncated settings.json.
    let tmp = path.with_extension("json.terax-tmp");
    std::fs::write(&tmp, out).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename into {}: {e}", path.display())
    })?;
    Ok(())
}

#[tauri::command]
pub fn agent_claude_hooks_status() -> bool {
    let Some(content) = settings_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
    else {
        return false;
    };
    HOOK_EVENTS
        .iter()
        .all(|(_, m)| content.contains(&format!("notify;Terax;{m}")))
}

#[tauri::command]
pub fn agent_enable_codex_notifications() -> Result<(), String> {
    let path = codex_config_path()?;
    let existing = match std::fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let merged = merge_codex_notifications(&existing)?;
    if merged == existing {
        return Ok(());
    }
    write_atomic(&path, &merged)
}

#[tauri::command]
pub fn agent_codex_notifications_status() -> bool {
    codex_config_path()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .is_some_and(|contents| codex_notifications_ready(&contents))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook_count(root: &Value, event: &str) -> usize {
        root["hooks"][event].as_array().map_or(0, Vec::len)
    }

    fn command(root: &Value, event: &str, idx: usize) -> String {
        root["hooks"][event][idx]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn adds_all_event_hooks_to_empty_config() {
        let out = merge_hooks(json!({}));
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 1);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert_eq!(hook_count(&out, "Stop"), 1);
        assert!(command(&out, "Notification", 0).contains("notify;Terax;attention"));
        assert!(command(&out, "Stop", 0).contains("notify;Terax;finished"));
        assert!(command(&out, "UserPromptSubmit", 0).contains("notify;Terax;working"));
        assert!(command(&out, "Stop", 0).contains("terminalSequence"));
        assert!(!command(&out, "Stop", 0).contains("/dev/tty"));
    }

    #[test]
    fn is_idempotent() {
        let once = merge_hooks(json!({}));
        let twice = merge_hooks(once.clone());
        assert_eq!(once, twice);
        assert_eq!(hook_count(&twice, "Notification"), 1);
    }

    #[test]
    fn migrates_legacy_dev_tty_hook() {
        let legacy = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [ {
                        "type": "command",
                        "command": "[ -n \"$TERAX_TERMINAL\" ] && printf '\\033]777;terax;notify\\033\\\\' > /dev/tty || true"
                    } ] }
                ]
            }
        });
        let out = merge_hooks(legacy);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("terminalSequence"));
        assert!(!command(&out, "Notification", 0).contains("/dev/tty"));
    }

    #[test]
    fn preserves_unrelated_settings_and_foreign_hooks() {
        let input = json!({
            "permissions": { "allow": ["Bash"] },
            "hooks": {
                "Notification": [
                    { "hooks": [ { "type": "command", "command": "say hi" } ] }
                ]
            }
        });
        let out = merge_hooks(input);
        assert_eq!(out["permissions"]["allow"][0], "Bash");
        assert_eq!(hook_count(&out, "Notification"), 2);
        assert_eq!(command(&out, "Notification", 0), "say hi");
    }

    #[test]
    fn replaces_non_object_root() {
        let out = merge_hooks(json!("garbage"));
        assert_eq!(hook_count(&out, "Notification"), 1);
    }

    #[test]
    fn prunes_empty_groups_and_collapses_duplicates() {
        let input = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [] },
                    { "hooks": [ { "type": "command", "command": hook_cmd("attention") } ] }
                ]
            }
        });
        let out = merge_hooks(input);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("notify;Terax;attention"));
    }

    #[test]
    fn existing_config_absent_or_empty_starts_fresh() {
        let p = std::path::Path::new("/x/settings.json");
        assert_eq!(existing_config(None, p).unwrap(), json!({}));
        assert_eq!(existing_config(Some("   \n"), p).unwrap(), json!({}));
    }

    #[test]
    fn existing_config_refuses_to_clobber_invalid_json() {
        let p = std::path::Path::new("/x/settings.json");
        assert!(existing_config(Some("{ not json,"), p).is_err());
        assert_eq!(
            existing_config(Some(r#"{"permissions":{}}"#), p).unwrap(),
            json!({ "permissions": {} })
        );
    }

    #[test]
    fn codex_notifications_preserve_existing_config() {
        let input = r#"# keep this comment
model = "gpt-5.5"
notify = ["existing-notifier", "turn-ended"]

[projects."/tmp/repo"]
trust_level = "trusted"

[tui]
animations = false
notification_method = "bel"
"#;
        let out = merge_codex_notifications(input).unwrap();
        assert!(out.contains("# keep this comment"));
        assert!(out.contains(r#"notify = ["existing-notifier", "turn-ended"]"#));
        assert!(out.contains(r#"model = "gpt-5.5""#));
        assert!(out.contains(r#"trust_level = "trusted""#));
        assert!(out.contains("animations = false"));
        assert!(codex_notifications_ready(&out));
    }

    #[test]
    fn codex_notifications_are_idempotent_and_keep_custom_events() {
        let input = r#"[tui]
notifications = ["custom-event", "agent-turn-complete"]
"#;
        let once = merge_codex_notifications(input).unwrap();
        let twice = merge_codex_notifications(&once).unwrap();
        assert_eq!(once, twice);
        assert!(once.contains("custom-event"));
        assert!(codex_notifications_ready(&once));
    }

    #[test]
    fn codex_notifications_preserve_existing_nested_tui_table() {
        let input = r#"[tui.model_availability_nux]
"gpt-5.5" = 4
"#;
        let out = merge_codex_notifications(input).unwrap();
        assert!(out.contains(r#""gpt-5.5" = 4"#));
        assert!(codex_notifications_ready(&out));
    }

    #[test]
    fn codex_notifications_refuse_invalid_toml() {
        assert!(merge_codex_notifications("[tui\nbroken = true").is_err());
        assert!(!codex_notifications_ready("[tui\nbroken = true"));
    }
}

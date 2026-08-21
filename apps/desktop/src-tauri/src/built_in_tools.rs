use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "Read",
                "description": "Read a file's contents from the project. Returns the full text of the file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "Path to the file, relative to the project root"
                        }
                    },
                    "required": ["file_path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "Write",
                "description": "Write content to a file. Creates the file if it doesn't exist, or overwrites existing content.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "Path to the file, relative to the project root"
                        },
                        "content": {
                            "type": "string",
                            "description": "The full content to write to the file"
                        }
                    },
                    "required": ["file_path", "content"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "Edit",
                "description": "Edit a file by replacing an exact string match with new content. The old_string must match exactly (including whitespace and indentation).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "Path to the file, relative to the project root"
                        },
                        "old_string": {
                            "type": "string",
                            "description": "The exact text to find and replace (must be unique in the file)"
                        },
                        "new_string": {
                            "type": "string",
                            "description": "The replacement text"
                        }
                    },
                    "required": ["file_path", "old_string", "new_string"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "ListDir",
                "description": "List files and directories in a project directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Directory path relative to the project root. Use '.' for the project root."
                        }
                    },
                    "required": ["path"]
                }
            }
        }),
    ]
}

fn resolve_path(project_root: &Path, file_path: &str) -> Result<PathBuf, String> {
    let cleaned = file_path.trim().trim_start_matches("./");
    if cleaned.is_empty() {
        return Err("File path is empty".to_string());
    }

    let resolved = project_root.join(cleaned);
    let canonical_root = project_root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve project root: {}", e))?;

    if let Ok(canonical_resolved) = resolved.canonicalize() {
        if !canonical_resolved.starts_with(&canonical_root) {
            return Err("Path escapes the project directory".to_string());
        }
    } else if let Some(parent) = resolved.parent() {
        if let Ok(canonical_parent) = parent.canonicalize() {
            if !canonical_parent.starts_with(&canonical_root) {
                return Err("Path escapes the project directory".to_string());
            }
        }
    }

    Ok(resolved)
}

pub async fn execute(
    project_root: &str,
    tool_name: &str,
    arguments: &Value,
) -> Result<String, String> {
    let root = Path::new(project_root);
    match tool_name {
        "Read" => execute_read(root, arguments).await,
        "Write" => execute_write(root, arguments).await,
        "Edit" => execute_edit(root, arguments).await,
        "ListDir" => execute_list_dir(root, arguments).await,
        other => Err(format!("Unknown tool: {}", other)),
    }
}

async fn execute_read(root: &Path, args: &Value) -> Result<String, String> {
    let file_path = args
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or("Missing file_path parameter")?;
    let resolved = resolve_path(root, file_path)?;
    tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| format!("Failed to read {}: {}", file_path, e))
}

async fn execute_write(root: &Path, args: &Value) -> Result<String, String> {
    let file_path = args
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or("Missing file_path parameter")?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("Missing content parameter")?;
    let resolved = resolve_path(root, file_path)?;

    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directories for {}: {}", file_path, e))?;
    }

    tokio::fs::write(&resolved, content)
        .await
        .map_err(|e| format!("Failed to write {}: {}", file_path, e))?;
    Ok(format!("Successfully wrote {} bytes to {}", content.len(), file_path))
}

async fn execute_edit(root: &Path, args: &Value) -> Result<String, String> {
    let file_path = args
        .get("file_path")
        .and_then(|v| v.as_str())
        .ok_or("Missing file_path parameter")?;
    let old_string = args
        .get("old_string")
        .and_then(|v| v.as_str())
        .ok_or("Missing old_string parameter")?;
    let new_string = args
        .get("new_string")
        .and_then(|v| v.as_str())
        .ok_or("Missing new_string parameter")?;

    let resolved = resolve_path(root, file_path)?;
    let content = tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;

    let count = content.matches(old_string).count();
    if count == 0 {
        return Err(format!(
            "old_string not found in {}. Make sure the text matches exactly (including whitespace).",
            file_path
        ));
    }
    if count > 1 {
        return Err(format!(
            "old_string found {} times in {}. It must be unique — include more surrounding context.",
            count, file_path
        ));
    }

    let new_content = content.replacen(old_string, new_string, 1);
    tokio::fs::write(&resolved, &new_content)
        .await
        .map_err(|e| format!("Failed to write {}: {}", file_path, e))?;
    Ok(format!("Successfully edited {}", file_path))
}

async fn execute_list_dir(root: &Path, args: &Value) -> Result<String, String> {
    let dir_path = args
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or(".");
    let resolved = resolve_path(root, dir_path)?;

    let mut entries = tokio::fs::read_dir(&resolved)
        .await
        .map_err(|e| format!("Failed to list directory {}: {}", dir_path, e))?;

    let mut items = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry
            .file_type()
            .await
            .map(|t| t.is_dir())
            .unwrap_or(false);
        if is_dir {
            items.push(format!("{}/", name));
        } else {
            items.push(name);
        }
    }
    items.sort();
    Ok(items.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_paths_escaping_project_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let args = json!({ "file_path": "../../etc/passwd" });
        let result = execute_read(root, &args).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("escapes") || err.contains("Failed to read"));
    }

    #[tokio::test]
    async fn read_write_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let write_args = json!({ "file_path": "test.tex", "content": "hello world" });
        let result = execute_write(root, &write_args).await;
        assert!(result.is_ok());

        let read_args = json!({ "file_path": "test.tex" });
        let content = execute_read(root, &read_args).await.unwrap();
        assert_eq!(content, "hello world");
    }

    #[tokio::test]
    async fn edit_replaces_unique_match() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("doc.tex"), "Hello World\nGoodbye World").unwrap();
        let args = json!({
            "file_path": "doc.tex",
            "old_string": "Hello World",
            "new_string": "Hi World"
        });
        let result = execute_edit(root, &args).await;
        assert!(result.is_ok());
        let content = std::fs::read_to_string(root.join("doc.tex")).unwrap();
        assert_eq!(content, "Hi World\nGoodbye World");
    }

    #[tokio::test]
    async fn edit_rejects_non_unique_match() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("doc.tex"), "World\nWorld").unwrap();
        let args = json!({
            "file_path": "doc.tex",
            "old_string": "World",
            "new_string": "Earth"
        });
        let result = execute_edit(root, &args).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("2 times"));
    }

    #[test]
    fn tool_definitions_are_valid_json() {
        let tools = tool_definitions();
        assert_eq!(tools.len(), 4);
        for tool in &tools {
            assert_eq!(tool["type"], "function");
            assert!(tool["function"]["name"].is_string());
        }
    }
}

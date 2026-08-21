use crate::built_in_tools;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{Emitter, WebviewWindow};
use tokio::sync::Mutex;

const MAX_TOOL_ROUNDS: usize = 25;

#[derive(Clone, serde::Serialize)]
struct DirectOutputEvent {
    tab_id: String,
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct DirectCompleteEvent {
    tab_id: String,
    success: bool,
}

#[derive(Clone, serde::Serialize)]
struct DirectErrorEvent {
    tab_id: String,
    data: String,
}

struct DirectSession {
    session_id: String,
    messages: Vec<Value>,
    system_prompt: String,
}

#[derive(Default, Clone)]
pub struct DirectEngineState {
    sessions: Arc<Mutex<HashMap<String, DirectSession>>>,
    cancelled: Arc<Mutex<HashMap<String, bool>>>,
}

impl DirectEngineState {
    pub async fn cancel(&self, tab_id: &str) {
        let mut cancelled = self.cancelled.lock().await;
        cancelled.insert(tab_id.to_string(), true);
    }

    async fn is_cancelled(&self, tab_id: &str) -> bool {
        let cancelled = self.cancelled.lock().await;
        cancelled.get(tab_id).copied().unwrap_or(false)
    }

    async fn clear_cancelled(&self, tab_id: &str) {
        let mut cancelled = self.cancelled.lock().await;
        cancelled.remove(tab_id);
    }
}

pub struct DirectEngineRequest {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub project_path: String,
    pub prompt: String,
    pub tab_id: String,
    pub session_id: Option<String>,
}

fn openai_chat_completions_url(base_url: &str) -> String {
    let clean = base_url.trim_end_matches('/');
    if clean.ends_with("/chat/completions") {
        return clean.to_string();
    }

    let lower = clean.to_ascii_lowercase();
    let path = lower
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/').map(|(_, path)| path))
        .unwrap_or("")
        .trim_matches('/');

    let has_chat_root = lower == "https://api.deepseek.com"
        || (!path.is_empty() && {
            let segments = path.split('/').collect::<Vec<_>>();
            let last = segments.last().copied().unwrap_or_default();
            matches!(last, "v1" | "v2" | "v3" | "v4" | "beta")
                || path.ends_with("/openai")
                || path.ends_with("compatible-mode/v1")
        });

    if has_chat_root {
        format!("{}/chat/completions", clean)
    } else {
        format!("{}/v1/chat/completions", clean)
    }
}

fn build_system_prompt(project_path: &str) -> String {
    let mut prompt = format!(
        concat!(
            "You are an AI assistant integrated into DeepPrism, a LaTeX document editor.\n",
            "The user's project is at: {}\n\n",
            "You have access to tools for reading and editing files in the project.\n\n",
            "Guidelines:\n",
            "1. INCREMENTAL EDITS: Use the Edit tool for small, targeted changes. ",
            "Never rewrite an entire file at once.\n",
            "2. PRESERVE EXISTING CONTENT: Always Read the file first. Keep the existing ",
            "preamble, packages, and structure intact.\n",
            "3. LaTeX BEST PRACTICES: Use proper sectioning (\\chapter, \\section, \\subsection), ",
            "citations (\\cite), cross-references (\\label, \\ref).\n",
            "4. When modifying LaTeX, ensure matching \\begin{{}} / \\end{{}} pairs.\n",
            "5. Place images in figures/ and reference with \\includegraphics{{figures/name}}.\n",
        ),
        project_path,
    );

    let claude_md_path = Path::new(project_path).join("CLAUDE.md");
    if let Ok(content) = std::fs::read_to_string(&claude_md_path) {
        if !content.trim().is_empty() {
            prompt.push_str("\n--- Project Instructions (CLAUDE.md) ---\n");
            prompt.push_str(&content);
            prompt.push('\n');
        }
    }

    prompt
}

fn emit_json(window: &WebviewWindow, tab_id: &str, msg: &Value) {
    let _ = window.emit(
        "claude-output",
        DirectOutputEvent {
            tab_id: tab_id.to_string(),
            data: msg.to_string(),
        },
    );
}

fn emit_init(window: &WebviewWindow, tab_id: &str, session_id: &str, model: &str) {
    emit_json(
        window,
        tab_id,
        &json!({
            "type": "system",
            "subtype": "init",
            "session_id": session_id,
            "model": model,
            "tools": ["Read", "Write", "Edit", "ListDir"],
        }),
    );
}

fn emit_streaming_delta(window: &WebviewWindow, tab_id: &str, text: &str) {
    emit_json(
        window,
        tab_id,
        &json!({
            "type": "assistant",
            "subtype": "streaming_delta",
            "message": {
                "content": [{ "type": "text", "text": text }],
            },
        }),
    );
}

fn emit_streaming_thinking(window: &WebviewWindow, tab_id: &str, thinking: &str) {
    emit_json(
        window,
        tab_id,
        &json!({
            "type": "assistant",
            "subtype": "streaming_delta",
            "message": {
                "content": [{ "type": "thinking", "thinking": thinking }],
            },
        }),
    );
}

fn emit_assistant_final(window: &WebviewWindow, tab_id: &str, content: &[Value]) {
    emit_json(
        window,
        tab_id,
        &json!({
            "type": "assistant",
            "subtype": "streaming_final",
            "message": { "content": content },
        }),
    );
}

fn emit_tool_use(
    window: &WebviewWindow,
    tab_id: &str,
    tool_id: &str,
    tool_name: &str,
    input: &Value,
) {
    emit_json(
        window,
        tab_id,
        &json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": tool_id,
                    "name": tool_name,
                    "input": input,
                }],
            },
        }),
    );
}

fn emit_tool_result(
    window: &WebviewWindow,
    tab_id: &str,
    tool_use_id: &str,
    content: &str,
    is_error: bool,
) {
    emit_json(
        window,
        tab_id,
        &json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                    "is_error": is_error,
                }],
            },
        }),
    );
}

fn emit_result(
    window: &WebviewWindow,
    tab_id: &str,
    success: bool,
    error_message: Option<&str>,
) {
    emit_json(
        window,
        tab_id,
        &json!({
            "type": "result",
            "subtype": if success { "success" } else { "error" },
            "is_error": !success,
            "result": error_message.unwrap_or(""),
        }),
    );
}

fn emit_complete(window: &WebviewWindow, tab_id: &str, success: bool) {
    let _ = window.emit(
        "claude-complete",
        DirectCompleteEvent {
            tab_id: tab_id.to_string(),
            success,
        },
    );
}

struct StreamedResponse {
    text: String,
    thinking: String,
    tool_calls: Vec<StreamedToolCall>,
    finish_reason: Option<String>,
}

struct StreamedToolCall {
    id: String,
    name: String,
    arguments: String,
}

async fn stream_chat_completion(
    window: &WebviewWindow,
    tab_id: &str,
    api_key: &str,
    base_url: &str,
    model: &str,
    messages: &[Value],
    tools: &[Value],
    state: &DirectEngineState,
) -> Result<StreamedResponse, String> {
    let url = openai_chat_completions_url(base_url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body.to_string());
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        let compact = if error_text.len() > 500 {
            format!("{}...", &error_text[..500])
        } else {
            error_text
        };
        return Err(format!("API returned HTTP {}: {}", status, compact));
    }

    let mut result = StreamedResponse {
        text: String::new(),
        thinking: String::new(),
        tool_calls: Vec::new(),
        finish_reason: None,
    };
    let mut tool_call_map: HashMap<i64, (String, String, String)> = HashMap::new();
    let mut buffer = String::new();

    let mut stream = response;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| format!("Stream error: {}", e))?
    {
        if state.is_cancelled(tab_id).await {
            return Err("Cancelled by user".to_string());
        }

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some((event_text, rest)) = take_sse_event(&buffer) {
            buffer = rest;
            let data = extract_sse_data(&event_text);
            if data.trim() == "[DONE]" {
                continue;
            }
            let Ok(chunk_json) = serde_json::from_str::<Value>(&data) else {
                continue;
            };
            let Some(choice) = chunk_json
                .get("choices")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
            else {
                continue;
            };
            let delta = choice.get("delta").unwrap_or(&Value::Null);

            if let Some(reasoning) = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                result.thinking.push_str(reasoning);
                emit_streaming_thinking(window, tab_id, reasoning);
            }

            if let Some(thinking) = delta
                .get("thinking")
                .and_then(|v| v.get("content").and_then(|c| c.as_str()).or_else(|| v.as_str()))
                .filter(|s| !s.is_empty())
            {
                result.thinking.push_str(thinking);
                emit_streaming_thinking(window, tab_id, thinking);
            }

            if let Some(content) = delta
                .get("content")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                result.text.push_str(content);
                emit_streaming_delta(window, tab_id, content);
            }

            if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                for call in calls {
                    let idx = call.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
                    let entry = tool_call_map.entry(idx).or_insert_with(|| {
                        (String::new(), String::new(), String::new())
                    });
                    if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                        entry.0 = id.to_string();
                    }
                    if let Some(name) = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|v| v.as_str())
                    {
                        entry.1 = name.to_string();
                    }
                    if let Some(args) = call
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(|v| v.as_str())
                    {
                        entry.2.push_str(args);
                    }
                }
            }

            if let Some(reason) = choice
                .get("finish_reason")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                result.finish_reason = Some(reason.to_string());
            }
        }
    }

    if !buffer.trim().is_empty() {
        let data = extract_sse_data(&buffer);
        if data.trim() != "[DONE]" {
            if let Ok(chunk_json) = serde_json::from_str::<Value>(&data) {
                if let Some(choice) = chunk_json
                    .get("choices")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                {
                    if let Some(content) = choice
                        .get("delta")
                        .and_then(|d| d.get("content"))
                        .and_then(|v| v.as_str())
                    {
                        result.text.push_str(content);
                        emit_streaming_delta(window, tab_id, content);
                    }
                }
            }
        }
    }

    let mut sorted_calls: Vec<_> = tool_call_map.into_iter().collect();
    sorted_calls.sort_by_key(|(idx, _)| *idx);
    for (_, (id, name, arguments)) in sorted_calls {
        let call_id = if id.is_empty() {
            format!("call_{}", uuid::Uuid::new_v4().simple())
        } else {
            id
        };
        result.tool_calls.push(StreamedToolCall {
            id: call_id,
            name,
            arguments,
        });
    }

    Ok(result)
}

fn take_sse_event(buffer: &str) -> Option<(String, String)> {
    if let Some(idx) = buffer.find("\n\n") {
        return Some((buffer[..idx].to_string(), buffer[idx + 2..].to_string()));
    }
    if let Some(idx) = buffer.find("\r\n\r\n") {
        return Some((buffer[..idx].to_string(), buffer[idx + 4..].to_string()));
    }
    None
}

fn extract_sse_data(event: &str) -> String {
    let mut parts = Vec::new();
    for line in event.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(data) = line.strip_prefix("data:") {
            parts.push(data.trim_start());
        }
    }
    parts.join("\n")
}

pub async fn execute(
    window: WebviewWindow,
    state: DirectEngineState,
    request: DirectEngineRequest,
) -> Result<(), String> {
    let tab_id = request.tab_id.clone();
    let window_clone = window.clone();
    let tab_id_clone = tab_id.clone();

    tokio::spawn(async move {
        let result = execute_inner(&window_clone, &state, &request).await;
        let success = result.is_ok();
        if let Err(ref err) = result {
            if err != "Cancelled by user" {
                emit_result(&window_clone, &tab_id_clone, false, Some(err));
                let _ = window_clone.emit(
                    "claude-error",
                    DirectErrorEvent {
                        tab_id: tab_id_clone.clone(),
                        data: err.clone(),
                    },
                );
            }
        } else {
            emit_result(&window_clone, &tab_id_clone, true, None);
        }
        state.clear_cancelled(&tab_id_clone).await;
        emit_complete(&window_clone, &tab_id_clone, success);
    });

    Ok(())
}

async fn execute_inner(
    window: &WebviewWindow,
    state: &DirectEngineState,
    request: &DirectEngineRequest,
) -> Result<(), String> {
    let session_id = request.session_id.clone().unwrap_or_else(|| {
        format!("direct-{}", uuid::Uuid::new_v4().simple())
    });

    let system_prompt = build_system_prompt(&request.project_path);
    let tools = built_in_tools::tool_definitions();

    let mut sessions = state.sessions.lock().await;
    let session = sessions.entry(session_id.clone()).or_insert_with(|| DirectSession {
        session_id: session_id.clone(),
        messages: Vec::new(),
        system_prompt: system_prompt.clone(),
    });

    session.messages.push(json!({
        "role": "user",
        "content": request.prompt,
    }));

    let all_messages = session.messages.clone();
    let session_system = session.system_prompt.clone();
    drop(sessions);

    emit_init(window, &request.tab_id, &session_id, &request.model);

    let mut api_messages = vec![json!({
        "role": "system",
        "content": session_system,
    })];
    api_messages.extend(all_messages.iter().cloned());

    let mut rounds = 0;
    loop {
        if state.is_cancelled(&request.tab_id).await {
            return Err("Cancelled by user".to_string());
        }
        if rounds >= MAX_TOOL_ROUNDS {
            eprintln!(
                "[direct-engine] [{}] max tool rounds ({}) reached",
                request.tab_id, MAX_TOOL_ROUNDS
            );
            break;
        }
        rounds += 1;

        let response = stream_chat_completion(
            window,
            &request.tab_id,
            &request.api_key,
            &request.base_url,
            &request.model,
            &api_messages,
            &tools,
            state,
        )
        .await?;

        if response.tool_calls.is_empty() {
            let mut final_content = Vec::new();
            if !response.thinking.is_empty() {
                final_content.push(json!({
                    "type": "thinking",
                    "thinking": response.thinking,
                    "signature": format!("ccr_{}", uuid::Uuid::new_v4().simple()),
                }));
            }
            if !response.text.is_empty() {
                final_content.push(json!({ "type": "text", "text": response.text }));
            }
            if !final_content.is_empty() {
                emit_assistant_final(window, &request.tab_id, &final_content);
            }

            let mut sessions = state.sessions.lock().await;
            if let Some(session) = sessions.get_mut(&session_id) {
                session.messages.push(json!({
                    "role": "assistant",
                    "content": if response.text.is_empty() { "(no text)" } else { &response.text },
                }));
            }
            break;
        }

        let mut assistant_content = Vec::new();
        if !response.text.is_empty() {
            assistant_content.push(json!({ "type": "text", "text": response.text }));
        }

        let mut openai_tool_calls = Vec::new();
        for call in &response.tool_calls {
            let parsed_args: Value =
                serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));

            emit_tool_use(
                window,
                &request.tab_id,
                &call.id,
                &call.name,
                &parsed_args,
            );

            openai_tool_calls.push(json!({
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": call.arguments,
                },
            }));
        }

        let assistant_msg = if assistant_content.is_empty() {
            json!({
                "role": "assistant",
                "tool_calls": openai_tool_calls,
            })
        } else {
            json!({
                "role": "assistant",
                "content": response.text,
                "tool_calls": openai_tool_calls,
            })
        };
        api_messages.push(assistant_msg.clone());

        for call in &response.tool_calls {
            if state.is_cancelled(&request.tab_id).await {
                return Err("Cancelled by user".to_string());
            }

            let parsed_args: Value =
                serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));

            let tool_result =
                built_in_tools::execute(&request.project_path, &call.name, &parsed_args).await;

            let (content, is_error) = match tool_result {
                Ok(output) => (output, false),
                Err(err) => (err, true),
            };

            emit_tool_result(window, &request.tab_id, &call.id, &content, is_error);

            api_messages.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": content,
            }));
        }

        let mut sessions = state.sessions.lock().await;
        if let Some(session) = sessions.get_mut(&session_id) {
            session.messages.push(assistant_msg);
            for call in &response.tool_calls {
                let parsed_args: Value =
                    serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));
                let tool_result =
                    built_in_tools::execute(&request.project_path, &call.name, &parsed_args).await;
                let (content, _) = match tool_result {
                    Ok(output) => (output, false),
                    Err(err) => (err, true),
                };
                session.messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": content,
                }));
            }
        }
        drop(sessions);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_chat_completions_url_for_deepseek() {
        assert_eq!(
            openai_chat_completions_url("https://api.deepseek.com"),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn builds_chat_completions_url_for_ollama() {
        assert_eq!(
            openai_chat_completions_url("http://localhost:11434/v1"),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn builds_chat_completions_url_for_plain_host() {
        assert_eq!(
            openai_chat_completions_url("https://example.com"),
            "https://example.com/v1/chat/completions"
        );
    }

    #[test]
    fn preserves_full_url() {
        assert_eq!(
            openai_chat_completions_url("https://example.com/v1/chat/completions"),
            "https://example.com/v1/chat/completions"
        );
    }

    #[test]
    fn sse_event_parsing() {
        let input = "data: {\"id\":\"1\"}\n\ndata: [DONE]\n\n";
        let (first, rest) = take_sse_event(input).unwrap();
        assert_eq!(extract_sse_data(&first), "{\"id\":\"1\"}");
        let (second, _) = take_sse_event(&rest).unwrap();
        assert_eq!(extract_sse_data(&second), "[DONE]");
    }

    #[test]
    fn system_prompt_includes_project_path() {
        let prompt = build_system_prompt("/tmp/test-project");
        assert!(prompt.contains("/tmp/test-project"));
        assert!(prompt.contains("DeepPrism"));
    }
}

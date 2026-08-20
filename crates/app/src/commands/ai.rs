//! AI chat proxy — calls Anthropic Claude / OpenAI APIs from the backend.
//! Streams responses back to the frontend via Tauri events.

use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const KEY_ID: &str = "mshell/nil/ai_key";
const ENDPOINT_ID: &str = "mshell/nil/ai_endpoint";

/// Total wall-clock budget for a single AI chat round-trip (connect + stream).
/// Kept aligned with the frontend's per-request timeout (120s) so a dead
/// endpoint doesn't keep burning the connection/stream after the UI has given
/// up on it.
const AI_TOTAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// Upper bound on accumulated AI response text (tokens). Guard against a
/// runaway or malicious endpoint streaming forever.
const AI_MAX_OUTPUT: usize = 16 * 1024 * 1024;

/// A chat message in the conversation.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Save AI API key to system keyring.
#[tauri::command]
pub async fn ai_save_key(key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        // Clear the key
        ssh_core::delete_secret(KEY_ID).map_err(|e| e.to_string())?;
        return Ok(());
    }
    ssh_core::set_secret(KEY_ID, &key).map_err(|e| e.to_string())
}

/// Read AI API key from system keyring.
#[tauri::command]
pub async fn ai_get_key() -> Result<String, String> {
    let result = ssh_core::get_secret(KEY_ID).map_err(|e| e.to_string())?;
    result.map(|s| s.to_string()).ok_or_else(|| "未设置 API Key".to_string())
}

/// Check if an API key is configured.
#[tauri::command]
pub async fn ai_has_key() -> Result<bool, String> {
    Ok(ssh_core::get_secret(KEY_ID).ok().flatten().is_some())
}

/// Save custom API endpoint URL.
#[tauri::command]
pub async fn ai_save_endpoint(endpoint: String) -> Result<(), String> {
    ssh_core::set_secret(ENDPOINT_ID, &endpoint).map_err(|e| e.to_string())
}

/// Read custom API endpoint URL.
#[tauri::command]
pub async fn ai_get_endpoint() -> Result<String, String> {
    let result = ssh_core::get_secret(ENDPOINT_ID).map_err(|e| e.to_string())?;
    Ok(result.map(|s| s.to_string()).unwrap_or_default())
}

/// Streaming chat with the AI.
/// If `endpoint` is set, uses it as the base URL (OpenAI-compatible).
/// Otherwise defaults to Anthropic for Claude models or OpenAI.
/// `request_id` correlates chunk/done events so concurrent requests don't interleave.
#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    messages: Vec<ChatMessage>,
    api_key: String,
    model: String,
    endpoint: String,
    request_id: String,
) -> Result<(), String> {
    // Bound the whole round trip (connect + stream) so a dead endpoint cannot
    // hang the frontend's "分析中…" state forever.
    let client = reqwest::Client::builder()
        .timeout(AI_TOTAL_TIMEOUT)
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))?;
    let is_claude = model.starts_with("claude");

    if !endpoint.trim().is_empty() {
        // Custom endpoint: OpenAI-compatible API
        chat_custom(&app, &client, &messages, &api_key, &model, &endpoint, &request_id).await
    } else if is_claude {
        chat_claude(&app, &client, &messages, &api_key, &model, &request_id).await
    } else {
        chat_openai(&app, &client, &messages, &api_key, &model, &request_id).await
    }
}

/// Fetch available models from the API endpoint.
/// For Anthropic: returns hardcoded Claude models.
/// For custom endpoints: calls GET /v1/models (OpenAI-compatible).
#[tauri::command]
pub async fn ai_list_models(api_key: String, endpoint: String) -> Result<Vec<String>, String> {
    let is_claude = api_key.starts_with("sk-ant");
    if !endpoint.trim().is_empty() {
        // Custom endpoint: try OpenAI-compatible models list
        let base = endpoint.trim_end_matches('/');
        let url = format!("{base}/models");
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| e.to_string())?;
        let mut req = client.get(&url);
        if !api_key.is_empty() {
            req = req.header("Authorization", format!("Bearer {api_key}"));
        }
        let resp = req.send().await.map_err(|e| format!("获取模型列表失败：{e}"))?;
        if !resp.status().is_success() {
            return Err(format!("API 返回 {}", resp.status()));
        }
        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let models: Vec<String> = body["data"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
                    .filter(|id| !id.contains("embedding") && !id.contains("tts"))
                    .collect()
            })
            .unwrap_or_default();
        if models.is_empty() {
            return Err("未找到可用模型".to_string());
        }
        Ok(models)
    } else if is_claude {
        Ok(vec![
            "claude-sonnet-5-20250709".into(),
            "claude-opus-5-20250709".into(),
            "claude-haiku-4-20250510".into(),
        ])
    } else {
        Ok(vec![
            "gpt-4o".into(),
            "gpt-4o-mini".into(),
            "gpt-4.1".into(),
            "gpt-4.1-mini".into(),
            "o4-mini".into(),
        ])
    }
}

/// Test connection to the API endpoint.
/// Sends a lightweight request to verify the endpoint and key are valid.
#[tauri::command]
pub async fn ai_test_connection(api_key: String, endpoint: String) -> Result<String, String> {
    let is_claude = api_key.starts_with("sk-ant");
    if !endpoint.trim().is_empty() {
        let base = endpoint.trim_end_matches('/');
        let url = format!("{base}/models");
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;
        let mut req = client.get(&url);
        if !api_key.is_empty() {
            req = req.header("Authorization", format!("Bearer {api_key}"));
        }
        let start = std::time::Instant::now();
        let resp = req.send().await.map_err(|e| format!("连接失败：{e}"))?;
        let ms = start.elapsed().as_millis();
        if resp.status().is_success() {
            Ok(format!("✅ 连接成功（{ms}ms）"))
        } else {
            Err(format!("❌ 服务器返回 {}", resp.status()))
        }
    } else if is_claude {
        // Test Anthropic connection with a minimal request
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;
        let start = std::time::Instant::now();
        let resp = client
            .get("https://api.anthropic.com/v1/models")
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .send()
            .await
            .map_err(|e| format!("连接失败：{e}"))?;
        let ms = start.elapsed().as_millis();
        if resp.status().is_success() {
            Ok(format!("✅ Claude API 连接成功（{ms}ms）"))
        } else {
            Err(format!("❌ {}", resp.status()))
        }
    } else {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;
        let start = std::time::Instant::now();
        let resp = client
            .get("https://api.openai.com/v1/models")
            .header("Authorization", format!("Bearer {api_key}"))
            .send()
            .await
            .map_err(|e| format!("连接失败：{e}"))?;
        let ms = start.elapsed().as_millis();
        if resp.status().is_success() {
            Ok(format!("✅ OpenAI API 连接成功（{ms}ms）"))
        } else {
            Err(format!("❌ {}", resp.status()))
        }
    }
}
async fn chat_custom(
    app: &AppHandle,
    client: &reqwest::Client,
    messages: &[ChatMessage],
    api_key: &str,
    model: &str,
    endpoint: &str,
    request_id: &str,
) -> Result<(), String> {
    let base = endpoint.trim_end_matches('/');
    let url = format!("{base}/chat/completions");

    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
        .collect();

    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": msgs,
    });

    let mut req = client.post(&url).json(&body);
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }

    let resp = req.send().await.map_err(|e| format!("请求失败：{e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("API 错误 ({status})：{text}"));
    }

    let full_text = stream_sse(resp, |delta| {
        let _ = app.emit("ai-chunk", serde_json::json!({ "requestId": request_id, "text": delta }));
    })
    .await?;

    let _ = app.emit("ai-done", serde_json::json!({ "requestId": request_id, "text": full_text }));
    Ok(())
}

async fn chat_claude(
    app: &AppHandle,
    client: &reqwest::Client,
    messages: &[ChatMessage],
    api_key: &str,
    model: &str,
    request_id: &str,
) -> Result<(), String> {
    let mut system_msg = String::new();
    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .filter_map(|m| {
            if m.role == "system" {
                system_msg = m.content.clone();
                None
            } else {
                Some(serde_json::json!({"role": m.role, "content": m.content}))
            }
        })
        .collect();

    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 4096,
        "stream": true,
        "messages": msgs,
    });
    if !system_msg.is_empty() {
        body["system"] = serde_json::json!(system_msg);
    }

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("API 错误 ({status})：{text}"));
    }

    let full_text = stream_sse(resp, |delta| {
        let _ = app.emit("ai-chunk", serde_json::json!({ "requestId": request_id, "text": delta }));
    })
    .await?;

    let _ = app.emit("ai-done", serde_json::json!({ "requestId": request_id, "text": full_text }));
    Ok(())
}

async fn chat_openai(
    app: &AppHandle,
    client: &reqwest::Client,
    messages: &[ChatMessage],
    api_key: &str,
    model: &str,
    request_id: &str,
) -> Result<(), String> {
    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
        .collect();

    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": msgs,
    });

    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("API 错误 ({status})：{text}"));
    }

    let full_text = stream_sse(resp, |delta| {
        let _ = app.emit("ai-chunk", serde_json::json!({ "requestId": request_id, "text": delta }));
    })
    .await?;

    let _ = app.emit("ai-done", serde_json::json!({ "requestId": request_id, "text": full_text }));
    Ok(())
}

/// Incrementally parse an SSE stream as it arrives, emitting each text delta via
/// `on_delta` and returning the accumulated full text.
///
/// True streaming: unlike buffering the whole body with `bytes().await`, chunks
/// are handled as they arrive so the frontend sees output in near-real-time.
async fn stream_sse(
    resp: reqwest::Response,
    mut on_delta: impl FnMut(&str),
) -> Result<String, String> {
    let mut full = String::new();
    let mut bytes = resp.bytes_stream();
    let mut pending: Vec<u8> = Vec::new();
    let mut done = false;

    while let Some(chunk) = bytes.next().await {
        let chunk = chunk.map_err(|e| format!("读取响应流失败：{e}"))?;
        pending.extend_from_slice(&chunk);

        // Split on newlines and handle complete lines; keep the tail for the
        // next chunk in case a JSON object spans TCP segments.
        let mut start = 0;
        while let Some(rel) = pending[start..].iter().position(|&b| b == b'\n') {
            let end = start + rel;
            let line = &pending[start..end];
            start = end + 1;
            // SSE lines are "data: <json>"; some servers use "\r\n".
            let line = if line.ends_with(b"\r") { &line[..line.len() - 1] } else { line };
            if let Some(data) = line.strip_prefix(b"data: ") {
                let data = std::str::from_utf8(data).unwrap_or_default();
                if data == "[DONE]" {
                    done = true;
                    break;
                }
                if let Ok(chunk) = serde_json::from_str::<serde_json::Value>(data) {
                    // Claude format: delta.text
                    if let Some(text) = chunk["delta"]["text"].as_str() {
                        full.push_str(text);
                        on_delta(text);
                    }
                    // OpenAI format: choices[0].delta.content
                    if let Some(text) = chunk["choices"][0]["delta"]["content"].as_str() {
                        full.push_str(text);
                        on_delta(text);
                    }
                }
            }
        }
        if done {
            break;
        }
        pending.drain(..start);

        if full.len() > AI_MAX_OUTPUT {
            return Err(format!("AI 响应超过 {AI_MAX_OUTPUT} 字节上限"));
        }
    }

    // Stream ended: parse any remaining tail that never saw a trailing newline
    // (some servers omit the final "\n"), so the last delta isn't lost.
    if !done && !pending.is_empty() {
        let line = pending.as_slice();
        let line = if line.ends_with(b"\r") { &line[..line.len() - 1] } else { line };
        if let Some(data) = line.strip_prefix(b"data: ") {
            let data = std::str::from_utf8(data).unwrap_or_default();
            // "[DONE]" on the tail line means a clean end; nothing left to emit.
            if data != "[DONE]" {
                if let Ok(chunk) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(text) = chunk["delta"]["text"].as_str() {
                        full.push_str(text);
                        on_delta(text);
                    }
                    if let Some(text) = chunk["choices"][0]["delta"]["content"].as_str() {
                        full.push_str(text);
                        on_delta(text);
                    }
                }
            }
        }
    }

    Ok(full)
}

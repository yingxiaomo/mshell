//! User-facing Chinese messages for connection / IO failures.

use protocol::ClientError;
use ssh_core::CoreError;

/// Map core/session errors to a frontend-parseable JSON string.
pub fn map_core_err(err: CoreError) -> String {
    let client = match err {
        CoreError::HostKeyChanged { fingerprint, host } => {
            ClientError::HostKeyChanged { fingerprint, host }
        }
        CoreError::HostKeyUnknown { fingerprint, host } => {
            ClientError::HostKeyUnknown { fingerprint, host }
        }
        CoreError::Auth(message) => ClientError::Auth {
            message: humanize_auth(&message),
        },
        CoreError::SessionNotFound(id) => ClientError::NotFound {
            message: format!("会话不存在或已断开（{id}）"),
        },
        CoreError::NotYet(what) => ClientError::Message {
            message: format!("功能尚未实现：{what}"),
        },
        other => ClientError::Message {
            message: humanize_message(&other.to_string()),
        },
    };
    serde_json::to_string(&client).unwrap_or_else(|e| e.to_string())
}

pub fn map_err_str(err: impl ToString) -> String {
    let message = err.to_string();
    if message.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&message) {
            if v.get("kind").is_some() {
                return message;
            }
        }
    }
    serde_json::to_string(&ClientError::Message {
        message: humanize_message(&message),
    })
    .unwrap_or_else(|e| e.to_string())
}

pub(crate) fn humanize_auth(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("password not found") || lower.contains("no entry") {
        return "未找到已保存的密码。请编辑连接并重新填写密码后保存。".into();
    }
    if lower.contains("rejected") || lower.contains("authentication") {
        return format!("认证失败：{raw}。请检查用户名、密码或密钥。");
    }
    if lower.contains("passphrase") {
        return format!("密钥口令错误或缺失：{raw}");
    }
    format!("认证失败：{raw}")
}

pub(crate) fn humanize_message(raw: &str) -> String {
    let lower = raw.to_lowercase();

    // Serial — check before generic "拒绝" / network rules.
    if lower.contains("串口")
        || lower.contains("serial")
        || (lower.contains("com")
            && (lower.contains("open")
                || lower.contains("port")
                || lower.contains("打开")
                || lower.contains("access is denied")
                || lower.contains("os error")))
    {
        if lower.contains("access is denied")
            || lower.contains("拒绝访问")
            || lower.contains("os error 5")
        {
            return "无法打开串口：设备被占用或权限不足。请关闭其它串口软件后重试。".into();
        }
        if lower.contains("cannot find")
            || lower.contains("系统找不到")
            || lower.contains("no such file")
            || lower.contains("os error 2")
        {
            return "串口不存在。请在设备管理器确认 COM 口号，并刷新端口列表。".into();
        }
        if lower.contains("打开串口") || lower.contains("串口") {
            // Prefer original Chinese serial messages from serial.rs
            if raw.chars().any(|c| c > '\u{7f}') {
                return raw.to_string();
            }
        }
    }

    // Network / connect
    if lower.contains("timed out") || lower.contains("timeout") || lower.contains("10060") {
        return "连接超时。请检查主机地址、端口与网络连通性。".into();
    }
    if lower.contains("connection refused")
        || lower.contains("actively refused")
        || lower.contains("10061")
    {
        return "连接被拒绝。目标端口可能未开放，或服务未启动。".into();
    }
    // Avoid matching Chinese UI copy that contains 拒绝 but is already humanized.
    if lower.contains("connection") && lower.contains("refused") {
        return "连接被拒绝。目标端口可能未开放，或服务未启动。".into();
    }
    if lower.contains("could not resolve")
        || lower.contains("name or service not known")
        || lower.contains("nodename nor servname")
        || lower.contains("11001")
        || lower.contains("failed to lookup")
    {
        return "无法解析主机名。请检查主机地址或 DNS。".into();
    }
    if lower.contains("network is unreachable") || lower.contains("10051") {
        return "网络不可达。请检查本机网络或路由。".into();
    }
    if lower.contains("no route to host") || lower.contains("10065") {
        return "无法到达主机。请检查地址、防火墙与中间网络。".into();
    }
    if lower.contains("connection reset")
        || lower.contains("forcibly closed")
        || lower.contains("10054")
    {
        return "连接被对方重置。可能是中间设备断开或服务异常。".into();
    }

    // SSH layer
    if lower.contains("unable to exchange")
        || lower.contains("key exchange")
        || lower.contains("kex")
    {
        return "SSH 密钥协商失败。对方 SSH 版本或算法可能不兼容。".into();
    }
    if lower.contains("banner") {
        return "未收到有效的 SSH 标识。端口可能不是 SSH 服务。".into();
    }
    if lower.contains("protocol") && lower.contains("ssh") {
        return format!("SSH 协议错误：{raw}");
    }

    // Local shell
    if lower.contains("无法启动本地终端") {
        return raw.to_string();
    }
    if lower.contains("spawn")
        && (lower.contains("cmd") || lower.contains("powershell") || lower.contains("pwsh"))
    {
        return format!("无法启动本地终端：{raw}。请确认系统已安装 cmd/PowerShell。");
    }

    // Telnet / generic TCP
    if lower.contains("telnet") {
        return format!("Telnet 连接失败：{raw}");
    }

    // Fallback: strip noisy prefixes then re-run once
    let trimmed = raw
        .trim_start_matches("io error: ")
        .trim_start_matches("ssh error: ")
        .trim_start_matches("keyring error: ");
    if trimmed != raw {
        return humanize_message(trimmed);
    }
    raw.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn msg_from_json(s: &str) -> String {
        let v: serde_json::Value = serde_json::from_str(s).unwrap();
        v.get("message")
            .and_then(|m| m.as_str())
            .unwrap_or(s)
            .to_string()
    }

    #[test]
    fn timeout_maps_to_chinese() {
        let s = map_core_err(CoreError::Other(
            "io error: connection timed out".into(),
        ));
        let m = msg_from_json(&s);
        assert!(m.contains("超时"), "{m}");
    }

    #[test]
    fn connection_refused_maps() {
        let s = map_core_err(CoreError::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "Connection refused",
        )));
        let m = msg_from_json(&s);
        assert!(m.contains("拒绝") || m.contains("未开放"), "{m}");
    }

    #[test]
    fn serial_access_denied() {
        let s = map_core_err(CoreError::Other(
            "打开串口 COM3 失败: Access is denied. (os error 5)".into(),
        ));
        let m = msg_from_json(&s);
        assert!(m.contains("占用") || m.contains("权限"), "{m}");
    }

    #[test]
    fn password_not_found_auth() {
        let s = map_core_err(CoreError::Auth("password not found".into()));
        let m = msg_from_json(&s);
        assert!(m.contains("密码"), "{m}");
    }

    #[test]
    fn session_not_found() {
        let id = Uuid::nil();
        let s = map_core_err(CoreError::SessionNotFound(id));
        let m = msg_from_json(&s);
        assert!(m.contains("会话"), "{m}");
    }

    #[test]
    fn host_key_unknown_keeps_kind() {
        let s = map_core_err(CoreError::HostKeyUnknown {
            fingerprint: "aa".into(),
            host: "h:22".into(),
        });
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v.get("kind").and_then(|k| k.as_str()), Some("hostKeyUnknown"));
    }

    #[test]
    fn map_err_str_passthrough_json() {
        let raw = r#"{"kind":"auth","message":"x"}"#;
        assert_eq!(map_err_str(raw), raw);
    }
}

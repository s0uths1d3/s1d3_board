//! 灵动岛 Webhook 集成测试（`cargo test --test island_webhook` 运行）。
//! 被测对象：`island::webhook` 的出站 URL 白名单校验 `validate_url`——
//! https 任意主机放行；http 仅回环（127.0.0.1 / localhost / [::1]）；其余协议拒绝。
//! 纯函数断言，无数据库、无网络、无 Tauri 运行时依赖。

use app_lib::webhook::validate_url;

#[test]
fn https_any_host_allowed() {
    assert!(validate_url("https://example.com/hook").is_ok());
    assert!(validate_url("https://10.0.0.1/hook").is_ok());
    assert!(validate_url("https://localhost:9000/hook").is_ok());
}

#[test]
fn http_loopback_allowed() {
    assert!(validate_url("http://127.0.0.1:8080/hook").is_ok());
    assert!(validate_url("http://localhost/hook").is_ok());
}

#[test]
fn http_remote_rejected() {
    // http 远程主机拒绝（防明文外发），提示改用 https
    let err = validate_url("http://example.com/hook").unwrap_err();
    assert!(err.contains("https"));
    assert!(validate_url("http://192.168.1.5/hook").is_err());
    assert!(validate_url("http://[::1]:8080/").is_ok()); // IPv6 回环仍放行
}

#[test]
fn non_http_schemes_rejected() {
    assert!(validate_url("ftp://example.com").is_err());
    assert!(validate_url("file:///etc/passwd").is_err());
    assert!(validate_url("not a url").is_err());
}

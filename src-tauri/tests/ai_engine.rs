//! AI 引擎集成测试（`cargo test --test ai_engine` 运行）。
//! 被测对象：`ai::engine::normalize_base_url`——base_url 规整（去尾部斜杠与空白，
//! 空值回落到该提供商的官方默认地址）。纯函数断言，无网络与 Tauri 运行时依赖。

use app_lib::engine::normalize_base_url;

#[test]
fn normalize_base_url_trims_trailing_slash() {
    assert_eq!(
        normalize_base_url("https://api.example.com/v1/", "https://default"),
        "https://api.example.com/v1"
    );
    // 多个尾斜杠全部去除
    assert_eq!(
        normalize_base_url("https://api.example.com/v1///", "https://default"),
        "https://api.example.com/v1"
    );
}

#[test]
fn normalize_base_url_keeps_clean_url() {
    assert_eq!(
        normalize_base_url("https://api.openai.com/v1", "https://default"),
        "https://api.openai.com/v1"
    );
}

#[test]
fn normalize_base_url_trims_whitespace() {
    assert_eq!(
        normalize_base_url("  https://api.example.com  ", "https://default"),
        "https://api.example.com"
    );
}

#[test]
fn normalize_base_url_empty_falls_back_to_default() {
    assert_eq!(normalize_base_url("", "https://fallback"), "https://fallback");
    assert_eq!(normalize_base_url("   ", "https://fallback"), "https://fallback");
    assert_eq!(normalize_base_url("/", "https://fallback"), "https://fallback");
}

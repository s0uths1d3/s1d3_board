//! 应用使用时长模块集成测试（独立于核心代码，`cargo test --test app_usage` 运行）。
//! 被测对象：`app_usage` 模块的 data URL 编码工具 `encode_data_url`——
//! 字节序列 → base64 编码的 PNG data URL（应用图标持久化链路的共用编码步骤）。

use app_lib::encode_data_url;

#[test]
fn encode_data_url_wraps_base64() {
    let out = encode_data_url(b"hello".to_vec());
    assert_eq!(out, "data:image/png;base64,aGVsbG8=");
}

#[test]
fn encode_data_url_empty_is_valid_data_url() {
    // 空字节也应产出合法 data URL（前缀 + 空 base64）
    assert_eq!(encode_data_url(Vec::new()), "data:image/png;base64,");
}

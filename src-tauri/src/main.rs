// Prevents additional console window on Windows in release, DO NOT REMOVE!!

// Linux 依赖：在 Linux 上，需要安装 xorg-dev 库：
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}

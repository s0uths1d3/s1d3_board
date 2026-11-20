#!/usr/bin/env python3
"""Generate the animated demo images used by the README "Screenshots" section.

Every image is rendered from a self-contained HTML mock-up that uses only
public / fictional sample data (MDN, RFC 9110, vuejs/core, npm docs, lorem
ipsum).  Nothing is captured from a local database or a real user session.

Output: .docs/images/*.gif — all frames share the same 1120x700 canvas.

Usage:
    python scripts/readme-shots/generate.py            # all scenes
    python scripts/readme-shots/generate.py clipboard  # a single scene

Requirements: Python 3.10+, Pillow, Google Chrome or Microsoft Edge.
"""

from __future__ import annotations

import argparse
import base64
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / ".docs" / "images"

W, H = 1120, 700          # logical canvas (also the final GIF size)
RENDER_SCALE = 2          # render at 2x then downscale for crisp text

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]

# ---------------------------------------------------------------------------
# public sample data
# ---------------------------------------------------------------------------

CLIPS = [
    {
        "text": 'const res = await fetch("https://api.github.com/repos/vuejs/core");',
        "app": "VS Code",
        "type": "TEXT",
        "favorite": True,
    },
    {
        "text": 'fetch(url, { method: "GET", headers: { Accept: "application/json" } })',
        "app": "Chrome",
        "type": "TEXT",
        "favorite": False,
    },
    {
        "text": "Fetch API — developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
        "app": "Chrome",
        "type": "TEXT",
        "favorite": False,
    },
    {
        "text": "https://github.com/vuejs/core",
        "app": "Chrome",
        "type": "LINK",
        "favorite": False,
    },
    {
        "text": "npm run tauri:dev  →  http://localhost:12321",
        "app": "Terminal",
        "type": "TEXT",
        "favorite": True,
    },
]

TODOS = [
    ("Review RFC 9110 caching semantics", "HIGH", "Study", "Today 18:00"),
    ("Update Vue 3 migration notes", "MEDIUM", "Docs", "Tomorrow"),
    ("Write tests for useTabs", "MEDIUM", "Code", "Fri 10:00"),
    ("Read MDN Fetch API guide", "LOW", "Study", "Sat"),
    ("Ship v0.5.1 changelog", "HIGH", "Release", "Today 20:00"),
]

NOTES = [
    ("Standup", "Demo the clipboard sequence paste flow", "blue", 160),
    ("Idea", "Keyboard-first: Ctrl+I to summon, Esc to dismiss", "yellow", 150),
    ("Bug", "Island capsule does not expand on hover when focus is lost", "pink", 158),
    ("Reference", "RFC 9110 §9.3.1 — GET is safe and idempotent", "green", 142),
    ("Snippet", "const rows = await repo.page(offset, limit)", "purple", 136),
    ("Read later", "MDN: Fetch API — https://mzl.la/fetch", "orange", 146),
    ("Meeting", "Clipboard review every Friday 15:00", "blue", 150),
    ("Design", "Amber palette · gold accent · soft shadows", "yellow", 142),
]

PINNED = [
    ("PR checklist", "git review", "git fetch origin && git rebase -i origin/main", "Ctrl+1"),
    ("API base", "api", "https://api.github.com/repos/vuejs/core", "Ctrl+2"),
    ("Daily standup", "team", "Yesterday · today · blockers", "Ctrl+3"),
    ("Commit template", "git", "feat(scope): concise summary", "Ctrl+4"),
    ("RFC quote", "docs", "GET means retrieve whatever information …", "Ctrl+5"),
    ("Dev server", "npm", "npm run tauri:dev", "Ctrl+6"),
    ("Release notes", "docs", "feat · fix · perf · docs · chore", "Ctrl+7"),
    ("Review reply", "team", "Thanks — addressed in 4f2c1ab.", "Ctrl+8"),
    ("Water reminder", "health", "Refill the bottle · 10:30", "Ctrl+9"),
]

APPS = [
    ("VS Code", "#3b82f6", 58, 106),
    ("Chrome", "#f59e0b", 42, 72),
    ("Terminal", "#10b981", 24, 42),
    ("Figma", "#ec4899", 14, 26),
    ("Slack", "#8b5cf6", 10, 20),
]

# ---------------------------------------------------------------------------
# tiny helpers
# ---------------------------------------------------------------------------


def lerp(a: float, b: float, p: float) -> float:
    return a + (b - a) * p


def clamp01(p: float) -> float:
    return max(0.0, min(1.0, p))


def ease(p: float) -> float:
    p = clamp01(p)
    return 1 - (1 - p) ** 3


def span(t: float, start: float, end: float) -> float:
    if end <= start:
        return 1.0 if t >= end else 0.0
    return clamp01((t - start) / (end - start))


def icon(name: str, size: int = 14, color: str = "currentColor", stroke_width: float = 1.8) -> str:
    """Minimal line icons (same visual language as the app's inline SVGs)."""
    paths = {
        "clip": '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M8 11h8M8 15h5"/>',
        "pin": '<path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
        "todo": '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
        "note": '<path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2z"/><path d="M14 21v-5a2 2 0 0 1 2-2h5"/>',
        "stats": '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="7" rx="1"/><rect x="12" y="7" width="3" height="11" rx="1"/><rect x="17" y="13" width="3" height="5" rx="1"/>',
        "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
        "calendar": '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>',
        "settings": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
        "search": '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
        "star": '<path d="M12 2.8l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.6l6.5-.9z"/>',
        "layers": '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 12l10 5 10-5"/><path d="M2 17l10 5 10-5"/>',
        "filter": '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
        "palette": '<circle cx="13.5" cy="6.5" r=".6" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".6" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".6" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".6" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1a1.6 1.6 0 0 1 1.7-1.7h2c3 0 5.5-2.5 5.5-5.5C22 6 17.5 2 12 2z"/>',
        "history": '<path d="M3 3v5h5"/><path d="M3 13a9 9 0 1 0 .5-5L3 8"/><path d="M12 7v5l4 2"/>',
        "minus": '<path d="M5 12h14"/>',
        "square": '<rect x="5" y="5" width="14" height="14" rx="2"/>',
        "close": '<path d="M6 6l12 12M18 6L6 18"/>',
        "check": '<path d="M20 6 9 17l-5-5"/>',
        "arrow": '<path d="M5 12h14M13 6l6 6-6 6"/>',
        "enter": '<path d="M9 10l-5 5 5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
        "plus": '<path d="M12 5v14M5 12h14"/>',
        "image": '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
        "file": '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/>',
    }
    body = paths.get(name, paths["square"])
    stroke = f'fill="none" stroke="currentColor" stroke-width="{stroke_width}" stroke-linecap="round" stroke-linejoin="round"'
    fill = 'fill="currentColor" stroke="none"' if name == "star" else stroke
    return (
        f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" {fill} '
        f'style="color:{color};flex:none">{body}</svg>'
    )


def mark(text: str, query: str) -> str:
    """Highlight occurrences of the search query (README demo, not HTML-safe input)."""
    if not query:
        return text
    low, q = text.lower(), query.lower()
    out, i = [], 0
    while True:
        j = low.find(q, i)
        if j < 0:
            out.append(text[i:])
            return "".join(out)
        out.append(text[i:j])
        out.append(f'<mark>{text[j:j + len(q)]}</mark>')
        i = j + len(q)


# ---------------------------------------------------------------------------
# shared chrome
# ---------------------------------------------------------------------------

TABS = [
    ("clip", "Clipboard"),
    ("pin", "Pinned"),
    ("todo", "Todo"),
    ("note", "Notes"),
    ("stats", "Statistics"),
    ("clock", "App usage"),
    ("calendar", "Calendar"),
    ("settings", "Settings"),
]


def titlebar(active: str) -> str:
    nav = ""
    for i, (key, label) in enumerate(TABS):
        is_active = key == active
        cls = "nav-tab active" if is_active else "nav-tab"
        nav += (
            f'<div class="{cls}" title="{label}">{icon(key, 15, "#c4a77d" if is_active else "#6b6354")}</div>'
        )
        if is_active:
            nav += f'<div class="nav-underline" style="left:{i * 40}px"></div>'
    controls = (
        f'<div class="win-btn">{icon("palette", 14, "#6b6354")}</div>'
        f'<div class="win-btn">{icon("history", 14, "#6b6354")}</div>'
        f'<div class="win-btn">{icon("minus", 14, "#6b6354")}</div>'
        f'<div class="win-btn">{icon("square", 14, "#6b6354")}</div>'
        f'<div class="win-btn">{icon("pin", 14, "#6b6354")}</div>'
        f'<div class="win-btn close">{icon("close", 14, "#b05c5c")}</div>'
    )
    return f"""
    <header class="titlebar">
      <div class="brand"><span class="gold-bar"></span><span class="brand-name">S1d3 Board</span></div>
      <nav class="nav">{nav}</nav>
      <div class="controls">{controls}</div>
    </header>"""


def capsule(text: str, kind: str = "success", p: float = 1.0, bottom: int = 20) -> str:
    """Dynamic-island style capsule floating above the panel content."""
    if p <= 0:
        return ""
    icons = {"success": "check", "info": "enter", "copy": "clip"}
    color = {"success": "#6f8a55", "info": "#c4a77d", "copy": "#c4a77d"}[kind]
    style = (
        f"bottom:{bottom + 6 * (1 - ease(p)):.0f}px;opacity:{ease(p):.3f};"
        f"transform:translateX(-50%) scale({lerp(0.92, 1.0, ease(p)):.3f});"
    )
    return (
        f'<div class="capsule" style="{style}">'
        f'{icon(icons[kind], 15, color)}<span>{text}</span></div>'
    )


def range_bar(active: str, offset: float | None = None, labels=("Day", "Week", "Month", "Year")) -> str:
    left = labels.index(active) * 74 if offset is None else offset
    items = "".join(
        f'<div class="range-item {"on" if l == active else ""}">{l}</div>' for l in labels
    )
    return (
        '<div class="rangebar"><div class="range-pill" style="left:%.1fpx"></div>%s</div>' % (left, items)
    )


def card_head(title: str, sub: str = "") -> str:
    return (
        f'<div class="page-head"><div class="page-title">{title}</div>'
        f'<div class="page-sub">{sub}</div></div>'
    )


# ---------------------------------------------------------------------------
# scenes
# ---------------------------------------------------------------------------


def scene_clipboard(t: float) -> str:
    q_full = "fetch"
    typed = q_full[: max(0, min(len(q_full), int((t - 0.4) / 0.14) + 1 if t >= 0.4 else 0))]
    filtering = ease(span(t, 1.2, 1.9))
    move = ease(span(t, 2.05, 2.65))
    capsule_p = span(t, 2.85, 3.25)

    rows = ""
    for i, clip in enumerate(CLIPS):
        matches = q_full in clip["text"].lower()
        if t >= 1.9 and not matches:
            continue
        opacity = 1.0 if t < 1.2 or matches else 1 - filtering
        dx = 0 if t < 1.2 or matches else 14 * filtering
        ring_alpha = (1 - move) if i == 0 else (move if i == 1 else 0)
        ring_style = ""
        if ring_alpha > 0.01:
            ring_style = (
                f"border-color:rgba(196,167,125,{ring_alpha:.3f});"
                f"box-shadow:0 0 0 1px rgba(196,167,125,{0.65 * ring_alpha:.3f}),"
                f"0 6px 18px rgba(74,64,52,{0.12 * ring_alpha:.3f})"
            )
            ring = " selected"
        else:
            ring = ""
        badge_alpha = ring_alpha if i in (0, 1) and t >= 1.9 else (1.0 if i == 0 else 0.0)
        key_badge = (
            f'<div class="clip-key" style="opacity:{badge_alpha:.3f}">Enter</div>'
            if badge_alpha > 0.02
            else ""
        )
        fav = '<span class="fav-bar"></span>' if clip["favorite"] else ""
        src_icon = {"VS Code": "file", "Chrome": "image", "Terminal": "enter"}.get(clip["app"], "file")
        rows += f"""
        <div class="clip-row{ring}" style="opacity:{opacity:.3f};transform:translateX({dx:.1f}px);{ring_style}">
          {fav}
          <div class="clip-index">{i + 1}</div>
          <div class="clip-body">
            <div class="clip-text">{mark(clip["text"], typed)}</div>
            <div class="clip-meta">
              <span class="meta-app">{icon(src_icon, 12, "#9a9080")}{clip["app"]}</span>
              <span class="meta-dot">·</span><span>{clip["type"]}</span>
              <span class="meta-dot">·</span><span>just now</span>
            </div>
          </div>
          {key_badge}
        </div>"""

    caret_on = int(t * 2.4) % 2 == 0
    caret = '<span class="caret"></span>' if caret_on else ""
    return f"""
    <div class="page">
      <div class="searchbar">
        {icon("search", 18, "#9a9080")}
        <span class="query">{typed}{caret}<span class="placeholder" style="display:{'none' if typed else 'inline'}">Search clipboard…</span></span>
        <div class="tool-icons">
          {icon("star", 14, "#c4a77d")}
          {icon("layers", 14, "#6b6354")}
          {icon("filter", 14, "#6b6354")}
        </div>
      </div>
      <div class="filter-strip" style="opacity:{filtering:.2f};height:{34 * filtering:.0f}px">
        <span>Filtered: <b>{typed or q_full}</b> · {sum(1 for c in CLIPS if q_full in c["text"].lower())} results</span>
        <span class="strip-x">{icon("close", 12, "#c4a77d")}</span>
      </div>
      <div class="clip-list">{rows}</div>
      <div class="page-foot">
        <span><b>Arrows</b> navigate</span><span><b>Enter</b> paste</span>
        <span><b>Ctrl+L</b> favorite</span><span><b>Ctrl+Shift+1…0</b> quick paste</span>
      </div>
      {capsule("Pasted from history", "copy", capsule_p, bottom=56)}
    </div>"""


def scene_todos(t: float) -> str:
    check = ease(span(t, 0.95, 1.75))
    progress = lerp(40, 60, check)
    done = 2 + (1 if check > 0.5 else 0)
    capsule_p = span(t, 1.95, 2.35)

    rows = ""
    for i, (text, prio, cat, due) in enumerate(TODOS):
        is_target = i == 2
        box_style = (
            f'background:rgba(111,138,85,{check:.3f});border-color:rgba(111,138,85,{check:.3f})'
            if is_target
            else ""
        )
        tick = (
            f'<span style="opacity:{check:.3f};display:flex">{icon("check", 13, "#ffffff", 3)}</span>'
            if is_target
            else ""
        )
        strike = (
            f"text-decoration:line-through;text-decoration-color:rgba(74,68,56,{0.55 * check:.2f});"
            f"color:rgba(74,68,56,{1 - 0.35 * check:.2f})"
            if is_target
            else ""
        )
        prio_cls = {"HIGH": "prio-high", "MEDIUM": "prio-mid", "LOW": "prio-low"}[prio]
        rows += f"""
        <div class="todo-row">
          <div class="checkbox" style="{box_style}">{tick}</div>
          <div class="todo-main">
            <div class="todo-text" style="{strike}">{text}</div>
            <div class="todo-meta">
              <span class="pill {prio_cls}">{prio.title()}</span>
              <span class="pill cat">{cat}</span>
              <span class="due">{icon("clock", 11, "#9a9080")}{due}</span>
            </div>
          </div>
          <div class="todo-menu">⋯</div>
        </div>"""

    return f"""
    <div class="page">
      {card_head("Todo", "Today · 5 items")}
      <div class="progress-card">
        <div class="progress-label"><span>{done} / {len(TODOS)} done</span><span class="muted">Smart reminders on</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:{progress:.1f}%"></div></div>
      </div>
      <div class="todo-list">{rows}</div>
      <div class="reminder-bar">
        <span class="reminder-icon">{icon("clock", 14, "#c4a77d")}</span>
        <span><b>Next reminder</b> · “Review RFC 9110 caching semantics” at 18:00</span>
        <span class="muted">delivered through the dynamic island</span>
      </div>
      {capsule("Task completed · 3 / 5", "success", capsule_p)}
    </div>"""


def scene_notes(t: float) -> str:
    new_p = ease(span(t, 0.5, 1.05))
    typed = "Try Ctrl+N → new note, Ctrl+Enter → save"[: max(0, int(span(t, 1.15, 2.35) * 42))]
    saved_p = span(t, 2.45, 2.8)
    blink = int(t * 2.4) % 2 == 0
    columns: list[list[str]] = [[], [], []]
    for i, (title, text, color, height) in enumerate(NOTES):
        columns[i % 3].append(
            f'<div class="note {color}" style="height:{height}px">'
            f'<div class="note-title">{title}</div><div class="note-text">{text}</div>'
            f'<div class="note-time">just now</div></div>'
        )
    typed_html = (
        f'<div class="note purple new-note" '
        f'style="height:{lerp(40, 168, new_p):.0f}px;opacity:{new_p:.2f}">'
        f'<div class="note-title">Shortcut</div><div class="note-text">{typed}'
        f'{"<span class=caret></span>" if blink and t < 2.35 else ""}</div>'
        f'<div class="note-time"><span style="opacity:{saved_p:.2f};display:flex">'
        f'{icon("check", 11, "#6f8a55")}</span></div></div>'
        if t >= 0.5
        else ""
    )
    columns[2].insert(0, typed_html)
    grid = "".join(f'<div class="note-col">{"".join(c)}</div>' for c in columns)
    return f"""
    <div class="page">
      {card_head("Notes", "9 notes · 6 colors")}
      <div class="note-toolbar">
        <div class="btn-gold">{icon("plus", 13, "#ffffff")} New note</div>
        <div class="muted">Ctrl+N create · Ctrl+Enter save</div>
      </div>
      <div class="note-grid" style="margin-top:14px">{grid}</div>
      {capsule("Note saved", "success", saved_p)}
    </div>"""


def scene_pinned(t: float) -> str:
    steps = [(0.9, 1), (1.6, 4), (2.3, 3)]
    selected, fade_from, fade = 0, 0, 0.0
    for start, target in steps:
        if t >= start:
            selected, fade_from = target, selected
            fade = ease(span(t, start, start + 0.55))
    capsule_p = span(t, 2.9, 3.3)
    cards = ""
    for i, (name, tags, text, key) in enumerate(PINNED):
        alpha = 0.0
        if i == selected:
            alpha = fade if fade_from != selected else 1.0
        elif i == fade_from and fade < 1:
            alpha = 1 - fade
        sel = f' style="border-color:rgba(196,167,125,{alpha:.2f});box-shadow:0 0 0 2px rgba(196,167,125,{alpha * 0.55:.2f}),0 8px 20px rgba(74,64,52,{0.08 + 0.06 * alpha:.2f});transform:translateY({-3 * alpha:.1f}px)"' if alpha > 0.01 else ""
        cards += f"""
        <div class="pin-card{' sel' if alpha > 0.99 else ''}"{sel}>
          <div class="pin-top"><span class="pin-name">{name}</span><span class="pin-key">{key}</span></div>
          <div class="pin-text">{text}</div>
          <div class="pin-tags">{"".join(f'<span>{t}</span>' for t in tags.split())}</div>
        </div>"""
    return f"""
    <div class="page">
      {card_head("Pinned", "Paste the first 10 with Ctrl+1 … Ctrl+0")}
      <div class="pin-grid">{cards}</div>
      <div class="hint-bar">
        <span>{icon("arrow", 12, "#c4a77d")} Arrow keys pick the nearest card</span>
        <span>{icon("enter", 12, "#c4a77d")} Enter pastes</span>
        <span>{icon("close", 12, "#c4a77d")} Delete removes</span>
      </div>
      {capsule("Pasted · PR checklist", "copy", capsule_p)}
    </div>"""


STATS = {
    "Day": (18, 12, 4, 3),
    "Week": (128, 96, 18, 24),
    "Month": (512, 388, 74, 96),
    "Year": (6210, 4680, 812, 1140),
}


def _bar_chart(values: list[int], color: str = "#c4a77d") -> str:
    peak = max(values)
    bars = ""
    for i, v in enumerate(values):
        h = 8 + 118 * (v / peak)
        lit = i >= len(values) - 4
        bars += (
            f'<div class="bar" style="height:{h:.1f}px;'
            f'background:{"#c4a77d" if lit else "rgba(196,167,125,.38)"}"></div>'
        )
    return f'<div class="chart">{bars}</div>'


def scene_stats(t: float) -> str:
    switch = ease(span(t, 0.6, 1.9))
    active = "Week" if switch < 0.5 else "Month"
    a, b = STATS["Week"], STATS["Month"]
    values = [f"{int(round(lerp(x, y, switch))):,}" for x, y in zip(a, b)]
    metrics = [
        ("Clips", values[0], "clip"),
        ("Pastes", values[1], "enter"),
        ("Notes", values[2], "note"),
        ("Todos done", values[3], "todo"),
    ]
    metric_html = "".join(
        f'<div class="metric"><div class="metric-icon">{icon(ic, 15, "#c4a77d")}</div>'
        f'<div class="metric-value">{v}</div><div class="metric-label">{label}</div></div>'
        for label, v, ic in metrics
    )
    week = [6, 9, 7, 12, 14, 10, 16, 13, 18, 15, 20, 22]
    month = [14, 18, 16, 24, 28, 22, 31, 27, 36, 33, 40, 45]
    chart_vals = [lerp(x, y, switch) for x, y in zip(week, month)]
    dist = [
        ("Clipboard", 46, 0.46),
        ("Todo", 22, 0.22),
        ("Notes", 18, 0.18),
        ("Statistics", 14, 0.14),
    ]
    dist_html = "".join(
        f'<div class="dist-row"><span class="dist-name">{name}</span>'
        f'<span class="dist-track"><span class="dist-fill" style="width:{p * 100:.0f}%"></span></span>'
        f'<span class="dist-val">{p * 100:.0f}%</span></div>'
        for name, _, p in dist
    )
    hourly = [2, 1, 0, 0, 0, 1, 3, 6, 9, 12, 14, 11, 8, 10, 13, 15, 12, 9, 7, 5, 4, 3, 2, 1]
    hours = "".join(
        f'<span class="hourbar" style="height:{4 + 44 * v / max(hourly):.0f}px;'
        f'background:{"#c4a77d" if 8 <= i <= 18 else "rgba(196,167,125,.38)"}"></span>'
        for i, v in enumerate(hourly)
    )
    return f"""
    <div class="page">
      <div class="stats-head">
        {card_head("Statistics", "Everything stays on this machine")}
        {range_bar(active, lerp(74, 148, switch))}
      </div>
      <div class="metric-grid">{metric_html}</div>
      <div class="panel-row">
        <div class="panel grow">
          <div class="panel-title">Daily activity <span class="muted">· clips per day</span></div>
          {_bar_chart(chart_vals)}
        </div>
        <div class="panel dist-panel">
          <div class="panel-title">Tab visits</div>
          {dist_html}
        </div>
      </div>
      <div class="stats-bottom">
        <div class="panel grow">
          <div class="panel-title">Active hours <span class="muted">· today</span></div>
          <div class="hourbars">{hours}</div>
          <div class="hour-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
        </div>
        <div class="panel facts">
          <div class="panel-title">Fun facts</div>
          <div class="fact-row"><span>Typed this week</span><b>18,420 chars</b></div>
          <div class="fact-row"><span>Longest streak</span><b>12 days</b></div>
          <div class="fact-row"><span>Top copier</span><b>VS Code</b></div>
          <div class="persona"><span>Keyboard-first</span><span>Local-only</span></div>
        </div>
      </div>
    </div>"""


def scene_appusage(t: float) -> str:
    switch = ease(span(t, 0.6, 1.9))
    active = "Day" if switch < 0.5 else "Week"
    total = lerp(196, 372, switch)  # minutes
    active_min = lerp(148, 288, switch)
    idle = total - active_min

    def hm(m: float) -> str:
        return f"{int(m // 60)}h {int(m % 60):02d}m"

    deg = active_min / total * 360
    donut = (
        f"background:conic-gradient(#c4a77d 0deg {deg:.1f}deg,"
        f"#d9c3a3 {deg:.1f}deg 357deg,"
        f"#e6dccb 357deg 360deg);"
    )
    rows = ""
    peak = lerp(APPS[0][2], APPS[0][3], switch)
    hourly = [3, 2, 1, 0, 0, 1, 4, 8, 12, 15, 17, 14, 9, 12, 16, 18, 15, 11, 8, 6, 5, 4, 3, 2]
    hours = "".join(
        f'<span class="hourbar" style="height:{4 + 38 * v / max(hourly):.0f}px;'
        f'background:{"#c4a77d" if 8 <= i <= 18 else "rgba(196,167,125,.38)"}"></span>'
        for i, v in enumerate(hourly)
    )
    for name, color, day_min, week_min in APPS:
        minutes = lerp(day_min, week_min, switch)
        pct = minutes / active_min * 100
        width = minutes / peak * 100
        rows += f"""
        <div class="app-row">
          <span class="app-logo" style="background:{color}">{name[0]}</span>
          <span class="app-name">{name}</span>
          <span class="app-track"><span class="app-fill" style="width:{width:.0f}%;background:{color}"></span></span>
          <span class="app-time">{hm(minutes)}</span>
          <span class="app-pct">{int(round(pct))}%</span>
        </div>"""
    return f"""
    <div class="page">
      <div class="stats-head">
        {card_head("App usage", "Foreground time · 30s segments")}
        {range_bar(active, lerp(0, 74, switch))}
      </div>
      <div class="usage-cards">
        <div class="usage-card"><div class="usage-label">Total</div><div class="usage-value">{hm(total)}</div></div>
        <div class="usage-card"><div class="usage-label">Active</div><div class="usage-value">{hm(active_min)}</div></div>
        <div class="usage-card"><div class="usage-label">Idle</div><div class="usage-value">{hm(idle)}</div></div>
      </div>
      <div class="panel-row">
        <div class="donut-panel">
          <div class="donut" style="{donut}"><div class="donut-hole"><span>{hm(active_min)}</span><small>active</small></div></div>
          <div class="legend"><span><i style="background:#c4a77d"></i>Active</span><span><i style="background:#d9c3a3"></i>Idle</span></div>
        </div>
        <div class="panel grow app-panel">
          <div class="panel-title">Top applications</div>
          {rows}
        </div>
      </div>
      <div class="panel" style="margin-top:10px">
        <div class="panel-title">Hourly activity <span class="muted">· foreground time</span></div>
        <div class="hourbars" style="height:44px">{hours}</div>
        <div class="hour-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
      </div>
    </div>"""


# ---------------------------------------------------------------------------
# HTML shell / CSS
# ---------------------------------------------------------------------------

CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1120px; height: 700px; overflow: hidden; }
body {
  font-family: "Segoe UI Variable Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  color: #4a4438;
  background: #f5ede4;
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}
.shot {
  position: relative; width: 1120px; height: 700px; overflow: hidden;
  background: linear-gradient(135deg, #faf6f2 0%, #f5ede4 52%, #ebe0d4 100%);
}
.shot::before, .shot::after {
  content: ""; position: absolute; z-index: 0; border-radius: 9999px; filter: blur(120px); pointer-events: none;
}
.shot::before { width: 520px; height: 420px; left: -120px; top: -160px; background: rgba(196,167,125,.42); }
.shot::after { width: 480px; height: 380px; right: -140px; bottom: -160px; background: rgba(212,201,184,.55); }
/* The backdrop is baked once into a static image: Chrome dithers gradients in
   device space, so identical CSS glows differ pixel-by-pixel between stacked
   frames and would defeat GIF delta compression. */
.static-bg .shot { background-image: var(--bg-image); background-size: 100% 100%; background-repeat: no-repeat; }
.static-bg .shot::before, .static-bg .shot::after { display: none; }
.titlebar {
  position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between;
  height: 40px; padding: 0 12px; background: #ece1d0; border-bottom: 1px solid #cbbfa9;
}
.brand { display: flex; align-items: center; gap: 8px; width: 220px; }
.gold-bar { width: 3px; height: 16px; border-radius: 999px; background: #c4a77d; }
.brand-name { font-size: 13px; font-weight: 600; letter-spacing: .1px; }
.nav { position: relative; display: flex; align-items: center; gap: 8px; }
.nav-tab {
  width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
}
.nav-tab.active { background: rgba(196,167,125,.14); }
.nav-underline { position: absolute; bottom: 1px; width: 32px; height: 2px; border-radius: 2px; background: #c4a77d; }
.controls { display: flex; align-items: center; gap: 4px; width: 220px; justify-content: flex-end; }
.win-btn { width: 28px; height: 28px; border-radius: 999px; display: flex; align-items: center; justify-content: center; }
.win-btn.close { background: rgba(176,92,92,.08); }
.page { position: relative; z-index: 1; padding: 16px 20px 0; height: calc(700px - 40px); }
.page-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
.page-title { font-size: 19px; font-weight: 650; letter-spacing: -.2px; }
.page-sub { font-size: 12px; color: #9a9080; }
.muted { color: #9a9080; font-size: 12px; }

/* clipboard */
.searchbar {
  display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 12px;
  background: rgba(236,225,208,.78); border: 1px solid #cbbfa9; border-radius: 16px;
  box-shadow: 0 4px 16px rgba(74,64,52,.10);
}
.query { flex: 1; font-size: 14px; color: #4a4438; white-space: pre; }
.placeholder { color: #9a9080; margin-left: 2px; }
.tool-icons { display: flex; align-items: center; gap: 12px; opacity: .85; }
.caret { display: inline-block; width: 1.5px; height: 16px; background: #c4a77d; vertical-align: -3px; margin-left: 1px; }
.filter-strip {
  display: flex; align-items: center; justify-content: space-between; overflow: hidden;
  margin-top: 8px; padding: 0 12px; border-radius: 12px; color: #a98f61;
  background: rgba(196,167,125,.12); border: 1px solid rgba(196,167,125,.45); font-size: 12px;
}
.filter-strip b { font-weight: 650; }
.strip-x { display: flex; }
.clip-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.clip-row {
  position: relative; display: flex; align-items: center; gap: 14px; height: 90px; padding: 10px 14px 10px 10px;
  background: rgba(236,225,208,.82); border: 1px solid #cbbfa9; border-radius: 16px;
  box-shadow: 0 4px 16px rgba(74,64,52,.09);
}
.clip-row.selected { border-color: #c4a77d; box-shadow: 0 0 0 1px rgba(196,167,125,.65), 0 6px 18px rgba(74,64,52,.12); }
.fav-bar { position: absolute; left: 5px; top: 14px; bottom: 14px; width: 4px; border-radius: 999px; background: #c4a77d; }
.clip-index { width: 48px; text-align: center; font-size: 40px; font-weight: 200; color: rgba(74,68,56,.28); font-variant-numeric: tabular-nums; }
.clip-body { flex: 1; min-width: 0; }
.clip-text { font-size: 15px; line-height: 1.45; color: #4a4438; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.clip-text mark { background: rgba(196,167,125,.55); color: #4a4438; border-radius: 3px; padding: 0 1px; }
.clip-meta { display: flex; align-items: center; gap: 6px; margin-top: 7px; font-size: 10.5px; letter-spacing: .35px; text-transform: uppercase; color: #8b8271; font-weight: 600; }
.meta-app { display: inline-flex; align-items: center; gap: 4px; }
.meta-dot { opacity: .5; }
.clip-key { font-size: 11px; font-weight: 600; letter-spacing: .3px; color: #a98f61; background: rgba(196,167,125,.16); border: 1px solid rgba(196,167,125,.5); padding: 3px 8px; border-radius: 8px; }
.page-foot { position: absolute; left: 20px; right: 20px; bottom: 14px; display: flex; gap: 22px; align-items: center; justify-content: center; font-size: 11.5px; color: #9a9080; }
.page-foot b { font-weight: 600; color: #8b8271; background: rgba(203,191,169,.32); border: 1px solid rgba(203,191,169,.55); border-radius: 6px; padding: 2px 6px; margin-right: 4px; }

/* capsule */
.capsule {
  position: absolute; z-index: 5; left: 50%; bottom: 20px; display: flex; align-items: center; gap: 8px;
  padding: 8px 16px; border-radius: 999px; color: #4a4438; font-size: 12.5px; font-weight: 600;
  background: rgba(250,246,242,.97); border: 1px solid #cbbfa9;
  box-shadow: 0 10px 28px rgba(74,64,52,.22);
}

/* todo */
.progress-card { padding: 12px 16px; background: rgba(236,225,208,.72); border: 1px solid #cbbfa9; border-radius: 16px; box-shadow: 0 4px 16px rgba(74,64,52,.08); }
.progress-label { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; color: #6b6354; margin-bottom: 8px; }
.progress-track { height: 7px; border-radius: 999px; background: rgba(203,191,169,.55); overflow: hidden; }
.progress-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #d9c3a3, #c4a77d); }
.todo-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.todo-row { display: flex; align-items: center; gap: 14px; padding: 12px 16px; background: rgba(236,225,208,.82); border: 1px solid #cbbfa9; border-radius: 16px; box-shadow: 0 4px 14px rgba(74,64,52,.07); }
.checkbox { width: 20px; height: 20px; border-radius: 6px; border: 1.6px solid #bfb29a; display: flex; align-items: center; justify-content: center; flex: none; }
.checkbox.checked { background: #6f8a55; border-color: #6f8a55; }
.todo-main { flex: 1; min-width: 0; }
.todo-text { font-size: 14px; font-weight: 550; transition: color .2s; }
.todo-row.done .todo-text { color: #8b8271; text-decoration: line-through; }
.todo-meta { display: flex; align-items: center; gap: 8px; margin-top: 7px; font-size: 11px; color: #8b8271; }
.pill { padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 650; letter-spacing: .3px; }
.prio-high { background: rgba(176,92,92,.14); color: #b05c5c; }
.prio-mid { background: rgba(196,167,125,.22); color: #9a7c4d; }
.prio-low { background: rgba(111,138,85,.15); color: #6f8a55; }
.pill.cat { background: rgba(203,191,169,.4); color: #6b6354; }
.due { display: inline-flex; align-items: center; gap: 4px; }
.todo-menu { color: #b5a992; font-size: 18px; }
.reminder-bar {
  display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 12px 16px;
  border-radius: 16px; border: 1px dashed rgba(196,167,125,.6); background: rgba(196,167,125,.08);
  font-size: 12px; color: #6b6354;
}
.reminder-bar b { font-weight: 650; color: #8b6f45; }
.reminder-icon { width: 26px; height: 26px; border-radius: 9px; background: rgba(196,167,125,.18); display: flex; align-items: center; justify-content: center; flex: none; }
.reminder-bar .muted { margin-left: auto; }

/* notes */
.note-toolbar { display: flex; align-items: center; justify-content: space-between; }
.btn-gold { display: inline-flex; align-items: center; gap: 6px; background: #c4a77d; color: #fff; font-size: 12.5px; font-weight: 600; padding: 8px 14px; border-radius: 12px; }
.note-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; align-items: start; }
.note-col { display: flex; flex-direction: column; gap: 10px; }
.note { position: relative; padding: 12px 13px; border-radius: 14px; border: 1px solid rgba(74,64,52,.10); box-shadow: 0 5px 14px rgba(74,64,52,.10); overflow: hidden; }
.note.blue { background: #dce8f4; } .note.yellow { background: #f5e8bf; } .note.pink { background: #f4dce2; }
.note.green { background: #dcebd8; } .note.purple { background: #e5dcf1; } .note.orange { background: #f6e0cd; }
.note-title { font-size: 12.5px; font-weight: 700; margin-bottom: 6px; color: #4a4438; }
.note-text { font-size: 12px; line-height: 1.5; color: #575043; }
.note-time { position: absolute; right: 11px; bottom: 8px; font-size: 10px; color: rgba(74,68,56,.48); display: flex; align-items: center; gap: 4px; }
.note.new-note { padding-top: 11px; }
.caret { display: inline-block; width: 1.5px; height: 13px; background: #7a7263; vertical-align: -2px; margin-left: 1px; }

/* pinned */
.pin-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.pin-card { height: 152px; padding: 14px; border-radius: 16px; background: rgba(236,225,208,.82); border: 1px solid #cbbfa9; box-shadow: 0 4px 14px rgba(74,64,52,.08); display: flex; flex-direction: column; }
.pin-card.sel { border-color: #c4a77d; box-shadow: 0 0 0 2px rgba(196,167,125,.55), 0 8px 20px rgba(74,64,52,.14); background: rgba(246,239,227,.92); }
.pin-top { display: flex; align-items: center; justify-content: space-between; }
.pin-name { font-size: 13.5px; font-weight: 650; }
.pin-key { font-size: 9.5px; font-weight: 650; color: #a98f61; background: rgba(196,167,125,.18); border: 1px solid rgba(196,167,125,.45); padding: 2px 6px; border-radius: 7px; }
.pin-text { flex: 1; margin-top: 10px; font-size: 12px; line-height: 1.55; color: #6b6354; overflow: hidden; }
.pin-tags { display: flex; gap: 5px; }
.pin-tags span { font-size: 10px; font-weight: 600; letter-spacing: .3px; color: #8f836f; background: rgba(203,191,169,.38); padding: 2px 7px; border-radius: 999px; }
.hint-bar { display: flex; align-items: center; gap: 20px; margin-top: 14px; padding: 10px 16px; border: 1px dashed rgba(196,167,125,.6); border-radius: 14px; color: #8b8271; font-size: 11.5px; }
.hint-bar span { display: inline-flex; align-items: center; gap: 6px; }

/* shared panels */
.stats-head { display: flex; align-items: flex-start; justify-content: space-between; }
.rangebar { position: relative; display: flex; gap: 2px; padding: 4px; border-radius: 12px; background: rgba(203,191,169,.34); border: 1px solid rgba(203,191,169,.6); }
.range-item { position: relative; z-index: 2; width: 70px; text-align: center; padding: 5px 0; font-size: 11.5px; font-weight: 600; color: #7d7464; }
.range-item.on { color: #4a4438; }
.range-pill { position: absolute; z-index: 1; top: 4px; width: 70px; height: 26px; border-radius: 9px; background: #f6efe3; box-shadow: 0 2px 8px rgba(74,64,52,.14); }
.metric-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 4px; }
.metric { position: relative; padding: 14px 16px; border-radius: 16px; background: rgba(236,225,208,.82); border: 1px solid #cbbfa9; box-shadow: 0 4px 14px rgba(74,64,52,.08); }
.metric-icon { position: absolute; right: 14px; top: 14px; }
.metric-value { font-size: 26px; font-weight: 300; letter-spacing: -.5px; font-variant-numeric: tabular-nums; }
.metric-label { margin-top: 6px; font-size: 11px; font-weight: 600; letter-spacing: .4px; text-transform: uppercase; color: #9a9080; }
.panel-row { display: flex; gap: 10px; margin-top: 10px; }
.panel { padding: 14px 16px; border-radius: 16px; background: rgba(236,225,208,.82); border: 1px solid #cbbfa9; box-shadow: 0 4px 14px rgba(74,64,52,.08); }
.grow { flex: 1; }
.panel-title { font-size: 12.5px; font-weight: 650; margin-bottom: 10px; }
.chart { display: flex; align-items: flex-end; gap: 8px; height: 128px; }
.bar { flex: 1; border-radius: 6px 6px 3px 3px; }
.dist-panel { width: 300px; }
.dist-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 11.5px; color: #6b6354; }
.dist-name { width: 66px; }
.dist-track { flex: 1; height: 7px; border-radius: 999px; background: rgba(203,191,169,.45); overflow: hidden; }
.dist-fill { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #d9c3a3, #c4a77d); }
.dist-val { width: 34px; text-align: right; font-variant-numeric: tabular-nums; color: #8b8271; }
.stats-bottom { display: flex; gap: 10px; margin-top: 10px; }
.hourbars { display: flex; align-items: flex-end; gap: 5px; height: 58px; }
.hourbar { flex: 1; border-radius: 3px 3px 2px 2px; }
.hour-axis { display: flex; justify-content: space-between; margin-top: 5px; font-size: 9.5px; color: #a89e8b; }
.facts { width: 300px; }
.fact-row { display: flex; justify-content: space-between; font-size: 11.5px; color: #8b8271; padding: 4px 0; border-bottom: 1px dashed rgba(203,191,169,.45); }
.fact-row b { font-weight: 650; color: #4a4438; }
.persona { display: flex; gap: 6px; margin-top: 8px; }
.persona span { font-size: 10px; font-weight: 650; color: #9a7c4d; background: rgba(196,167,125,.2); border: 1px solid rgba(196,167,125,.35); border-radius: 999px; padding: 2px 8px; }

/* app usage */
.usage-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.usage-card { padding: 14px 16px; border-radius: 16px; background: rgba(236,225,208,.82); border: 1px solid #cbbfa9; box-shadow: 0 4px 14px rgba(74,64,52,.08); }
.usage-label { font-size: 11px; font-weight: 600; letter-spacing: .4px; text-transform: uppercase; color: #9a9080; }
.usage-value { margin-top: 6px; font-size: 24px; font-weight: 300; font-variant-numeric: tabular-nums; }
.donut-panel { width: 300px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 14px; border-radius: 16px; background: rgba(236,225,208,.82); border: 1px solid #cbbfa9; box-shadow: 0 4px 14px rgba(74,64,52,.08); }
.donut { width: 170px; height: 170px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.donut-hole { width: 108px; height: 108px; border-radius: 50%; background: #f5ede4; display: flex; flex-direction: column; align-items: center; justify-content: center; box-shadow: inset 0 1px 4px rgba(74,64,52,.10); }
.donut-hole span { font-size: 17px; font-weight: 550; font-variant-numeric: tabular-nums; }
.donut-hole small { margin-top: 2px; font-size: 10px; letter-spacing: .4px; text-transform: uppercase; color: #9a9080; }
.legend { display: flex; gap: 18px; margin-top: 12px; font-size: 11px; color: #8b8271; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend i { width: 8px; height: 8px; border-radius: 3px; }
.app-panel { padding-top: 12px; }
.app-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-size: 12px; }
.app-logo { width: 22px; height: 22px; border-radius: 7px; color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; }
.app-name { width: 72px; font-weight: 550; }
.app-track { flex: 1; height: 7px; border-radius: 999px; background: rgba(203,191,169,.45); overflow: hidden; }
.app-fill { display: block; height: 100%; border-radius: 999px; }
.app-time { width: 52px; text-align: right; color: #6b6354; font-variant-numeric: tabular-nums; }
.app-pct { width: 34px; text-align: right; color: #9a9080; font-variant-numeric: tabular-nums; }
"""


# ---------------------------------------------------------------------------
# scene registry: (renderer, time points in seconds)
# ---------------------------------------------------------------------------

FPS = 20.0          # animation sampling rate
BATCH_FRAMES = 8    # frames rendered per tall screenshot


def timeline(start: float, end: float, fps: float = FPS) -> list[float]:
    """Frame times: one hold at t=0, then uniform samples over the animation."""
    steps = int(round((end - start) * fps))
    return [0.0] + [round(start + i / fps, 3) for i in range(steps + 1)]


SCENES = {
    "clipboard": (
        scene_clipboard,
        timeline(0.4, 3.25),
        "clip",
    ),
    "todos": (
        scene_todos,
        timeline(0.95, 2.35),
        "todo",
    ),
    "notes": (
        scene_notes,
        timeline(0.5, 2.8),
        "note",
    ),
    "pinned": (
        scene_pinned,
        timeline(0.9, 3.3),
        "pin",
    ),
    "statistics": (
        scene_stats,
        timeline(0.6, 1.9),
        "stats",
    ),
    "app-usage": (
        scene_appusage,
        timeline(0.6, 1.9),
        "clock",
    ),
}


# ---------------------------------------------------------------------------
# rendering pipeline
# ---------------------------------------------------------------------------


def find_browser() -> str:
    for path in CHROME_CANDIDATES:
        if Path(path).exists():
            return path
    for name in ("chrome", "google-chrome", "chromium", "msedge"):
        found = shutil.which(name)
        if found:
            return found
    raise SystemExit("Chrome/Edge not found. Install one or edit CHROME_CANDIDATES.")


def capture(browser: str, html_path: Path, png: Path, profile: Path, height: int) -> None:
    args = [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        f"--user-data-dir={profile}",
        f"--window-size={W},{height}",
        f"--force-device-scale-factor={RENDER_SCALE}",
        "--default-background-color=00000000",
        f"--screenshot={png}",
    ]
    subprocess.run(
        [browser, *args, html_path.as_uri()],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=120,
    )
    if not png.exists():
        raise RuntimeError(f"render failed: {png}")


_BG_URI: str | None = None


def background_uri(browser: str, profile: Path) -> str:
    """Bake the decorative backdrop once and inline it for pixel-identical frames.

    Chrome dithers CSS gradients in device space, so the same glow renders a
    few RGB levels differently depending on where it sits on the page.  That
    noise defeats GIF delta compression, so the backdrop is rasterised once.
    """
    global _BG_URI
    if _BG_URI:
        return _BG_URI
    html = (
        "<!doctype html><html><head><meta charset='utf-8'><style>"
        + CSS
        + f"\nhtml,body{{width:{W}px;height:{H}px;overflow:hidden}}\n</style></head>"
        + "<body><div class='shot'></div></body></html>"
    )
    html_path = profile.parent / "backdrop.html"
    html_path.write_text(html, encoding="utf-8")
    png = profile.parent / "backdrop.png"
    capture(browser, html_path, png, profile, H)
    _BG_URI = "data:image/png;base64," + base64.b64encode(png.read_bytes()).decode()
    return _BG_URI


def render_batch(browser: str, fragments: list[str], png: Path, profile: Path, bg: str) -> None:
    """Render several stacked frames in one screenshot to keep generation fast."""
    body = "".join(f'<div class="shot">{f}</div>' for f in fragments)
    html = (
        "<!doctype html><html class='static-bg'><head><meta charset='utf-8'><style>"
        + CSS
        + f"\n:root{{--bg-image:url(\"{bg}\")}}\nhtml,body{{height:auto;overflow:visible}}\n</style>"
        + "</head><body>"
        + body
        + "</body></html>"
    )
    html_path = png.with_suffix(".html")
    html_path.write_text(html, encoding="utf-8")
    capture(browser, html_path, png, profile, H * len(fragments))


def build_gif(frames: list[Image.Image], durations: list[int], out: Path) -> None:
    base = frames[0].quantize(colors=128, method=Image.MEDIANCUT)
    paletted = [f.quantize(palette=base, dither=Image.Dither.NONE) for f in frames]
    paletted[0].save(
        out,
        save_all=True,
        append_images=paletted[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=1,
    )


def make_scene(name: str, browser: str, keep_frames: bool) -> Path:
    renderer, times, active = SCENES[name]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{name}.gif"
    with tempfile.TemporaryDirectory(prefix=f"s1d3-{name}-") as tmp:
        tmp_path = Path(tmp)
        profile = tmp_path / "profile"
        bg = background_uri(browser, profile)
        fragments = [titlebar(active) + renderer(t) for t in times]
        frames: list[Image.Image] = []
        for start in range(0, len(fragments), BATCH_FRAMES):
            chunk = fragments[start : start + BATCH_FRAMES]
            png = tmp_path / f"batch-{start:03d}.png"
            render_batch(browser, chunk, png, profile, bg)
            sheet = Image.open(png).convert("RGB")
            expected = (W * RENDER_SCALE, H * RENDER_SCALE * len(chunk))
            if sheet.size != expected:
                raise RuntimeError(f"{name}: unexpected screenshot {sheet.size}, want {expected}")
            for i in range(len(chunk)):
                box = (
                    0,
                    i * H * RENDER_SCALE,
                    W * RENDER_SCALE,
                    (i + 1) * H * RENDER_SCALE,
                )
                frames.append(sheet.crop(box).resize((W, H), Image.LANCZOS))
                if keep_frames:
                    frames[-1].save(tmp_path / f"preview-{start + i:02d}.png")

        durations = [
            int(round((times[i + 1] - times[i]) * 1000)) for i in range(len(times) - 1)
        ]
        durations.append(1400)  # final hold
        build_gif(frames, durations, out)

        if keep_frames:
            preview_dir = ROOT / ".screenshots" / ".tmp"
            preview_dir.mkdir(parents=True, exist_ok=True)
            for f in tmp_path.glob("preview-*.png"):
                shutil.copy2(f, preview_dir / f"{name}-{f.name}")

    size = out.stat().st_size / 1024
    print(f"  {out.relative_to(ROOT)}  {W}x{H}  {len(times)} frames  {size:.0f} KiB")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenes", nargs="*", help="scene names; default = all")
    parser.add_argument("--keep-frames", action="store_true", help="also write PNG previews")
    args = parser.parse_args()

    names = args.scenes or list(SCENES)
    unknown = [n for n in names if n not in SCENES]
    if unknown:
        raise SystemExit(f"unknown scene(s): {', '.join(unknown)}; choose from {', '.join(SCENES)}")

    browser = find_browser()
    print(f"browser: {browser}")
    for name in names:
        make_scene(name, browser, args.keep_frames)


if __name__ == "__main__":
    main()

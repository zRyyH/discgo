# DiscGo — design system

Direction (PLAN.md section 8): Discord's organisation, Linear/Arc restraint. One dark
theme. Tokens live in [src/styles.css](src/styles.css) (`@theme`, Tailwind 4) and are
used as Tailwind classes (`bg-bg-2`, `text-text-2`, `border-border`, …).

## Tokens

| Token | Value | Use |
|---|---|---|
| `bg-0` | `#0B0C10` | window background, inputs inside panels, media stage |
| `bg-1` | `#111218` | sidebar, member list, settings nav |
| `bg-2` | `#171923` | chat and panels |
| `bg-3` | `#1E2130` | hover, selected row, composer, skeletons |
| `border` | `#262A3A` | 1 px separators and outlines |
| `text-1` | `#E7E9F0` | primary text |
| `text-2` | `#9BA1B5` | secondary text, inactive channels |
| `text-3` | `#646B80` | metadata, group titles, placeholders |
| `accent` | `#8B9CFF` | the only accent: primary button, focus, links, progress |
| `ok` | `#3DDC97` | online dot, speaking ring |
| `danger` | `#FF5C6C` | mute/deafen active, destructive actions, errors |
| `warn` | `#FFC857` | reconnecting, dev-only UI, admin crown |

Type: Inter (variable, bundled) — `text-body` 13 px, `text-msg` 14 px, `text-meta`
12 px, `text-title` 15 px/600. JetBrains Mono for codes and code. Line height 1.45.
Radii: `rounded-sm` 6, `rounded-md` 10, `rounded-lg` 14. 4 px grid. Shadow only on
popovers, tooltips and dialogs (`shadow-popover`). Icons: Lucide 18 px, stroke 1.75.

## Layout

```
┌ Titlebar 36 px (community name, window controls) ──────────────────────────┐
│ Sidebar 240 │ Header 48 (# channel ……………… members toggle) │ Members 220 │
│ TEXTO  +    │                                               │ ONLINE — n  │
│ # geral     │ Message list (virtualised)                    │ ● Ana  👑   │
│ VOZ    +    │                                               │ OFFLINE — n │
│ 🔊 Sala     │                                               │   Bruno     │
│   ◯ Ana 🎙̸ │ ┌ Composer (+, text, send) ──────────────────┐ │             │
│ User panel  │ └────────────────────────────────────────────┘ │             │
└─────────────┴───────────────────────────────────────────────┴─────────────┘
```

- Messages from the same author within 5 minutes share one header (avatar 40 px, name,
  time); following lines show the time on hover. A day divider separates dates.
- Hover on a message shows a floating toolbar: copy, edit (own), delete (own, confirmed).
- Composer: Enter sends, Shift+Enter breaks the line, ↑ in an empty composer edits the
  last own message, files by button, drag-and-drop or paste, with upload progress.
- Voice channels list their participants under the channel (avatar 20 px, mute/deafen
  icon, 2 px `ok` ring while speaking).
- Empty states: one icon and one line of text. Skeletons: flat `bg-3` blocks, no shimmer.

## Motion and weight (PLAN 7.6)

Only `transform`/`opacity`/colour transitions, 120–180 ms; `prefers-reduced-motion`
disables them. No `backdrop-filter`, no animated gradients or shadows, no polling: the
only interval timers are the gateway ping (every 30 s) and call statistics while in a call.

## Sounds

`src/assets/sounds/*.ogg` (Ogg Opus, synthesized sine chimes): join, leave, mute,
unmute, stream. Played at 30 % volume; Settings → Sons turns them off.

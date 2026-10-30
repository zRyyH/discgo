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
- Sign-in: one card on `bg-0` with two static glows and a faded dot grid; Google's light "Continuar com o Google"
  button (white, official G); while the browser login runs the card shows the three steps and "Abrir de novo".
- Friends (sidebar "Amigos", badge with pending requests): segmented Online / Todos / Pendentes and an
  accent "Adicionar amigo" button that opens a sign-in style card (mark, title, one line, field, your
  own username to copy).
- The sign-in look is the app's look (PLAN fase 9C): `BrandMark` (titlebar, splash), `Backdrop` (full
  window states), `Card` (settings sections, add friend), `Splash` while opening and connecting
  (the mark's dot breathes). Settings: nav rows with icons and the same pill as the sidebar.
- Sidebar: the open text channel (or Amigos) has an accent pill at the left edge, the joined voice
  channel a green one; the user panel shows a status dot and mute/deafen as toggled (red tint).
- Empty states (`EmptyState`): one icon on a raised tile, one line, at most one action. Skeletons:
  flat `bg-3` blocks, no shimmer. Errors from actions are toasts (one line, top centre, 3.5 s).
- Text: one line of supporting text at most; no paragraph over ~12 words outside dialogs.

## Motion and weight (PLAN 7.6)

Only `transform`/`opacity`/colour transitions, 120–180 ms (200–260 ms for things entering
the screen); `prefers-reduced-motion` disables them. No `backdrop-filter`, no animated
gradients or shadows, no polling: the only interval timers are the gateway ping (every 30 s)
and call statistics while in a call. One exception: the `Segmented` pill transitions `width`
(it is absolutely positioned, nothing else lays out).

Keyframes in `src/styles.css` and where they are used:

| Keyframe | Use |
|---|---|
| `rise` (8 px up + fade) | screens and cards appearing, messages that just arrived (once, < 5 s old), voice participants, friend rows (staggered 30 ms, max 6), settings sections |
| `pop` (scale .96 + fade) | dialogs, tooltips, toasts, badges, attachment chips, call tiles, an icon that changes (mic → mic off; not on first mount) |
| `pop-out`, `fade-out` | dialogs and their overlay leaving (Radix waits for `data-[state=closed]`) |
| `slide-down` | strips under the titlebar (update, reconnecting) |
| `slide-up` / `sink` | the voice bar entering and leaving a call (`usePresence` keeps it mounted 160 ms) |
| `breathe` | the mark's dot on the splash |

Transitions: buttons press to 97 % (`active:scale`), icon buttons to 90 %; the active pill
grows with `scale-y`; the hover toolbar on messages fades and rises 4 px; the speaking ring
fades its outline colour; the call's corner controls fade out 2 s after the mouse stops.

## Sounds

`src/assets/sounds/*.ogg` (Ogg Opus, synthesized sine chimes): join, leave, mute,
unmute, stream. Played at 30 % volume; Settings → Sons turns them off.

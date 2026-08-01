# AudioTool Design System

## Direction

The physical scene is a producer working late beside a calibrated monitor: the room is dark enough for focus, while every important control remains immediately readable. The visual mood is deep-dusk navigation with a warm transport light.

AudioTool uses a restrained product color strategy. Cobalt identifies navigation and selection; orange is reserved for primary actions, live progress, and the playhead. Neutral surfaces carry almost all of the interface.

## Color

All authored colors use OKLCH.

### Dark theme

```css
--bg: oklch(0.105 0 0);
--surface-1: oklch(0.145 0.012 252);
--surface-2: oklch(0.185 0.016 252);
--surface-3: oklch(0.225 0.02 252);
--ink: oklch(0.965 0.006 252);
--muted: oklch(0.735 0.018 252);
--primary: oklch(0.62 0.15 252);
--primary-strong: oklch(0.54 0.16 252);
--accent: oklch(0.72 0.17 48);
--success: oklch(0.72 0.13 153);
--warning: oklch(0.79 0.15 82);
--danger: oklch(0.66 0.19 25);
```

### Light theme

```css
--bg: oklch(1 0 0);
--surface-1: oklch(0.975 0.004 252);
--surface-2: oklch(0.945 0.008 252);
--surface-3: oklch(0.91 0.012 252);
--ink: oklch(0.2 0.025 252);
--muted: oklch(0.46 0.025 252);
--primary: oklch(0.478 0.136 252);
--primary-strong: oklch(0.4 0.14 252);
--accent: oklch(0.62 0.17 48);
--success: oklch(0.5 0.13 153);
--warning: oklch(0.57 0.14 82);
--danger: oklch(0.52 0.18 25);
```

Filled primary and accent controls use near-white text. Status text is paired with an icon or explicit label.

## Typography

Use Plus Jakarta Sans throughout the product in weights 400, 500, 600, and 700. Product type follows a fixed compact scale rather than fluid display sizes. Data values may use the same family with tabular numerals.

- Page title: 1.75rem / 1.15, weight 700, tracking -0.025em
- Section title: 1.125rem / 1.3, weight 650
- Body: 0.9375rem / 1.55, weight 400
- Control: 0.875rem / 1.2, weight 600
- Metadata: 0.75rem / 1.35, weight 500

Headings use balanced wrapping; explanatory prose is capped at 70 characters.

## Shape and spacing

Use a 4px base spacing unit. Controls are 36px or 40px high. Panel radii are 12px, controls 8px, and pills are reserved for compact states. Avoid nested cards; use dividers and surface changes to express hierarchy.

The application shell uses a 248px sidebar on wide screens, a compact top bar at tablet widths, and a bottom-aware mobile navigation pattern. The mixer becomes horizontally scrollable by track content, never by the entire page.

## Components

All interactive components include default, hover, focus-visible, active, disabled, loading, and error behavior. Use Tabler icons at 18px or 20px with consistent stroke weight. Skeletons preserve final geometry. Empty states teach the next action.

Audio-specific controls use familiar symbols and labels. Waveforms are generated from actual audio data. Stem colors may distinguish tracks but must be reinforced by instrument names and icons.

## Motion

Motion communicates state. Frequent fader, scrubber, pan, trim, and transport interactions update immediately. Menus, inline panels, and route state changes use interruptible 150 to 220ms transitions with `cubic-bezier(0.22, 1, 0.36, 1)`. Enter movement is at most 8px; exits are quieter. No bounce, parallax, decorative loops, or orchestrated app page loads.

Every transition has a `prefers-reduced-motion: reduce` alternative. Keyboard-triggered actions do not wait for animation.

## Responsive behavior

Validate at 375px, 768px, 1024px, and 1440px. At narrow widths, dense mixer controls wrap into labelled rows, secondary metadata collapses, and a desktop recommendation may appear without blocking the user. Touch targets remain at least 44px where space allows.

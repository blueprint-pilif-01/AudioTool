# UI technical audit

Audit date: 2026-07-18. Scope: `apps/web/src`, production build, desktop 1440 x 900,
tablet 768 px, mobile 375 px, and Playwright Desktop Chrome/Pixel 7 flows.

## Audit health score

| #         | Dimension         | Score    | Key finding                                                                                                           |
| --------- | ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| 1         | Accessibility     | 3/4      | Semantics, labels, focus and reduced motion are strong; several compact controls are below the ideal 44 px touch size |
| 2         | Performance       | 3/4      | Route splitting and transform-based motion are good; three progress indicators transition `width`                     |
| 3         | Responsive design | 4/4      | No page overflow at tested breakpoints; workflow and navigation adapt cleanly                                         |
| 4         | Theming           | 4/4      | Tokenized light/dark themes and system resolution work consistently                                                   |
| 5         | Anti-patterns     | 3/4      | Product UI is restrained; automated scan flags the common Plus Jakarta Sans face                                      |
| **Total** | **17/20**         | **Good** | **Four warnings, no blocking issue**                                                                                  |

## Anti-pattern verdict

**Pass with minor warnings.** It does not read as an AI-generated card gallery: the application
opens directly into the tool-dense Projects workspace, hierarchy is clear, icons come from one
family, and there is no promotional landing step before the user's task. The remaining recognizable
pattern is Plus Jakarta Sans; blur is limited to sticky navigation and transport surfaces rather
than applied to every panel.

## Executive summary

- Issues: 0 P0, 0 P1, 4 P2/P3 warnings.
- Keyboard focus, skip link, landmarks, control names, status announcements, reduced motion, and
  dark mode are present.
- Desktop, tablet, and mobile visual inspection found no horizontal page overflow.
- The E2E flow passes with seven tracks on desktop and mobile.

## Detailed findings

### [P2] Compact touch targets

- **Location:** `apps/web/src/styles/main.css`, `.button`, `.icon-button`, `.transport-button`, and
  track controls.
- **Category:** Accessibility / Responsive.
- **Impact:** Some 38–40 px controls need more precision for touch users than the recommended 44 px
  target.
- **Standard:** WCAG 2.2 Target Size (Minimum), 2.5.8.
- **Recommendation:** Increase the mobile hit box to at least 44 x 44 px without making the visual
  icon larger; retain the current compact desktop density where pointer precision is available.
- **Suggested command:** `$impeccable adapt`.

### [P2] Progress bars animate layout width

- **Location:** `apps/web/src/styles/main.css`, `.project-stepper__track span`,
  `.job-progress__bar > span`, `.upload-progress span`.
- **Category:** Performance.
- **Impact:** The three short progress animations can trigger layout work during frequent job
  updates. The current impact is small, but the pattern should not spread to waveform/timeline
  animation.
- **Recommendation:** Render the bar at full width with `transform-origin: left` and animate
  `scaleX()`.
- **Suggested command:** `$impeccable optimize`.

### [P3] Common display typeface

- **Location:** `apps/web/src/styles/main.css` and `apps/web/src/main.ts`.
- **Category:** Anti-pattern.
- **Impact:** Plus Jakarta Sans is highly readable but less ownable as a product signature.
- **Recommendation:** Keep it for this milestone unless brand work supplies a properly licensed,
  tested alternative; typography stability is more valuable than novelty during functional QA.
- **Suggested command:** `$impeccable typeset`.

### [P3] Backdrop filters need low-power fallback review

- **Location:** public header, mobile navigation, and sticky mixer transport.
- **Category:** Performance / Theming.
- **Impact:** Blur is visually restrained but can cost compositing time on low-power devices.
- **Recommendation:** Verify on older mobile hardware and disable blur under reduced transparency
  or a performance media strategy if profiling shows dropped frames.
- **Suggested command:** `$impeccable optimize`.

## Positive findings

- All visible controls use semantic buttons, links, labels, and clear accessible names.
- Focus-visible styling and a skip-to-content link are global.
- Motion is short, state-driven, and disabled by `prefers-reduced-motion`.
- Color usage is tokenized; the theme toggle uses resolved system state rather than stored preference
  alone.
- The dynamic stepper fits all five steps at 375 px and the navigation drawer removes hidden content
  from interaction.
- Code-split routes keep the initial production JavaScript bundle modest.

## Recommended actions

1. **[P2] `$impeccable adapt`:** enlarge mobile hit areas for compact mixer/navigation controls.
2. **[P2] `$impeccable optimize`:** change progress width transitions to scale transforms and profile
   blur on low-power hardware.
3. **[P3] `$impeccable typeset`:** revisit the product typeface only during a dedicated brand pass.
4. **[P3] `$impeccable polish`:** run a final regression after the above changes.

Re-run the audit after fixes to measure the score again.

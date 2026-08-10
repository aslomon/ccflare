# ccflare Design System

## Product Character

ccflare is an operational developer tool. Its interface should feel precise,
calm, compact, and trustworthy rather than decorative. Data density is welcome
when hierarchy remains clear. Avoid generic gradients, oversized marketing
type, ornamental glass effects, and motion that competes with live metrics.

## Color Palette

All product colors come from the CSS variables in `apps/web/styles/globals.css`.
Use semantic tokens rather than literal colors in components.

- Primary and focus: Cloudflare orange `#f38020`.
- Light background/card: `#ffffff`; foreground: `#0a0a0f`.
- Dark background: `#111318`; card: `#181b22`; foreground: `#f2f2f2`.
- Success: green; warning: amber; destructive: red; information: blue.
- Charts use `--chart-1` through `--chart-5` in their defined sequence.
- Muted colors carry secondary labels, never critical state or primary values.

## Typography

- UI and data: JetBrains Mono with SF Mono, Cascadia Code, Fira Code, and the
  system monospace fallback.
- Page heading: `text-2xl font-semibold`.
- Card title: semibold with tight leading and tracking.
- Primary metric: `text-2xl font-bold`.
- Supporting label: `text-sm text-muted-foreground`.
- Fine print and annotations: `text-xs`, with adequate contrast.
- Monetary values retain full precision in data and round only when formatted
  for display. Label estimates explicitly as estimates.

## Spacing System

Use Tailwind's four-pixel scale. The established dashboard rhythm is:

- Page sections: `space-y-6`.
- Responsive grids: `gap-4` for metrics and `gap-6` for charts.
- Standard card content: `p-6`.
- Compact control groups: `gap-2` or `space-y-2`.
- Preserve a minimum 320-pixel viewport and collapse grids before squeezing
  labels or values.

## Border Radii

- Base radius: `0.375rem`.
- Cards and grouped surfaces: `rounded-lg`.
- Inputs and buttons: `rounded-md`.
- Status dots and badges: fully rounded only when their semantics warrant it.

## Shadows

- Cards use `shadow-sm` with a visible semantic border.
- Menus, dialogs, and floating popovers may use `shadow-md` or `shadow-lg`.
- Avoid stacking shadows or using shadow as the sole boundary in dark mode.

## Animation

- Standard interaction transition: 200 ms.
- Accordion motion: 200 ms ease-out.
- Progress changes: 700 ms ease-out.
- Loading may use a restrained pulse or spinner.
- Live charts and changing metrics must not bounce, scale, or reflow
  distractingly. Respect reduced-motion preferences when adding new motion.

## Component Patterns

- Use the existing shadcn New York primitives in `apps/web/src/components/ui`.
- Metric cards pair a low-emphasis icon, short label, prominent value, and an
  optional contextual trend.
- Operational state always combines color with text or an icon.
- Controls remain compact and keyboard accessible with visible focus rings.
- Server Components are not applicable to this Bun/React dashboard; keep state
  and data fetching in hooks and keep formatting logic outside visual markup.

## Data Visualization

- Never round source values before chart construction or aggregation.
- Seven-day series show both date and time; duplicate `HH:mm` labels across
  days are not acceptable.
- Missing time buckets are represented explicitly rather than silently joined.
- Tokens and estimated cost must remain distinguishable by label, unit, color,
  and tooltip.
- Empty, partial, unknown-price, and degraded-accounting states are visible and
  must never be represented as confirmed zero usage or zero cost.
- Chart colors follow the shared theme variables and retain equivalent meaning
  in light and dark modes.

## Brand Guidelines

- Use “ccflare” in lowercase in prose and UI copy.
- Orange is the identity accent, not a background wash.
- Technical language should be concise and factual. Prefer “Estimated Cost” to
  “Cost” when values come from a pricing catalogue rather than an invoice.

## Tone and Mood

Operational, sober, and reassuring. The dashboard should make health,
consumption, and degradation obvious at a glance without dramatizing normal
variation.

## Storage and Privacy UI Rules

- Raw payload capture is off by default and presented as a temporary debugging
  capability, never ordinary analytics retention.
- Token and cost accounting is visually separate from raw payload retention.
- Truncated, dropped, unavailable, or corrupt payloads show a clear state and
  never masquerade as complete data.
- Never render credentials, authorization headers, refresh tokens, or raw
  secret-bearing configuration values.

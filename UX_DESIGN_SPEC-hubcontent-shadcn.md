# Design Spec: HubContent (App Landing) — shadcn Conversion

## 1. Design Rationale

The HubContent component (`src/modules/hub/HubContent.tsx`) renders the main app landing page at the `/app` route and is displayed inside the WorkspaceOS sidebar layout. It currently uses **212 custom CSS class definitions** from `styles.css` (`.commandDesk`, `.commandTopbar`, `.commandIdentity`, `.commandSearch`, `.journeyHome`, `.journeyHero`, `.journeyGuardrail`, `.journeyGrid`, `.journeyCard`, `.journeySteps`, `.journeyWorkbench`, `.journeyPanel`, `.journeyPanelHeader`, `.journeyQueueGrid`, `.journeyScopePills`, `.journeyResults`, `.previewPanel`, `.roleBoundaryNotice`, etc.).

This custom CSS approach:
- Duplicates styling already available via shadcn primitives (Card, Badge, Button, Input, Skeleton)
- Uses non-Tailwind spacing/typography tokens that deviate from the design system
- Has no consistent loading, empty, or error states
- Is not responsive at mobile widths inside the WorkspaceOS layout
- Lacks the Zendesk Coral (#eb6651) accent and Slack-inspired aesthetic already adopted by the rest of the app

## 2. Layout Architecture

```
┌─────────────────────────────────────────────────────┐
│  WorkspaceOS Layout (already shadcn)                │
│  ┌───────────────────────────────────────────────┐  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │  commandTopbar (→ replace with shadcn    │  │  │
│  │  │  search bar + session card)              │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  │                                                │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │  journeyHero (→ HeroCard)               │  │  │
│  │  │  ┌─────────────┐ ┌───────────────────┐  │  │  │
│  │  │  │ Title/desc  │ │ Role guardrail    │  │  │  │
│  │  │  │ Primary CTA  │ │ card              │  │  │  │
│  │  │  └─────────────┘ └───────────────────┘  │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  │                                                │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │  journeyGrid (→ 4 shadcn Cards)         │  │  │
│  │  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐  │  │  │
│  │  │  │Card 1│ │Card 2│ │Card 3│ │Card 4│  │  │  │
│  │  │  └──────┘ └──────┘ └──────┘ └──────┘  │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  │                                                │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │  journeyWorkbench (→ 2 shadcn Cards)     │  │  │
│  │  │  ┌─────────────────┐ ┌────────────────┐  │  │  │
│  │  │  │ Live Queues     │ │ Search Results │  │  │  │
│  │  │  │ Queue cards     │ │ Scope pills    │  │  │  │
│  │  │  └─────────────────┘ └────────────────┘  │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  │                                                │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │  previewPanel (→ shadcn Card + Sheet    │  │  │
│  │  │  or slide-in detail)                    │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## 3. Component Breakdown

### 3.1 WorkspaceSearchBar (replaces `commandTopbar`)
- **Purpose**: Global search input + session identity card
- **shadcn components**: Input (with search icon), Badge, Card
- **Data**: `data.query`, `session`
- **States**:
  - Default: Input with placeholder "Search candidates, companies, requests, transfers, ID batches"
  - Focused: Input ring highlight (#1f73b7)
  - Empty: No results message (already handled by journeyResults)

### 3.2 HeroCard (replaces `journeyHero` + `journeyGuardrail`)
- **Purpose**: Welcome message and primary action for the role
- **shadcn components**: Card, Button, Badge
- **Data**: `guide.title`, `guide.description`, `guide.primary`, `guide.guardrail`, `session`
- **Layout**: 2-column grid (1fr auto) at desktop, stacked on mobile
- **States**:
  - Default: Title + description + "Start with…" primary button + role guardrail card
  - Role boundary notice: Coral alert banner when `requiredRole !== session.role` (using Alert or Card with border-destructive)
- **Styling**: Zendesk Coral #eb6651 for primary CTA, clean white card with subtle border

### 3.3 WorkflowCardGrid (replaces `journeyGrid` + `journeyCard`)
- **Purpose**: 4 workflow journey cards (Candidate readiness, Hiring pipeline, Finance, Compliance - varies by role)
- **shadcn components**: Card, CardHeader, CardContent, Badge, Button
- **Data**: `guide.journeys`
- **Layout**: `grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3`
- **Each card**:
  - Kicker badge (coral bg with white text): `"{needsReview} waiting"`
  - Title: Journey name
  - Description: Short paragraph
  - Steps list: 3 numbered steps (use `list-decimal` with custom styling or Badge for step numbers)
  - Action link: Button (variant="outline" or "link")
- **States**:
  - Default: 4-card grid
  - Loading: 4 skeleton Card shimmers
  - Empty: Single Card with "No workflows configured for this role"

### 3.4 WorkspacePanels (replaces `journeyWorkbench` + panels)
#### Panel A: Live Queues
- **shadcn components**: Card, CardHeader, CardContent
- **Data**: `data.queues`
- **Layout**: Grid of queue metric cards inside Card
- **States**:
  - Has queues: Grid of metric cards
  - Empty queues: "No items in queue"
  - Loading: Skeleton shimmer

#### Panel B: Search & Results
- **shadcn components**: Card, Badge, Button, Input
- **Data**: `data.scopes`, `data.results`, `data.query`
- **Layout**: Scope pills (Badge with hover/active states), results list (Link items)
- **States**:
  - Default: Pills + results list
  - Active search: Filtered results with pills showing active scope
  - Empty: "No matching records for this login and scope."
  - Loading: Skeleton list items

### 3.5 RecordPreview (replaces `previewPanel`)
- **shadcn components**: Card, CardHeader, CardContent, Badge, Button, Separator
- **Data**: `data.preview`
- **States**:
  - Has preview: Detail card with header, flags (Badges), actions (Buttons), facts (key-value grid), related records (Card list)
  - No preview: Not rendered
- **Styling**: Clean white card, coral action buttons, separator between sections

### 3.6 RoleBoundaryNotice
- **Purpose**: Alert when a user tries to access a different role's workspace
- **shadcn components**: Card (with destructive variant) or Alert component
- **Data**: `session.role`, `requiredRole`
- **Styling**: Coral/red border, warning icon from lucide-react

## 4. Zendesk Coral + Slack Aesthetic

| Token | Value | Usage |
|-------|-------|-------|
| Primary accent | `#eb6651` | Buttons, links, highlights |
| Hover | `#d45441` | Button hover states |
| Light bg | `#fef1ef` | Badge backgrounds, active states |
| Sidebar | Already shadcn (WorkspaceNavigation) | Clean links, no borders, subtle hover |
| Cards | White bg, `border-border`, `shadow-sm` | All cards |
| Typography | `text-foreground`, `text-muted-foreground` | Title, subtitle |
| Scope pills | Badge with `hover:bg-accent` | Search scope filters |
| Queue metrics | Card grid inside flex-wrap | Live queue values |

**NO glass morphism, NO backdrop-blur, NO frosted glass.**

## 5. File Structure

### New files
None — all changes are to existing files.

### Modified files
| File | Changes |
|------|---------|
| `src/modules/hub/HubContent.tsx` | Replace all CSS class names with Tailwind + shadcn. Convert `.commandDesk` → shadcn section, `.commandTopbar` → search bar, `.journeyHero` → HeroCard, `.journeyGrid` → WorkflowCardGrid, `.journeyWorkbench` → WorkspacePanels, `.previewPanel` → RecordPreview using shadcn Card/Badge/Button/Input/Skeleton |
| `src/app/hub/page.tsx` | Minor — remove `className="commandOS"` wrapper, replace with Tailwind grid |
| `src/app/app/page.tsx` | No changes needed (already passes HubContent data) |
| `src/app/styles.css` | **Remove ~212 lines** of `.commandRail*`, `.journey*`, `.preview*`, `.roleBoundary*` CSS classes after conversion |

### Deletable CSS (estimate)
Approximately 212 lines from `styles.css`, spanning lines ~3502–5727 (`.commandOS`, `.commandRail`, `.commandRailNav`, `.commandRailFooter`, `.commandSignout`, `.commandDesk`, `.commandTopbar`, `.commandIdentity`, `.commandSearch`, `.journeyHome`, `.journeyHero`, `.journeyEyebrow`, `.journeyHeroActions`, `.journeyGuardrail`, `.journeyGrid`, `.journeyCard`, `.journeyCardHeader`, `.journeySteps`, `.journeyWorkbench`, `.journeyPanel`, `.journeyPanelHeader`, `.journeyQueueGrid`, `.journeyQueue`, `.journeyScopePills`, `.journeyResults`, `.previewPanel`, `.previewHeader`, `.previewFlags`, `.previewActions`, `.previewFacts`, `.previewRelated`, `.previewRelatedHeader`, `.previewRow`, `.previewEmpty`, `.roleBoundaryNotice`, and all `@media` variants).

## 6. Data Contracts

These already exist in `HubContent.tsx` — no changes needed:

```typescript
type HubContentData = {
  query: string;
  scope: string;
  scopes: HubScopeItem[];
  navigation: HubNavigationItem[];
  queues: HubQueue[];
  system: HubSystemItem[];
  results: HubResult[];
  preview: HubPreview | null;
};

type HubQueue = {
  label: string;
  value: number;
  note: string;
  href?: Route;
  tone: string;
};

type HubResult = {
  id: string;
  type: string;
  title: string;
  subtitle: string;
  meta: string;
  href?: Route;
};
```

## 7. Acceptance Criteria

- [ ] HubContent uses ONLY Tailwind CSS classes + shadcn components — zero custom CSS class names
- [ ] All custom CSS classes (.commandRail*, .journey*, .preview*, .roleBoundary*) removed from styles.css
- [ ] Desktop layout matches: hero 2-col header, workflow cards in responsive grid, panels side by side
- [ ] Mobile layout stacks all sections vertically (test at <760px)
- [ ] Zendesk Coral #eb6651 used for primary CTAs, blue #1f73b7 for secondary links/badges
- [ ] Loading state shows shadcn Skeleton shimmers matching each section's dimensions
- [ ] Empty state for queues shows "No items in queue" message
- [ ] Empty state for results shows "No matching records for this login and scope."
- [ ] Error state handled by parent error.tsx or inline alert for role boundary
- [ ] Role boundary notice shows coral/destructive-styled alert card with Switch account link
- [ ] `tsc --noEmit` passes with zero errors
- [ ] No glass effects, no backdrop-blur, no color-mix() CSS functions

## Implementation Notes

- The HubContent component is rendered inside WorkspaceOS which already provides the sidebar and mobile nav — do not duplicate those
- The HubShortcuts component with its own command palette may be redundant with WorkspaceOS's CommandDialog — consider replacing with the shared CommandDialog
- Use `cn()` utility for conditional class merging
- All colors should use Tailwind theme (`text-foreground`, `text-muted-foreground`, `bg-card`, `border-border`) or shadcn CSS variables — no hardcoded hex except for Zendesk brand colors (#1f73b7, #eb6651) used as inline overrides or Tailwind custom theme values

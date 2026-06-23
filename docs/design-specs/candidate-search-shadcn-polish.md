# shadcn Polish: Candidate Search Page

## 1. Design Rationale

The current Candidate Search (CandidateSearchOS + CandidateProfile) uses entirely custom CSS classes with zero shadcn components. The styles live in `src/app/styles.css` (~400 lines for `candidateDesk*`, `candidateSearch*`, `candidateProfile*` classes), duplicating what shadcn already provides. This creates inconsistency with the rest of the app (HubContent, WorkspaceShell, DataTable, country admin all use proper shadcn patterns). Converting to shadcn will:

- Eliminate 400+ lines of custom CSS
- Unify the visual language across the app
- Get dark mode, responsive behavior, and focus states for free via shadcn
- Use the Zendesk Coral (#eb6651) + Slack aesthetic consistently

## 2. Layout Architecture

```
┌────────────────────────────────────────────────────────┐
│  Topbar: Brand | Search bar | Tools (Theme + Account)  │
├────────────────────────────────────────────────────────┤
│  Filter context bar (active facets, clear all)         │
├────────────────────────────────────────────────────────┤
│  [Bulk action bar — shown only when items selected]    │
├────────────────────────────────────────────────────────┤
│  ┌──────────────┬──────────────────────────────┐       │
│  │  Left:       │  Right:                      │       │
│  │  Tab bar     │  If candidate selected:      │       │
│  │  Search tab  │    CandidateProfile view     │       │
│  │  or open     │  Else:                       │       │
│  │  candidate   │    Search results grid       │       │
│  │  tabs        │    with facets sidebar       │       │
│  └──────────────┴──────────────────────────────┘       │
└────────────────────────────────────────────────────────┘
```

## 3. Component Breakdown

### 3.1 CandidateSearchOS (Shell)

| Sub-component | shadcn replacement | Purpose |
|---|---|---|
| `.candidateDesk` | `main` grid layout | Outer shell with grid background |
| `.candidateDeskTopbar` | `header` with flex + shadcn `Card` | App-level toolbar: brand, search, tools |
| `.candidateDeskBrand` | `Link` with shadcn `buttonVariants` | Logo + "Candidates" title |
| `.candidateDeskSearch` | Form with shadcn `Input` + `Button` | Search input with submit |
| `.candidateDeskTools` | `div` flex layout | ThemeToggle, account badge, sign out |
| `.candidateDeskAccount` | `Card` with inner layout | Role badge + name + email |
| `.candidateDeskBody` | `div` grid | Main content area |

### 3.2 CandidateSearchTab

| Sub-component | shadcn replacement | Purpose |
|---|---|---|
| `.candidateSearchPanel` | `Card` | Outer search container |
| `.candidateSearchTabHeader` | `CardHeader` | "Search tab" heading + result count |
| `.candidatePowerFilters` | `details` with shadcn `Badge` | Collapsible facet rail |
| `.candidateFacetRail` | `div` scrollable grid | Filter groups (country, university, etc.) |
| `.candidateSearchFilters` | `nav` with `buttonVariants("ghost")` | All / Active / Needs review / Incomplete / Civil ID |
| `.candidateResultList` | `div` grid | Scrollable result rows |
| `.candidateResultCard` | `Card` with `CardContent` | Individual candidate row |

### 3.3 CandidateProfile

| Sub-component | shadcn replacement | Purpose |
|---|---|---|
| `.candidateProfile` | `Card` | Profile view container |
| `.candidateProfileHero` | `CardHeader` with avatar + info | Name, ID, status, company |
| `.candidateAvatar` | `div` with `cn()` | Initials avatar circle |
| `.candidateProfileActions` | `div` with `Button` variants | Action links |
| `.candidateReadiness` | `Card` sub-section | Readiness score + checklist |
| `.candidateFactGrid` | `div` CSS grid | Key-value fact cards |
| `.candidateProfilePanel` | `Card` | Skills, timeline, education sections |
| `.candidatePills` | `div` with `Badge` | Skill/tag pills |
| `.candidateRows` | `div` grid | List rows for timeline/education/etc. |

### 3.4 Supporting Components

| Component | shadcn replacement | Purpose |
|---|---|---|
| `CandidateTabs` | `Tabs` from shadcn | Search tab + open candidate tabs |
| `BulkCandidateBar` | `Card` with `Badge` + `Button` | Batch selection actions |
| `ActiveSearchContext` | `Card` with filter `Badge`s | Active filter display |
| `FacetGroup` | `Card` with checkbox-like links | Collapsible filter group |
| `EmptyState` | `Card` with icon + text | No results fallback |

## 4. Zendesk Coral + Slack Aesthetic

### Color Palette (from DESIGN_SYSTEM.md)

```css
/* Zendesk Coral — primary accent */
--sh-coral: #eb6651;
--sh-coral-hover: #d45441;
--sh-coral-light: #fef1ef;

/* Zendesk Blue — secondary */
--sh-blue: #1f73b7;

/* Semantic */
--sh-success: #24835b;
--sh-warning: #a66212;
--sh-error: #b42318;
--sh-info: #0b63ce;
```

### Token Application

| Element | Token |
|---|---|
| Active tab indicator | `--sh-coral` (coral bottom border) |
| Search button | Coral accent (`bg-[#eb6651] text-white hover:bg-[#d45441]`) |
| Primary action buttons | Coral accent |
| Filter badges (active) | `bg-[#1f73b7]/10 text-[#1f73b7]` |
| Status badges | Semantic colors (success=green, warning=amber, error=red) |
| Card backgrounds | `bg-card` (white with subtle shadow) |
| Border stops | `border-border` (Light: #d6dce7, Dark: #2a3547) |
| Result row hover | `bg-muted/50` |
| Avatar initials | `bg-[#1f73b7]/10 text-[#1f73b7]` |

### NO glass morphism, NO backdrop-blur, NO frosted glass.

## 5. File Structure

### Files to modify:
- `src/modules/candidates/CandidateSearchOS.tsx` — Convert to shadcn patterns (major refactor)
- `src/modules/candidates/CandidateProfile.tsx` — Convert to shadcn patterns (major refactor)

### Files to clean up:
- `src/app/styles.css` — Remove all `.candidateDesk*`, `.candidateSearch*`, `.candidateProfile*`, `.candidateResult*`, `.candidateTabs*`, `.candidateFacet*`, `.candidateBulk*`, `.candidateEmpty*`, `.candidateAccess*` classes (~400 lines)

### No new files needed — all shadcn components are already installed.

## 6. Data Contracts (unchanged)

The data contracts remain identical — only the presentation layer changes.

```typescript
// Candidate search params (unchanged)
type CandidateSearchParams = {
  role: "staff" | "admin";
  staffId: number;
  query: string;
  filter: CandidateSearchFilter;
  visibility: CandidateSearchVisibility;
  candidateId?: number;
  tabIds: number[];
  selectedIds: number[];
  country?: string;
  university?: string;
  company?: string;
  skill?: string;
  gender?: string;
  profile?: string;
  assignment?: string;
  document?: string;
};

// Candidate search data (unchanged)
type CandidateSearchData = {
  query: string;
  filter: string;
  role: string;
  visibility: string;
  matchingCount: number;
  assignedCount?: number;
  rows: CandidateRow[];
  facets: CandidateSearchFacet[];
  openTabs: CandidateTab[];
  selectedId?: number;
  selected?: CandidateDetailData | null;
  selectedBlocked?: boolean;
  selectedActions: { label: string; href: string }[];
  params: CandidateSearchParams;
};
```

## 7. Acceptance Criteria

- [ ] `CandidateSearchOS.tsx` uses only shadcn/tailwind classes — NO custom CSS class names (`candidateDesk`, `candidateSearchTabHeader`, etc.)
- [ ] All `button`, `Card`, `Badge`, `Input`, `Tabs` elements use shadcn components from `@/components/ui/`
- [ ] Search button uses `#eb6651` (Zendesk Coral) accent color
- [ ] Active filter pills use `#1f73b7` (Zendesk Blue) background tint
- [ ] `.candidateDesk*`, `.candidateSearch*`, `.candidateProfile*` CSS blocks removed from `styles.css`
- [ ] Candidate profile view uses `Card` with proper `CardHeader`, `CardContent` hierarchy
- [ ] Empty state uses shadcn Card with meaningful message and CTA button
- [ ] Loading state uses shadcn Skeleton shimmer (future enhancement)
- [ ] Result rows have hover state via `hover:bg-muted/50`
- [ ] All text sizes use tailwind utilities (`text-sm`, `text-xs`, etc.)
- [ ] Responsive: single column on mobile, split view on desktop
- [ ] `tsc --noEmit` passes with zero errors
- [ ] Dark mode works via CSS variables (inherited from shadcn + theme provider)
- [ ] No inline styles — all styling via Tailwind utility classes
- [ ] No glass morphism, backdrop-blur, or frosted glass effects

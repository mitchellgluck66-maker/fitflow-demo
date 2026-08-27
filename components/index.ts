// Core primitives
export { Card, CardHeader } from './Card';
export { Button } from './Button';
export { Badge } from './Badge';
export { KPITile } from './KPITile';
export { Toast } from './Toast';
export { Modal } from './Modal';
export { Loader, PageLoader, SkeletonRow } from './Loader';
export { Input, Select, Toggle } from './Input';

// Phase B
export { DateRangePicker } from './DateRangePicker';
export { Funnel } from './Funnel';
export { FunnelStrip } from './FunnelStrip';
export { PeopleDrawer } from './PeopleDrawer';
export { KpiDeltaTile } from './KpiDeltaTile';
export { useScorecard } from './useScorecard';

// Phase C
export { CampaignTable } from './CampaignTable';
export { PaymentsTable } from './PaymentsTable';

// Phase E — filtering
export { FilterBar, NoMatches } from './FilterBar';
export { SortableHeader } from './SortableHeader';
export { SourceBreakdownTable } from './SourceBreakdownTable';
export { useTableState, applyClient, facetOptions } from './useTableState';
export type { TableState, SortDir } from './tableState';

// Layout
export { NavBar } from './NavBar';
export { SampleDataBanner } from './SampleDataBanner';
export { PageHeader, PageBody, SectionLabel, EmptyState } from './PageHeader';

// Theming
export { ThemeProvider, useTheme, themeInitScript } from './ThemeProvider';
export { ThemeToggle } from './ThemeToggle';

// Attendance
export { OutcomeButtons, OUTCOMES } from './OutcomeButtons';
export type { Outcome } from './OutcomeButtons';

// Error handling
export { ErrorBoundary } from './ErrorBoundary';

export type { ButtonProps } from './Button';
export type { CardProps } from './Card';
export type { BadgeProps } from './Badge';
export type { KPITileProps } from './KPITile';
export type { ModalProps } from './Modal';
export type { ToastProps } from './Toast';

// Phase E polish
export { RadialRing } from './RadialRing';
export { Skeleton, SkeletonText, SkeletonTile, SkeletonTable, SkeletonChart } from './Skeleton';

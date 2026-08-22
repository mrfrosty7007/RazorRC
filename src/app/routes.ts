import { LayoutDashboard, LineChart, ListChecks, ScrollText, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type NavGroupId = 'recover' | 'understand';

export interface NavRoute {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Shown as the page subtitle and the sidebar tooltip. */
  description: string;
  group: NavGroupId;
}

/**
 * Navigation is grouped by what the merchant is doing, not by data type: the
 * first group acts on money, the second explains it. Both the sidebar and the
 * router read this list, so a new page is added in exactly one place.
 */
export const NAV_GROUPS: { id: NavGroupId; label: string }[] = [
  { id: 'recover', label: 'Recover' },
  { id: 'understand', label: 'Understand' },
];

export const NAV_ROUTES: NavRoute[] = [
  {
    path: '/',
    label: 'Dashboard',
    icon: LayoutDashboard,
    description: 'Where every at-risk rupee stands right now',
    group: 'recover',
  },
  {
    path: '/queue',
    label: 'Recovery queue',
    icon: ListChecks,
    description: 'Every failed payment the engine is working on',
    group: 'recover',
  },
  {
    path: '/copilot',
    label: 'AI Copilot',
    icon: Sparkles,
    description: 'Playbooks, ranked recommendations and the reasoning behind them',
    group: 'recover',
  },
  {
    path: '/analytics',
    label: 'Analytics',
    icon: LineChart,
    description: 'Why payments fail and which recoveries actually work',
    group: 'understand',
  },
  {
    path: '/audit',
    label: 'Audit trail',
    icon: ScrollText,
    description: 'Append-only record of every action taken on your payments',
    group: 'understand',
  },
];

export function routeFor(pathname: string): NavRoute | undefined {
  return NAV_ROUTES.find((route) => route.path === pathname);
}

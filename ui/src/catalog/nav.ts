/**
 * Page-level navigation for the catalog links deep inside the run and workflow views (step panel chips, "dùng ở"
 * chips), so the props do not have to pass through every component. App registers the handlers.
 */
import type { CatalogSelection } from './CatalogPage';

type Nav = { openCatalog?: (selection: CatalogSelection) => void; openWorkflow?: (workflow: string, step?: string) => void };
let nav: Nav = {};
export function setCatalogNav(next: Nav): void { nav = next; }
/** undefined when the page has no catalog view (callers then render plain chips). */
export const openCatalog = (): Nav['openCatalog'] => nav.openCatalog;
export const openWorkflow = (): Nav['openWorkflow'] => nav.openWorkflow;

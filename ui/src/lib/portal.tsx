import { createContext, useContext } from 'react';

/**
 * Where Radix portals render. Inside the Nimbalyst panel the app lives in a shadow root, and content portalled to
 * document.body would lose every style; the shell provides a node inside its theme wrapper instead.
 */
export const PortalContainer = createContext<HTMLElement | null>(null);
export function usePortalContainer(): HTMLElement | undefined { return useContext(PortalContainer) ?? undefined; }

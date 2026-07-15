import { createContext, useContext } from "react";

/** Raw URL of the first media item in the live message, or null in card previews. */
export const PreviewMediaPriorityContext = createContext<string | null>(null);

export function usePreviewMediaPriority(url: string): boolean {
  const priorityUrl = useContext(PreviewMediaPriorityContext);
  return !!url && priorityUrl === url;
}

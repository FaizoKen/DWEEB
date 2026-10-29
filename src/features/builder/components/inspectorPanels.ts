/**
 * The lazy chunk behind every tree row's inline editor (`LazyInspector`).
 * One module re-exporting both panels so they load as a single request:
 * the component Inspector and the gallery-item one share most of their
 * field editors, and a row of either kind is the first thing clicked.
 */
export { Inspector } from "./Inspector";
export { GalleryItemInspector } from "./inspectors/GalleryItemInspector";

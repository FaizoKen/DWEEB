/**
 * The Share dialog's tab ids.
 *
 * They live here rather than in `ShareDialog.tsx` so a panel the dialog renders
 * can name a tab (the update-failure notice offers "Post as a new message")
 * without importing its own host.
 */
export type ShareTab = "send" | "update" | "restore" | "share" | "json" | "code" | "about";

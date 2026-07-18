import { afterEach, describe, expect, it } from "vitest";

import { ComponentType, type WebhookMessage } from "@/core/schema";
import {
  forgetAttachment,
  garbageCollect,
  getAttachmentFile,
  parseSessionUrl,
  registerAttachment,
  registerAttachments,
  subscribeAttachments,
} from "@/core/state/attachmentStore";
import { useMessageStore } from "@/core/state/messageStore";
import { collectReferencedMediaUrls } from "./useAttachmentGc";

const registeredIds: string[] = [];

function messageWithFile(url: string): WebhookMessage {
  return {
    components: [
      {
        _id: "file-1",
        type: ComponentType.File,
        file: { url },
      },
    ],
  } as WebhookMessage;
}

function emptyMessage(): WebhookMessage {
  return { components: [] };
}

function registerTestFile(): { id: string; url: string } {
  const url = registerAttachment(new File(["hello"], "hello.txt", { type: "text/plain" }));
  const id = parseSessionUrl(url)!.blobId;
  registeredIds.push(id);
  return { id, url };
}

afterEach(() => {
  for (const id of registeredIds.splice(0)) forgetAttachment(id);
  useMessageStore.setState({ message: emptyMessage(), past: [], future: [], selectedId: null });
});

describe("attachment history garbage collection", () => {
  it("registers a file batch with one registry notification", () => {
    let notifications = 0;
    const unsubscribe = subscribeAttachments(() => notifications++);
    const urls = registerAttachments([
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.png", { type: "image/png" }),
    ]);
    unsubscribe();
    for (const url of urls) registeredIds.push(parseSessionUrl(url)!.blobId);

    expect(urls).toHaveLength(2);
    expect(notifications).toBe(1);
  });

  it("keeps a deleted upload alive so Undo restores usable bytes", () => {
    const { id, url } = registerTestFile();
    const beforeDelete = messageWithFile(url);

    // This is the state produced by a structural delete: the live tree no
    // longer references the upload, but the pre-delete tree remains undoable.
    useMessageStore.setState({
      message: emptyMessage(),
      past: [{ message: beforeDelete }],
      future: [],
      selectedId: null,
    });
    garbageCollect(collectReferencedMediaUrls(useMessageStore.getState()));

    expect(getAttachmentFile(id)?.name).toBe("hello.txt");
    useMessageStore.getState().undo();
    expect(useMessageStore.getState().message.components[0]).toMatchObject({
      type: ComponentType.File,
      file: { url },
    });
    expect(getAttachmentFile(id)?.name).toBe("hello.txt");
  });

  it("keeps uploads referenced only by redo history and frees unreachable ones", () => {
    const redoUpload = registerTestFile();
    const orphan = registerTestFile();
    useMessageStore.setState({
      message: emptyMessage(),
      past: [],
      future: [{ message: messageWithFile(redoUpload.url) }],
      selectedId: null,
    });

    garbageCollect(collectReferencedMediaUrls(useMessageStore.getState()));

    expect(getAttachmentFile(redoUpload.id)).not.toBeNull();
    expect(getAttachmentFile(orphan.id)).toBeNull();
    useMessageStore.getState().redo();
    expect(getAttachmentFile(redoUpload.id)).not.toBeNull();
  });

  it("keeps uploads referenced only by a named browser-saved message", () => {
    const savedUpload = registerTestFile();
    const orphan = registerTestFile();

    garbageCollect(
      collectReferencedMediaUrls({ message: emptyMessage(), past: [], future: [] }, [
        { payload: messageWithFile(savedUpload.url) },
      ]),
    );

    expect(getAttachmentFile(savedUpload.id)?.name).toBe("hello.txt");
    expect(getAttachmentFile(orphan.id)).toBeNull();
  });
});

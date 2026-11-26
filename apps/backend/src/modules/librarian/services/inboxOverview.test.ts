import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { inspectInbox } from "./inboxOverview.js";

let sandbox: string;
let inbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "asl-inbox-overview-"));
  inbox = path.join(sandbox, "inbox");
  await fs.mkdir(inbox);
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

it("counts actual visible audiobook files without traversing staging directories or links", async () => {
  const pack = path.join(inbox, "Pack");
  const hidden = path.join(inbox, ".collection-staging");
  const other = path.join(sandbox, "Other");
  await Promise.all([pack, hidden, other, path.join(pack, "Disc 1")].map(dir => fs.mkdir(dir, { recursive: true })));
  await Promise.all([
    path.join(pack, "Disc 1", "01.MP3"), path.join(pack, "cover.jpg"), path.join(inbox, "Loose.m4b"),
    path.join(hidden, "staged.mp3"), path.join(other, "outside.mp3"),
  ].map(file => fs.writeFile(file, "fixture")));
  await fs.symlink(other, path.join(pack, "linked"), "junction");
  const snapshot = await inspectInbox(inbox);
  expect(snapshot.entries).toHaveLength(2);
  expect(snapshot.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "Pack", audioFiles: 1, otherFiles: 1, partial: true }),
    expect.objectContaining({ name: "Loose.m4b", audioFiles: 1, otherFiles: 0, partial: false }),
  ]));
});

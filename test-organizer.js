import { MetadataScanner } from "./apps/backend/dist/modules/librarian/services/scanner.js";

const scanner = new MetadataScanner({ PORT: 3050, TARGET_DIR: '/Volumes/Audio/library' });
async function run() {
  const target = '/Volumes/Audio/inbox/2026 - A Parade of Horribles';
  const book = await scanner.scanTarget(target);
  const action = scanner.getOrganizer().organizeBook(book);
  console.log('Book title:', book.title);
  console.log('Action:', action.action_type);
  if (action.action_type === 'skip') console.log('Reason:', action.reason);
}
run().catch(console.error);

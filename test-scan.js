import { MetadataScanner } from "./apps/backend/dist/modules/librarian/services/scanner.js";
import { AudiobookOrganizer } from "./apps/backend/dist/modules/librarian/services/organizer.js";

async function run() {
  const scanner = new MetadataScanner({ PORT: 3050, TARGET_DIR: '/Volumes/Audio/library' });
  const organizer = scanner.getOrganizer();
  
  const dirs = await scanner.discoverTargets('/Volumes/Audio/inbox');
  
  const results = [];
  for (const target of dirs) {
    try {
      const book = await scanner.scanTarget(target);
      if (book.audio_files.length > 0) {
        const action = organizer.organizeBook(book);
        if (action.action_type !== "skip") {
          results.push(action);
        }
      }
    } catch (e) {
      console.error(e);
    }
  }
  
  console.log(`Found ${results.length} actions:`);
  for (const a of results) {
    console.log(a.book.title, "->", a.action_type);
  }
}
run().catch(console.error);
